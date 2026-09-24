import type { RuntimeAdapter } from "./adapter.server";
import {
  createClaudeAdapter,
  type ClaudeQueryFn,
} from "./claude-runtime.server";
import {
  createCodexAdapter,
  type CodexFactory,
} from "./codex-runtime.server";
import { filteredSpawnEnv } from "./spawn-env.server";

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

// Ruling 142 / 127: the credential-free base every child is spawned on lives
// in `spawn-env.server.ts` (a leaf the git layer imports too).
export { CREDENTIAL_ENV_RE, filteredSpawnEnv } from "./spawn-env.server";

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
