import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type { RuntimeAdapter } from "./adapter.server";
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
 *   - codex:  CODEX_API_KEY | OPENAI_API_KEY  (an interactive `codex login`
 *     also authenticates the SDK, but we can't cheaply prove that here, so
 *     an env key is the detection signal; document the login path).
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
 *   - codex: CODEX_API_KEY / OPENAI_API_KEY, or VIBERR_CODEX_USE_CLI_AUTH=1.
 * When none is present the registry falls back to the simulated backend.
 */
function hasCredential(backend: RealBackend, env: NodeJS.ProcessEnv = process.env): boolean {
  if (backend === "claude") {
    return !!(
      env.ANTHROPIC_API_KEY ||
      env.CLAUDE_CODE_OAUTH_TOKEN ||
      isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH)
    );
  }
  return !!(
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

/** Constructs the three adapters (SDK factories injectable for tests). */
export function createAdapters(deps: AdapterDeps = {}): AdapterSet {
  const env = safeEnv();
  // Inject only the credential vars that are present. When neither is set
  // (pure CLI/keychain auth via VIBERR_CLAUDE_USE_CLI_AUTH), pass no env so
  // the spawned SDK inherits the full process env (and the logged-in CLI).
  const claudeEnv: Record<string, string> = {
    ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
    ...(env.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
    // Persist the session store so resuming an agent (via a task comment)
    // works across restarts. Must ride in the SDK's env (which replaces the
    // child env) or the config dir would fall back to ephemeral ~/.claude.
    ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
  };
  return {
    claude: createClaudeAdapter({
      ...(deps.claudeQueryFn ? { queryFn: deps.claudeQueryFn } : {}),
      ...(Object.keys(claudeEnv).length ? { env: claudeEnv } : {}),
    }),
    codex: createCodexAdapter({
      ...(deps.codexFactory ? { codexFactory: deps.codexFactory } : {}),
      // API key when present; otherwise NO key so the Codex SDK falls back to
      // the ChatGPT-plan (subscription) login in $CODEX_HOME/auth.json.
      ...(env.CODEX_API_KEY || env.OPENAI_API_KEY
        ? { apiKey: (env.CODEX_API_KEY ?? env.OPENAI_API_KEY)! }
        : {}),
      // Point the SDK's spawned `codex` at the subscription login dir.
      ...(env.CODEX_HOME ? { env: { CODEX_HOME: env.CODEX_HOME } } : {}),
    }),
    simulated: createSimulatedAdapter(),
  };
}

function safeEnv(): {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CLAUDE_CONFIG_DIR?: string;
  CODEX_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEX_HOME?: string;
} {
  try {
    const env = getEnv();
    // Default Claude's session store under the data volume when not overridden.
    const claudeConfigDir =
      env.CLAUDE_CONFIG_DIR ?? `${env.VIBERR_DATA_ROOT}/runtimes/claude-home`;
    return {
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.CLAUDE_CODE_OAUTH_TOKEN
        ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
        : {}),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      ...(env.CODEX_API_KEY ? { CODEX_API_KEY: env.CODEX_API_KEY } : {}),
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
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
