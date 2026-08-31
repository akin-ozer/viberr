import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";
import {
  backendCredentialHealth,
  claudeCliAuthDiagnostics,
  claudeSpawnEnv,
  codexAuthMisconfiguration,
  codexCliAuthDiagnostics,
  codexSpawnEnv,
  createAdapters,
  isBackendAvailable,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
} from "./runtime-registry.server";
import {
  backendUnavailableMessage,
  repoWriteWithheldFromDenylist,
  webSearchWithheldFromDenylist,
} from "./run-service.server";
import type { RunSpec } from "./adapter.server";
import type { CodexClient, CodexFactory } from "./codex-runtime.server";
import type {
  ClaudeQuery,
  ClaudeQueryOptions,
} from "./claude-runtime.server";
import { resolveSpecialistDisallowedTools } from "../tasks/specialist-tool-policy";
import { agentGitIdentity } from "../tasks/specialist-run.server";
import { CAP_CATALOG, capabilityEnforcement } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";

/**
 * A Claude SDK query as the adapter consumes it: an async generator of SDK
 * messages plus `interrupt`. Yields the given messages, then completes.
 */
function fakeClaudeQuery(...messages: unknown[]): ClaudeQuery {
  const gen = (async function* (): AsyncGenerator<unknown, void> {
    for (const message of messages) yield message;
  })();
  return Object.assign(gen, { interrupt: async () => {} });
}

describe("runtime-registry", () => {
  const tmpDirs: string[] = [];
  const savedDataRoot = process.env.VIBERR_DATA_ROOT;
  const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  // The D1 tests repoint $HOME so `~/.codex/auth.json` is a fact they control
  // rather than one the machine supplies. It MUST go back: the temp dir is
  // removed below, and a stale $HOME pointing at a deleted directory would
  // leak into every later test in this worker.
  const savedHome = process.env.HOME;
  afterEach(() => {
    resetRegistryForTests();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.VIBERR_CLAUDE_USE_CLI_AUTH;
    delete process.env.CODEX_ACCESS_TOKEN;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VIBERR_CODEX_USE_CLI_AUTH;
    delete process.env.CODEX_HOME;
    if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    // The mirror resolves the run home under the data root, so these tests
    // repoint it; put the ambient value back rather than dropping it.
    if (savedDataRoot === undefined) delete process.env.VIBERR_DATA_ROOT;
    else process.env.VIBERR_DATA_ROOT = savedDataRoot;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A CLAUDE_CONFIG_DIR that exists, optionally holding a file-based login. */
  function claudeConfigDir(opts: { credentials: boolean }): string {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-claude-home-"));
    tmpDirs.push(dir);
    if (opts.credentials) {
      writeFileSync(path.join(dir, ".credentials.json"), "{}");
    }
    return dir;
  }

  function codexHome(withAuth: boolean): string {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-codex-home-"));
    tmpDirs.push(dir);
    if (withAuth) writeFileSync(path.join(dir, "auth.json"), "{}");
    return dir;
  }

  it("detects claude available when ANTHROPIC_API_KEY is present (no API call)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isBackendAvailable("claude")).toBe(true);
  });

  it("detects claude available via a subscription OAuth token (claude setup-token)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    expect(isBackendAvailable("claude")).toBe(true);
  });

  /**
   * D2/pass-16 — this test used to assert PRESENCE ONLY: the flag alone made the
   * registry pick the REAL adapter, so the F-DOCKER1 shape (flag set from
   * `.env`, config dir pointed somewhere the logged-in CLI never wrote) was
   * fully reachable on the Claude side too — every run then died on auth
   * instead of degrading honestly. The flag is now validated as far as the
   * platform allows; see `claudeCliAuthDiagnostics`.
   */
  it("detects claude available via CLI-auth when the config dir holds a login", () => {
    process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir({ credentials: true });
    expect(isBackendAvailable("claude")).toBe(true);
    expect(claudeCliAuthDiagnostics().verified).toBe("file");
  });

  it("reports claude UNAVAILABLE under CLI-auth when the config dir does not exist (D2)", () => {
    // The CLI materializes its config dir on first use, so "logged in, but the
    // directory it would have created is absent" is provably false — on every
    // platform. This is the Claude half of the F-DOCKER1 guard.
    process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
    process.env.CLAUDE_CONFIG_DIR = path.join(
      tmpdir(),
      `viberr-claude-missing-${Date.now()}`,
    );
    expect(isBackendAvailable("claude")).toBe(false);
    expect(claudeCliAuthDiagnostics().verified).toBe("refuted");
    expect(backendUnavailableMessage("claude")).toContain("holds no `claude` login");
  });

  it("a real ANTHROPIC_API_KEY is authoritative even with no config dir", () => {
    process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpdir(), "viberr-claude-nope");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isBackendAvailable("claude")).toBe(true);
  });

  it("an existing config dir with no credentials FILE is honest about how it verified", () => {
    // macOS keeps the CLI credential in the login Keychain, so there is no file
    // to check and the server must not pop a keychain prompt to probe. The
    // weaker verification is REPORTED rather than hidden; every other platform
    // expects the credentials file and refutes the flag without it.
    process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir({ credentials: false });
    const onMac = claudeCliAuthDiagnostics(process.env, "darwin");
    expect(onMac.verified).toBe("presence");
    const onLinux = claudeCliAuthDiagnostics(process.env, "linux");
    expect(onLinux.verified).toBe("refuted");
    // The honesty surface says which, instead of a bare "configured".
    if (process.platform === "darwin") {
      const health = backendCredentialHealth("claude");
      expect(health.verification).toBe("presence");
      expect(health.detail).toContain("cannot fully verify");
    }
  });

  it("detects codex available via CODEX_API_KEY or OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isBackendAvailable("codex")).toBe(true);
  });

  it("detects codex available via a ChatGPT workspace access token", () => {
    process.env.CODEX_ACCESS_TOKEN = "cat-test";
    expect(isBackendAvailable("codex")).toBe(true);
  });

  it("detects codex available via CLI-auth when $CODEX_HOME/auth.json exists", () => {
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = codexHome(true);
    expect(isBackendAvailable("codex")).toBe(true);
  });

  it("reports codex UNAVAILABLE under CLI-auth when auth.json is missing (F-DOCKER1)", () => {
    // The docker-compose case: CODEX_HOME points at an empty dir (no auth.json
    // copied). The flag alone must NOT select the real adapter — that produced
    // the redacted 'Codex execution failed' crash. Honest degraded state instead.
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = codexHome(false);
    expect(isBackendAvailable("codex")).toBe(false);
  });

  /**
   * D1/pass-16 — the live incident (2026-08-03).
   *
   * A dev launcher exported `CODEX_HOME=<dataRoot>/runtimes/codex-home`, which
   * is EXACTLY the path `resolveCodexHome` returns. Auth source == run home, so
   * `prepareCodexHome`'s mirror short-circuits, the probe looks for auth.json
   * inside Viberr's own empty run home, and every Codex run was refused with a
   * bare "no usable credential configured" — while a working `~/.codex` login
   * sat one directory away and the generic copy told the operator to copy their
   * login INTO the app-owned dir, cementing the misconfiguration.
   */
  it("names the CODEX_HOME==run-home misconfiguration instead of a bare refusal (D1)", () => {
    // HERMETIC: $HOME is a temp dir with NO `.codex/auth.json`, so this drives
    // the "you have no login anywhere" half of the copy. The test used to read
    // the real machine's home, so which half it exercised depended on whether
    // the developer happened to be logged into Codex — it passed locally and
    // failed on CI, and the branch CI hit was never asserted at all.
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-data-root-"));
    tmpDirs.push(dataRoot);
    const fakeHome = mkdtempSync(path.join(tmpdir(), "viberr-home-"));
    tmpDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    process.env.VIBERR_DATA_ROOT = dataRoot;
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    // The exact misconfiguration: CODEX_HOME pointed at Viberr's own run home.
    process.env.CODEX_HOME = path.join(dataRoot, "runtimes", "codex-home");

    const diag = codexCliAuthDiagnostics();
    expect(diag.sourceIsRunHome).toBe(true);
    expect(diag.authJsonExists).toBe(false);
    expect(diag.defaultLoginExists).toBe(false);
    expect(isBackendAvailable("codex")).toBe(false);

    const detail = codexAuthMisconfiguration(diag);
    expect(detail).toContain("Viberr's OWN per-run home");
    // No login to point at, so the copy must say how to CREATE one.
    expect(detail).toContain("Unset CODEX_HOME");
    expect(detail).toContain("codex login");

    // It reaches the two surfaces an operator actually reads: the run refusal…
    const message = backendUnavailableMessage("codex");
    expect(message).toContain("Viberr's OWN per-run home");
    // …and it must NOT re-suggest copying the login into that same dead dir.
    expect(message).not.toContain("docker compose cp");

    // …and the credential-health surface the backend pickers render.
    const health = backendCredentialHealth("codex");
    expect(health.available).toBe(false);
    expect(health.detail).toContain("Viberr's OWN per-run home");
  });

  it("points at the login the operator ALREADY has, when there is one (D1)", () => {
    // The other half, and the one the live incident actually was: a working
    // `~/.codex` login sat one directory away while every run was refused. The
    // copy has to name it and say UNSET, not "run codex login" — the operator
    // has already done that.
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-data-root-"));
    tmpDirs.push(dataRoot);
    const fakeHome = mkdtempSync(path.join(tmpdir(), "viberr-home-"));
    tmpDirs.push(fakeHome);
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".codex", "auth.json"), "{}");
    process.env.HOME = fakeHome;
    process.env.VIBERR_DATA_ROOT = dataRoot;
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = path.join(dataRoot, "runtimes", "codex-home");

    const diag = codexCliAuthDiagnostics();
    expect(diag.sourceIsRunHome).toBe(true);
    expect(diag.defaultLoginExists).toBe(true);

    const detail = codexAuthMisconfiguration(diag);
    expect(detail).toContain("Viberr's OWN per-run home");
    expect(detail).toContain(path.join(fakeHome, ".codex", "auth.json"));
    expect(detail).toContain("UNSET CODEX_HOME");
    // Nothing to log in to — telling them to would be the wrong instruction.
    expect(detail).not.toContain("then run `codex login`");
  });

  it("the ordinary missing-auth.json case still gets the docker recipe (not the D1 copy)", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-data-root-"));
    tmpDirs.push(dataRoot);
    process.env.VIBERR_DATA_ROOT = dataRoot;
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = codexHome(false); // a real login dir, just empty
    expect(codexCliAuthDiagnostics().sourceIsRunHome).toBe(false);
    const message = backendUnavailableMessage("codex");
    expect(message).toContain("docker compose cp");
    expect(message).not.toContain("Viberr's OWN per-run home");
  });

  it("a real CODEX_ACCESS_TOKEN is authoritative even with no auth.json", () => {
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = codexHome(false);
    process.env.CODEX_ACCESS_TOKEN = "cat-test";
    expect(isBackendAvailable("codex")).toBe(true);
  });

  it("reports unavailable when no credential is present", () => {
    expect(isBackendAvailable("claude")).toBe(false);
    expect(isBackendAvailable("codex")).toBe(false);
  });

  it("re-probes an unavailable detection — a credential fixed at runtime heals it", () => {
    expect(isBackendAvailable("claude")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"; // set AFTER first probe
    expect(isBackendAvailable("claude")).toBe(true); // live re-probe picks it up
  });

  it("self-heals the docker codex-home trap: auth.json dropped in AFTER the first probe", () => {
    // The recurring compose breakage: a wiped ./docker-data volume empties
    // CODEX_HOME, codex probes unavailable, and the old first-probe-wins cache
    // pinned that for the process lifetime — even `docker compose cp`ing the
    // file back kept runs refused until a restart. Now the next run just works.
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    const home = codexHome(false);
    process.env.CODEX_HOME = home;
    expect(isBackendAvailable("codex")).toBe(false); // fresh volume: no auth.json
    writeFileSync(path.join(home, "auth.json"), "{}"); // docker compose cp …
    expect(isBackendAvailable("codex")).toBe(true); // no restart needed
  });

  it("an explicit setBackendAvailability override is sticky — never re-probed", () => {
    // The test harness forces both backends unavailable; an ambient dev-.env
    // credential must NOT flip that back via the live re-probe.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setBackendAvailability("claude", false);
    expect(isBackendAvailable("claude")).toBe(false);
  });

  it("selectAdapter returns the real adapter when available", () => {
    setBackendAvailability("claude", true);
    const adapters = createAdapters();
    expect(selectAdapter("claude", adapters)).toEqual({
      kind: "real",
      adapter: adapters.claude,
    });
  });

  it("returns unavailable when the requested backend has no credential", () => {
    setBackendAvailability("codex", false);
    const adapters = createAdapters();
    expect(selectAdapter("codex", adapters)).toEqual({ kind: "unavailable" });
  });

  // P14-RT-05: the mirror used to run ONCE, inside createAdapters. The
  // availability probe re-probes live and reports codex available the moment
  // auth.json lands, and the unavailable copy promises "the next run picks it up
  // without a restart" — but the run home stayed empty until a restart, so runs
  // failed auth instead. Selection is per-run, so the mirror belongs here.
  it("selectAdapter mirrors an auth.json that lands AFTER the adapters were built", () => {
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    const login = codexHome(false);
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-data-root-"));
    tmpDirs.push(dataRoot);
    process.env.CODEX_HOME = login;
    process.env.VIBERR_DATA_ROOT = dataRoot;
    const runHome = path.join(dataRoot, "runtimes", "codex-home");

    // Boot: no login yet, so nothing to mirror.
    const adapters = createAdapters();
    expect(existsSync(path.join(runHome, "auth.json"))).toBe(false);

    // The human logs in (or `docker compose cp`s the file in) mid-process.
    writeFileSync(path.join(login, "auth.json"), "{}");
    expect(selectAdapter("codex", adapters)).toEqual({
      kind: "real",
      adapter: adapters.codex,
    });
    expect(existsSync(path.join(runHome, "auth.json"))).toBe(true);
  });

  it("selectAdapter touches nothing for claude, or outside cached-login mode", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-data-root-"));
    tmpDirs.push(dataRoot);
    process.env.VIBERR_DATA_ROOT = dataRoot;
    process.env.CODEX_HOME = codexHome(true);
    // Token auth: auth.json is irrelevant, so the run home is never populated.
    process.env.CODEX_ACCESS_TOKEN = "cat-test";
    const adapters = createAdapters();
    expect(selectAdapter("codex", adapters).kind).toBe("real");
    expect(
      existsSync(path.join(dataRoot, "runtimes", "codex-home", "auth.json")),
    ).toBe(false);
  });

  it("codexSpawnEnv preserves runtime essentials but filters unrelated server secrets", () => {
    // The Codex SDK REPLACES the child env with what we pass, so it must be
    // complete — the bug was passing only { CODEX_HOME }, stripping PATH/HOME
    // and breaking the spawned `codex` binary.
    process.env.PATH = process.env.PATH || "/usr/bin:/bin";
    process.env.VIBERR_CODEX_TEST_MARKER = "present";
    process.env.VIBERR_SESSION_SECRET = "server-session-secret";
    process.env.ANTHROPIC_API_KEY = "claude-secret";
    try {
      const env = codexSpawnEnv("/codex");
      expect(env.CODEX_HOME).toBe("/codex"); // forced
      expect(env.PATH).toBeTruthy(); // preserved (would be missing with the bug)
      expect(env.VIBERR_CODEX_TEST_MARKER).toBe("present"); // process.env carried through
      expect(env.VIBERR_SESSION_SECRET).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.keys(env).length).toBeGreaterThan(2);
    } finally {
      delete process.env.VIBERR_CODEX_TEST_MARKER;
      delete process.env.VIBERR_SESSION_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("claudeSpawnEnv preserves runtime essentials but filters server secrets (F10-02)", () => {
    // The Claude Agent SDK REPLACES the child env with what we pass (verified in
    // sdk.mjs). Previously the adapter spread the raw process.env, leaking every
    // server secret to the spawned `claude`. claudeSpawnEnv mirrors codexSpawnEnv.
    process.env.PATH = process.env.PATH || "/usr/bin:/bin";
    process.env.VIBERR_CLAUDE_TEST_MARKER = "present";
    process.env.MY_DEPLOY_SECRET = "server-deploy-secret";
    process.env.DATABASE_URL = "postgres://secret";
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    try {
      const env = claudeSpawnEnv("/claude-cfg", "anthropic-key", "oauth-tok");
      expect(env.CLAUDE_CONFIG_DIR).toBe("/claude-cfg"); // forced
      expect(env.PATH).toBeTruthy(); // preserved
      expect(env.VIBERR_CLAUDE_TEST_MARKER).toBe("present"); // ordinary var carried
      // The selected Claude credential is re-added explicitly...
      expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
      // ...but NO server secret survives the filter.
      expect(env.MY_DEPLOY_SECRET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      delete process.env.VIBERR_CLAUDE_TEST_MARKER;
      delete process.env.MY_DEPLOY_SECRET;
      delete process.env.DATABASE_URL;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("codexSpawnEnv prefers subscription access-token auth over API billing", () => {
    process.env.CODEX_API_KEY = "api-billing-key";
    process.env.OPENAI_API_KEY = "platform-billing-key";
    try {
      const env = codexSpawnEnv("/codex", "cat-subscription-test");
      expect(env.CODEX_HOME).toBe("/codex");
      expect(env.CODEX_ACCESS_TOKEN).toBe("cat-subscription-test");
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CODEX_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("codexSpawnEnv keeps an explicitly selected cached login off API billing", () => {
    process.env.CODEX_API_KEY = "api-billing-key";
    process.env.OPENAI_API_KEY = "platform-billing-key";
    try {
      const env = codexSpawnEnv("/codex", undefined, true);
      expect(env.CODEX_HOME).toBe("/codex");
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CODEX_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("createAdapters accepts injected SDK fakes (no real SDK constructed)", () => {
    let queryCalled = false;
    const adapters = createAdapters({
      claudeQueryFn: () => {
        queryCalled = true;
        return fakeClaudeQuery();
      },
    });
    expect(adapters.claude.backend).toBe("claude");
    expect(queryCalled).toBe(false); // constructing the adapter must not call query
  });
});

/**
 * UC-16 — "do Codex and Claude Code work the same way from Viberr's eye?"
 *
 * A specialist is ONE uniform machinery differentiated only by its capability +
 * resource grants (generic-agents, 2026-07-19). The two backends must therefore
 * be interchangeable at every seam Viberr controls, and where they genuinely
 * differ the difference must be DISCLOSED (ruling 51 / R18-5, and the capability
 * matrix's "What differs between the two runtimes" list) rather than silent.
 *
 * These tests drive BOTH adapters — built by the production `createAdapters`
 * factory, with the provider SDKs faked so nothing bills — from ONE spec that
 * differs only in `backend`, and assert the EFFECT is the same even where the
 * mechanism is not (Claude tool denylist vs Codex sandbox mode). They replace
 * the two-legged live run in `planning/discovery-2026-08-06-pass19/runbooks/UC-16.md`,
 * which needs a real repo, real PRs and 20 minutes of provider time.
 */
describe("UC-16 backend parity (claude ↔ codex, one spec, two adapters)", () => {
  afterEach(() => resetRegistryForTests());

  /** The Codex thread options + CLI options these tests read. `config` is the
   *  SDK's own recursive `--config` value, so a leaf is decoded where read. */
  interface CodexCapture {
    thread: {
      model?: string;
      sandboxMode?: string;
      workingDirectory?: string;
      networkAccessEnabled?: boolean;
      webSearchMode?: string;
    };
    env?: Record<string, string>;
    config?: CodexOptions["config"];
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  /** Start the SAME spec on both real adapters; return what each SDK was handed. */
  async function startOnBoth(
    spec: Omit<RunSpec, "backend">,
  ): Promise<{ claude: ClaudeQueryOptions; codex: CodexCapture }> {
    let claude: ClaudeQueryOptions = {};
    const codex: CodexCapture = { thread: {} };

    const codexFactory: CodexFactory = (options) => {
      codex.env = options?.env;
      codex.config = options?.config;
      const thread: ReturnType<CodexClient["startThread"]> = {
        id: "thread-parity",
        async runStreamed() {
          const events = (async function* (): AsyncGenerator<ThreadEvent> {
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
          })();
          return { events };
        },
      };
      const client: CodexClient = {
        startThread: (opts) => {
          Object.assign(codex.thread, opts ?? {});
          return thread;
        },
        resumeThread: (_id, opts) => {
          Object.assign(codex.thread, opts ?? {});
          return thread;
        },
      };
      return client;
    };

    const adapters = createAdapters({
      claudeQueryFn: (params) => {
        claude = params.options ?? {};
        return fakeClaudeQuery({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          usage: {},
        });
      },
      codexFactory,
    });

    const sink = { onLine: () => {}, onExit: () => {} };
    adapters.claude.start({ ...spec, backend: "claude" }, sink);
    adapters.codex.start({ ...spec, backend: "codex" }, sink);
    await drain();
    return { claude, codex };
  }

  /** The task identity every run carries: same key, same branch checkout. */
  const PARITY_TASK = {
    runId: "run_parity",
    projectSlug: "viberr-core",
    taskKey: "VIB-16",
    threadId: "primary",
    role: "Primary specialist",
    kind: "primary",
    model: "sonnet",
    prompt: "Implement the marker file.",
    workdir: "/data/projects/viberr-core/tasks/VIB-16/workspace/viberr",
    autonomous: true,
  } satisfies Omit<RunSpec, "backend">;

  /** A fully-granted deliverer, as the profile editor would persist it. */
  const DELIVERY_GRANTS: CapabilityGrant[] = [
    { capabilityId: "execute-code-or-write-repo", mode: "direct" },
    { capabilityId: "create-task-branch", mode: "direct" },
    { capabilityId: "commit-push-branch", mode: "direct" },
    { capabilityId: "open-review-pr", mode: "direct" },
    { capabilityId: "use-web-search-fetch", mode: "direct" },
  ];

  const REPO_WRITE_TOOLS = [
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    "Bash(git commit:*)",
  ];

  function withMode(
    grants: CapabilityGrant[],
    capabilityId: string,
    mode: CapabilityGrant["mode"],
  ): CapabilityGrant[] {
    return grants.map((g) => (g.capabilityId === capabilityId ? { ...g, mode } : g));
  }

  /**
   * Build the spec the way `startRun` builds it (run-service.server.ts) —
   * grants → `resolveSpecialistDisallowedTools` → the two derived backend flags.
   * Composing the REAL functions is what makes this a parity test rather than a
   * restatement of hand-written lists: change the policy and both legs move.
   */
  function specForGrants(grants: CapabilityGrant[]): Omit<RunSpec, "backend"> {
    const disallowedTools = resolveSpecialistDisallowedTools(grants);
    const spec: Omit<RunSpec, "backend"> = { ...PARITY_TASK };
    if (disallowedTools.length) spec.disallowedTools = disallowedTools;
    if (repoWriteWithheldFromDenylist(disallowedTools)) {
      spec.repoWriteWithheld = true;
    }
    if (webSearchWithheldFromDenylist(disallowedTools)) {
      spec.webSearchWithheld = true;
    }
    return spec;
  }

  it("ruling 101: withheld repo-write binds on BOTH backends — Claude tool deny, Codex read-only sandbox", async () => {
    const withheld = await startOnBoth(
      specForGrants(withMode(DELIVERY_GRANTS, "execute-code-or-write-repo", "off")),
    );
    // Claude: the write tools are removed from the model's context (deny binds
    // even under bypassPermissions) — the capability is ENFORCED.
    expect(withheld.claude.disallowedTools).toEqual(
      expect.arrayContaining(REPO_WRITE_TOOLS),
    );
    const granted = await startOnBoth(specForGrants(DELIVERY_GRANTS));
    for (const tool of REPO_WRITE_TOOLS) {
      expect(granted.claude.disallowedTools ?? []).not.toContain(tool);
    }
    // Codex (ruling 101, superseding R22's advisory posture): grants decide
    // the sandbox. The withheld run is READ-ONLY — physically bound, matching
    // Claude — while the granted autonomous deliverer with egress keeps
    // danger-full-access. The scoped push/PR/merge commands remain
    // server-owned either way.
    expect(withheld.codex.thread.sandboxMode).toBe("read-only");
    expect(granted.codex.thread.sandboxMode).toBe("danger-full-access");

    // Claude keeps Bash (the specialist must run its validation), so shell-level
    // writes stay reachable there too — the physical repo-write enforcement was
    // never total on either backend; the server-owned delivery gate is what
    // actually decides what ships.
    expect(withheld.claude.disallowedTools).not.toContain("Bash");
  });

  it("withheld web egress binds on BOTH backends, by different channels", async () => {
    const withheld = await startOnBoth(
      specForGrants(withMode(DELIVERY_GRANTS, "use-web-search-fetch", "off")),
    );
    expect(withheld.claude.disallowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch"]),
    );
    expect(withheld.codex.thread.webSearchMode).toBe("disabled");
    expect(withheld.codex.thread.networkAccessEnabled).toBeUndefined();
    // R22: an egress-withheld Codex run is workspace-write, NOT
    // danger-full-access — full access would turn the network on and defeat the
    // withheld egress. The workspace-write default (network off) is what gates
    // it. So egress remains an ENFORCED capability on both backends (owner
    // ruling: sandbox removed, egress kept).
    expect(withheld.codex.thread.sandboxMode).toBe("workspace-write");

    const granted = await startOnBoth(specForGrants(DELIVERY_GRANTS));
    expect(granted.claude.disallowedTools ?? []).not.toContain("WebFetch");
    expect(granted.codex.thread.webSearchMode).toBeUndefined();
  });

  it("every tool-layer capability's DECLARED enforcement scope matches what the adapters do", async () => {
    // The capability matrix renders a "Claude-enforced" badge from
    // `capabilityEnforcement`. A badge that drifts from the adapters is worse
    // than no badge: it tells an admin a withheld grant binds on a backend where
    // it does not. Derive the tool-layer capabilities from the policy itself (so
    // a NEW deny rule is covered the day it lands) and check each one against
    // the Codex thread options the same grant actually produces.
    const allGranted: CapabilityGrant[] = CAP_CATALOG.map((c) => ({
      capabilityId: c.id,
      mode: "direct",
    }));
    const baseline = new Set(resolveSpecialistDisallowedTools(allGranted));
    const grantedRun = await startOnBoth(specForGrants(allGranted));
    const codexPosture = (c: CodexCapture) =>
      JSON.stringify([
        c.thread.sandboxMode,
        c.thread.webSearchMode ?? null,
        c.thread.networkAccessEnabled ?? null,
      ]);

    const toolLayer: string[] = [];
    for (const cap of CAP_CATALOG) {
      const denied = resolveSpecialistDisallowedTools(
        withMode(allGranted, cap.id, "off"),
      );
      const claudeBinds = denied.some((t) => !baseline.has(t));
      if (!claudeBinds) continue; // not a tool-layer capability at all
      toolLayer.push(cap.id);
      const run = await startOnBoth(specForGrants(withMode(allGranted, cap.id, "off")));
      const codexBinds =
        codexPosture(run.codex) !== codexPosture(grantedRun.codex);
      expect(
        { id: cap.id, scope: capabilityEnforcement(cap.id) },
        `${cap.id}: codex ${codexBinds ? "binds" : "does not bind"} this grant`,
      ).toEqual({ id: cap.id, scope: codexBinds ? "both" : "claude-only" });
    }

    // And the tool-layer set itself is exactly these five — a new deny rule has
    // to be classified deliberately (and disclosed) rather than inheriting one.
    expect(toolLayer.sort()).toEqual([
      "commit-push-branch",
      "create-task-branch",
      "execute-code-or-write-repo",
      "open-review-pr",
      "use-web-search-fetch",
    ]);
  });

  it("ruling 101: the operator is read-only on BOTH backends — Claude deny, Codex sandbox — with Codex egress gated", async () => {
    // R19-1 made this load-bearing: the operator stands beside a full clone of
    // the project repo it must never write. Ruling 101 restored the Codex
    // read-only sandbox for coordination machinery, so "never write" binds
    // physically on both legs — and its Codex EGRESS stays gated (no network).
    const operator = await startOnBoth({
      ...PARITY_TASK,
      kind: "operator",
      threadId: "op",
      role: "Operator",
      workdir: "/data/projects/viberr-core/tasks/VIB-16",
    });
    // Claude: the repo-mutation built-ins are removed from the model's context
    // by RUN KIND — the adapter is the backstop even if a caller forgets to pass
    // `operatorDisallowedTools` (this spec passes none).
    expect(operator.claude.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"]),
    );
    // …while the tool-loading path it needs to reach its mcp__viberr__* tools stays.
    expect(operator.claude.disallowedTools).not.toContain("ToolSearch");
    // Codex (ruling 101): read-only, egress fully gated — an operator that
    // set autonomous:true must NOT reach danger-full-access (that turns the
    // network on).
    expect(operator.codex.thread.sandboxMode).toBe("read-only");
    expect(operator.codex.thread.networkAccessEnabled).toBe(false);
    // Autonomy does NOT buy the operator write access on either backend.
    expect(operator.claude.permissionMode).toBe("bypassPermissions");
    expect(operator.codex.thread.sandboxMode).not.toBe("danger-full-access");

    // B-2 (pass 24, owner ruling): the operator now honors `use-web-search-fetch`
    // on BOTH backends, removing the old asymmetry. With the grant HELD, Claude
    // keeps WebFetch/WebSearch AND the Codex operator gets web search — its
    // OS-sandbox network stays off (`networkAccessEnabled: false`, above), which
    // is a different egress. A withheld grant disables web search on both.
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebFetch");
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebSearch");
    expect(operator.codex.thread.webSearchMode).not.toBe("disabled");
  });

  it("both backends carry the same task identity into the run (NFR15 traceability)", async () => {
    // F24: one delivery identity, whichever backend ran. `agentGitIdentityEnv`
    // (specialist-run) builds these from the DELIVERING profile id, and the two
    // adapters have to land them in different places: Claude's SDK replaces the
    // child env with `options.env`, while Codex splits the CLI env (which
    // carries subscription auth) from the model's OWN shell — where
    // `inherit: "core"` strips everything not named in `shell_environment_policy.set`.
    const identity = agentGitIdentity("developer-claude");
    const env = {
      GIT_CEILING_DIRECTORIES: "/data/projects/viberr-core/tasks/VIB-16",
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    const both = await startOnBoth({ ...PARITY_TASK, env });

    // Same workspace directory ⇒ same checkout, same task-key branch, same
    // commits to trace back to the task.
    expect(both.claude.cwd).toBe(PARITY_TASK.workdir);
    expect(both.codex.thread.workingDirectory).toBe(PARITY_TASK.workdir);

    for (const [key, value] of Object.entries(env)) {
      expect(both.claude.env?.[key]).toBe(value);
      expect(both.codex.env?.[key]).toBe(value);
    }
    // The overlay is a MERGE on both: the base spawn env survives, so the
    // spawned CLI keeps PATH/HOME (adversarial-review HIGH #3).
    expect(both.claude.env?.PATH).toBeTruthy();
    expect(both.codex.env?.PATH).toBeTruthy();

    // Codex only: the identity must be re-exported into the model's own shell,
    // or a `git commit` the agent runs is authored by whoever spawned the
    // process (P13-RT-10). Exactly these keys cross — nothing more, nothing less.
    const policy = z
      .object({
        inherit: z.string().optional().catch(undefined),
        set: z.record(z.string(), z.string()).optional().catch(undefined),
      })
      .catch({})
      .parse(both.codex.config?.shell_environment_policy);
    expect(policy.inherit).toBe("core");
    expect(policy.set).toEqual(env);
  });
});
