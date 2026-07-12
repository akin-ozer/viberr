import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type { RuntimeAdapter } from "./adapter.server";
import { resolveClaudeConfigDir } from "./claude-config.server";
import {
  createClaudeAdapter,
  type ClaudeQueryFn,
} from "./claude-runtime.server";
import {
  createCodexAdapter,
  type CodexFactory,
} from "./codex-runtime.server";
import { createSimulatedAdapter } from "./simulated-runtime.server";

/**
 * Runtime registry: selects the adapter for a requested backend and detects
 * whether a real backend is USABLE via the official SDKs.
 *
 * Detection is an SDK-AUTH check — cheap, no paid API call (the brief is
 * explicit: never call the API to detect). A backend is "available" when its
 * credential is present in the environment:
 *   - claude: ANTHROPIC_API_KEY
 *   - codex: CODEX_ACCESS_TOKEN (ChatGPT workspace subscription),
 *     CODEX_API_KEY | OPENAI_API_KEY, or an explicitly opted-in cached
 *     `codex login`.
 * Overridable per process (cached HMR-safe global symbol). When the
 * requested real backend is unavailable, the registry returns the SIMULATED
 * adapter but the run-service keeps the requested backend on the row and
 * sets simulated=1 — real-vs-sim is a separate flag from the glyph backend.
 */

export type RealBackend = "claude" | "codex";

interface RegistryState {
  detected: Partial<Record<RealBackend, boolean>>;
}

const REGISTRY_KEY = Symbol.for("viberr.runtimeRegistry");

function getState(): RegistryState {
  const cache = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  let state = cache[REGISTRY_KEY];
  if (!state) {
    state = { detected: {} };
    cache[REGISTRY_KEY] = state;
  }
  return state;
}

/**
 * Cheap credential-presence check (no API call). A real backend is usable
 * when a credential the spawned process can actually see is present:
 *   - claude: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (from
 *     `claude setup-token`), or the explicit opt-in VIBERR_CLAUDE_USE_CLI_AUTH=1
 *     for machines whose `claude` CLI is already logged in (keychain auth).
 *   - codex: CODEX_ACCESS_TOKEN, CODEX_API_KEY / OPENAI_API_KEY, or
 *     VIBERR_CODEX_USE_CLI_AUTH=1.
 * When none is present the registry falls back to the simulated backend.
 */
function hasCredential(backend: RealBackend, env: NodeJS.ProcessEnv = process.env): boolean {
  // Explicit override: force the deterministic simulated engine regardless of
  // any ambient credential (e.g. a developer's `.env` re-loaded by dotenv). The
  // e2e harness sets this so the golden-path specs run against the synchronous
  // scripted operator instead of live, non-deterministic agent runs.
  if (isTruthy(env.VIBERR_FORCE_SIMULATED_RUNTIME)) return false;
  if (backend === "claude") {
    return !!(
      env.ANTHROPIC_API_KEY ||
      env.CLAUDE_CODE_OAUTH_TOKEN ||
      isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH)
    );
  }
  return !!(
    env.CODEX_ACCESS_TOKEN ||
    env.CODEX_API_KEY ||
    env.OPENAI_API_KEY ||
    isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH)
  );
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Cached backend availability. First call reads the env; subsequent calls
 * return the cached boolean (an explicit override via
 * `setBackendAvailability` wins).
 */
export function isBackendAvailable(backend: RealBackend): boolean {
  const state = getState();
  if (state.detected[backend] === undefined) {
    const ok = hasCredential(backend);
    state.detected[backend] = ok;
    logger.info("runtime backend detection", { backend, available: ok });
  }
  return state.detected[backend]!;
}

/** Test-only: clear the detection cache. */
export function resetRegistryForTests(): void {
  const cache = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  cache[REGISTRY_KEY] = undefined;
}

/** Force a cached detection result (tests / an explicit override). */
export function setBackendAvailability(backend: RealBackend, available: boolean): void {
  getState().detected[backend] = available;
}

// ---------------------------------------------------------- selection

export interface AdapterSet {
  claude: RuntimeAdapter;
  codex: RuntimeAdapter;
  simulated: RuntimeAdapter;
}

export interface AdapterDeps {
  /** Inject the Claude SDK `query` (tests). */
  claudeQueryFn?: ClaudeQueryFn;
  /** Inject the Codex SDK factory (tests). */
  codexFactory?: CodexFactory;
}

/**
 * A complete but secret-filtered spawn env for the Codex SDK. Its `env` option
 * replaces the child process env wholesale, so PATH/HOME/locale/proxy settings
 * must survive; unrelated server credentials must not. The selected Codex
 * credential is added explicitly below.
 */
export function codexSpawnEnv(
  codexHome?: string,
  accessToken?: string,
  preferCachedLogin = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    // Keep ordinary runtime settings while excluding credentials belonging to
    // the app, Claude, GitHub, cloud providers, package registries, etc. The SDK
    // adds `apiKey` itself; subscription auth is restored explicitly below.
    if (
      /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i.test(
        key,
      ) ||
      /^(?:DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO)$/i.test(key)
    ) {
      continue;
    }
    out[key] = value;
  }
  if (codexHome) out.CODEX_HOME = codexHome;
  if (accessToken) {
    out.CODEX_ACCESS_TOKEN = accessToken;
  }
  if (accessToken || preferCachedLogin) {
    // Both paths are explicit requests for ChatGPT subscription auth. Do not
    // let ambient billing credentials silently switch the SDK back to API mode.
    delete out.CODEX_API_KEY;
    delete out.OPENAI_API_KEY;
  }
  return out;
}

/** Constructs the three adapters (SDK factories injectable for tests). */
export function createAdapters(deps: AdapterDeps = {}): AdapterSet {
  const env = safeEnv();
  // A Codex access token is a ChatGPT-workspace credential, not a Platform API
  // key. Prefer it when both are configured so subscription runs cannot
  // silently fall through to usage-based API billing.
  const preferCachedCodexLogin = isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH);
  const codexApiKey = env.CODEX_ACCESS_TOKEN || preferCachedCodexLogin
    ? undefined
    : (env.CODEX_API_KEY ?? env.OPENAI_API_KEY);
  const codexEnv = codexSpawnEnv(
    env.CODEX_HOME,
    env.CODEX_ACCESS_TOKEN,
    preferCachedCodexLogin,
  );
  // The SDK's `env` REPLACES the child environment (it is not merged), so we
  // MUST start from process.env — otherwise the spawned runtime loses PATH and
  // HOME, which silently breaks stdio MCP servers (`npx …` can't be found) and
  // the CLI's own auth/session lookup. Then overlay the credential vars and a
  // deterministic config dir so session transcripts land where session-export
  // reads them (resolveClaudeConfigDir is the single source both agree on).
  const claudeEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
    ...(env.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
    CLAUDE_CONFIG_DIR: resolveClaudeConfigDir(),
  };
  return {
    claude: createClaudeAdapter({
      ...(deps.claudeQueryFn ? { queryFn: deps.claudeQueryFn } : {}),
      env: claudeEnv,
    }),
    codex: createCodexAdapter({
      ...(deps.codexFactory ? { codexFactory: deps.codexFactory } : {}),
      // API key when present; otherwise NO key so the Codex SDK uses either
      // CODEX_ACCESS_TOKEN or the ChatGPT login in $CODEX_HOME/auth.json.
      ...(codexApiKey ? { apiKey: codexApiKey } : {}),
      // Point the SDK's spawned `codex` at the subscription login dir. NOTE:
      // the Codex SDK REPLACES the child env with this object (unlike the
      // Claude SDK, which merges into process.env), so we must hand it a FULL
      // env — otherwise `codex` spawns with only CODEX_HOME and loses PATH/HOME
      // (git/auth break). Merge process.env, then force CODEX_HOME.
      env: codexEnv,
    }),
    simulated: createSimulatedAdapter(),
  };
}

function safeEnv(): {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CLAUDE_CONFIG_DIR?: string;
  CODEX_ACCESS_TOKEN?: string;
  CODEX_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEX_HOME?: string;
  VIBERR_CODEX_USE_CLI_AUTH?: string;
} {
  try {
    const env = getEnv();
    return {
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.CLAUDE_CODE_OAUTH_TOKEN
        ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
        : {}),
      CLAUDE_CONFIG_DIR: resolveClaudeConfigDir(),
      ...(env.CODEX_ACCESS_TOKEN
        ? { CODEX_ACCESS_TOKEN: env.CODEX_ACCESS_TOKEN }
        : {}),
      ...(env.CODEX_API_KEY ? { CODEX_API_KEY: env.CODEX_API_KEY } : {}),
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
      ...(env.VIBERR_CODEX_USE_CLI_AUTH
        ? { VIBERR_CODEX_USE_CLI_AUTH: env.VIBERR_CODEX_USE_CLI_AUTH }
        : {}),
    };
  } catch {
    // Env not configured (tests) — no real keys, simulated carries everything.
    return {};
  }
}

export interface SelectResult {
  adapter: RuntimeAdapter;
  /** True on fallback: the requested backend is kept, simulated engine used. */
  simulated: boolean;
}

/**
 * Selects the adapter for a requested real backend: the real one when its
 * credential is present, else the simulated engine (simulated=true; the
 * caller keeps the requested backend on the run row for glyph fidelity).
 */
export function selectAdapter(backend: RealBackend, adapters: AdapterSet): SelectResult {
  if (isBackendAvailable(backend)) return { adapter: adapters[backend], simulated: false };
  return { adapter: adapters.simulated, simulated: true };
}
