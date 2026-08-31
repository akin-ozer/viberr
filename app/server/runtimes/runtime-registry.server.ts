import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type { RuntimeAdapter } from "./adapter.server";
import {
  resolveClaudeConfigDir,
  resolveClaudeConfigDirFrom,
} from "./claude-config.server";
import {
  prepareCodexHome,
  resolveCodexAuthSource,
  resolveCodexHome,
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

/** The single `globalThis` slot this module owns — the cache survives an HMR
 *  module reload, which a module-level variable would not. */
interface RegistryHost {
  [REGISTRY_KEY]?: RegistryState;
}

/**
 * SAFETY: `REGISTRY_KEY` is module-private, and `getState` /
 * `resetRegistryForTests` below are the only code in the process that reads or
 * writes the slot it names — so the slot holds a `RegistryState` this module
 * put there, or nothing at all.
 */
const registryHost = globalThis as RegistryHost;

function getState(): RegistryState {
  let state = registryHost[REGISTRY_KEY];
  if (!state) {
    state = { detected: {}, overrides: {} };
    registryHost[REGISTRY_KEY] = state;
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
export interface CodexCliAuthDiagnostics {
  optIn: boolean;
  authJsonPath: string;
  authJsonExists: boolean;
  /** The app-owned home every codex RUN executes in (`prepareCodexHome`). */
  runHome: string;
  /**
   * D1: `CODEX_HOME` resolves to the app-owned RUN home, so the auth SOURCE and
   * the run home are the same directory — `prepareCodexHome` returns early
   * ("nothing to mirror") and no `codex login` anywhere on the machine can ever
   * reach a run. Every run is then refused with a bare "no usable credential
   * configured" that points at a Viberr-internal path the operator never chose.
   */
  sourceIsRunHome: boolean;
  /** Where `codex login` writes by default (`~/.codex/auth.json`). */
  defaultLoginPath: string;
  /** Whether that default login actually exists — what makes D1 actionable. */
  defaultLoginExists: boolean;
}

export function codexCliAuthDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
): CodexCliAuthDiagnostics {
  const source = path.resolve(resolveCodexAuthSource(env));
  const authJsonPath = path.join(source, "auth.json");
  const runHome = resolveCodexHome(env);
  // Derived from the env this function was HANDED, not from the process's.
  // `os.homedir()` reads `process.env.HOME` directly, so the one field that
  // reached around the `env` parameter was also the one that made the D1 copy
  // branch on whether the machine running the code happens to hold a real
  // `~/.codex` login — which is how the D1 test passed on a developer box with
  // a Codex login and failed on CI without one. `os.homedir()` stays the
  // fallback for the (Windows / no-$HOME) case where the env carries nothing.
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const defaultLoginPath = path.join(home, ".codex", "auth.json");
  const exists = (file: string): boolean => {
    try {
      return existsSync(file);
    } catch {
      return false;
    }
  };
  return {
    optIn: isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH),
    authJsonPath,
    authJsonExists: exists(authJsonPath),
    runHome,
    sourceIsRunHome: source === path.resolve(runHome),
    defaultLoginPath,
    defaultLoginExists: exists(defaultLoginPath),
  };
}

/**
 * D1 — the ONE Codex misconfiguration that produces a refusal nothing explains.
 *
 * Live incident (2026-08-03, this repo): a dev launcher exported
 * `CODEX_HOME=<dataRoot>/runtimes/codex-home`. That is exactly the path
 * `resolveCodexHome` returns, so the auth source EQUALS the run home, the
 * mirror in `prepareCodexHome` short-circuits, the probe looks for `auth.json`
 * inside Viberr's own empty run home, and every Codex run is refused — while a
 * perfectly good `~/.codex/auth.json` sits one directory away. The generic
 * F-DOCKER1 copy makes it worse: it tells the operator to copy their login INTO
 * the app-owned directory, cementing the misconfiguration instead of naming it.
 *
 * Returns an actionable sentence, or null when this is not the problem.
 */
export function codexAuthMisconfiguration(
  diag: CodexCliAuthDiagnostics = codexCliAuthDiagnostics(),
): string | null {
  if (!diag.optIn || diag.authJsonExists || !diag.sourceIsRunHome) return null;
  return (
    `CODEX_HOME is set to \`${diag.runHome}\`, which is Viberr's OWN per-run home — ` +
    `so the login Viberr mirrors FROM and the home it runs IN are the same empty directory, ` +
    `and no \`codex login\` can ever reach a run. ` +
    (diag.defaultLoginExists
      ? `Your actual login is already at \`${diag.defaultLoginPath}\`: UNSET CODEX_HOME (or point it at \`${path.dirname(diag.defaultLoginPath)}\`) and the next run picks it up without a restart.`
      : `Unset CODEX_HOME so it resolves to \`${path.dirname(diag.defaultLoginPath)}\`, then run \`codex login\` — Viberr mirrors that login into its run home per run.`)
  );
}

export interface ClaudeCliAuthDiagnostics {
  optIn: boolean;
  /** The config/HOME dir the spawned runtime reads (`resolveClaudeConfigDir`). */
  configDir: string;
  configDirExists: boolean;
  /** Where Claude Code writes a FILE-based login. */
  credentialsPath: string;
  credentialsExist: boolean;
  /** How strongly the opt-in was verified — see {@link claudeCliAuthUsable}. */
  verified: "file" | "presence" | "refuted";
}

/**
 * D2 — make the Claude CLI-auth opt-in at least as honest as the Codex one.
 *
 * `VIBERR_CLAUDE_USE_CLI_AUTH=1` used to be pure presence: the flag alone made
 * the registry pick the REAL adapter, so the F-DOCKER1 shape was fully
 * reachable on this side too (flag set from `.env`, `CLAUDE_CONFIG_DIR` pointed
 * at an app-owned directory the logged-in CLI never wrote to → every run dies on
 * auth instead of degrading honestly).
 *
 * What CAN be verified, precisely:
 *  - `refuted` — the config dir does not exist at all. The CLI materializes its
 *    config dir on first use, so "logged in, but the directory it would have
 *    created is absent" is provably false. Reported UNAVAILABLE, matching
 *    `codexCliAuthUsable`.
 *  - `file` — `<configDir>/.credentials.json` exists: a real, file-backed login.
 *  - `presence` — the dir exists but holds no credentials file. On **darwin**
 *    this is the NORMAL logged-in state: Claude Code stores its OAuth
 *    credential in the login Keychain, and reading it from the server would
 *    require an interactive keychain-unlock prompt (and would be an
 *    availability probe that pops a system dialog). There is no file to check,
 *    so the flag is honoured and the weaker verification is REPORTED rather than
 *    hidden. On every other platform the CLI writes the credentials file, so a
 *    missing one means "not logged in" → `refuted`.
 */
export function claudeCliAuthDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClaudeCliAuthDiagnostics {
  const optIn = isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH);
  let configDir: string;
  try {
    // Live env, not `getEnv()` — the probe re-runs on every call so a fixed
    // credential heals without a restart (same reason as the codex side).
    configDir = resolveClaudeConfigDirFrom(env);
  } catch {
    configDir = "";
  }
  const credentialsPath = configDir
    ? path.join(configDir, ".credentials.json")
    : "";
  const exists = (file: string): boolean => {
    if (!file) return false;
    try {
      return existsSync(file);
    } catch {
      return false;
    }
  };
  const configDirExists = exists(configDir);
  const credentialsExist = exists(credentialsPath);
  const verified: ClaudeCliAuthDiagnostics["verified"] = credentialsExist
    ? "file"
    : configDirExists && platform === "darwin"
      ? "presence"
      : "refuted";
  return {
    optIn,
    configDir,
    configDirExists,
    credentialsPath,
    credentialsExist,
    verified,
  };
}

/** The Claude counterpart of `codexCliAuthUsable` (D2). */
function claudeCliAuthUsable(env: NodeJS.ProcessEnv): boolean {
  return claudeCliAuthDiagnostics(env).verified !== "refuted";
}

function hasCredential(backend: RealBackend, env: NodeJS.ProcessEnv = process.env): boolean {
  if (backend === "claude") {
    // A real key/token is authoritative on its own; CLI-auth mode additionally
    // requires a config dir the logged-in CLI could plausibly have written
    // (D2 — previously the flag alone was enough).
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
    return isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH) && claudeCliAuthUsable(env);
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
    // D1: a backend flipping to unavailable because of a KNOWN misconfiguration
    // must not be logged as a bare boolean — that is exactly the silence the
    // live incident produced. Say what is wrong the moment we notice.
    if (!ok && backend === "codex") {
      const misconfigured = codexAuthMisconfiguration();
      if (misconfigured) {
        logger.error("codex is unavailable because CODEX_HOME is misconfigured", {
          detail: misconfigured,
        });
      }
    }
  }
  return ok;
}

/**
 * Why a backend is (un)available, in words — the ONE place the UI, the run
 * service and the logs get their answer from, so "Codex — not configured" can
 * stop being the whole story (D1/D2, and the F16 gap on the Agents page).
 *
 * `detail` is null when the backend is available and fully verified; otherwise
 * it is an actionable sentence naming the specific misconfiguration.
 */
export interface BackendCredentialHealth {
  backend: RealBackend;
  available: boolean;
  /** How strongly availability was proven: a real credential, a validated
   *  cached login, or a presence-only signal we could not verify further. */
  verification: "credential" | "file" | "presence" | "none";
  detail: string | null;
}

export function backendCredentialHealth(
  backend: RealBackend,
  env: NodeJS.ProcessEnv = process.env,
): BackendCredentialHealth {
  const available = isBackendAvailable(backend);
  if (backend === "claude") {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { backend, available, verification: "credential", detail: null };
    }
    const diag = claudeCliAuthDiagnostics(env);
    if (!diag.optIn) {
      return {
        backend,
        available,
        verification: "none",
        detail: available
          ? null
          : "No Claude credential is configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or opt in to a logged-in `claude` CLI with VIBERR_CLAUDE_USE_CLI_AUTH=1.",
      };
    }
    if (diag.verified === "file") {
      return { backend, available, verification: "file", detail: null };
    }
    if (diag.verified === "presence") {
      return {
        backend,
        available,
        verification: "presence",
        detail: `Using the logged-in \`claude\` CLI at \`${diag.configDir}\`. Viberr cannot fully verify this: on macOS the CLI keeps its credential in the login Keychain, which the server would have to prompt for. If runs fail on auth, re-run \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN.`,
      };
    }
    return {
      backend,
      available,
      verification: "none",
      detail: `VIBERR_CLAUDE_USE_CLI_AUTH=1 is set, but \`${diag.configDir}\` does not exist — the \`claude\` CLI has never run against that config dir, so it holds no login. Point CLAUDE_CONFIG_DIR at the logged-in dir, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.`,
    };
  }
  if (env.CODEX_ACCESS_TOKEN || env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    return { backend, available, verification: "credential", detail: null };
  }
  const diag = codexCliAuthDiagnostics(env);
  if (!diag.optIn) {
    return {
      backend,
      available,
      verification: "none",
      detail: available
        ? null
        : "No Codex credential is configured. Set CODEX_ACCESS_TOKEN, CODEX_API_KEY or OPENAI_API_KEY, or opt in to a cached `codex login` with VIBERR_CODEX_USE_CLI_AUTH=1.",
    };
  }
  if (diag.authJsonExists) {
    return { backend, available, verification: "file", detail: null };
  }
  return {
    backend,
    available,
    verification: "none",
    detail:
      codexAuthMisconfiguration(diag) ??
      `VIBERR_CODEX_USE_CLI_AUTH=1 is set, but the Codex CLI login file is missing at \`${diag.authJsonPath}\`. Run \`codex login\`, or copy it from a logged-in machine — the next run picks it up without a restart.`,
  };
}

/** Test-only: clear detection state and overrides. */
export function resetRegistryForTests(): void {
  registryHost[REGISTRY_KEY] = undefined;
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

/**
 * Credential-shaped env var NAMES. Exported because the OUTPUT side needs the
 * same list as the input side: `filteredSpawnEnv` strips these from the agent's
 * child env, and the run sink redacts the VALUES of the ones the app then
 * deliberately re-adds (P13-U-1) from every persisted log line. One regex, so
 * "what counts as a credential" cannot drift between the two.
 */
export const CREDENTIAL_ENV_RE =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const PRIVATE_RUNTIME_ENV_RE =
  /^(?:DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO)$/i;

export function filteredSpawnEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
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
  // auth.json in so subscription auth keeps working — and `selectAdapter`
  // re-mirrors per run, because this factory runs once per process (P14-RT-05).
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
  const claudeDeps: NonNullable<Parameters<typeof createClaudeAdapter>[0]> = {
    env: claudeEnv,
  };
  if (deps.claudeQueryFn) claudeDeps.queryFn = deps.claudeQueryFn;
  const codexDeps: NonNullable<Parameters<typeof createCodexAdapter>[0]> = {
    // Point the SDK's spawned `codex` at the subscription login dir. Both
    // SDKs REPLACE the child env with this object, so we hand it a FULL
    // (secret-filtered) env — otherwise `codex` spawns with only CODEX_HOME
    // and loses PATH/HOME (git/auth break). `codexSpawnEnv` starts from
    // process.env, strips credentials, then forces CODEX_HOME.
    env: codexEnv,
  };
  if (deps.codexFactory) codexDeps.codexFactory = deps.codexFactory;
  // API key when present; otherwise NO key at all so the Codex SDK uses either
  // CODEX_ACCESS_TOKEN or the ChatGPT login in $CODEX_HOME/auth.json.
  if (codexApiKey) codexDeps.apiKey = codexApiKey;
  return {
    claude: createClaudeAdapter(claudeDeps),
    codex: createCodexAdapter(codexDeps),
  };
}

export type SelectResult =
  | { kind: "real"; adapter: RuntimeAdapter }
  /** No usable credential — the caller must fail the run honestly. */
  | { kind: "unavailable" };

/**
 * Selects the requested adapter when its credential is present, otherwise
 * reports that it is unavailable.
 *
 * P14-RT-05: the codex auth mirror is refreshed HERE, per run, not once in
 * `createAdapters`. The adapter set is built once per process, so on any
 * deployment where the login dir differs from the run home (every non-container
 * dev machine) an `auth.json` that landed after boot never reached the run home
 * — while `isBackendAvailable` (which probes the LOGIN dir, live) kept reporting
 * codex available and the unavailable-copy promised "the next run picks it up
 * without a restart". Runs then failed auth against an empty home. Refreshing at
 * selection time makes that promise true, and covers a mid-process re-login on
 * hosts where the mirror is a copy rather than a symlink. Cheap and idempotent:
 * outside cached-login mode `prepareCodexHome` returns before touching the disk,
 * and a live symlink is a single lstat.
 */
export function selectAdapter(backend: RealBackend, adapters: AdapterSet): SelectResult {
  if (!isBackendAvailable(backend)) return { kind: "unavailable" };
  if (backend === "codex") {
    const { authMirrored, home } = prepareCodexHome();
    if (authMirrored) {
      logger.info("codex run home auth mirror refreshed", { home });
    }
  }
  return { kind: "real", adapter: adapters[backend] };
}
