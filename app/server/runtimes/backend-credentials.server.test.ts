import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  fakeVendorLogout,
  fakeVendorLogouts,
  resetFakeVendorEnv,
  setFakeVendorEvidenceDir,
  setFakeVendorLogoutExit,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../../test-support/fake-vendor-binary";
import { insertUser } from "~/server/auth/user-store.server";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { openSecret } from "~/server/secrets/secret-box.server";
import {
  MAX_ACCOUNTS_PER_BACKEND,
  backendAccountName,
  connectedUserIds,
  countConnectedUsers,
  disconnectBackendAccount,
  getBackendAccount,
  getBackendCredential,
  isBackendAvailableFor,
  listBackendAccounts,
  loginTargetFor,
  recordBackendLogin,
  renameBackendAccount,
  runCredentialFor,
  setBackendApiKey,
  switchBackendAccount,
  userBackendHealth,
  type BackendCredentialActor,
  type BackendCredentialRow,
  type LoginMethod,
} from "./backend-credentials.server";
import {
  latestBackendRateLimits,
  recordBackendCredentialRefusal,
  recordBackendQuotaExhaustion,
  type BackendCredentialRefusal,
  type BackendQuotaExhaustion,
} from "./backend-quota.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import {
  backendAccountHome,
  claudeLoginCredentialPath,
  codexLoginCredentialPath,
  ensureBackendAccountHome,
  ensureUserBackendHome,
  userBackendHome,
  vendorLoginCredentialPath,
} from "./user-homes.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Ruling 137: a person's own agent accounts. Every seam here is real — a
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
  vi.useRealTimers();
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

/** An account a test signed in, and the home its vendor file is in. */
interface SignedInAccount {
  row: BackendCredentialRow;
  home: string;
}

/**
 * What a confirmed hosted sign-in leaves (ruling 138): the account the driver
 * minted before the vendor ran, recorded as a `login` row, and — unless
 * `file` is false — the vendor's own sign-in file in that account's home,
 * where the binary wrote it. `file: false` keeps the home: that reads as a
 * wiped volume everywhere except a Claude home on macOS, which is a Keychain
 * sign-in, so a Claude test of the wiped volume removes the home as well.
 */
function signIn(
  backend: RealBackend,
  method: LoginMethod,
  detail: Record<string, string> = {},
  opts: { file?: boolean; who?: BackendCredentialActor } = {},
): SignedInAccount {
  const who = opts.who ?? actor;
  const target = loginTargetFor(db, who.userId, backend);
  const { home } = ensureBackendAccountHome(who.userId, backend, target, dataRoot);
  if (opts.file !== false) writeFileSync(vendorLoginCredentialPath(backend, home), "{}");
  const row = recordBackendLogin(db, who, backend, method, detail, target);
  return { row, home };
}

/** A pasted key the provider accepts, as a new account. */
function pasteKey(backend: RealBackend, secret = backend === "claude" ? CLAUDE_KEY : OPENAI_KEY) {
  return setBackendApiKey(db, actor, backend, "api_key", secret, {
    fetchImpl: fakeProvider(200).fetchImpl,
  });
}

// ------------------------------------------------------------ paste a key

describe("setBackendApiKey", () => {
  it("verifies a Claude key against Anthropic's free models endpoint, then seals it", async () => {
    const provider = fakeProvider(200);
    const row = await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: provider.fetchImpl,
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
      }),
    );
    expect(error?.userMessage).toBe("Anthropic rejected the key (HTTP 401).");
    expect(error?.status).toBe(400);
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(listAuditEvents(db, { action: "profile.backend.connected" })).toEqual([]);
  });

  it.each([
    ["claude", CLAUDE_KEY, "api.anthropic.com"],
    ["codex", OPENAI_KEY, "api.openai.com"],
  ] as const)("names the %s host it could not reach — and never the key it was sending", async (backend, secret, host) => {
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, backend, "api_key", secret, {
        fetchImpl: unreachableProvider(secret).fetchImpl,
      }),
    );
    expect(error?.userMessage).toContain(host);
    expect(error?.userMessage).not.toContain(secret);
    expect(getBackendCredential(db, actor.userId, backend)).toBeNull();
  });

  it("stores a ChatGPT workspace access token UNVERIFIED, with no probe at all", async () => {
    const row = await setBackendApiKey(
      db,
      actor,
      "codex",
      "access_token",
      CHATGPT_TOKEN,
      { fetchImpl: noProbeExpected() },
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
      }),
    );
    expect(error).not.toBeNull();
    expect(provider.calls).toEqual([]);
  });


  it("ADDS an account beside a sign-in (ruling 138): nothing is logged out, and the key is the one in use", async () => {
    const signedIn = signIn("claude", "claudeai", { email: "work@example.com" });

    const row = await setBackendApiKey(db, actor, "claude", "api_key", CLAUDE_KEY, {
      fetchImpl: fakeProvider(200).fetchImpl,
    });

    // The sign-in stays exactly as it was: no vendor logout, its file in its
    // own home, its row beside the new one.
    expect(fakeVendorLogout(signedIn.home)).toBeNull();
    expect(existsSync(claudeLoginCredentialPath(signedIn.home))).toBe(true);
    expect(listBackendAccounts(db, actor.userId, "claude").map((account) => account.id)).toEqual([
      row.id,
      signedIn.row.id,
    ]);
    // The newest connection is the one runs bill.
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(row.id);
  });

  it("refuses an account past the ceiling before the provider is asked anything", async () => {
    for (let i = 0; i < MAX_ACCOUNTS_PER_BACKEND; i += 1) {
      await pasteKey("codex", `sk-proj-viberr-test-key-${String(i).padStart(4, "0")}`);
    }
    const provider = fakeProvider(200);
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
        fetchImpl: provider.fetchImpl,
      }),
    );
    expect(error?.userMessage).toBe(
      `You already have ${MAX_ACCOUNTS_PER_BACKEND} Codex accounts connected. Disconnect one before adding another.`,
    );
    expect(provider.calls).toEqual([]);
    expect(listBackendAccounts(db, actor.userId, "codex")).toHaveLength(MAX_ACCOUNTS_PER_BACKEND);
    // The sign-in path is refused by the same rule, before any process.
    expect(thrownFrom(() => loginTargetFor(db, actor.userId, "codex"))?.userMessage).toBe(
      error?.userMessage,
    );
    // The other backend has its own ceiling.
    expect(() => loginTargetFor(db, actor.userId, "claude")).not.toThrow();
  });

  it("holds the ceiling when another connect lands while the provider is answering", async () => {
    for (let i = 0; i < MAX_ACCOUNTS_PER_BACKEND - 1; i += 1) {
      await pasteKey("codex", `sk-proj-viberr-test-key-${String(i).padStart(4, "0")}`);
    }
    // The last free slot is taken by a second paste that lands while this
    // one's probe is in flight: the check before the probe passed, so only the
    // one after it can refuse.
    const racing: typeof fetch = async (input, init) => {
      await pasteKey("codex", "sk-proj-viberr-test-key-race");
      return fakeProvider(200).fetchImpl(input, init);
    };
    const error = await thrownFromAsync(() =>
      setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, { fetchImpl: racing }),
    );
    expect(error?.userMessage).toBe(
      `You already have ${MAX_ACCOUNTS_PER_BACKEND} Codex accounts connected. Disconnect one before adding another.`,
    );
    expect(listBackendAccounts(db, actor.userId, "codex")).toHaveLength(MAX_ACCOUNTS_PER_BACKEND);
  });
});

// --------------------------------------------------------------- vendor login

describe("recordBackendLogin", () => {
  it("records a sign-in with no secret of any kind", () => {
    const { row } = signIn("codex", "device", { status: "Logged in using ChatGPT" });
    expect(row.kind).toBe("login");
    expect(row.method).toBe("device");
    expect(row.secretSuffix).toBeNull();
    expect(row.detail).toEqual({ status: "Logged in using ChatGPT" });
    expect(row.verifiedAt).not.toBeNull();
    expect(row.legacyHome).toBe(false);
    expect(storedBox(row.id)).toBeNull();

    const audit = listAuditEvents(db, { action: "profile.backend.connected" });
    expect(audit[0]!.details).toEqual({
      backend: "codex",
      kind: "login",
      method: "device",
      signedInAgain: false,
    });
  });

  it("adds a sign-in beside a pasted key (ruling 138), and the sign-in is the one in use", async () => {
    const key = await pasteKey("codex");
    const { row } = signIn("codex", "device");
    const rows = listBackendAccounts(db, actor.userId, "codex");
    expect(rows.map((account) => account.id)).toEqual([row.id, key.id]);
    expect(rows[0]!.kind).toBe("login");
    expect(rows[1]!.secretSuffix).toBe("wxyz");
  });

  it("signs an existing account in again in its own home, keeping its id and its name", () => {
    const first = signIn("claude", "claudeai", { email: "work@example.com" });
    renameBackendAccount(db, actor, first.row.id, "Work");
    const second = signIn("claude", "claudeai", { email: "personal@example.com" });
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(second.row.id);

    const again = loginTargetFor(db, actor.userId, "claude", first.row.id);
    expect(again).toEqual({ id: first.row.id, legacyHome: false, existing: true });
    const row = recordBackendLogin(db, actor, "claude", "console", { email: "work@example.com" }, again);

    expect(row.id).toBe(first.row.id);
    expect(row.method).toBe("console");
    expect(row.label).toBe("Work");
    expect(listBackendAccounts(db, actor.userId, "claude")).toHaveLength(2);
    // Signing an account in again makes it the one in use.
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(first.row.id);
    expect(
      listAuditEvents(db, { action: "profile.backend.connected" }).map((event) => event.details),
    ).toContainEqual({ backend: "claude", kind: "login", method: "console", signedInAgain: true });
  });

  it("refuses to sign in again into anything but the person's own sign-in on that backend", async () => {
    const key = await pasteKey("claude");
    expect(thrownFrom(() => loginTargetFor(db, actor.userId, "claude", key.id))?.userMessage).toBe(
      "That Claude account is a pasted API key, not a sign-in. Add a new account to sign in.",
    );
    const codex = signIn("codex", "device");
    expect(
      thrownFrom(() => loginTargetFor(db, actor.userId, "claude", codex.row.id))?.userMessage,
    ).toBe("That Claude account isn't connected any more.");
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    expect(thrownFrom(() => loginTargetFor(db, murat.id, "codex", codex.row.id))?.userMessage).toBe(
      "That Codex account isn't connected any more.",
    );
  });

  it("keeps each person's connection to itself", () => {
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    signIn("claude", "console");
    expect(listBackendAccounts(db, murat.id, "claude")).toEqual([]);
    expect(getBackendCredential(db, murat.id, "claude")).toBeNull();
  });
});

// ------------------------------------------------ several accounts (507)

describe("switching accounts (ruling 138)", () => {
  it("makes another account the one runs bill, with no vendor process and no file moved", () => {
    // Both sign-ins and the switch land in one millisecond: the account
    // selected last wins on its stamp, never on the order of the random ids.
    vi.useFakeTimers({ toFake: ["Date"] });
    const work = signIn("claude", "claudeai", { email: "work@example.com" });
    const personal = signIn("claude", "claudeai", { email: "personal@example.com" });
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(personal.row.id);
    expect(runCredentialFor(db, actor.userId, "claude", dataRoot).env.CLAUDE_CONFIG_DIR).toBe(
      personal.home,
    );

    const switched = switchBackendAccount(db, actor, work.row.id, { dataRoot, platform: "linux" });

    expect(switched.id).toBe(work.row.id);
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(work.row.id);
    // The next run is pointed at the other account's own home; both sign-ins
    // are where their vendor wrote them, and nothing was logged out.
    const cred = runCredentialFor(db, actor.userId, "claude", dataRoot);
    expect(cred.env.CLAUDE_CONFIG_DIR).toBe(work.home);
    expect(cred.accountId).toBe(work.row.id);
    expect(existsSync(claudeLoginCredentialPath(work.home))).toBe(true);
    expect(existsSync(claudeLoginCredentialPath(personal.home))).toBe(true);
    expect(fakeVendorLogout(work.home)).toBeNull();
    expect(fakeVendorLogout(personal.home)).toBeNull();
    expect(listBackendAccounts(db, actor.userId, "claude").map((a) => a.id)).toEqual([
      work.row.id,
      personal.row.id,
    ]);

    const audit = listAuditEvents(db, { action: "profile.backend.switched" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subjectId).toBe(work.row.id);
    expect(audit[0]!.details).toEqual({ backend: "claude", kind: "login", from: personal.row.id });

    // And back again, just as cheaply.
    switchBackendAccount(db, actor, personal.row.id, { dataRoot, platform: "linux" });
    expect(runCredentialFor(db, actor.userId, "claude", dataRoot).env.CLAUDE_CONFIG_DIR).toBe(
      personal.home,
    );
  });

  it("switches between a sign-in and a pasted key on Codex", async () => {
    const chatgpt = signIn("codex", "device");
    const key = await pasteKey("codex");
    expect(runCredentialFor(db, actor.userId, "codex", dataRoot).env.CODEX_API_KEY).toBe(OPENAI_KEY);

    switchBackendAccount(db, actor, chatgpt.row.id, { dataRoot, platform: "linux" });
    const cred = runCredentialFor(db, actor.userId, "codex", dataRoot);
    // A Codex run keeps the SHARED home (its adapter forks a private one from
    // it) and learns the account's own home for the sign-in it copies in.
    expect(cred.env).toEqual({ CODEX_HOME: userBackendHome(actor.userId, "codex", dataRoot) });
    expect(cred.accountHome).toBe(chatgpt.home);
    expect(cred.secrets).toEqual([]);
    expect(key.id).not.toBe(chatgpt.row.id);
  });

  it("refuses the account already in use, one whose sign-in is gone, and another person's", async () => {
    const gone = signIn("claude", "claudeai", { email: "wiped@example.com" }, { file: false });
    const key = await pasteKey("claude");

    expect(thrownFrom(() => switchBackendAccount(db, actor, key.id))?.userMessage).toBe(
      "API key ending in abcd is already the Claude account in use.",
    );
    expect(
      thrownFrom(() => switchBackendAccount(db, actor, gone.row.id, { dataRoot, platform: "linux" }))
        ?.userMessage,
    ).toContain("wiped@example.com can't be used yet: Your Claude sign-in file is missing");

    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    expect(
      thrownFrom(() => switchBackendAccount(db, { userId: murat.id, label: murat.email }, key.id))
        ?.userMessage,
    ).toBe("That account isn't connected any more.");
    // Nothing moved.
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(key.id);
    expect(listAuditEvents(db, { action: "profile.backend.switched" })).toEqual([]);
  });
});

describe("naming accounts (ruling 138)", () => {
  it("names an account, clears the name, and refuses one too long to be a name", async () => {
    const key = await pasteKey("claude");
    expect(backendAccountName(key)).toBe("API key ending in abcd");

    const named = renameBackendAccount(db, actor, key.id, "  Work   laptop ");
    expect(named.label).toBe("Work laptop");
    expect(backendAccountName(named)).toBe("Work laptop");
    expect(
      listAuditEvents(db, { action: "profile.backend.renamed" })[0]!.details,
    ).toEqual({ backend: "claude", named: true });

    const cleared = renameBackendAccount(db, actor, key.id, "   ");
    expect(cleared.label).toBeNull();
    expect(backendAccountName(cleared)).toBe("API key ending in abcd");

    expect(thrownFrom(() => renameBackendAccount(db, actor, key.id, "x".repeat(61)))?.userMessage).toBe(
      "An account name can be at most 60 characters.",
    );
    // A name decides nothing about which account runs bill.
    expect(getBackendCredential(db, actor.userId, "claude")?.id).toBe(key.id);
  });

  it("names an unnamed account by what the vendor reported, else by its kind", () => {
    expect(backendAccountName(signIn("claude", "claudeai", { email: "a@example.com" }).row)).toBe(
      "a@example.com",
    );
    expect(backendAccountName(signIn("claude", "console").row)).toBe("Console sign-in");
    expect(backendAccountName(signIn("codex", "device").row)).toBe("ChatGPT sign-in");
  });
});

// ---------------------------------------------------------------- disconnect

describe("disconnectBackendAccount", () => {
  it("logs the vendor out in the account's own home, removes that home, and keeps the transcripts", async () => {
    const { row, home } = signIn("codex", "device");
    const shared = userBackendHome(actor.userId, "codex", dataRoot);
    const transcript = path.join(shared, "sessions", "2026", "09", "rollout.jsonl");
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"line":1}\n');

    const evidence = ctx.makeTempDir();
    setFakeVendorEvidenceDir(evidence);
    const result = await disconnectBackendAccount(db, actor, row.id, {
      binary: vendors.binaries.codex,
      dataRoot,
    });

    expect(result).toMatchObject({ wasActive: true, active: null });
    expect(result.removed.id).toBe(row.id);
    // The vendor's own logout ran, in THIS account's home, before it went.
    const logouts = fakeVendorLogouts(evidence);
    expect(logouts.map((logout) => logout.argv)).toEqual([["logout"]]);
    expect(logouts[0]!.env.CODEX_HOME).toBe(home);
    // The account's whole home is gone — its sign-in with it — and nothing
    // else of the person's.
    expect(existsSync(home)).toBe(false);
    expect(existsSync(transcript)).toBe(true);
    expect(getBackendCredential(db, actor.userId, "codex")).toBeNull();

    const audit = listAuditEvents(db, { action: "profile.backend.disconnected" });
    expect(audit[0]!.details).toEqual({ backend: "codex", kind: "login", wasActive: true });
  });

  it("runs the vendor's own logout in that account's home, with nothing of the server's", async () => {
    const other = signIn("claude", "claudeai", { email: "stays@example.com" });
    const { row, home } = signIn("claude", "claudeai", { email: "goes@example.com" });
    const evidence = ctx.makeTempDir();
    setFakeVendorEvidenceDir(evidence);
    await disconnectBackendAccount(db, actor, row.id, {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    const logouts = fakeVendorLogouts(evidence);
    expect(logouts).toHaveLength(1);
    const logout = logouts[0]!;
    expect(logout.argv).toEqual(["auth", "logout"]);
    // Spawn hygiene: the logout child saw no credential-shaped variable of the
    // server's, only the ACCOUNT home it was told to work in — never the
    // backend home, never the person's other account.
    expect(secretsVisibleTo(logout.env)).toEqual([]);
    expect(logout.env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(logout.env.CODEX_HOME).toBeUndefined();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(claudeLoginCredentialPath(other.home))).toBe(true);
  });

  it("disconnects even when the vendor logout fails or the file is already gone", async () => {
    const { row } = signIn("claude", "claudeai", {}, { file: false });
    setFakeVendorLogoutExit(7);
    await disconnectBackendAccount(db, actor, row.id, {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(
      listAuditEvents(db, { action: "profile.backend.disconnected" }),
    ).toHaveLength(1);
  });

  it("runs no vendor process for a pasted key", async () => {
    const key = await pasteKey("claude");
    const { home } = ensureBackendAccountHome(actor.userId, "claude", key, dataRoot);
    await disconnectBackendAccount(db, actor, key.id, {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    expect(fakeVendorLogout(home)).toBeNull();
    expect(getBackendCredential(db, actor.userId, "claude")).toBeNull();
    expect(
      listAuditEvents(db, { action: "profile.backend.disconnected" })[0]!.details,
    ).toEqual({ backend: "claude", kind: "api_key", wasActive: true });
  });

  it("hands runs back to the account used before, and leaves the others alone (ruling 138)", async () => {
    const work = signIn("claude", "claudeai", { email: "work@example.com" });
    const key = await pasteKey("claude");
    const personal = signIn("claude", "claudeai", { email: "personal@example.com" });
    switchBackendAccount(db, actor, work.row.id, { dataRoot, platform: "linux" });
    // In use: work. Before it: personal, then the key.

    const inactive = await disconnectBackendAccount(db, actor, key.id, { dataRoot });
    expect(inactive.wasActive).toBe(false);
    expect(inactive.active?.id).toBe(work.row.id);

    const active = await disconnectBackendAccount(db, actor, work.row.id, {
      binary: vendors.binaries.claude,
      dataRoot,
    });
    expect(active.wasActive).toBe(true);
    expect(active.active?.id).toBe(personal.row.id);
    expect(runCredentialFor(db, actor.userId, "claude", dataRoot).env.CLAUDE_CONFIG_DIR).toBe(
      personal.home,
    );
    // The account that stays keeps its sign-in.
    expect(existsSync(claudeLoginCredentialPath(personal.home))).toBe(true);
  });

  it("says so honestly when the account is not the person's, or already gone", async () => {
    const error = await thrownFromAsync(() =>
      disconnectBackendAccount(db, actor, "ubc_nothing00000", { dataRoot }),
    );
    expect(error?.userMessage).toBe("That account isn't connected any more.");
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    const key = await pasteKey("codex");
    const other = await thrownFromAsync(() =>
      disconnectBackendAccount(db, { userId: murat.id, label: murat.email }, key.id, { dataRoot }),
    );
    expect(other?.userMessage).toBe("That account isn't connected any more.");
    expect(getBackendCredential(db, actor.userId, "codex")?.id).toBe(key.id);
    expect(listAuditEvents(db, { action: "profile.backend.disconnected" })).toEqual([]);
  });
});

// ------------------------------------------- an account from before 507

describe("an account connected before ruling 138 (legacy_home)", () => {
  /** The row the boot rebuild carries forward: its sign-in sits in the
   *  backend home itself, where the one-account build had the vendor write. */
  function legacySignIn(backend: RealBackend): SignedInAccount {
    const home = ensureUserBackendHome(actor.userId, backend, dataRoot);
    writeFileSync(vendorLoginCredentialPath(backend, home), "{}");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_backend_credentials
         (id, user_id, backend, kind, method, detail_json, verified_at, selected_at,
          legacy_home, created_at, updated_at)
       VALUES (?, ?, ?, 'login', ?, '{}', ?, ?, 1, ?, ?)`,
    ).run(`ubc_legacy_${backend}`, actor.userId, backend, backend === "claude" ? "claudeai" : "device", now, now, now, now);
    return { row: getBackendAccount(db, actor.userId, `ubc_legacy_${backend}`)!, home };
  }

  it("keeps reading its sign-in from the backend home, and runs there", () => {
    const { row, home } = legacySignIn("claude");
    expect(row.legacyHome).toBe(true);
    expect(backendAccountHome(actor.userId, "claude", row, dataRoot)).toBe(home);
    expect(userBackendHealth(db, actor.userId, "claude", { dataRoot, platform: "linux" }).available).toBe(true);
    expect(runCredentialFor(db, actor.userId, "claude", dataRoot).env.CLAUDE_CONFIG_DIR).toBe(home);
  });

  it("sits beside a new account, and a disconnect removes its file but never the backend home", async () => {
    const legacy = legacySignIn("codex");
    const added = signIn("codex", "device");
    expect(listBackendAccounts(db, actor.userId, "codex").map((a) => a.id)).toEqual([
      added.row.id,
      legacy.row.id,
    ]);
    switchBackendAccount(db, actor, legacy.row.id, { dataRoot, platform: "linux" });
    expect(runCredentialFor(db, actor.userId, "codex", dataRoot).accountHome).toBe(legacy.home);

    await disconnectBackendAccount(db, actor, legacy.row.id, { dataRoot });
    expect(existsSync(codexLoginCredentialPath(legacy.home))).toBe(false);
    // The backend home holds the other account and the transcripts.
    expect(existsSync(legacy.home)).toBe(true);
    expect(existsSync(codexLoginCredentialPath(added.home))).toBe(true);
    expect(getBackendCredential(db, actor.userId, "codex")?.id).toBe(added.row.id);
  });
});

// -------------------------------------------------------------------- health

describe("userBackendHealth", () => {
  it("points an unconnected person at their own profile", () => {
    const health = userBackendHealth(db, actor.userId, "claude", { dataRoot });
    expect(health.available).toBe(false);
    expect(health.kind).toBeNull();
    expect(health.verification).toBe("none");
    expect(health.accountId).toBeNull();
    expect(health.detail).toBe(
      "Claude isn't connected. Connect it on your Profile → Agent accounts.",
    );
  });

  it("counts a sealed key as available with no filesystem in play", async () => {
    const row = await pasteKey("claude");
    const health = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "linux",
    });
    expect(health.available).toBe(true);
    expect(health.verification).toBe("credential");
    expect(health.kind).toBe("api_key");
    expect(health.secretSuffix).toBe("abcd");
    expect(health.connectedAt).toBe(row.createdAt);
    expect(health.accountId).toBe(row.id);
    expect(health.accountName).toBe("API key ending in abcd");
    expect(health.detail).toBeNull();
  });

  it("requires the sign-in FILE for a login, in the account's own home, and says what a wiped volume did", () => {
    const { home } = signIn("claude", "claudeai", { authMethod: "claudeai" }, { file: false });
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

    // A file in the BACKEND home is not this account's: it counts for nothing.
    writeFileSync(claudeLoginCredentialPath(userBackendHome(actor.userId, "claude", dataRoot)), "{}");
    expect(userBackendHealth(db, actor.userId, "claude", { dataRoot, platform: "linux" }).available).toBe(false);

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

  it("says a working account is one switch away when the one in use cannot run (ruling 138)", async () => {
    await pasteKey("claude");
    const wiped = signIn("claude", "claudeai", { email: "wiped@example.com" }, { file: false });
    // A wiped volume takes the account's home with it, so no platform can
    // count the sign-in as present (macOS honours a home without the file).
    rmSync(wiped.home, { recursive: true, force: true });
    const health = userBackendHealth(db, actor.userId, "claude", { dataRoot, platform: "linux" });
    expect(health.available).toBe(false);
    expect(health.detail).toBe(
      "Your Claude sign-in file is missing from this server (the runtime volume was wiped). " +
        "Sign in again on your Profile → Agent accounts. " +
        "Another of your Claude accounts is connected there: switching to it needs no sign-in.",
    );
    // No fallback: a run still bills the account in use, or nothing.
    expect(thrownFrom(() => runCredentialFor(db, actor.userId, "claude", dataRoot))?.userMessage).toBe(
      health.detail,
    );
  });

  it("honours a macOS Keychain login as presence — only Claude's, and only when its home exists", () => {
    const target = loginTargetFor(db, actor.userId, "claude");
    recordBackendLogin(db, actor, "claude", "claudeai", {}, target);
    const noHome = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "darwin",
    });
    expect(noHome.available).toBe(false);

    ensureBackendAccountHome(actor.userId, "claude", target, dataRoot);
    const withHome = userBackendHealth(db, actor.userId, "claude", {
      dataRoot,
      platform: "darwin",
    });
    expect(withHome.available).toBe(true);
    expect(withHome.verification).toBe("presence");
    expect(withHome.detail).toBeNull();

    // Codex signs in to its auth.json alone, and a run copies only that file:
    // its home without the file is no sign-in, on macOS too.
    signIn("codex", "device", {}, { file: false });
    const codex = userBackendHealth(db, actor.userId, "codex", { dataRoot, platform: "darwin" });
    expect(codex.available).toBe(false);
    expect(codex.verification).toBe("none");
  });

  it("refuses to probe a home for an id that is not path-safe", () => {
    const odd = insertUser(db, {
      id: "u_arda/../etc",
      email: "odd@viberr.dev",
      name: "Odd",
      role: "member",
    });
    recordBackendLogin(
      db,
      { userId: odd.id, label: odd.email },
      "codex",
      "device",
      {},
      { id: "ubc_odd", legacyHome: false, existing: false },
    );
    expect(
      thrownFrom(() => userBackendHealth(db, odd.id, "codex", { dataRoot })),
    ).not.toBeNull();
  });

  it("isBackendAvailableFor is the same answer", async () => {
    expect(isBackendAvailableFor(db, actor.userId, "codex", { dataRoot })).toBe(false);
    await pasteKey("codex");
    expect(isBackendAvailableFor(db, actor.userId, "codex", { dataRoot })).toBe(true);
  });
});

describe("connected counts", () => {
  it("counts the people whose connection actually holds, per backend, once each", async () => {
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
    // Arda pasted two keys; Murat signed in and the file is there; Selin signed
    // in and the volume was wiped.
    await pasteKey("codex");
    await pasteKey("codex", "sk-proj-viberr-test-key-second");
    signIn("codex", "device", {}, { who: { userId: murat.id, label: murat.email } });
    signIn("codex", "device", {}, { who: { userId: selin.id, label: selin.email }, file: false });

    const env = { dataRoot, platform: "linux" } as const;
    expect(connectedUserIds(db, "codex", env)).toEqual(["u_arda", "u_murat"]);
    expect(countConnectedUsers(db, "codex", env)).toBe(2);
    expect(countConnectedUsers(db, "claude", env)).toBe(0);
  });
});

// ------------------------------------------------------------ run credential

describe("runCredentialFor", () => {
  it("hands a Claude run its account's own home and key, and the sink the value to redact", async () => {
    const row = await pasteKey("claude");
    const cred = runCredentialFor(db, actor.userId, "claude", dataRoot);
    expect(cred.kind).toBe("api_key");
    expect(cred.homeDir).toBe(userBackendHome(actor.userId, "claude", dataRoot));
    expect(cred.accountId).toBe(row.id);
    expect(cred.accountHome).toBe(backendAccountHome(actor.userId, "claude", row, dataRoot));
    expect(existsSync(cred.accountHome)).toBe(true);
    expect(cred.env).toEqual({
      CLAUDE_CONFIG_DIR: cred.accountHome,
      ANTHROPIC_API_KEY: CLAUDE_KEY,
    });
    expect(cred.secrets).toEqual([CLAUDE_KEY]);
    // The launch hands the account's home, and the shared transcripts it
    // links to, to the person's agent user (ruling 139).
    expect(cred.ownDirs).toEqual([
      cred.accountHome,
      path.join(cred.homeDir, "projects"),
    ]);
  });

  it("gives a Codex key CODEX_API_KEY — and never an OPENAI_API_KEY", async () => {
    await pasteKey("codex");
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

  it("adds no secret for a sign-in: the binary reads its own file, in its own home", () => {
    const { home } = signIn("claude", "claudeai");
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
    signIn("codex", "device", {}, { file: false });
    const error = thrownFrom(() => runCredentialFor(db, actor.userId, "codex", dataRoot));
    expect(error?.code).toBe(ERROR_CODES.RUN_UNAVAILABLE);
    expect(error?.userMessage).toContain("sign-in file is missing");
  });
});

describe("no reader hands out a box", () => {
  it("keeps the sealed value out of every returned row", async () => {
    const created = await pasteKey("claude");
    const fetched = getBackendCredential(db, actor.userId, "claude");
    expect(fetched).not.toBeNull();
    expectNoSecretInRow(created, CLAUDE_KEY);
    expectNoSecretInRow(fetched!, CLAUDE_KEY);
    for (const row of listBackendAccounts(db, actor.userId, "claude")) {
      expectNoSecretInRow(row, CLAUDE_KEY);
    }
    // The health answer every surface renders is just as clean.
    const health = userBackendHealth(db, actor.userId, "claude", { dataRoot });
    expect(JSON.stringify(health)).not.toContain(CLAUDE_KEY);
  });
});

// ------------------------------------------- refusals on the previous account

/**
 * Ruling 160(b): a credential change retires the refusal Viberr observed on the
 * credential it replaces. Live (2026-09-07) the Claude card kept "usage window
 * spent · reopens 21:30" after its owner signed the backend into another
 * account: the runs went through and the notice contradicted them, because a
 * completed run was the record's only retirement short of the instant the OLD
 * account had named. Ruling 160 keeps the rule for every change of the account
 * that bills the next run — a connect, a switch, the active account's removal —
 * and not for a change that leaves it alone. Driven through the real writers,
 * so what is asserted is the seam each of them shares, not the store function
 * alone.
 *
 * Canaries: drop `activeAccountChanged` from `setBackendApiKey`,
 * `recordBackendLogin`, `switchBackendAccount` or `disconnectBackendAccount`
 * and the matching case fails.
 */
describe("a change of the account in use retires the refusal observed on the previous one (ruling 160(b))", () => {
  function spentWindow(userId: string, label = "Arda Test"): BackendQuotaExhaustion {
    return {
      credentialUserId: userId,
      credentialLabel: label,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      resetsAtPrecision: "exact",
      providerText: "Claude AI usage limit reached|1780000000",
      runId: "run_spent",
      observedAt: new Date().toISOString(),
    };
  }
  function rejected(userId: string | null): BackendCredentialRefusal {
    return {
      credentialUserId: userId,
      credentialLabel: userId ? "Arda Test" : null,
      providerText:
        "The account's organization does not allow Claude Code (oauth_org_not_allowed).",
      runId: "run_refused",
      observedAt: new Date().toISOString(),
    };
  }
  function observed(backend: "claude" | "codex") {
    return latestBackendRateLimits(db).find((row) => row.backend === backend)!;
  }

  it("a confirmed sign-in retires both records on that backend, and that backend only", () => {
    recordBackendQuotaExhaustion(db, "claude", spentWindow(actor.userId));
    recordBackendCredentialRefusal(db, "claude", rejected(actor.userId));
    recordBackendQuotaExhaustion(db, "codex", spentWindow(actor.userId));

    signIn("claude", "claudeai", { email: "other@example.com" });

    expect(observed("claude")).toMatchObject({ exhausted: null, credentialRefused: null });
    expect(observed("codex").exhausted).not.toBeNull();
  });

  it("a pasted key the vendor accepts retires them; one it rejects leaves them standing", async () => {
    recordBackendQuotaExhaustion(db, "codex", spentWindow(actor.userId));
    recordBackendCredentialRefusal(db, "codex", rejected(actor.userId));

    await expect(
      setBackendApiKey(db, actor, "codex", "api_key", OPENAI_KEY, {
        fetchImpl: fakeProvider(401).fetchImpl,
      }),
    ).rejects.toThrow();
    // A key the vendor refused connected nothing, so the old account's
    // verdict still stands.
    expect(observed("codex").exhausted).not.toBeNull();
    expect(observed("codex").credentialRefused).not.toBeNull();

    await pasteKey("codex");
    expect(observed("codex")).toMatchObject({ exhausted: null, credentialRefused: null });
  });

  it("switching to another account retires them: the spent window was the other account's (ruling 160)", async () => {
    const spare = await pasteKey("claude");
    signIn("claude", "claudeai");
    recordBackendQuotaExhaustion(db, "claude", spentWindow(actor.userId));

    switchBackendAccount(db, actor, spare.id, { dataRoot, platform: "linux" });

    expect(observed("claude").exhausted).toBeNull();
  });

  it("disconnecting the account in use retires them; disconnecting another one does not", async () => {
    const spare = await pasteKey("codex", "sk-proj-viberr-test-key-spare");
    const inUse = signIn("codex", "device");
    recordBackendQuotaExhaustion(db, "codex", spentWindow(actor.userId));

    await disconnectBackendAccount(db, actor, spare.id, { dataRoot });
    expect(observed("codex").exhausted).not.toBeNull();

    await disconnectBackendAccount(db, actor, inUse.row.id, {
      binary: vendors.binaries.codex,
      dataRoot,
    });
    expect(observed("codex").exhausted).toBeNull();
    expect(getBackendCredential(db, actor.userId, "codex")).toBeNull();
  });

  it("ruling 160: another person's record, and one naming nobody, survive this person's change", () => {
    const murat = insertUser(db, {
      id: "u_murat",
      email: "murat@viberr.dev",
      name: "Murat Test",
      role: "member",
    });
    recordBackendQuotaExhaustion(db, "claude", spentWindow(murat.id, "Murat Test"));
    recordBackendCredentialRefusal(db, "claude", rejected(null));

    signIn("claude", "console");

    expect(observed("claude").exhausted?.credentialUserId).toBe(murat.id);
    expect(observed("claude").credentialRefused).not.toBeNull();
    expect(observed("claude").credentialRefused?.credentialUserId).toBeNull();
  });
});
