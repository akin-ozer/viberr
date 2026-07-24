import { existsSync } from "node:fs";
import path from "node:path";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type { RuntimeAdapter } from "./adapter.server";
import { resolveClaudeConfigDir } from "./claude-config.server";
import {
  prepareCodexHome,
  resolveCodexAuthSource,
} from "./codex-config.server";
import {
  createClaudeAdapter,
  type ClaudeQueryFn,
} from "./claude-runtime.server";
import {
  createCodexAdapter,
  type CodexFactory,
} from "./codex-runtime.server";

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
 * An unavailable backend reports `unavailable`; the run service records an
 * honest error instead of fabricating work.
 */

export type RealBackend = "claude" | "codex";

interface RegistryState {
  /** Last PROBED value per backend — kept only to log on change. */
  detected: Partial<Record<RealBackend, boolean>>;
  /** Explicit overrides (setBackendAvailability) — sticky, never re-probed. */
  overrides: Partial<Record<RealBackend, boolean>>;
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
 * fast with an honest error).
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
 *
 * P13-LV-13/LV-14: runs no longer execute in `$CODEX_HOME` — they get an
 * app-owned run home (`resolveCodexHome`) that `prepareCodexHome` mirrors the
 * login into. The probe deliberately still asks about the LOGIN dir, not the
 * mirror: the login is what a human manages, and a probe that also accepted the
 * mirror would go sticky (a run home keeps a stale copy long after the login was
 * removed) and lose the self-healing property below. In the container the two
 * paths are the same dir, so the documented docker recipe is unchanged.
 */
export function codexCliAuthDiagnostics(env: NodeJS.ProcessEnv = process.env): {
  optIn: boolean;
  authJsonPath: string;
  authJsonExists: boolean;
} {
  const authJsonPath = path.join(resolveCodexAuthSource(env), "auth.json");
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

function hasCredential(backend: RealBackend, env: NodeJS.ProcessEnv = process.env): boolean {
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
 * values it is never re-probed. The test harness relies on that twice:
 * `setupAppTest` installs the fake runtime (configureRunServiceForTests), which
 * forces BOTH backends available so route tests drive the deterministic fake
 * adapters rather than a live re-probe; and a test that afterwards forces one
 * backend unavailable keeps it unavailable for the rest of the file, immune to
 * an ambient dev-`.env` credential.
 */
export function setBackendAvailability(backend: RealBackend, available: boolean): void {
  getState().overrides[backend] = available;
}

// ---------------------------------------------------------- selection

export interface AdapterSet {
  claude: RuntimeAdapter;
  codex: RuntimeAdapter;
}

export interface AdapterDeps {
  /** Inject the Claude SDK `query` (tests). */
  claudeQueryFn?: ClaudeQueryFn;
  /** Inject the Codex SDK factory (tests). */
  codexFactory?: CodexFactory;
}

const CREDENTIAL_ENV_RE =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const PRIVATE_RUNTIME_ENV_RE =
  /^(?:DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO)$/i;

function filteredSpawnEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !CREDENTIAL_ENV_RE.test(entry[0]) &&
        !PRIVATE_RUNTIME_ENV_RE.test(entry[0]),
    ),
  );
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
  const out = filteredSpawnEnv();
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

/**
 * A complete but secret-filtered spawn env for the Claude Agent SDK (F10-02).
 *
 * The SDK REPLACES the child `claude` process env with the `env` we pass —
 * verified in the bundled sdk.mjs (`env = options.env` when provided; only a
 * default `{...process.env}` when omitted). So filtering here is REAL: the
 * spawned agent never sees a variable we drop. This mirrors `codexSpawnEnv` and
 * fixes the asymmetry where Claude previously received the FULL server
 * environment (session-signing + encryption secrets, DATABASE_URL, the GitHub
 * PAT, provider keys, unrelated deploy secrets) while Codex was already
 * filtered. Keep ordinary runtime settings (PATH/HOME/locale/proxy) so stdio
 * MCP servers (`npx …`) and the CLI's own session lookup keep working; strip
 * every credential-shaped variable; then re-add only the selected Claude
 * credential and the deterministic config dir.
 */
export function claudeSpawnEnv(
  configDir: string,
  apiKey?: string,
  oauthToken?: string,
): Record<string, string> {
  const out = filteredSpawnEnv();
  out.CLAUDE_CONFIG_DIR = configDir;
  if (apiKey) out.ANTHROPIC_API_KEY = apiKey;
  if (oauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return out;
}

/** Constructs the two provider adapters (SDK factories injectable for tests). */
export function createAdapters(deps: AdapterDeps = {}): AdapterSet {
  const env = getEnv();
  // A Codex access token is a ChatGPT-workspace credential, not a Platform API
  // key. Prefer it when both are configured so subscription runs cannot
  // silently fall through to usage-based API billing.
  const preferCachedCodexLogin = isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH);
  const codexApiKey = env.CODEX_ACCESS_TOKEN || preferCachedCodexLogin
    ? undefined
    : (env.CODEX_API_KEY ?? env.OPENAI_API_KEY);
  // P13-LV-13/LV-14: a run gets an APP-OWNED CODEX_HOME, never the operator's
  // personal `~/.codex`. That home is the only isolation boundary the Codex SDK
  // offers — `--config` overrides merge into whatever the home declares, so a
  // host home leaks its `config.toml` MCP servers, `skills/`, `plugins/` and
  // `AGENTS.md` into every governed run. `prepareCodexHome` mirrors the login's
  // auth.json in so subscription auth keeps working.
  const codexEnv = codexSpawnEnv(
    prepareCodexHome().home,
    env.CODEX_ACCESS_TOKEN,
    preferCachedCodexLogin,
  );
  // The SDK's `env` REPLACES the child environment (it is not merged). We build
  // it from `claudeSpawnEnv`, which starts from process.env — so the spawned
  // runtime keeps PATH/HOME (stdio MCP `npx …` and CLI auth/session lookup
  // work) — but FILTERS OUT every server credential and adds only the selected
  // Claude credential + a deterministic CLAUDE_CONFIG_DIR (so session
  // transcripts land where session-export reads them). Previously this spread
  // the raw process.env and leaked all server secrets to the agent (F10-02).
  const claudeEnv = claudeSpawnEnv(
    resolveClaudeConfigDir(),
    env.ANTHROPIC_API_KEY,
    env.CLAUDE_CODE_OAUTH_TOKEN,
  );
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
      // Point the SDK's spawned `codex` at the subscription login dir. Both
      // SDKs REPLACE the child env with this object, so we hand it a FULL
      // (secret-filtered) env — otherwise `codex` spawns with only CODEX_HOME
      // and loses PATH/HOME (git/auth break). `codexSpawnEnv` starts from
      // process.env, strips credentials, then forces CODEX_HOME.
      env: codexEnv,
    }),
  };
}

export type SelectResult =
  | { kind: "real"; adapter: RuntimeAdapter }
  /** No usable credential — the caller must fail the run honestly. */
  | { kind: "unavailable" };

/**
 * Selects the requested adapter when its credential is present, otherwise
 * reports that it is unavailable.
 */
export function selectAdapter(backend: RealBackend, adapters: AdapterSet): SelectResult {
  if (isBackendAvailable(backend)) return { kind: "real", adapter: adapters[backend] };
  return { kind: "unavailable" };
}
