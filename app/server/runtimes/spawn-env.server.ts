import { ENV_KEYS } from "~/server/config/env.server";
import { CLAUDE_AUTO_COMPACT_WINDOW_ENV } from "./context-policy.server";

/**
 * Spawn env hygiene: the base every child the server starts is built on.
 *
 * Split out of `runtime-registry.server.ts` (pass 40 review, R-seams-1) so the
 * git layer builds every git the server spawns on it without importing the two
 * runtime adapters. `runtime-registry.server.ts` re-exports both names, so
 * nothing that imported them from there moved.
 */

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
 * Ruling 137: the two vendor HOME variables, stripped for the same reason the
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
 * Ruling 141 adds `CODEX_SQLITE_HOME`, the CLI's state-db location: the Codex
 * adapter sets it per run to the principal's shared home (the run's own
 * `CODEX_HOME` is a private fork), so an ambient one — a host's `~/.codex`
 * state — must not be what a child inherits when the adapter has nothing to
 * set it to.
 */
const RUNTIME_HOME_ENV_RE = /^(?:CLAUDE_CONFIG_DIR|CODEX_HOME|CODEX_SQLITE_HOME)$/;

/**
 * Ruling 171: the CLI's prompt-cache switches, stripped because the cache
 * lifetime is the CLI's automatic choice and Viberr sets none of them.
 *
 * Not setting them was not enough. None of these names is credential-shaped
 * or declared by the env schema, so one on the host (a developer's shell, a
 * deployment's old `.env`) rode into every Claude child, where
 * `DISABLE_PROMPT_CACHING` would turn caching off for every run the instance
 * makes, `ENABLE_PROMPT_CACHING_1H` would pay the hour's 2x write on every
 * API-key run that 374(a) priced out, and any of them would make ruling 171's
 * `CACHE_TTL_MS`, which the resume verdict and the Insights resume table
 * assume, quietly wrong. The names are the CLI's own (the 2.1.280 bundle),
 * with its per-model and Bedrock variants.
 */
const PROMPT_CACHE_ENV_RE =
  /^(?:DISABLE_PROMPT_CACHING(?:_[A-Z0-9]+)?|ENABLE_PROMPT_CACHING_1H(?:_[A-Z0-9]+)?|FORCE_PROMPT_CACHING_5M|CLAUDE_CODE_(?:SUBAGENT_)?PROMPT_CACHE_TTL)$/;

/**
 * Ruling 171: the CLI's compaction switches, stripped for the same reason: the
 * CLI compacts at its model's own limit, and Viberr compacts a large session at
 * the end of its run with `/compact`.
 *
 * On the host, the window (`CLAUDE_AUTO_COMPACT_WINDOW_ENV`) and
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` would move where every run compacts (a
 * mid-run compaction rewrites the prefix the rest of the run reads from
 * cache), `DISABLE_AUTO_COMPACT` would stop it, and `DISABLE_COMPACT` would
 * refuse the completion compaction itself. A server started from inside a
 * Claude Code session inherits the first two: the container this ruling was
 * written in did, and ruling 171's hermeticity tests failed there.
 *
 * Neither list stops Viberr choosing a value on purpose: a run's own overlay
 * (`spec.env`) is spread over this base, as a window from `contextWindowEnv`
 * would be.
 */
const COMPACTION_ENV: ReadonlySet<string> = new Set([
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "DISABLE_AUTO_COMPACT",
  "DISABLE_COMPACT",
]);

/**
 * Ruling 141(a) (pass 34, U34-7): the app's OWN configuration, stripped for a
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
 * schema declares does either (ruling 141(a), {@link APP_CONFIG_ENV}): the rule is
 * "every declared name is stripped, an undeclared name passes", so the child
 * never inherits this server's `NODE_ENV`, `PORT` or data root, while a
 * name the schema does not know is by definition not Viberr's configuration.
 *
 * Ruling 137: this base carries NO provider credential and NO home — the
 * credential names go by {@link CREDENTIAL_ENV_RE}, the two home names by
 * {@link RUNTIME_HOME_ENV_RE}. A run adds back
 * exactly one principal's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (and, for a pasted
 * key, that one key) through `runCredentialFor` — so the child of a run billed
 * to person A can never see person B's credential, and a stale ambient
 * `OPENAI_API_KEY` on the host can never quietly pay for a ChatGPT-workspace
 * run.
 *
 * Ruling 171: and NO prompt-cache or compaction switch
 * ({@link PROMPT_CACHE_ENV_RE}, {@link COMPACTION_ENV}), so the cache
 * lifetime and the compaction point a run gets are the CLI's own choice, as
 * rulings 171 and 171 decided.
 */
export function filteredSpawnEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !CREDENTIAL_ENV_RE.test(entry[0]) &&
        !PRIVATE_RUNTIME_ENV_RE.test(entry[0]) &&
        !RUNTIME_HOME_ENV_RE.test(entry[0]) &&
        !PROMPT_CACHE_ENV_RE.test(entry[0]) &&
        !COMPACTION_ENV.has(entry[0]) &&
        !APP_CONFIG_ENV.has(entry[0]),
    ),
  );
}
