import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeSpawnEnv,
  codexSpawnEnv,
  createAdapters,
  isBackendAvailable,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
  setSimulatedRuntimePermittedForTests,
  simulatedRuntimePermitted,
} from "./runtime-registry.server";

describe("runtime-registry — detection & fallback", () => {
  const tmpDirs: string[] = [];
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
    delete process.env.VIBERR_FORCE_SIMULATED_RUNTIME;
    delete process.env.VIBERR_TEST_RUNTIME_OK;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

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

  it("detects claude available via the CLI-auth opt-in flag", () => {
    process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
    expect(isBackendAvailable("claude")).toBe(true);
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

  it("R7-2: an unavailable backend is `unavailable` — the gated test engine only inside the gate, never a silent fallback", () => {
    setBackendAvailability("codex", false);
    const adapters = createAdapters();
    setSimulatedRuntimePermittedForTests(false);
    expect(selectAdapter("codex", adapters)).toEqual({ kind: "unavailable" });
    setSimulatedRuntimePermittedForTests(true);
    expect(selectAdapter("codex", adapters)).toEqual({
      kind: "simulated",
      adapter: adapters.simulated,
    });
  });

  it("R7-2 gate: env matrix — test env or force-flag+ack only; fail-closed elsewhere", () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
    // vitest: NODE_ENV=test is inside the gate with no flags at all.
    expect(simulatedRuntimePermitted(env({ NODE_ENV: "test" }))).toBe(true);
    // e2e harness: force flag + the explicit second ack under development.
    expect(
      simulatedRuntimePermitted(
        env({ NODE_ENV: "development", VIBERR_FORCE_SIMULATED_RUNTIME: "1", VIBERR_TEST_RUNTIME_OK: "1" }),
      ),
    ).toBe(true);
    // A stray force flag alone (dev or prod) is INERT — fail-closed.
    expect(
      simulatedRuntimePermitted(
        env({ NODE_ENV: "development", VIBERR_FORCE_SIMULATED_RUNTIME: "1" }),
      ),
    ).toBe(false);
    expect(
      simulatedRuntimePermitted(
        env({ NODE_ENV: "production", VIBERR_FORCE_SIMULATED_RUNTIME: "1" }),
      ),
    ).toBe(false);
    // The ack without the force flag opens the gate for nothing real either
    // way (no force → credentials rule), but bare prod stays closed.
    expect(simulatedRuntimePermitted(env({ NODE_ENV: "production" }))).toBe(false);
  });

  it("R7-2 gate: an inert force flag does not mask a real credential outside the gate", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.VIBERR_FORCE_SIMULATED_RUNTIME = "1";
    setSimulatedRuntimePermittedForTests(false); // model a prod/dev process
    try {
      expect(isBackendAvailable("claude")).toBe(true);
    } finally {
      setSimulatedRuntimePermittedForTests(undefined);
      delete process.env.VIBERR_FORCE_SIMULATED_RUNTIME;
    }
  });

  it("R7-2 gate: inside the gate the force flag masks credentials (e2e determinism)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.VIBERR_FORCE_SIMULATED_RUNTIME = "1";
    try {
      // vitest: NODE_ENV === "test" → gate open → the flag takes effect.
      expect(isBackendAvailable("claude")).toBe(false);
    } finally {
      delete process.env.VIBERR_FORCE_SIMULATED_RUNTIME;
    }
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
        return (async function* () {})() as never;
      },
    });
    expect(adapters.claude.backend).toBe("claude");
    expect(queryCalled).toBe(false); // constructing the adapter must not call query
  });
});
