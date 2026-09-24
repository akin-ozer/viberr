import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resetAgentIsolationForTests } from "./agent-isolation.server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
import {
  ANSI_ESCAPE,
  FAKE_CLAUDE_URL,
  FAKE_CODEX_URL,
  FAKE_DEVICE_CODE,
  fakeVendorArgv,
  fakeVendorEnv,
  fakeVendorStdin,
  fakeVendorTerminated,
  resetFakeVendorEnv,
  setFakeVendorLoggedOut,
  setFakeVendorMode,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../../test-support/fake-vendor-binary";
import { listAuditEvents } from "../../../test-support/audit-log";
import { isAppError, type AppError } from "~/server/errors/app-error.server";
import { getBackendCredential } from "./backend-credentials.server";
import {
  cancelBackendLogin,
  getBackendLogin,
  resetBackendLoginsForTests,
  resolveBackendBinary,
  startBackendLogin,
  submitBackendLoginCode,
  type BinaryTarget,
  type LoginSessionView,
  type LoginState,
} from "./backend-login.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import { userBackendHome } from "./user-homes.server";

/**
 * The hosted sign-in driver (ruling 127, spec §3.4), driven against REAL child
 * processes.
 *
 * Every test here spawns an actual executable (`test-support/fake-vendor-binary`
 * writes one per vendor into a temp dir) that prints the vendors' exact lines
 * with ANSI colour, waits on stdin for Anthropic's code or sleeps and exits for
 * OpenAI's device flow, writes the credential file into the env-provided home,
 * and answers `auth status` / `login status`. Nothing is stubbed: what is under
 * test is a process contract (argv, env, stdio, exit codes, timers), and a
 * module mock would assert none of it.
 */

const ctx = createTestDbContext();

let db: DatabaseSync;
let dataRoot: string;
let fake: FakeVendorBinaries;

const ACTOR = { userId: "u_signin", label: "person@viberr.dev" };

beforeEach(() => {
  db = ctx.makeDb();
  dataRoot = ctx.makeTempDir();
  // `user_backend_credentials.user_id` references `users`, so the person a
  // sign-in bills has to exist before the driver can record one.
  insertUser(db, {
    id: ACTOR.userId,
    email: ACTOR.label,
    name: "Sign-in Test",
    role: "member",
  });
  fake = writeFakeVendorBinaries();
  resetFakeVendorEnv();
});

afterEach(() => {
  resetBackendLoginsForTests();
  resetFakeVendorEnv();
  fake.cleanup();
  ctx.cleanup();
});

function start(
  backend: "claude" | "codex",
  method: "claudeai" | "console" | "device",
  overrides: { timeoutMs?: number } = {},
): LoginSessionView {
  return startBackendLogin(db, ACTOR, backend, method, {
    binaries: fake.binaries,
    dataRoot,
    ...overrides,
  });
}

const home = (backend: "claude" | "codex"): string =>
  userBackendHome(ACTOR.userId, backend, dataRoot);

/** Poll the driver's own read path until the session satisfies `predicate`.
 *  Real processes settle on their own schedule, so waiting is the honest way to
 *  observe them; a fixed sleep would be a flake waiting to happen. */
async function waitForLogin(
  backend: "claude" | "codex",
  predicate: (view: LoginSessionView) => boolean,
  what: string,
): Promise<LoginSessionView> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const view = getBackendLogin(ACTOR.userId, backend);
    if (view && predicate(view)) return view;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}; last state: ${view?.state ?? "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isState =
  (...states: LoginState[]) =>
  (view: LoginSessionView): boolean =>
    states.includes(view.state);

/** The typed refusal a call raised, narrowed through the app's own guard so no
 *  assertion is needed. Fails loudly when the call did not refuse at all. */
function refusalFrom(run: () => string): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected an AppError, but the call returned");
}

/** Wait for a file one of the fake children writes. Same reason as
 *  `waitForLogin`: a real process settles when it settles. */
async function waitForFile(file: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("resolveBackendBinary", () => {
  it("finds each bundled vendor binary the way that vendor's SDK finds its own", () => {
    // The Agent SDK's native package and the Codex SDK's platform package are
    // ordinary optional dependencies of this repo, so both must resolve here.
    const claude = resolveBackendBinary("claude");
    const codex = resolveBackendBinary("codex");
    expect(claude).toMatch(/claude-agent-sdk-\w+-\w+[/\\]claude$/);
    expect(codex).toMatch(/vendor[/\\][^/\\]+[/\\]bin[/\\]codex$/);
    expect(existsSync(claude)).toBe(true);
    expect(existsSync(codex)).toBe(true);
  });

  it("resolves one vendor at a time, so a missing package blocks only its own flow", () => {
    // A target neither vendor publishes a package for: `sunos` is outside the
    // Codex triple table and has no Agent SDK native package either, which is
    // the shape of a host installed with --omit=optional.
    const nowhere: BinaryTarget = { platform: "sunos", arch: "sparc" };
    expect(existsSync(resolveBackendBinary("claude"))).toBe(true);
    expect(existsSync(resolveBackendBinary("codex"))).toBe(true);

    // Each refusal names the vendor being signed in to and nothing else: a
    // person pressing "Sign in with Claude" on a host whose Codex package never
    // installed must still be able to connect Claude, and must not be told
    // about an OpenAI package they did not ask for.
    const claudeFailure = refusalFrom(() => resolveBackendBinary("claude", nowhere));
    expect(claudeFailure.message).toContain("@anthropic-ai/claude-agent-sdk");
    expect(claudeFailure.message).not.toContain("@openai/codex");

    const codexFailure = refusalFrom(() => resolveBackendBinary("codex", nowhere));
    expect(codexFailure.status).toBe(500);
    expect(codexFailure.message).toContain("@openai/codex");
    // The actionable half must reach the PERSON: an AppError with no
    // `userMessage` surfaces on the Profile card as "Something went wrong on
    // our side.", which names neither the cause nor the remedy.
    expect(codexFailure.userMessage).toBe(
      "The bundled Codex binary is not installed on this server, so a hosted sign-in " +
        "cannot start. Ask an admin to reinstall the dependencies without --omit=optional, " +
        "or paste an API key instead.",
    );
    expect(codexFailure.userMessage).not.toBe(codexFailure.message);
  });
});

/**
 * Ruling 460: the sign-in writes the person's credential into their home, so it
 * runs as the person's own OS user — through the launcher, like their runs —
 * and so does the status check that confirms it. The stand-in launcher logs
 * what the real one reads and then execs the vendor binary it was handed.
 */
describe("the sign-in runs as the person's own OS user (ruling 460)", () => {
  afterEach(() => resetAgentIsolationForTests());

  it("spawns the launcher for the sign-in and its confirmation, with the vendor binary and the person's uid", async () => {
    const dir = ctx.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--prepare-home" ]; then exit 0; fi',
        `echo "uid=$VIBERR_LAUNCH_UID exec=$VIBERR_LAUNCH_EXEC home=$VIBERR_LAUNCH_HOME args=$*" >> '${log}'`,
        'exec "$VIBERR_LAUNCH_EXEC" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests({ status: "on", uidFloor: 20001, reason: null }, { launcher });

    start("claude", "claudeai");
    await waitForLogin("claude", (view) => view.needsCode, "the Claude code prompt");
    submitBackendLoginCode(db, ACTOR, "claude", "abc-123");
    const done = await waitForLogin("claude", isState("succeeded", "failed"), "the sign-in");
    expect(done.state).toBe("succeeded");

    const entries = readFileSync(log, "utf8").trim().split("\n");
    const prefix = `uid=20001 exec=${fake.binaries.claude} home=${home("claude")}`;
    expect(entries).toEqual([
      `${prefix} args=auth login --claudeai`,
      `${prefix} args=auth status`,
    ]);
    // The agent's own $HOME, not the server's.
    expect(fakeVendorEnv(home("claude"))?.HOME).toBe(
      path.join(dataRoot, "runtimes", "users", ACTOR.userId, "home"),
    );
  });
});

describe("startBackendLogin (claude)", () => {
  it("captures the URL, prompts for the code, records the row and audits", async () => {
    const started = start("claude", "claudeai");
    expect(started.state).toBe("starting");
    expect(started.backend).toBe("claude");
    expect(started.method).toBe("claudeai");
    expect(started.error).toBeNull();
    // The start is audited before anything else can happen.
    expect(
      listAuditEvents(db, { action: "profile.backend.login_started" }),
    ).toHaveLength(1);

    // The URL arrives ANSI-coloured and must reach the view stripped.
    const awaiting = await waitForLogin(
      "claude",
      (view) => view.needsCode,
      "the Claude code prompt",
    );
    expect(awaiting.url).toBe(FAKE_CLAUDE_URL);
    expect(awaiting.url).not.toContain(ANSI_ESCAPE);
    expect(awaiting.state).toBe("awaiting-code");

    // The CLI printed the prompt WITHOUT a newline; matching it is what proves
    // the driver reads accumulated text, not completed lines.
    expect(awaiting.needsCode).toBe(true);

    const submitted = submitBackendLoginCode(db, ACTOR, "claude", " abc-123 ");
    expect(submitted.state).toBe("finishing");
    expect(submitted.needsCode).toBe(false);

    const done = await waitForLogin(
      "claude",
      isState("succeeded", "failed"),
      "the Claude sign-in to finish",
    );
    expect(done.state).toBe("succeeded");
    expect(done.error).toBeNull();

    // The credential row is a `login` row with the vendor's own facts and NO
    // secret; the vendor wrote the credential file itself.
    const row = getBackendCredential(db, ACTOR.userId, "claude");
    expect(row?.kind).toBe("login");
    expect(row?.method).toBe("claudeai");
    expect(row?.secretSuffix).toBeNull();
    expect(row?.detail.authMethod).toBe("claudeai");
    expect(row?.detail.email).toBe("person@example.com");
    expect(row?.verifiedAt).not.toBeNull();
    expect(existsSync(`${home("claude")}/.credentials.json`)).toBe(true);
    expect(
      listAuditEvents(db, { action: "profile.backend.connected" }),
    ).toHaveLength(1);
  });

  it("writes the trimmed code to stdin and nothing else, ever", async () => {
    start("claude", "console");
    await waitForLogin("claude", (view) => view.needsCode, "the code prompt");
    submitBackendLoginCode(db, ACTOR, "claude", "  paste-me  ");
    await waitForLogin("claude", isState("succeeded"), "success");
    // The child recorded every byte it read: exactly the code and a newline.
    expect(fakeVendorStdin(home("claude"))).toBe("paste-me\n");
  });

  it("spawns argv only, on one home and no credential-shaped variable", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-child";
    process.env.CODEX_HOME = "/some/ambient/codex-home";
    try {
      start("claude", "console");
      await waitForLogin("claude", (view) => view.needsCode, "the code prompt");
      const env = fakeVendorEnv(home("claude"));
      expect(env).not.toBeNull();
      expect(env?.CLAUDE_CONFIG_DIR).toBe(home("claude"));
      // The OTHER vendor's home is deleted, never inherited: an ambient
      // CODEX_HOME must not follow a Claude sign-in around.
      expect(env?.CODEX_HOME).toBeUndefined();
      const leaked = Object.keys(env ?? {}).filter((key) =>
        CREDENTIAL_ENV_RE.test(key),
      );
      expect(leaked).toEqual([]);
      expect(fakeVendorArgv(home("claude"))).toEqual([
        "auth",
        "login",
        "--console",
      ]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CODEX_HOME;
    }
  });

  it("fails with the vendor's redacted sentence on a non-zero exit", async () => {
    setFakeVendorMode("fail");
    start("claude", "claudeai");
    const failed = await waitForLogin("claude", isState("failed"), "a failure");
    expect(failed.error).toBe("error: browser authorization was refused.");
    expect(failed.error).not.toContain(ANSI_ESCAPE);
    expect(getBackendCredential(db, ACTOR.userId, "claude")).toBeNull();
    const audits = listAuditEvents(db, {
      action: "profile.backend.login_failed",
    });
    expect(audits).toHaveLength(1);
  });

  it("refuses to record a sign-in the vendor does not confirm", async () => {
    setFakeVendorLoggedOut(true);
    start("claude", "claudeai");
    await waitForLogin("claude", (view) => view.needsCode, "the code prompt");
    submitBackendLoginCode(db, ACTOR, "claude", "abc");
    const failed = await waitForLogin("claude", isState("failed"), "a failure");
    // Exit 0 is the CLI's opinion about its own process, not proof: the row is
    // only written when `auth status` says loggedIn.
    expect(failed.error).toMatch(/not signed in/);
    expect(getBackendCredential(db, ACTOR.userId, "claude")).toBeNull();
  });

  it("refuses a code before the vendor asks for one", async () => {
    setFakeVendorMode("hang");
    start("claude", "claudeai");
    await waitForLogin("claude", (view) => view.url !== null, "the URL");
    expect(() =>
      submitBackendLoginCode(db, ACTOR, "claude", "too-early"),
    ).toThrow(/has not asked for a code/);
  });

  it("refuses an empty or over-long code once the vendor has asked", async () => {
    start("claude", "claudeai");
    await waitForLogin("claude", (view) => view.needsCode, "the code prompt");

    // Whitespace is not a code. Without this guard a bare newline would reach
    // the live `claude auth login` child, which reads it AS the code and fails
    // a sign-in the person never actually got wrong.
    expect(() => submitBackendLoginCode(db, ACTOR, "claude", "   ")).toThrow(
      /Paste the code Anthropic showed you/,
    );
    expect(() =>
      submitBackendLoginCode(db, ACTOR, "claude", "x".repeat(513)),
    ).toThrow(/too long to be the one/);
    // Both refusals happen BEFORE stdin: the child is still waiting.
    expect(fakeVendorStdin(home("claude"))).toBeNull();

    submitBackendLoginCode(db, ACTOR, "claude", "the-real-code");
    await waitForLogin("claude", isState("succeeded"), "success");
    // Exactly one line ever reached the child, and it is the accepted one.
    expect(fakeVendorStdin(home("claude"))).toBe("the-real-code\n");
  });

  it("refuses a pasted code for Codex, which has no paste step", () => {
    expect(() => submitBackendLoginCode(db, ACTOR, "codex", "x")).toThrow(
      /does not take a pasted code/,
    );
  });
});

describe("startBackendLogin (codex)", () => {
  it("captures the device URL and the code on the line after the prompt", async () => {
    process.env.VIBERR_FAKE_VENDOR_DELAY_MS = "400";
    const started = start("codex", "device");
    expect(started.method).toBe("device");
    const awaiting = await waitForLogin(
      "codex",
      (view) => view.userCode !== null,
      "the device code",
    );
    expect(awaiting.url).toBe(FAKE_CODEX_URL);
    expect(awaiting.userCode).toBe(FAKE_DEVICE_CODE);
    expect(awaiting.userCode).not.toContain(ANSI_ESCAPE);
    // There is no paste step on the Codex flow: the person types the code on
    // the vendor's own page.
    expect(awaiting.needsCode).toBe(false);
    expect(awaiting.state).toBe("awaiting-browser");

    const done = await waitForLogin(
      "codex",
      isState("succeeded", "failed"),
      "the Codex sign-in to finish",
    );
    expect(done.state).toBe("succeeded");
    const row = getBackendCredential(db, ACTOR.userId, "codex");
    expect(row?.kind).toBe("login");
    expect(row?.method).toBe("device");
    expect(row?.detail.status).toBe("Logged in using ChatGPT (person@example.com)");
    expect(existsSync(`${home("codex")}/auth.json`)).toBe(true);
    expect(fakeVendorArgv(home("codex"))).toEqual(["login", "--device-auth"]);
  });

  it("adds the workspace-admin instruction to a disabled device flow", async () => {
    setFakeVendorMode("fail");
    start("codex", "device");
    const failed = await waitForLogin("codex", isState("failed"), "a failure");
    expect(failed.error).toContain(
      "device code login is not enabled for this workspace.",
    );
    expect(failed.error).toContain(
      "Ask your ChatGPT workspace admin to enable device code authorization, or use an API key.",
    );
  });

  it("refuses a sign-in method the vendor does not offer", () => {
    expect(() => start("codex", "claudeai")).toThrow(
      /does not offer that sign-in method/,
    );
    expect(() => start("claude", "device")).toThrow(
      /does not offer that sign-in method/,
    );
  });
});

describe("session lifetime", () => {
  it("times out a hung sign-in, kills the child and audits the failure", async () => {
    setFakeVendorMode("hang");
    start("claude", "claudeai", { timeoutMs: 150 });
    const failed = await waitForLogin("claude", isState("failed"), "the timeout");
    expect(failed.error).toBe("Sign-in timed out. Start again.");
    const audits = listAuditEvents(db, {
      action: "profile.backend.login_failed",
    });
    expect(audits[0]?.details).toMatchObject({
      backend: "claude",
      reason: "Sign-in timed out. Start again.",
    });
    expect(getBackendCredential(db, ACTOR.userId, "claude")).toBeNull();
  });

  it("cancels a running sign-in and audits it", async () => {
    setFakeVendorMode("hang");
    start("codex", "device");
    await waitForLogin("codex", (view) => view.url !== null, "the URL");
    const cancelled = cancelBackendLogin(db, ACTOR, "codex");
    expect(cancelled?.state).toBe("cancelled");
    expect(
      listAuditEvents(db, { action: "profile.backend.login_cancelled" }),
    ).toHaveLength(1);
    // Terminal, and stays readable so the poller can render the outcome.
    expect(getBackendLogin(ACTOR.userId, "codex")?.state).toBe("cancelled");
    // A second cancel is not a second audit row: the session is already over.
    expect(cancelBackendLogin(db, ACTOR, "codex")?.state).toBe("cancelled");
    expect(
      listAuditEvents(db, { action: "profile.backend.login_cancelled" }),
    ).toHaveLength(1);
    // Nothing to cancel on the other backend.
    expect(cancelBackendLogin(db, ACTOR, "claude")).toBeNull();
  });

  it("keeps ONE session per user and backend, replacing (and killing) the old", async () => {
    setFakeVendorMode("hang");
    const first = start("claude", "claudeai");
    await waitForLogin("claude", (view) => view.url !== null, "the first URL");
    expect(fakeVendorTerminated(home("claude"))).toBe(false);

    const second = start("claude", "console");
    expect(second.id).not.toBe(first.id);
    expect(second.method).toBe("console");
    // The map holds the replacement, not both.
    expect(getBackendLogin(ACTOR.userId, "claude")?.id).toBe(second.id);
    // And the FIRST child is actually dead. The replacement is still hanging,
    // so this marker can only have been written by the process that was
    // replaced: without the kill it would keep running, holding this person's
    // runtime home and stdin until the container restarted.
    await waitForFile(
      `${home("claude")}/fake-terminated.txt`,
      "the replaced child to die",
    );
    // Submitting still goes to the replacement, which has not been prompted.
    expect(() =>
      submitBackendLoginCode(db, ACTOR, "claude", "x"),
    ).toThrow();
  });

  it("kills the child a cancel ends", async () => {
    setFakeVendorMode("hang");
    start("codex", "device");
    await waitForLogin("codex", (view) => view.url !== null, "the URL");
    cancelBackendLogin(db, ACTOR, "codex");
    await waitForFile(
      `${home("codex")}/fake-terminated.txt`,
      "the cancelled child to die",
    );
  });

  it("keeps the two backends' sessions apart", async () => {
    setFakeVendorMode("hang");
    start("claude", "claudeai");
    start("codex", "device");
    await waitForLogin("claude", (view) => view.url !== null, "the Claude URL");
    await waitForLogin("codex", (view) => view.url !== null, "the Codex URL");
    expect(getBackendLogin(ACTOR.userId, "claude")?.backend).toBe("claude");
    expect(getBackendLogin(ACTOR.userId, "codex")?.backend).toBe("codex");
    // And apart from another person's, which is what makes the poll route safe
    // to serve keyed on the session user alone.
    expect(getBackendLogin("u_somebody_else", "claude")).toBeNull();
  });
});
