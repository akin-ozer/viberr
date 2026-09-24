import type { RuntimeAdapter } from "./adapter.server";
import {
  createClaudeAdapter,
  type ClaudeQueryFn,
} from "./claude-runtime.server";
import {
  createCodexAdapter,
  type CodexFactory,
} from "./codex-runtime.server";
import { ENV_KEYS } from "~/server/config/env.server";

/**
 * Runtime registry: constructs the two provider adapters and hands one back
 * for a requested backend.
 *
 * Ruling 127 took the CREDENTIAL out of this module entirely. There used to be
 * an availability probe here (`isBackendAvailable`, `backendCredentialHealth`
 * and their CLI-auth diagnostics) that answered "is this backend configured?"
 * by reading the deployment's own environment. That question no longer has an
 * instance-level answer: every run bills ONE person, so whether a backend can
 * run is a fact about that person's connected account, not about this server.
 * `backend-credentials.server.ts` owns it now (`userBackendHealth`,
 * `runCredentialFor`), `run-principal.server.ts` decides WHOSE account a run
 * uses, and the run service assembles the child env from the credential it
 * resolves.
 *
 * What is left here is the part that was never about a credential:
 *
 *  - {@link CREDENTIAL_ENV_RE} / {@link filteredSpawnEnv} — spawn env hygiene.
 *    Both adapters are built on a base env with EVERY credential-shaped
 *    variable stripped, so a child process starts from a blank credential
 *    slate and sees only what the run service explicitly adds for its
 *    principal — and, since ruling 142, with every name the app's own env
 *    schema declares stripped too ({@link APP_CONFIG_ENV}), so the child
 *    never sees this server's configuration either.
 *  - {@link createAdapters} / {@link selectAdapter} — construction and lookup.
 */

export type RealBackend = "claude" | "codex";

// ---------------------------------------------------------- spawn env

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

/**
 * Ruling 127: the two vendor HOME variables, stripped for the same reason the
 * credentials are.
 *
 * Neither name is credential-shaped, so {@link CREDENTIAL_ENV_RE} lets both
 * through — but a home is where a vendor binary KEEPS its credential, so an
 * ambient `CODEX_HOME` on the server process (a deployment upgrading onto this
 * branch with its old `.env`, say) would ride into every child, including a
 * Claude run billed to somebody else: one `codex exec` from inside that run
 * would authenticate against whatever sign-in file that directory still holds
 * and bill a person nobody chose. `runCredentialFor` adds back exactly the one
 * home its principal owns, so stripping both here is what makes this base's
 * "carries NO home" promise true rather than aspirational. The two sibling
 * spawn sites (the sign-in driver and `runVendorLogout`) delete them by hand
 * in `vendorSpawnEnv`, for the same reason, at the same boundary.
 *
 * Ruling 181 adds `CODEX_SQLITE_HOME`, the CLI's state-db location: the Codex
 * adapter sets it per run to the principal's shared home (the run's own
 * `CODEX_HOME` is a private fork), so an ambient one — a host's `~/.codex`
 * state — must not be what a child inherits when the adapter has nothing to
 * set it to.
 */
const RUNTIME_HOME_ENV_RE = /^(?:CLAUDE_CONFIG_DIR|CODEX_HOME|CODEX_SQLITE_HOME)$/;

/**
 * Ruling 142 (pass 34, U34-7): the app's OWN configuration, stripped for a
 * different reason than the credentials.
 *
 * `ENV_KEYS` is every name the env schema declares — `NODE_ENV`, `PORT`,
 * `VIBERR_DATA_ROOT`, `BETTER_AUTH_URL`, the OAuth client ids, the unlock
 * flags, every `VIBERR_*` knob. None of it is a secret; it is simply not the
 * child's. An agent works in the PROJECT's repository and a stdio MCP server
 * is somebody else's program: the container's `NODE_ENV=production` and
 * `PORT=5173` rode into a Developer run's shell and broke the project's own
 * `vitest` and `next start` until the agent unset them by hand. Every
 * JavaScript project's tooling reads exactly those two names, and the rest of
 * the list is one grep away from the same surprise.
 *
 * Keyed on the schema rather than a hand-written list so a knob added there is
 * excluded the same day; the "no undeclared env reads" gate
 * (`env.server.test.ts`) is what keeps the schema — and so this set — complete.
 * A name the schema does NOT declare still passes: PATH, HOME, locale, proxies,
 * the image's `UV_*` caches and the `LOG_LEVEL` / `VIBERR_E2E_*` /
 * `VIBERR_CLAUDE_TEST_MARKER` reads the gate allows are not Viberr's
 * configuration, and a child may legitimately need them. Nothing a child needs
 * comes from a declared name: `VIBERR_BROWSER_EXECUTABLE`, the one knob a
 * child's tool depends on, is read by the PARENT and handed to the browser MCP
 * as argv (`specialist-browser-mcp.server.ts`); the agent toolkit and the
 * controller's `viberr_ops` mount are in-process SDK servers that read the
 * validated env themselves.
 */
const APP_CONFIG_ENV: ReadonlySet<string> = new Set(ENV_KEYS);

/**
 * The server's environment with every credential-shaped, private-runtime and
 * app-configuration variable removed — the base both adapters spawn on, and
 * the base every stdio MCP child (`mcpSpawnEnv`) and the sign-in driver
 * (`backend-login.server.ts`) start from.
 *
 * Both SDKs REPLACE the child env with the object they are handed (verified in
 * the bundled `sdk.mjs`: `env = options.env` when provided), so this filtering
 * is real, not advisory. Ordinary runtime settings (PATH/HOME/locale/proxy)
 * survive so stdio MCP servers (`npx …`) and the CLIs' own machinery keep
 * working; nothing that looks like a secret does, and nothing the app's env
 * schema declares does either (ruling 142, {@link APP_CONFIG_ENV}): the rule is
 * "every declared name is stripped, an undeclared name passes", so the child
 * never inherits this server's `NODE_ENV`, `PORT` or data root, while a
 * name the schema does not know is by definition not Viberr's configuration.
 *
 * Ruling 127: this base carries NO provider credential and NO home — the
 * credential names go by {@link CREDENTIAL_ENV_RE}, the two home names by
 * {@link RUNTIME_HOME_ENV_RE}. A run adds back
 * exactly one principal's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (and, for a pasted
 * key, that one key) through `runCredentialFor` — so the child of a run billed
 * to person A can never see person B's credential, and a stale ambient
 * `OPENAI_API_KEY` on the host can never quietly pay for a ChatGPT-workspace
 * run.
 */
export function filteredSpawnEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !CREDENTIAL_ENV_RE.test(entry[0]) &&
        !PRIVATE_RUNTIME_ENV_RE.test(entry[0]) &&
        !RUNTIME_HOME_ENV_RE.test(entry[0]) &&
        !APP_CONFIG_ENV.has(entry[0]),
    ),
  );
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
 * Constructs the two provider adapters (SDK factories injectable for tests).
 *
 * Both get the SAME credential-free base env. The per-run half — the
 * principal's home and, when they pasted one, their key — is merged onto it in
 * `startRun` from `runCredentialFor`, because it differs per run and this
 * factory runs once per process. Building a credential in here is what made
 * one deployment-wide account pay for everybody's runs (ruling 127).
 */
export function createAdapters(deps: AdapterDeps = {}): AdapterSet {
  const claudeDeps: NonNullable<Parameters<typeof createClaudeAdapter>[0]> = {
    env: filteredSpawnEnv(),
  };
  if (deps.claudeQueryFn) claudeDeps.queryFn = deps.claudeQueryFn;
  const codexDeps: NonNullable<Parameters<typeof createCodexAdapter>[0]> = {
    env: filteredSpawnEnv(),
  };
  if (deps.codexFactory) codexDeps.codexFactory = deps.codexFactory;
  return {
    claude: createClaudeAdapter(claudeDeps),
    codex: createCodexAdapter(codexDeps),
  };
}

/**
 * The adapter for a backend.
 *
 * A plain lookup since ruling 127: whether a run may proceed is decided
 * upstream, by resolving its credential principal — `startRun` calls
 * `runCredentialFor` and takes the refusal path before it ever asks for an
 * adapter. The name stays because every caller reads as "pick the runtime for
 * this backend", which is exactly what it still does.
 */
export function selectAdapter(
  backend: RealBackend,
  adapters: AdapterSet,
): RuntimeAdapter {
  return adapters[backend];
}
