import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  fakeVendorLogout,
  resetFakeVendorEnv,
  setFakeVendorLogoutExit,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../../test-support/fake-vendor-binary";
import { insertUser } from "~/server/auth/user-store.server";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { openSecret } from "~/server/secrets/secret-box.server";
import {
  connectedUserIds,
  countConnectedUsers,
  disconnectBackend,
  getBackendCredential,
  isBackendAvailableFor,
  listBackendCredentials,
  recordBackendLogin,
  runCredentialFor,
  setBackendApiKey,
  userBackendHealth,
  type BackendCredentialActor,
  type BackendCredentialRow,
} from "./backend-credentials.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import {
  claudeLoginCredentialPath,
  codexLoginCredentialPath,
  ensureUserBackendHome,
  userBackendHome,
} from "./user-homes.server";

/**
 * Ruling 121: a person's own agent accounts. Every seam here is real — a
 * migrated SQLite file, a temp data root, the actual secret box, and the shared
 * fake VENDOR BINARIES (`test-support/fake-vendor-binary.ts`, the same pair the
 * sign-in driver's tests drive), which are real executable scripts, so the
 * logout path is exercised as a spawned process rather than as a stub.
 */

const ctx = createTestDbContext();

const CLAUDE_KEY = "sk-ant-api03-viberr-test-key-abcd";
const OPENAI_KEY = "sk-proj-viberr-test-key-wxyz";
const CHATGPT_TOKEN = "chatgpt-workspace-access-token-0001";

let db: DatabaseSync;
let dataRoot: string;
let vendors: FakeVendorBinaries;
let actor: BackendCredentialActor;

beforeEach(() => {
  db = ctx.makeDb();
  dataRoot = ctx.makeTempDir();
  vendors = writeFakeVendorBinaries();
  const user = insertUser(db, {
    id: "u_arda",
    email: "arda@viberr.dev",
    name: "Arda Test",
    role: "admin",
  });
  actor = { userId: user.id, label: user.email };
});

afterEach(() => {
  resetFakeVendorEnv();
  vendors.cleanup();
  ctx.cleanup();
});

// ------------------------------------------------------------- fake vendors

interface ProbeCall {
  url: string;
  headers: Record<string, string>;
}

interface FakeProvider {
  fetchImpl: typeof fetch;
  calls: ProbeCall[];
}

/** A provider that answers the free `GET /v1/models` probe. `status` 200 is an
 *  acceptance; anything else is the vendor refusing the key. */
function fakeProvider(status: number): FakeProvider {
  const calls: ProbeCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** A provider that cannot be reached at all. Its rejection deliberately CARRIES
 *  the key, the way a real fetch error carries the request it failed on — the
 *  message the person sees must not. */
function unreachableProvider(secret: string): FakeProvider {
  const calls: ProbeCall[] = [];
  const fetchImpl: typeof fetch = (input) => {
    calls.push({ url: String(input), headers: {} });
    return Promise.reject(
      new Error(`getaddrinfo ENOTFOUND while sending ${secret}`),
    );
  };
  return { fetchImpl, calls };
}

/** A fetch that fails the test if anything calls it (the access-token path
 *  must not probe: there is no free endpoint that accepts one). */
function noProbeExpected(): typeof fetch {
  return () => {
    throw new Error("no provider probe should have been made");
  };
}

/** The server's own credential-shaped variables. `filteredSpawnEnv` strips
 *  every one of them, so a logout child that can see any of these was handed
 *  the server's environment instead of a filtered one. */
const SERVER_SECRET_ENV = [
  "VIBERR_SECRET_ENCRYPTION_KEY",
  "VIBERR_SESSION_SECRET",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
] as const;

/** Which of them the spawned logout could actually see. */
function secretsVisibleTo(env: Record<string, string>): string[] {
  return SERVER_SECRET_ENV.filter((key) => env[key]);
}

/** The box column, read raw — the ONE place a test may look at it. */
function storedBox(credentialId: string): string | null {
  const row = z
    .object({ secret_box: z.string().nullable() })
    .safeParse(
      db
        .prepare(`SELECT secret_box FROM user_backend_credentials WHERE id = ?`)
        .get(credentialId),
    );
  return row.success ? row.data.secret_box : null;
}

function thrownFrom<T>(run: () => T): AppError | null {
  try {
    run();
    return null;
  } catch (error) {
    return isAppError(error) ? error : null;
  }
}

async function thrownFromAsync<T>(
  run: () => Promise<T>,
): Promise<AppError | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return isAppError(error) ? error : null;
  }
}

/** Nothing a reader hands out may carry the secret or its box. */
function expectNoSecretInRow(row: BackendCredentialRow, secret: string): void {
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("secret_box");
  expect(Object.keys(row)).not.toContain("secretBox");
}

// ------------------------------------------------------------ paste a key

describe("setBackendApiKey", () => {
  it("verifies a Claude key against Anthropic's free models endpoint, then seals it", async () => {
    const provider = fakeProvider(200);
    const row = await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: provider.fetchImpl,
      dataRoot,
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    // The key rides a header, never the URL, and the version header is the one
    // Anthropic requires.
    expect(provider.calls[0]!.headers["x-api-key"]).toBe(CLAUDE_KEY);
    expect(provider.calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(provider.calls[0]!.url).not.toContain(CLAUDE_KEY);

    expect(row.kind).toBe("api_key");
    expect(row.method).toBeNull();
    expect(row.secretSuffix).toBe("abcd");
    expect(row.verifiedAt).not.toBeNull();
    expectNoSecretInRow(row, CLAUDE_KEY);

    // Sealed at rest, and openable — the run path depends on both.
    const box = storedBox(row.id);
    expect(box).not.toBeNull();
    expect(box).not.toContain(CLAUDE_KEY);
    expect(openSecret(box!)).toBe(CLAUDE_KEY);

    const audit = listAuditEvents(db, { action: "profile.backend.connected" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toEqual({
      backend: "claude",
      kind: "api_key",
      verified: true,
    });
    expect(JSON.stringify(audit[0])).not.toContain(CLAUDE_KEY);
  });

  it("verifies a Codex key against OpenAI with a bearer token", async () => {
    const provider = fakeProvider(200);
    const row = await setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
      fetchImpl: provider.fetchImpl,
      dataRoot,
    });
    expect(provider.calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(provider.calls[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(row.backend).toBe("codex");
    expect(row.verifiedAt).not.toBeNull();
  });

  it("refuses a key the vendor rejects, and stores nothing", async () => {
    const provider = fakeProvider(401);
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
        fetchImpl: provider.fetchImpl,
        dataRoot,
      }),
    );
    expect(error?.userMessage).toBe("Anthropic rejected the key (HTTP 401).");
    expect(error?.status).toBe(400);
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(listAuditEvents(db, { action: "profile.backend.connected" })).toEqual([]);
  });

  it("names the host it could not reach — and never the key it was sending", async () => {
    const provider = unreachableProvider(CLAUDE_KEY);
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
        fetchImpl: provider.fetchImpl,
        dataRoot,
      }),
    );
    expect(error?.userMessage).toContain("api.anthropic.com");
    expect(error?.userMessage).not.toContain(CLAUDE_KEY);
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
  });

  it("names the OpenAI host on a codex network failure", async () => {
    const provider = unreachableProvider(OPENAI_KEY);
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
        fetchImpl: provider.fetchImpl,
        dataRoot,
      }),
    );
    expect(error?.userMessage).toContain("api.openai.com");
    expect(error?.userMessage).not.toContain(OPENAI_KEY);
  });

  it("stores a ChatGPT workspace access token UNVERIFIED, with no probe at all", async () => {
    const row = await setBackendApiKey(
      db,
      actor,
      "codex",
      "access_token",
      CHATGPT_TOKEN,
      { fetchImpl: noProbeExpected(), dataRoot },
    );
    expect(row.kind).toBe("access_token");
    expect(row.verifiedAt).toBeNull();
    expect(row.detail).toEqual({ verification: "unverified" });
    expect(
      listAuditEvents(db, { action: "profile.backend.connected" })[0]!.details,
    ).toEqual({ backend: "codex", kind: "access_token", verified: false });
  });

  it("has no access-token path for Claude", async () => {
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "claude", "access_token", CHATGPT_TOKEN, {
        fetchImpl: noProbeExpected(),
        dataRoot,
      }),
    );
    expect(error?.userMessage).toContain("Claude has no workspace access token");
  });

  it.each([
    ["an empty value", "   "],
    ["a value with whitespace", "sk-ant-key with a space"],
    ["an implausibly long value", `sk-ant-${"x".repeat(600)}`],
    ["a key that is not an Anthropic one", "ghp_looks-like-github"],
  ])("refuses %s before it ever reaches the provider", async (_name, secret) => {
    const provider = fakeProvider(200);
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "claude", "api_key", secret, {
        fetchImpl: provider.fetchImpl,
        dataRoot,
      }),
    );
    expect(error).not.toBeNull();
    expect(provider.calls).toEqual([]);
  });

  it("REPLACES a sign-in: logs the vendor out, drops its credential file, keeps one row", async () => {
    const home = ensureUserBackendHome(actor.userId, "claude", dataRoot);
    writeFileSync(claudeLoginCredentialPath(home), '{"token":"vendor-owned"}');
    recordBackendLogin(db, actor, "claude", "claudeai", { authMethod: "claudeai" });

    const provider = fakeProvider(200);
    const row = await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: provider.fetchImpl,
      binary: vendors.binaries.claude,
      dataRoot,
    });

    const logout = fakeVendorLogout(home);
    expect(logout?.argv).toEqual(["auth", "logout"]);
    // Spawn hygiene: the logout child saw no credential-shaped variable of the
    // server's, only the home it was told to work in.
    expect(secretsVisibleTo(logout?.env ?? {})).toEqual([]);
    expect(logout?.env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(existsSync(claudeLoginCredentialPath(home))).toBe(false);

    expect(row.kind).toBe("api_key");
    expect(listBackendCredentials(db, actor.userId)).toHaveLength(1);
    const rows = db
      .prepare(`SELECT count(*) AS c FROM user_backend_credentials`)
      .get();
    expect(z.object({ c: z.number() }).parse(rows).c).toBe(1);
  });
});

// --------------------------------------------------------------- vendor login

describe("recordBackendLogin", () => {
  it("records a sign-in with no secret of any kind", () => {
    const row = recordBackendLogin(db, actor, "codex", "device", {
      status: "Logged in using ChatGPT",
    });
    expect(row.kind).toBe("login");
    expect(row.method).toBe("device");
    expect(row.secretSuffix).toBeNull();
    expect(row.detail).toEqual({ status: "Logged in using ChatGPT" });
    expect(row.verifiedAt).not.toBeNull();
    expect(storedBox(row.id)).toBeNull();

    const audit = listAuditEvents(db, { action: "profile.backend.connected" });
    expect(audit[0]!.details).toEqual({
      backend: "codex",
      kind: "login",
      method: "device",
    });
  });

  it("replaces a pasted key with the sign-in that supersedes it", async () => {
    await setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    recordBackendLogin(db, actor, "codex", "device", {});
    const rows = listBackendCredentials(db, actor.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("login");
    expect(rows[0]!.secretSuffix).toBeNull();
  });

  it("keeps each person's connection to itself", () => {
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    recordBackendLogin(db, actor, "claude", "console", {});
    expect(listBackendCredentials(db, murat.id)).toEqual([]);
    expect(getBackendCredential(db, murat.id, "claude")).toBeNull();
  });
});

// ---------------------------------------------------------------- disconnect

describe("disconnectBackend", () => {
  it("logs the vendor out, removes the credential file and keeps the transcripts", async () => {
    const home = ensureUserBackendHome(actor.userId, "codex", dataRoot);
    writeFileSync(codexLoginCredentialPath(home), '{"tokens":{"access":"x"}}');
    const transcript = path.join(home, "sessions", "2026", "09", "rollout.jsonl");
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"line":1}\n');
    recordBackendLogin(db, actor, "codex", "device", {});

    await disconnectBackend(db, actor, "codex", {
      binary: vendors.binaries.codex,
      dataRoot,
    });

    const logout = fakeVendorLogout(home);
    expect(logout?.argv).toEqual(["logout"]);
    // The child acts on the home this call named — never on an ambient one,
    // and never on the OTHER vendor's.
    expect(logout?.env.CODEX_HOME).toBe(home);
    expect(logout?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(existsSync(codexLoginCredentialPath(home))).toBe(false);
    // The run record is not a credential.
    expect(existsSync(transcript)).toBe(true);
    expect(getBackendCredential(db, actor.userId, "codex")).toBeNull();

    const audit = listAuditEvents(db, { action: "profile.backend.disconnected" });
    expect(audit[0]!.details).toEqual({ backend: "codex", kind: "login" });
  });

  it("disconnects even when the vendor logout fails or the file is already gone", async () => {
    const home = ensureUserBackendHome(actor.userId, "claude", dataRoot);
    recordBackendLogin(db, actor, "claude", "claudeai", {});
    setFakeVendorLogoutExit(7);
    await disconnectBackend(db, actor, "claude", {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    // The logout really did run and really did fail.
    expect(fakeVendorLogout(home)).not.toBeNull();
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(
      listAuditEvents(db, { action: "profile.backend.disconnected" }),
    ).toHaveLength(1);
  });

  it("runs no vendor process for a pasted key", async () => {
    await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    const home = ensureUserBackendHome(actor.userId, "claude", dataRoot);
    await disconnectBackend(db, actor, "claude", {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    expect(fakeVendorLogout(home)).toBeNull();
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(
      listAuditEvents(db, { action: "profile.backend.disconnected" })[0]!.details,
    ).toEqual({ backend: "claude", kind: "api_key" });
  });

  it("says so honestly when nothing is connected", async () => {
    const error = await thrownFromAsync(() =>
      disconnectBackend(db, actor, "claude", { dataRoot }),
    );
    expect(error?.userMessage).toBe("Claude isn't connected.");
    expect(listAuditEvents(db, { action: "profile.backend.disconnected" })).toEqual(
      [],
    );
  });
});

// -------------------------------------------------------------------- health

describe("userBackendHealth", () => {
  it("points an unconnected person at their own profile", () => {
    const health = userBackendHealth(db, actor.userId, "claude", { dataRoot });
    expect(health.available).toBe(false);
    expect(health.kind).toBeNull();
    expect(health.verification).toBe("none");
    expect(health.detail).toBe(
      "Claude isn't connected. Connect it on your Profile → Agent accounts.",
    );
  });

  it("counts a sealed key as available with no filesystem in play", async () => {
    const row = await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    const health = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "linux",
    });
    expect(health.available).toBe(true);
    expect(health.verification).toBe("credential");
    expect(health.kind).toBe("api_key");
    expect(health.secretSuffix).toBe("abcd");
    expect(health.connectedAt).toBe(row.createdAt);
    expect(health.detail).toBeNull();
  });

  it("requires the sign-in FILE for a login, and says what a wiped volume did", () => {
    recordBackendLogin(db, actor, "claude", "claudeai", { authMethod: "claudeai" });
    const missing = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "linux",
    });
    expect(missing.available).toBe(false);
    expect(missing.verification).toBe("none");
    expect(missing.method).toBe("claudeai");
    expect(missing.detail).toBe(
      "Your Claude sign-in file is missing from this server (the runtime volume was wiped). " +
        "Sign in again on your Profile → Agent accounts.",
    );

    const home = ensureUserBackendHome(actor.userId, "claude", dataRoot);
    writeFileSync(claudeLoginCredentialPath(home), "{}");
    // Re-probed on every call: no restart, no cache to clear.
    const healed = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "linux",
    });
    expect(healed.available).toBe(true);
    expect(healed.verification).toBe("file");
    expect(healed.detail).toBeNull();
  });

  it("honours a macOS Keychain login as presence — but only when the home exists", () => {
    recordBackendLogin(db, actor, "claude", "claudeai", {});
    const noHome = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "darwin",
    });
    expect(noHome.available).toBe(false);

    ensureUserBackendHome(actor.userId, "claude", dataRoot);
    const withHome = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "darwin",
    });
    expect(withHome.available).toBe(true);
    expect(withHome.verification).toBe("presence");
    expect(withHome.detail).toBeNull();
  });

  it("refuses to probe a home for an id that is not path-safe", () => {
    const odd = insertUser(db, {
      id: "u_arda/../etc",
      email: "odd@viberr.dev",
      name: "Odd",
      role: "member",
    });
    recordBackendLogin(db, { userId: odd.id, label: odd.email }, "codex", "device", {});
    expect(
      thrownFrom(() => userBackendHealth(db, odd.id, "codex", { dataRoot })),
    ).not.toBeNull();
  });

  it("isBackendAvailableFor is the same answer", async () => {
    expect(isBackendAvailableFor(db, actor.userId, "codex", { dataRoot })).toBe(false);
    await setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    expect(isBackendAvailableFor(db, actor.userId, "codex", { dataRoot })).toBe(true);
  });
});

describe("connected counts", () => {
  it("counts the people whose connection actually holds, per backend", async () => {
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    const selin = insertUser(db, {
      id: "u_selin",
      email: "selin@viberr.dev",
      name: "Selin Test",
      role: "member",
    });
    // Arda pasted a key; Murat signed in and the file is there; Selin signed in
    // and the volume was wiped.
    await setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    const muratHome = ensureUserBackendHome(murat.id, "codex", dataRoot);
    writeFileSync(codexLoginCredentialPath(muratHome), "{}");
    recordBackendLogin(db, { userId: murat.id, label: murat.email }, "codex", "device", {});
    recordBackendLogin(db, { userId: selin.id, label: selin.email }, "codex", "device", {});

    const env = { dataRoot, platform: "linux" } as const;
    expect(connectedUserIds(db, "codex", env)).toEqual(["u_arda", "u_murat"]);
    expect(countConnectedUsers(db, "codex", env)).toBe(2);
    expect(countConnectedUsers(db, "claude", env)).toBe(0);
  });
});

// ------------------------------------------------------------ run credential

describe("runCredentialFor", () => {
  it("hands a Claude run the person's home and key, and the sink the value to redact", async () => {
    await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    const cred = runCredentialFor(db, actor.userId, "claude", dataRoot);
    expect(cred.kind).toBe("api_key");
    expect(cred.homeDir).toBe(userBackendHome(actor.userId, "claude", dataRoot));
    expect(existsSync(cred.homeDir)).toBe(true);
    expect(cred.env).toEqual({
      CLAUDE_CONFIG_DIR: cred.homeDir,
      ANTHROPIC_API_KEY: CLAUDE_KEY,
    });
    expect(cred.secrets).toEqual([CLAUDE_KEY]);
  });

  it("gives a Codex key CODEX_API_KEY — and never an OPENAI_API_KEY", async () => {
    await setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
      dataRoot,
    });
    const cred = runCredentialFor(db, actor.userId, "codex", dataRoot);
    expect(cred.env).toEqual({
      CODEX_HOME: cred.homeDir,
      CODEX_API_KEY: OPENAI_KEY,
    });
    expect("OPENAI_API_KEY" in cred.env).toBe(false);
    // …and an ambient one cannot survive either: the base env every adapter
    // starts from strips every credential-shaped name.
    expect(CREDENTIAL_ENV_RE.test("OPENAI_API_KEY")).toBe(true);
    expect(cred.secrets).toEqual([OPENAI_KEY]);
  });

  it("gives a workspace token CODEX_ACCESS_TOKEN, with no API key beside it", async () => {
    await setBackendApiKey(db, actor, "codex", "access_token", CHATGPT_TOKEN, {
      fetchImpl: noProbeExpected(),
      dataRoot,
    });
    const cred = runCredentialFor(db, actor.userId, "codex", dataRoot);
    expect(cred.env).toEqual({
      CODEX_HOME: cred.homeDir,
      CODEX_ACCESS_TOKEN: CHATGPT_TOKEN,
    });
    expect("OPENAI_API_KEY" in cred.env).toBe(false);
    expect("CODEX_API_KEY" in cred.env).toBe(false);
    expect(cred.secrets).toEqual([CHATGPT_TOKEN]);
  });

  it("adds no secret for a sign-in: the binary reads its own file", () => {
    const home = ensureUserBackendHome(actor.userId, "claude", dataRoot);
    writeFileSync(claudeLoginCredentialPath(home), "{}");
    recordBackendLogin(db, actor, "claude", "claudeai", {});
    const cred = runCredentialFor(db, actor.userId, "claude", dataRoot);
    expect(cred.kind).toBe("login");
    expect(cred.env).toEqual({ CLAUDE_CONFIG_DIR: home });
    expect(cred.secrets).toEqual([]);
  });

  it("refuses with the person's own actionable sentence when nothing is connected", () => {
    const error = thrownFrom(() => runCredentialFor(db, actor.userId, "codex", dataRoot));
    expect(error?.code).toBe(ERROR_CODES.RUN_UNAVAILABLE);
    expect(error?.status).toBe(409);
    expect(error?.userMessage).toBe(
      "Codex isn't connected. Connect it on your Profile → Agent accounts.",
    );
  });

  it("refuses a sign-in whose file is gone, naming the wiped volume", () => {
    recordBackendLogin(db, actor, "codex", "device", {});
    const error = thrownFrom(() => runCredentialFor(db, actor.userId, "codex", dataRoot));
    expect(error?.code).toBe(ERROR_CODES.RUN_UNAVAILABLE);
    expect(error?.userMessage).toContain("sign-in file is missing");
  });
});

describe("no reader hands out a box", () => {
  it("keeps the sealed value out of every returned row", async () => {
    const created = await setBackendApiKey(
      db,
      actor,
      "claude",
      "api_key",
      CLAUDE_KEY,
      { fetchImpl: fakeProvider(200).fetchImpl, dataRoot },
    );
    const fetched = getBackendCredential(db, actor.userId, "claude");
    expect(fetched).not.toBeNull();
    expectNoSecretInRow(created, CLAUDE_KEY);
    expectNoSecretInRow(fetched!, CLAUDE_KEY);
    for (const row of listBackendCredentials(db, actor.userId)) {
      expectNoSecretInRow(row, CLAUDE_KEY);
    }
    // The health answer every surface renders is just as clean.
    const health = userBackendHealth(db, actor.userId, "claude", { dataRoot });
    expect(JSON.stringify(health)).not.toContain(CLAUDE_KEY);
  });
});
