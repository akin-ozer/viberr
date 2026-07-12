import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_HEALTH_SIGNAL_TTL_MS,
  codexSpawnEnv,
  createAdapters,
  getBackendHealth,
  isBackendAvailable,
  recordBackendRunResult,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
} from "./runtime-registry.server";

describe("runtime-registry — detection & fallback", () => {
  afterEach(() => {
    resetRegistryForTests();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.VIBERR_CLAUDE_USE_CLI_AUTH;
    delete process.env.CODEX_ACCESS_TOKEN;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VIBERR_CODEX_USE_CLI_AUTH;
  });

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

  it("detects codex available via the ChatGPT-plan CLI-auth opt-in flag", () => {
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    expect(isBackendAvailable("codex")).toBe(true);
  });

  it("reports unavailable when no credential is present", () => {
    expect(isBackendAvailable("claude")).toBe(false);
    expect(isBackendAvailable("codex")).toBe(false);
  });

  it("caches the first detection result", () => {
    expect(isBackendAvailable("claude")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"; // set AFTER first probe
    expect(isBackendAvailable("claude")).toBe(false); // still cached false
  });

  it("separates configured presence from recent verified/degraded run evidence", () => {
    setBackendAvailability("claude", true);
    const start = new Date("2026-07-13T08:00:00.000Z");

    expect(getBackendHealth("claude", start)).toMatchObject({
      status: "unknown",
      configured: true,
      verified: false,
      degraded: false,
      unknown: true,
      lastCheckedAt: null,
    });

    recordBackendRunResult("claude", "success", start);
    expect(getBackendHealth("claude", new Date(start.getTime() + 1))).toMatchObject({
      status: "verified",
      configured: true,
      verified: true,
      degraded: false,
      unknown: false,
      lastSuccessAt: start.toISOString(),
    });

    const failedAt = new Date(start.getTime() + 1_000);
    recordBackendRunResult("claude", "failure", failedAt);
    expect(getBackendHealth("claude", failedAt)).toMatchObject({
      status: "degraded",
      verified: false,
      degraded: true,
      lastCheckedAt: failedAt.toISOString(),
      lastSuccessAt: start.toISOString(),
      lastFailureAt: failedAt.toISOString(),
    });

    expect(
      getBackendHealth(
        "claude",
        new Date(failedAt.getTime() + BACKEND_HEALTH_SIGNAL_TTL_MS + 1),
      ),
    ).toMatchObject({ status: "unknown", unknown: true, degraded: false });
  });

  it("reports absent configuration as unconfigured even if an old run signal exists", () => {
    const at = new Date("2026-07-13T08:00:00.000Z");
    recordBackendRunResult("codex", "success", at);
    setBackendAvailability("codex", false);
    expect(getBackendHealth("codex", at)).toMatchObject({
      status: "unconfigured",
      configured: false,
      verified: false,
      degraded: false,
      unknown: false,
      lastSuccessAt: at.toISOString(),
    });
  });

  it("selectAdapter returns the real adapter when available", () => {
    setBackendAvailability("claude", true);
    const adapters = createAdapters();
    const { adapter, simulated } = selectAdapter("claude", adapters);
    expect(simulated).toBe(false);
    expect(adapter).toBe(adapters.claude);
  });

  it("selectAdapter falls back to the simulated engine when unavailable (simulated flag set)", () => {
    setBackendAvailability("codex", false);
    const adapters = createAdapters();
    const { adapter, simulated } = selectAdapter("codex", adapters);
    expect(simulated).toBe(true);
    expect(adapter).toBe(adapters.simulated);
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
