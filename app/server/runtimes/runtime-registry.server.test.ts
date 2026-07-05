import { afterEach, describe, expect, it } from "vitest";
import {
  createAdapters,
  isBackendAvailable,
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
