import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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
 * Overridable per process (cached HMR-safe global symbol).
 *
 * R7-2 (don't simulate at all): an unavailable backend NO LONGER falls back
 * to the simulated engine. Selection reports `unavailable` and the
 * run-service fails the run fast with an honest error. The simulated adapter
 * survives ONLY as a deterministic test engine behind a fail-closed gate
 * (see simulatedRuntimePermitted).
 */

export type RealBackend = "claude" | "codex";

interface RegistryState {
  /** Last PROBED value per backend — kept only to log on change. */
  detected: Partial<Record<RealBackend, boolean>>;
  /** Explicit overrides (setBackendAvailability) — sticky, never re-probed. */
  overrides: Partial<Record<RealBackend, boolean>>;
  /** Test override for the R7-2 simulated-runtime gate (undefined → env). */
  simPermitted?: boolean;
}

const REGISTRY_KEY = Symbol.for("viberr.runtimeRegistry");

function getState(): RegistryState {
  const cache = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  let state = cache[REGISTRY_KEY];
  if (!state) {
    state = { detected: {}, overrides: {} };
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
 * When none is present the backend is UNAVAILABLE (R7-2: runs on it fail
 * fast with an honest error — no simulated fallback).
 */
/**
 * When Codex CLI auth is the ONLY signal (no access token / API key), the
 * subscription login lives in `$CODEX_HOME/auth.json` (default `~/.codex`).
 * F-DOCKER1: docker-compose overrides `CODEX_HOME=/data/runtimes/codex-home`
 * but nothing copies auth.json there, so `VIBERR_CODEX_USE_CLI_AUTH=1` used to
 * make the registry pick the REAL adapter on a presence-only check — every run
 * then died with a single redacted "Codex execution failed" line. Validate the
 * file actually exists so the flag reflects USABLE auth: no auth.json → Codex is
 * reported unavailable (honest degraded state) instead of a doomed real run.
 */
function codexCliAuthUsable(env: NodeJS.ProcessEnv): boolean {
  return codexCliAuthDiagnostics(env).authJsonExists;
}

/**
 * Why-is-Codex-unavailable diagnostics for actionable error copy: whether the
 * CLI-auth opt-in is set, where auth.json is expected, and whether it exists.
 * The docker-compose recurring trap: `CODEX_HOME=/data/runtimes/codex-home`
 * lives on the wiped-able volume, so recreating `docker-data` silently drops
 * auth.json while the opt-in flag (from .env) stays set — the error must name
 * the missing FILE, not re-suggest the flag.
 */
export function codexCliAuthDiagnostics(env: NodeJS.ProcessEnv = process.env): {
  optIn: boolean;
  authJsonPath: string;
  authJsonExists: boolean;
} {
  const home = env.CODEX_HOME || path.join(homedir(), ".codex");
  const authJsonPath = path.join(home, "auth.json");
  let authJsonExists = false;
  try {
    authJsonExists = existsSync(authJsonPath);
  } catch {
    authJsonExists = false;
  }
  return {
    optIn: isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH),
    authJsonPath,
    authJsonExists,
  };
}

/**
 * R7-2 fail-closed gate: the simulated engine is reachable ONLY when this
 * returns true. Two ways in, both test-scoped:
 *   - NODE_ENV === "test" (vitest) — the unit suite drives the whole
 *     coordination pipeline on the deterministic engine;
 *   - VIBERR_FORCE_SIMULATED_RUNTIME=1 AND VIBERR_TEST_RUNTIME_OK=1 — the
 *     Playwright harness (its app server boots NODE_ENV=development).
 * Design note: gating on NODE_ENV !== "production" is NOT enough — dev
 * servers are exactly where the old silent fallback fabricated demo runs, so
 * dev must be as honest as prod. The force flag alone therefore has NO effect
 * outside a test env: a stray VIBERR_FORCE_SIMULATED_RUNTIME=1 in prod/dev
 * neither forces nor permits the simulated engine (fail-closed).
 */
export function simulatedRuntimePermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = getState().simPermitted;
  if (override !== undefined) return override;
  if (env.NODE_ENV === "test") return true;
  return (
    isTruthy(env.VIBERR_FORCE_SIMULATED_RUNTIME) && isTruthy(env.VIBERR_TEST_RUNTIME_OK)
  );
}

/** Test-only: override the R7-2 gate (fail-fast paths are testable). */
export function setSimulatedRuntimePermittedForTests(value: boolean | undefined): void {
  getState().simPermitted = value;
}

function hasCredential(backend: RealBackend, env: NodeJS.ProcessEnv = process.env): boolean {
  // Explicit override: force the deterministic simulated engine regardless of
  // any ambient credential (e.g. a developer's `.env` re-loaded by dotenv). The
  // e2e harness sets this so the golden-path specs run against the synchronous
  // scripted operator instead of live, non-deterministic agent runs. Only
  // honored inside the R7-2 gate — outside it the flag is inert.
  if (isTruthy(env.VIBERR_FORCE_SIMULATED_RUNTIME) && simulatedRuntimePermitted(env)) {
    return false;
  }
  if (backend === "claude") {
    return !!(
      env.ANTHROPIC_API_KEY ||
      env.CLAUDE_CODE_OAUTH_TOKEN ||
      isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH)
    );
  }
  // A real token/key is authoritative on its own; CLI-auth mode additionally
  // requires a usable auth.json (see codexCliAuthUsable / F-DOCKER1).
  if (env.CODEX_ACCESS_TOKEN || env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    return true;
  }
  return isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH) && codexCliAuthUsable(env);
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Live backend availability. An explicit override (`setBackendAvailability`)
 * wins and is sticky; otherwise the (cheap: env reads + one existsSync)
 * detection runs on EVERY call, logging only on change. Re-probing is what
 * makes the docker codex-home trap self-healing: a backend that was
 * unavailable because `$CODEX_HOME/auth.json` was missing becomes available
 * the moment the file is dropped in — no restart. (The old first-probe-wins
 * cache pinned "unavailable" for the process lifetime.)
 */
export function isBackendAvailable(backend: RealBackend): boolean {
  const state = getState();
  const override = state.overrides[backend];
  if (override !== undefined) return override;
  const ok = hasCredential(backend);
  if (state.detected[backend] !== ok) {
    state.detected[backend] = ok;
    logger.info("runtime backend detection", { backend, available: ok });
  }
  return ok;
}

/** Test-only: clear detection state and overrides. */
export function resetRegistryForTests(): void {
  const cache = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  cache[REGISTRY_KEY] = undefined;
}

/**
 * Force availability (tests / an explicit override). Sticky: unlike detected
 * values it is never re-probed, so the test harness's "both backends
 * unavailable" hold can't be flipped back by an ambient dev-`.env` credential.
 */
export function setBackendAvailability(backend: RealBackend, available: boolean): void {
  getState().overrides[backend] = available;
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

export type SelectResult =
  | { kind: "real"; adapter: RuntimeAdapter }
  /** The gated deterministic test engine (simulated=1 on the run row). */
  | { kind: "simulated"; adapter: RuntimeAdapter }
  /** No credential, no test gate — the caller must FAIL the run honestly. */
  | { kind: "unavailable" };

/**
 * Selects the adapter for a requested real backend: the real one when its
 * credential is present; the simulated TEST engine only inside the R7-2 gate
 * (the caller keeps the requested backend on the run row for glyph fidelity);
 * otherwise `unavailable` — there is NO silent simulated fallback anymore, an
 * unavailable backend must produce an honest error run, never a fake stream.
 */
export function selectAdapter(backend: RealBackend, adapters: AdapterSet): SelectResult {
  if (isBackendAvailable(backend)) return { kind: "real", adapter: adapters[backend] };
  if (simulatedRuntimePermitted()) {
    return { kind: "simulated", adapter: adapters.simulated };
  }
  return { kind: "unavailable" };
}
