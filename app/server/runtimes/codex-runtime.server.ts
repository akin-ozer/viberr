import { z } from "zod";
import {
  LOCAL_NETWORK_FAILURE_RE,
  emptyRunFailureFacts,
  localNetworkFailureCode,
  type RunFailureFacts,
} from "~/shared/run-failure";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type {
  Codex as CodexSdk,
  CodexOptions,
  ModelReasoningEffort,
  Thread,
  ThreadErrorEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import {
  answeredStep,
  postTurnTransportLine,
  RUN_PHASE,
  stepUpdateForLine,
  viberrLine,
  type RunCallbacks,
  type CompactCallbacks,
  type CompactOutcome,
  type RunHandle,
  type RunSpec,
  type RuntimeAdapter,
} from "./adapter.server";
import { withProviderText } from "~/shared/provider-marker";
import {
  codexUsageTail,
  SESSION_DAMAGED_RE,
  SESSION_MISSING_RE,
  SESSION_STORE_UNREADABLE_MARK,
  SESSION_STORE_UNREADABLE_RE,
} from "./session-export.server";
import {
  codexCompactionHomeId,
  finishCodexRunHome,
  prepareCodexRunHome,
  type CodexRunHome,
  type RunHomePerson,
} from "./user-homes.server";
import { removeAgentTreeSync } from "./agent-trees.server";
import { projectEnvelope } from "./wire-format.server";
import { causeMessages, redactProviderText } from "~/server/secrets/git-output-redact.server";
import {
  reapRunProcesses,
  RUN_MARKER_ENV,
  type ReapRunProcesses,
  compactionMarkerEnv,
} from "./run-processes.server";
import { RUN_TMP_ENV_KEYS } from "./run-tmp.server";
import { codexCompactionConfig } from "./context-policy.server";
import {
  codexVendor,
  compactCodexThread,
  withPathDirs,
  type SpawnAppServer,
  type ThreadResumeConfig,
} from "./codex-app-server.server";
import {
  launchEnv,
  prepareAgentPath,
  shareFileForAgentsToRead,
  type AgentLaunch,
} from "./agent-isolation.server";
import { joinedPrompt, sortedNames, sortedRecord } from "./prompt-prefix.server";
import { BROWSER_MCP_NAME, BROWSER_TOOL_TIMEOUT_SEC } from "~/server/tasks/browser-deadline.server";
import { errorMessage, toError } from "~/shared/errors";

/**
 * Codex adapter — the OFFICIAL Codex SDK (`@openai/codex-sdk`, verified against
 * {@link CODEX_SDK_VERIFIED_VERSION}, which a test pins to the DECLARED
 * dependency; 0.146.0 → 0.153.4 moved the SDK's surface in three additive
 * places, listed on that constant, and none of the event shapes this adapter
 * or the wire normalizer reads; 0.153.4 → 0.156.0 → 0.160.1 moved only the
 * pinned CLI).
 * `new Codex()`, `codex.startThread({ workingDirectory,
 * skipGitRepoCheck, sandboxMode, model })` (or `resumeThread(threadId, …)`),
 * then `thread.runStreamed(prompt, { signal })` → `{ events }`, an async
 * generator of the ThreadEvents documented in runtime-adapters.md §2.3
 * (thread.started → thread_id; turn.started/completed with usage incl.
 * cached_input_tokens; item.started/updated/completed variants; turn.failed;
 * error). Each event is persisted as raw_json via `JSON.stringify(event)`
 * and projected through the shared normalizer. Tokens only, no dollar cost. A
 * run is one turn, whose usage the SDK streams only as it ends, so a run's
 * Turns and Tokens come off the rollout after each model call (ruling 165(b)).
 *
 * Interrupt: the SDK's `TurnOptions.signal` (AbortSignal) — we pass an
 * AbortController and abort it. Resume: `codex.resumeThread(threadId)`.
 * Success is gated on seeing `turn.completed` with no TOP-LEVEL
 * `turn.failed`/`error` (an item whose type is `error` is explicitly non-fatal
 * in the SDK contract). The SDK spawns the codex binary internally; startup or
 * runtime failures are surfaced as sanitized failed runs.
 *
 * Auth: whatever the run's CREDENTIAL PRINCIPAL connected (ruling 137) — the
 * `codex login` the vendor binary wrote into that person's `CODEX_HOME`, or a
 * `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` they pasted. Both arrive on
 * `spec.env`, assembled by `runCredentialFor` in the run service; this adapter
 * reads no credential of its own. The SDK factory is injectable so tests drive
 * fakes — real Codex is NEVER invoked.
 */

/**
 * The `@openai/codex-sdk` release this adapter (and the effort catalog) was
 * verified against.
 *
 * D5/pass-16: the header claimed v0.144.1 while the dependency had moved to
 * 0.146.0, and nothing could tell — a version claim in prose is unfalsifiable.
 * It lives here as a constant so `codex-runtime.server.test.ts` can assert it
 * against package.json: bumping the dependency without re-reading this adapter
 * now fails a test instead of quietly rotting a docstring.
 *
 * 0.153.4 (2026-09-06, from 0.146.0): the SDK's own surface moved in three
 * places only — `CodexOptions.configOverrides` (raw `--config key=value`
 * strings; Viberr keeps the structured `config`), `ThreadOptions.threadSource`
 * (a rollout source label; not sent, its accepted values are the CLI's) and
 * the `ModelReasoningEffort` union, which gained `max`, `ultra` and
 * `persistent` (see `resolveCodexReasoningEffort`). Every flag the SDK emits
 * (`exec --experimental-json` as the hidden alias of `--json`, `--sandbox`,
 * `--cd`, `--add-dir`, `--skip-git-repo-check`, `--output-schema`) and every
 * config key `codexConfigForRun` writes were re-checked against the bundled
 * 0.153.4 binary, as were the `login --device-auth` prompt (byte-identical
 * source) and `login status` markers `backend-login` parses. `--add-dir` still
 * reads "writable alongside the primary workspace", so the ruling-183 carve-out
 * (ruling 144: `danger-full-access`, always) stands.
 *
 * 0.156.0 (2026-09-23, from 0.153.4, owner's request for GPT-6 Luna): the
 * SDK's own `dist` is byte-identical, so only the pinned CLI moved. The move
 * is the point: the account's server-sent model list is filtered by client
 * version, and GPT-6 Luna and GPT-6 Sol declare `minimal_client_version`
 * 0.155.0, so a 0.153.4 client was never offered either (its cached list, read
 * off the account's own home, had no `gpt-6-*` but Astra). Re-checked on the
 * 0.156.0 binary: every flag the SDK emits parses (a real `exec` with all of
 * them reached the API and stopped at the 401 of an empty home), every config
 * key `codexConfigForRun` writes is present, as are `thread/compact/start`,
 * the `contextCompaction` item and the `login` markers `backend-login` reads.
 * `--help` after a value flag now exits 2 where 0.153.4 exited 0, which is the
 * CLI's argument parser, not a flag it lost.
 *
 * Ruling 165(b), measured on the 0.156.0 binary: the rollout carries a top-level
 * `token_usage_record` per model call (the call's usage, the turn's running
 * total and the thread's), written before the tool the call asked for runs,
 * which the live Turns and Tokens read (`codexUsageTail`); and a resumed
 * thread's `turn.completed.usage` is the THREAD's running total, where ruling
 * 172 had measured the turn's on runs stored before this bump. A bump
 * re-checks both.
 *
 * 0.160.1 (2026-10-07, from 0.156.0, the dependency refresh): the SDK's own
 * `dist` is byte-identical again, so only the pinned CLI moved. Re-checked on
 * the 0.160.1 binary: `exec --help` and `login --help` print byte-identical
 * text to 0.156.0's; a real `exec` with every flag the SDK emits and every
 * config key `codexConfigForRun` writes (the `mcp_servers` leaves included)
 * parsed, reached the API and stopped at the 401 of an empty home, streaming
 * the same `thread.started` / `turn.started` / `error` / `turn.failed` shapes;
 * `login status` still prints "Not logged in"; and the binary still carries
 * `thread/compact/start`, `contextCompaction`, `token_usage_record` and the
 * device-flow "Enter this one-time code". Ruling 165(b)'s two facts were measured
 * against a scripted local Responses server (a `model_providers` entry, every
 * call answering 1234 input tokens): the rollout carries one
 * `token_usage_record` per call, and `exec resume` of the thread reported
 * `turn.completed.usage.input_tokens` 2468, the thread's running total.
 */
export const CODEX_SDK_VERIFIED_VERSION = "0.160.1";

/** Narrow injectable seam, derived from the installed SDK's public types. */
export type CodexThread = Pick<Thread, "id" | "runStreamed">;
export type CodexClient = {
  startThread(...args: Parameters<CodexSdk["startThread"]>): CodexThread;
  resumeThread(...args: Parameters<CodexSdk["resumeThread"]>): CodexThread;
};
export type CodexFactory = (options?: CodexOptions) => CodexClient;

interface CodexAdapterDeps {
  /** Injected Codex factory (default: the real SDK, imported lazily). */
  codexFactory?: CodexFactory;
  /** The credential-free base spawn env (`filteredSpawnEnv`). The run's own
   *  overlay — its principal's CODEX_HOME and, for a pasted credential, that
   *  one key — arrives on `spec.env` and is merged over this. There is no
   *  `apiKey` dep: the SDK's own `apiKey` option does nothing but set
   *  `env.CODEX_API_KEY` (verified in @openai/codex-sdk/dist/index.js), which
   *  is exactly what `runCredentialFor` already puts there for the ONE person
   *  the run bills (ruling 137). */
  env?: Record<string, string>;
  /** Ruling 174: how the completion compaction starts `codex app-server`
   *  (a test scripts the JSON-RPC exchange over pipes of its own). */
  spawnAppServer?: SpawnAppServer;
  /** Ruling 142: the sweep that runs once a marked run has settled (default:
   *  the real one). */
  reapProcesses?: ReapRunProcesses;
}

type CodexConfig = NonNullable<CodexOptions["config"]>;

/** One portable MCP declaration, decoded from the opaque value `RunSpec` carries
 * (the two SDKs disagree on the shape, so nothing upstream can type it). Arms
 * are tried in order and mirror the CLI's own resolution: an in-process `sdk`
 * server decodes to `null` (present, nothing to translate), an `http` server
 * needs a real `url`, everything else is a stdio command. A value matching no
 * arm is dropped — including a stdio declaration whose `args` array holds a
 * non-string, because translating a half-declared server would silently change
 * the command the profile wrote. */
const codexMcpServerSchema = z.union([
  z.object({ type: z.literal("sdk") }).transform(() => null),
  z
    .object({
      type: z.literal("http"),
      url: z.string(),
      /** Ruling 191: a gateway mount's run token. A header map that is not
       *  all strings is not a declaration of one and reads as absent. */
      headers: z.record(z.string(), z.string()).optional().catch(undefined),
    })
    .transform((server) => ({
      transport: "http" as const,
      url: server.url,
      headers: server.headers ?? {},
    })),
  z
    .object({
      command: z.string(),
      /** A non-array `args` is not a declaration at all and reads as absent;
       *  only a partially malformed ARRAY rejects the whole server. */
      args: z.preprocess(
        (raw) => (Array.isArray(raw) ? raw : undefined),
        z.array(z.string()).optional(),
      ),
    })
    .transform((server) => ({
      transport: "stdio" as const,
      command: server.command,
      args: server.args ?? [],
    })),
]);

/**
 * What a stdio server is started with beyond the CLI's short default
 * environment: the run marker (ruling 142) and the run's own temporary
 * directory (ruling 141(c)), so a browser it launches writes its profile there and
 * the settle removes it. Ids and paths, never secrets, so argv is a fine place.
 */
const STDIO_SERVER_ENV_KEYS = [RUN_MARKER_ENV, ...RUN_TMP_ENV_KEYS] as const;

/**
 * Ruling 146: how long the CLI may take to start a required MCP server. A
 * minute is room for a stdio server that installs on its first start (`uvx`)
 * and for the gateway to reach a remote upstream; a server that has not
 * started by then ends the run before the model is called.
 */
const MCP_REQUIRED_STARTUP_TIMEOUT_SEC = 60;

function stdioServerEnv(runEnv: RunSpec["env"]) {
  const out: Partial<Record<(typeof STDIO_SERVER_ENV_KEYS)[number], string>> = {};
  for (const key of STDIO_SERVER_ENV_KEYS) {
    const value = runEnv?.[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Translate only the portable external-server subset shared by both SDKs.
 * Claude's in-process `{ type: "sdk" }` server has no Codex equivalent and is
 * intentionally skipped rather than serialized into invalid CLI config.
 *
 * NAMING (P13-LV-15, vendor behavior, disclosed not normalized): the two CLIs
 * derive a different tool prefix from the SAME declared server name — Claude
 * mounts `mcp__everything-http__echo`, the Codex CLI lowercases hyphens to
 * underscores and mounts `mcp__everything_http__echo`. Viberr passes the
 * declared name through unchanged on both, so a persona/skill/directive that
 * names a tool LITERALLY works on one backend and not the other. Nothing here
 * can fix that (the transform is inside the codex binary); the honest fix is a
 * caveat on the MCP admin surface — see the pass-13 report.
 *
 * NOTE also that this config does not REMOVE servers the run home declares —
 * the CLI merges `--config` per dotted leaf key. That is why runs get an
 * a per-person CODEX_HOME (`user-homes.server.ts`) instead of the host's.
 *
 * Ruling 142: a stdio server is started with the CLI's short default
 * environment plus its declared `env`, so the run marker is declared there —
 * it is an id, not a secret, and argv is a fine place for it — and whatever
 * the server launches (a browser, a language server) inherits it.
 *
 * Ruling 188: a server's admin-marked write tools, on a run that withholds
 * repo write, become its `disabled_tools` (a per-server key the pinned CLI
 * reads, alongside `enabled_tools`). Tool names, not secrets, so argv is fine
 * here too.
 *
 * Ruling 191: an HTTP server's `headers` become its `http_headers` (the pinned
 * CLI's per-server table for a Streamable HTTP server). The only headers a
 * portable config carries are a gateway mount's `Authorization: Bearer <run
 * token>`: never a credential — the credential stays in Viberr's gateway — and
 * a token that opens only this run's grants, only through the loopback
 * gateway and only while this run is live, so argv is an acceptable place for
 * it. That is what ended "a credentialed org MCP connects unauthenticated on
 * Codex" (F40-3): both backends now get the same gateway config.
 *
 * Ruling 146: every server is `required` unless the run names it optional.
 * The CLI starts MCP servers in the background and builds a turn's tools from
 * the ones ready when the turn starts; a run is one turn, so a server a second
 * late was missing for the whole run and nothing said so (live: AWSC-106's
 * rework had no board readers, and 16 of 31 runs whose agent printed its tools
 * lacked a server Viberr mounted). A required server is started before the
 * first turn, within `MCP_REQUIRED_STARTUP_TIMEOUT_SEC`, and one that cannot
 * start ends the session before the model is called. An optional server is a
 * mount whose probe already failed: the prompt says it may be missing, so it
 * must not stop the run. */
function codexMcpServers(
  servers: RunSpec["mcpServers"],
  runEnv: RunSpec["env"],
  toolDenials: RunSpec["mcpToolDenials"] = [],
  optional: RunSpec["mcpOptional"] = [],
): CodexConfig {
  const serverEnv = stdioServerEnv(runEnv);
  const translated: CodexConfig = {};
  const optionalNames = new Set(optional);
  /** Ruling 146: the CLI starts this server before the first turn, or fails. */
  const startFirst = (server: CodexConfig, name: string) => {
    if (optionalNames.has(name)) return;
    server.required = true;
    server.startup_timeout_sec = MCP_REQUIRED_STARTUP_TIMEOUT_SEC;
  };
  // Ruling 169: servers in name order and their withheld tools sorted, so two
  // runs of one profile hand the CLI the same argv whatever order the grants
  // were stored in.
  for (const [name, value] of Object.entries(sortedRecord(servers ?? {}))) {
    if (!name) continue;
    const declaration = codexMcpServerSchema.safeParse(value);
    if (!declaration.success || declaration.data === null) continue;
    const disabledTools = sortedNames(
      toolDenials
        .filter((denial) => denial.server === name)
        .flatMap((denial) => denial.tools),
    );

    if (declaration.data.transport === "http") {
      const http: CodexConfig = {
        url: declaration.data.url,
        default_tools_approval_mode: "approve",
      };
      // Ruling 191: the gateway mount's run token (see the docstring).
      if (Object.keys(declaration.data.headers).length) {
        http.http_headers = sortedRecord(declaration.data.headers);
      }
      if (disabledTools.length) http.disabled_tools = disabledTools;
      startFirst(http, name);
      translated[name] = http;
      continue;
    }

    const stdio: CodexConfig = {
      command: declaration.data.command,
      default_tools_approval_mode: "approve",
    };
    // An empty `args` is not the same declaration as none at all.
    if (declaration.data.args.length) stdio.args = declaration.data.args;
    if (Object.keys(serverEnv).length) stdio.env = serverEnv;
    if (disabledTools.length) stdio.disabled_tools = disabledTools;
    // Ruling 146: the browser's supervisor answers a stuck call at its own
    // deadline, saying the browser was restarted, so Codex must still be
    // waiting then; its default gives up first and says only "timed out".
    if (name === BROWSER_MCP_NAME) stdio.tool_timeout_sec = BROWSER_TOOL_TIMEOUT_SEC;
    startFirst(stdio, name);
    translated[name] = stdio;
  }
  return translated;
}

/**
 * Do not cast arbitrary profile strings into the SDK's closed effort union.
 *
 * The union (SDK 0.153.4) is `minimal | low | medium | high | xhigh | max |
 * ultra | persistent`. Two members are deliberately NOT forwarded even though
 * the type would allow them: `ultra` is "maximum reasoning with automatic task
 * delegation" in the bundled catalog — the model spawning its own sub-agents,
 * which is the orchestration Viberr reserves for the operator and denies on
 * Claude through the whole Task family (`BASE_DENIED_BUILTINS`) — and
 * `persistent` is supported by no bundled model at all. Neither is offered by
 * the catalog (`CODEX_EFFORTS`), so a value that reaches here is a stored one
 * from before this fence; it falls back to the CLI default rather than run a
 * tier the deployment never chose.
 */
function resolveCodexReasoningEffort(
  effort?: string,
): ModelReasoningEffort | undefined {
  switch (effort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    default:
      return undefined;
  }
}

/**
 * Per-run env that must cross into the model's OWN shell (as opposed to the
 * CLI's process env, which carries subscription auth and must not leak to
 * tools). `shell_environment_policy.inherit: "core"` strips everything else, so
 * anything Viberr promises the agent's shell has to be named here.
 *
 * P13-RT-10: `agentGitIdentityEnv` documents "these override any `git config`
 * the agent sets … so codex and claude are indistinguishable in the git
 * history". That only held on Claude (whose spec.env is merged into the whole
 * child env); on Codex the identity was stripped before any `git commit` the
 * agent ran, leaving the repo-local `git config user.*` written at clone as the
 * only mechanism — a weaker guarantee than the docstring claims, and none at
 * all when `setIdentity` failed.
 *
 * Ruling 142: the run marker crosses too, so a command the model backgrounds
 * (`npm run dev &`) carries it and the settle sweep can find it after the CLI
 * is gone.
 *
 * Ruling 141(c): so does the run's own temporary directory, named rather than
 * left to "core", which is the CLI's list to change.
 */
const SHELL_EXPORTED_ENV_KEYS = [
  "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  RUN_MARKER_ENV,
  ...RUN_TMP_ENV_KEYS,
] as const;

/** The `shell_environment_policy.set` table — closed over the keys above, so a
 *  new promise to the agent's shell has to be declared there first. */
type ShellExportedEnv = Partial<
  Record<(typeof SHELL_EXPORTED_ENV_KEYS)[number], string>
>;

function shellExportedEnv(spec: RunSpec) {
  const out: ShellExportedEnv = {};
  for (const key of SHELL_EXPORTED_ENV_KEYS) {
    const value = spec.env?.[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Config inherited by the Codex CLI is distinct from the environment exposed
 * to shell commands the model runs. Keep the former intact for subscription
 * auth, while using the CLI's supported shell policy to expose only platform
 * essentials to generated commands.
 *
 * ISOLATION (P13-LV-13 / LV-14 / RT-04): the CLI merges `--config` overrides
 * into whatever `$CODEX_HOME/config.toml` already declares, so config alone
 * cannot close the host channels — the run's PER-PERSON home
 * (`userBackendHome`, ruling 137) is what does. These keys are the
 * second half of the same fence, because the CLI RE-INSTALLS its five bundled
 * `.system` skills into *any* home on startup (verified with
 * `codex debug prompt-input` on a pristine home: `imagegen`, `openai-docs`,
 * `plugin-creator`, `skill-creator`, `skill-installer` were still advertised),
 * and because the repo's own `AGENTS.md` is read from the WORKSPACE, not the
 * home. On THIS backend Viberr injects every granted skill/KB doc as prompt
 * text, so a run needs none of the CLI's own instruction sources.
 *
 * That injection is now backend-ASYMMETRIC, deliberately. Claude gained a native
 * skills mechanism this pass (`mountGrantedSkills` + the SDK's `skills` filter),
 * so a Claude run receives each granted skill's metadata and loads the body only
 * when it invokes one. The Codex CLI has no equivalent to switch on — its whole
 * skills channel is severed right below, precisely because it cannot be governed
 * per-skill — so Codex keeps the prompt-text injection. Same grants, same craft,
 * two carriers; the alternative would be re-opening this channel to a CLI that
 * re-installs its own bundled skills into any home.
 */
function codexConfigForRun(spec: RunSpec): CodexConfig {
  const exported = shellExportedEnv(spec);
  const shellEnvironmentPolicy: CodexConfig = {
    inherit: "core",
    ignore_default_excludes: false,
  };
  // Only NAME a `set` table when there is something to promise — an empty one
  // is not the same declaration as none at all.
  if (Object.keys(exported).length) shellEnvironmentPolicy.set = exported;

  const config: CodexConfig = {
    // This and the shell policy below keep the principal's CODEX_ACCESS_TOKEN
    // (or any other credential on the CLI's own process env) from tools the
    // model runs.
    allow_login_shell: false,
    // RT-04: the checked-out repo's `AGENTS.md` (and any fallback project doc)
    // is otherwise merged into the run's INSTRUCTIONS at a higher trust tier
    // than the repository contents the trust-boundary block calls untrusted —
    // a prompt-injection ingress with no Claude counterpart (`settingSources:
    // []` means a repo's CLAUDE.md never loads). 0 bytes = never read one.
    project_doc_max_bytes: 0,
    // LV-13: drop the CLI's whole skills channel. `include_instructions: false`
    // removes the "## Skills" block (bundled + user-installed alike);
    // `bundled.enabled: false` additionally refuses the `.system` set the CLI
    // self-installs into EVERY home on startup. Both keys were confirmed
    // effective, and near-miss keys (`skills.enabled`, `skills.disabled`,
    // `skills.roots`) confirmed inert, with `codex debug prompt-input` against
    // codex-cli 0.144.6. `bundled` is a STRUCT there — a bare
    // `skills.bundled = false` makes the CLI refuse to load its configuration
    // at all ("invalid type: boolean, expected struct BundledSkillsConfig"),
    // which would fail every run.
    skills: {
      include_instructions: false,
      bundled: { enabled: false },
    },
    features: {
      // Viberr exposes only a profile's declared external MCPs; ambient
      // ChatGPT apps/connectors must not appear as extra tools.
      apps: false,
      // LV-13/LV-14 defense in depth: a plugin contributes BOTH skills and MCP
      // servers (the host leak included `github:yeet` and a plugin-supplied
      // `sites-design-picker` server). A person's own codex home carries no
      // plugins, but a home that somehow gained one (the vendor binary writes
      // there too) must not re-open the channel. Hooks are host-configured
      // shell callbacks — same class.
      plugins: false,
      hooks: false,
    },
    // Match Claude's per-run isolation: no cross-run memory generation,
    // injection, or memory-specific tools from the managed Codex home.
    memories: {
      generate_memories: false,
      use_memories: false,
      dedicated_tools: false,
    },
    // The SDK accepts arbitrary supported CLI config overrides. Translate the
    // portable HTTP/stdio declarations so a run sees only the MCPs its
    // profile selected. NOTE: the CLI merges this per-leaf-key into
    // `$CODEX_HOME/config.toml`, so it removes nothing the home declares —
    // the app-owned run home is what makes this exhaustive.
    mcp_servers: codexMcpServers(spec.mcpServers, spec.env, spec.mcpToolDenials, spec.mcpOptional),
    shell_environment_policy: shellEnvironmentPolicy,
  };
  // The persona/expertise prompt, only when the run carries one, so the key
  // never lands empty. Ruling 169: a prompt split is the same text in the
  // same order, joined — Codex has no boundary to hand it to.
  if (spec.systemPrompt) config.developer_instructions = joinedPrompt(spec.systemPrompt);
  // Ruling 170: a specialist's context is compacted at the shared window,
  // with the shared summarizer prompt; a kind with no window (the operator)
  // sets none of the three keys and keeps the CLI's own default.
  Object.assign(config, codexCompactionConfig(spec.kind));
  return config;
}

/**
 * Ruling 144 (owner, 2026-09-12, pass 36): **Viberr does not confine a Codex
 * run with the CLI's OS sandbox.** Every Codex run is started
 * `danger-full-access`; the boundary is Viberr's own — the prompt contract,
 * the per-engagement workspace isolation (P8), the server-owned delivery gate
 * and the revision-bound verdicts — exactly the R22 position ("viberr IS the
 * sandbox"), which the 2026-08-31 parity ruling had partly reversed.
 *
 * Why it came back: the sandbox cost more than it bought. F36-1 — bubblewrap
 * cannot create a user namespace under Docker's default seccomp profile, so
 * EVERY confined run failed at its first shell command and the model reported
 * the environment as a verdict; the remedy was to run the whole container
 * `seccomp=unconfined`. F36-11 — with the network off the CLI installs a
 * seccomp filter that refuses every socket syscall, `AF_UNIX` included, so
 * Node's synchronous `child_process` (npm, and most build and test tooling)
 * fails with `EPERM` after the child already ran; a confined reviewer could
 * not run the project's gate, and the review gate deadlocked on it (live
 * HLC-18, 2026-09-12). Both are upstream and neither is expressible as a
 * Viberr rule. Removing the sandbox removes both, and lets the container keep
 * Docker's own seccomp profile.
 *
 * What that costs, stated plainly and rendered everywhere it matters: on
 * Codex a withheld repo-write family is ADVISORY (the prompt omits the steps,
 * the delivery gate refuses them — `codexRepoWriteAdvisory`), and the
 * operator's OS-level network is no longer forced off. Web SEARCH still binds
 * on both backends (`webSearchMode: "disabled"`), because that is the CLI's
 * own tool, not the OS sandbox. Claude is unchanged: its tool denylist was
 * always the channel there.
 */

/** The idle (inactivity) timeout for a codex run in ms — the window a single
 *  turn/tool may produce no event before the run is treated as hung. Overridable
 *  via VIBERR_CODEX_IDLE_TIMEOUT_MS; defaults to 15 minutes (owner ruling A8;
 *  the default and the parse live in the env schema, ruling 39). */
function codexIdleTimeoutMs(): number {
  return getEnv().VIBERR_CODEX_IDLE_TIMEOUT_MS;
}

/**
 * After an interrupt or idle-abort has SIGTERM'd the codex child (via the SDK's
 * spawn signal), how long to wait for the stream to actually end before
 * force-settling the run. The abort IS the kill lever here — unlike the Claude
 * adapter's cooperative `interrupt()` — but a child that survives SIGTERM (a
 * trapped signal, or a grandchild holding the stdout pipe open) never ends the
 * iterator, so without this the row sits `running` until the next restart's
 * orphan sweep: the Stop-did-nothing defect, on the other backend. The settle
 * that follows sweeps that child and the grandchild by the run marker (ruling
 * 142), so the row and the processes end together.
 */
export const INTERRUPT_SETTLE_GRACE_MS = 20_000;

/** CLI failures can include stderr and command lines. Those may contain
 * credentials, so the raw text is never logged unscrubbed — but R20-3 settled
 * that a REDACTED provider complaint is loggable (ruling 219), so instead of
 * discarding it we keep the scrubbed sentence. Falls back to the class-only
 * message when the scrub finds nothing usable. */
function safeCodexError(cause: unknown): Error {
  const safe = new Error(
    redactProviderText(cause) || "Codex SDK/CLI execution failed.",
  );
  safe.name = cause instanceof Error ? cause.name : "Error";
  return safe;
}

/** The adapter's own failure classes, matched against the raw error while it is
 * still in memory. Persisted (as a tag suffix on the terminal err line) so the
 * escalation path can route quota/auth without ever re-reading the redacted
 * stderr. Mirrors the routing classes `runFailureReason` (agent-reply) returns;
 * "unavailable" is the fail-fast (no credential) class handled upstream, never
 * here — the codex process only reaches this classifier once it has started. */
export type CodexFailureKind =
  | "quota"
  | "auth"
  /** Parity with the Claude adapter's class of the same name: the PROVIDER
   *  could not serve the run (overloaded, 5xx, "service unavailable"). Codex
   *  streams no structured status, so this leg is prose-only, on the same
   *  signatures the run projection has always read as backend unavailability
   *  (`BACKEND_UNAVAILABLE_SIGNATURES`). The remedy is a retry, so it must not
   *  fall to `unknown` and its "review its authentication" advice. */
  | "overloaded"
  | "idle_timeout"
  /** P13-D-2: the rollout behind the resumed session id is gone from
   *  `$CODEX_HOME/sessions`. `resumeRun`'s pre-flight probe normally catches
   *  this and re-anchors before spawning; this covers the case where the SDK
   *  finds out first (a transcript swept between the probe and the spawn). */
  | "session_missing"
  | "unknown";

/** The classifier's whole output: the routing class, the canonical sentence a
 *  human reads, and the provider's own words after redaction. */
interface CodexFailure {
  kind: CodexFailureKind;
  message: string;
  providerText: string;
  /** U35-11: where an `overloaded` failure happened (see `RunFailureFacts`);
   *  null for every other kind. */
  origin: RunFailureFacts["origin"];
}

/** Ruling 146: what the CLI writes when a required MCP server did not start,
 *  followed by `<server>: <reason>` for each, `; ` between them. */
const REQUIRED_MCP_FAILED_MARK = "required MCP servers failed to initialize: ";

/** Ruling 146: the servers a session failed on, by the names the CLI gives
 *  them, or null when no required server failed. Only a name is kept: the
 *  reasons are the CLI's own transport errors. */
function requiredMcpServersThatFailed(raw: string): string[] | null {
  if (!raw.includes(REQUIRED_MCP_FAILED_MARK)) return null;
  const names = new Set<string>();
  for (const after of raw.split(REQUIRED_MCP_FAILED_MARK).slice(1)) {
    for (const entry of (after.split("\n")[0] ?? "").split("; ")) {
      const name = entry.split(": ")[0]?.trim() ?? "";
      if (/^[\w.-]+$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** "the MCP server `a` it mounts", "the MCP servers `a` and `b` it mounts". */
function mountedServersPhrase(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length === 0) return "an MCP server it mounts";
  if (quoted.length === 1) return `the MCP server ${quoted[0]} it mounts`;
  return `the MCP servers ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} it mounts`;
}

/** Classify a provider failure IN MEMORY before its raw text is redacted, and
 * pair the class with a redaction-safe canonical message. The raw error can
 * echo stderr, command lines, or credentials, so ONLY the class and the
 * canonical sentence ever leave this function — the raw text is never returned,
 * logged, or persisted. The class is what survives to `runFailureReason`; the
 * message is deliberately generic (and does not necessarily re-match the
 * downstream regexes), which is exactly why the class rides the tag instead. */
function classifyCodexFailure(
  cause: unknown,
  phase: "start" | "execution",
  // F22-08: the reason the SDK streamed as a `turn.failed` / `error` event,
  // when one was seen. The thrown `cause` is only the exit banner ("exited with
  // code 1: Reading prompt from stdin..."), so classifying on it alone routes a
  // usage-limit run to the generic auth/config branch and drops the retry date.
  // When present, this text drives BOTH the class regexes and the provider text.
  streamText?: string | null,
): CodexFailure {
  const parts = causeMessages(cause);
  if (streamText) parts.unshift(streamText);
  const raw = parts.join("\n");
  // R20-3 (F20-4): the provider's OWN words, scrubbed. The canonical `message`
  // stays generic (and the class rides the tag), but the redacted sentence is
  // now surfaced beside it so a human can act on "model is not supported when
  // using Codex with a ChatGPT account" instead of "review the configuration".
  // Prefer the streamed reason (F22-08) — it is the sentence a human can act on.
  const providerText = redactProviderText(streamText ?? cause);
  // P13-D-2 before the auth branch: a missing rollout is not a credential
  // problem, and telling a human to "review the configured subscription
  // credential" for it sends them to the one place that is definitely fine.
  // Ruling 162 (F37-41): the store is THERE and unreadable — same class, same
  // remedy, different sentence. Before the auth branch for the same reason the
  // vanished-rollout check is: live, "file is not a database" was reported as
  // "review the configured subscription credential", with "redirect with
  // sharper guidance" recommended, for a corrupt file on this host's disk.
  if (SESSION_STORE_UNREADABLE_RE.test(raw)) {
    return {
      kind: "session_missing",
      message:
        `The Codex session could not be resumed: the CLI's own ${SESSION_STORE_UNREADABLE_MARK}. ` +
        "Nothing is wrong with the credential and no rewritten directive changes it: every resume " +
        "fails until that file is repaired or removed, while fresh runs still work. Re-run the " +
        "agent to start a fresh session anchored on task.md.",
      providerText,
      origin: null,
    };
  }
  // Ruling 162: the rollout is there and its head is torn. The resume probe
  // catches this before a spawn; this is the run that got there first.
  if (SESSION_DAMAGED_RE.test(raw)) {
    return {
      kind: "session_missing",
      message:
        "The Codex session could not be resumed. Its rollout is damaged: the CLI says it does not " +
        "start with the session's metadata. Nothing is wrong with the credential and no rewritten " +
        "directive changes it: every resume of this session fails, while fresh runs still work. " +
        "Re-run the agent to start a fresh session anchored on task.md.",
      providerText,
      origin: null,
    };
  }
  if (SESSION_MISSING_RE.test(raw)) {
    return {
      kind: "session_missing",
      message:
        "The Codex session could not be resumed: its rollout no longer exists under $CODEX_HOME/sessions. Nothing is wrong with the credential; the conversation history is gone. Re-run the agent to start a fresh session anchored on task.md.",
      providerText,
      origin: null,
    };
  }
  // Ruling 146: a required MCP server did not start. Before the quota, auth
  // and network branches: its stderr carries the server's own transport error
  // ("error sending request for url"), which the network branch would read as
  // this deployment failing to reach Codex.
  const failedServers = requiredMcpServersThatFailed(raw);
  if (failedServers) {
    return {
      kind: "unknown",
      message:
        `Codex could not start this run: ${mountedServersPhrase(failedServers)} did not start, and a run ` +
        "starts only with every server it mounts (ruling 146). Nothing reached the model. Run the agent " +
        "again. If it fails the same way, the server is down: retest it in Instance settings → MCP " +
        "servers, or take it off the agent's grants.",
      providerText,
      origin: null,
    };
  }
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(raw)) {
    return {
      kind: "quota",
      message:
        "Codex usage limit was reached. Retry after the subscription limit resets.",
      providerText,
      origin: null,
    };
  }
  if (
    /unauthor|forbidden|invalid.*(?:key|token|credential)|\b401\b|\b403\b|not logged in|authenticate|authentication/i.test(
      raw,
    )
  ) {
    return {
      kind: "auth",
      message:
        "Codex authentication failed. Review the configured subscription credential.",
      providerText,
      origin: null,
    };
  }
  // U35-11 (pass 35): a connection that failed BEFORE the provider answered
  // (TLS, DNS, a refused or reset socket) is the deployment's own network
  // path, not the provider's side. Same class and the same retry, its own
  // origin and sentence; parity with the Claude adapter. Codex streams no HTTP
  // status, so an explicit 5xx in the prose is the provider's answer and wins.
  if (
    !/\b5(?:0[023]|29)\b/.test(raw) &&
    LOCAL_NETWORK_FAILURE_RE.test(raw)
  ) {
    const code = localNetworkFailureCode(raw);
    return {
      kind: "overloaded",
      message: `Codex could not be reached from this deployment: the connection failed before the provider answered${code ? ` (${code})` : ""}. Nothing about the account or the task is wrong; check this deployment's network path (TLS, DNS, proxy) and retry in a few minutes.`,
      providerText,
      origin: "local",
    };
  }
  if (
    /overloaded|\bat capacity\b|\b5(?:0[023]|29)\b|temporarily unavailable|service unavailable|server error/i.test(
      raw,
    )
  ) {
    return {
      kind: "overloaded",
      message:
        "Codex could not serve this run: the provider was overloaded or failed on its own side. Nothing about the account or the task is wrong; retry in a few minutes.",
      providerText,
      origin: "provider",
    };
  }
  return {
    kind: "unknown",
    message:
      phase === "start"
        ? "Codex could not start. Review its authentication and runtime configuration."
        : "Codex execution failed. Review its authentication and runtime configuration.",
    providerText,
    origin: null,
  };
}

/** F22-08: the reason on a fatal stream event, decoded at the I/O boundary. An
 *  `error` event carries `.message`; a `turn.failed` event carries
 *  `.error.message`. Both are optional and best-effort — a shape the reader does
 *  not recognize simply yields no message and the run falls back to the thrown
 *  error's text. */
const fatalEventMessageSchema = z
  .object({
    message: z.string().optional().catch(undefined),
    error: z
      .object({ message: z.string().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .catch({});

/**
 * Ruling 139: what hands a path in the principal's home to their uid (the
 * launcher's `--prepare-home`) — the run home the server just forked, the
 * sign-in it wrote back — and, ruling 140, what removes the run home as them
 * (their CLI wrote it). None when the run is not launched.
 */
function agentOwner(agent: AgentLaunch | undefined): RunHomePerson | undefined {
  if (!agent) return undefined;
  return {
    own: (target) => prepareAgentPath(agent.uid, target, agent.launcher),
    remove: (target) => removeAgentTreeSync(target, agent),
  };
}

/** The one argument of the SDK's private `CodexExec.run` this adapter reads
 *  (dist/index.js). */
interface CodexExecArgs {
  outputSchemaFile?: string;
}
/** The SDK's private `CodexExec`, as far as this adapter touches it. */
interface CodexExec {
  run(args: CodexExecArgs): AsyncGenerator<string>;
}
/** A `Codex` whose private `exec` still has the `run` this adapter wraps: the
 *  field is private in the SDK's types, so it is parsed, not asserted. */
const codexWithExecSchema = z.object({
  exec: z.custom<CodexExec>(
    (value) => value instanceof Object && "run" in value && value.run instanceof Function,
  ),
});

/**
 * Ruling 145: the Codex SDK writes a turn's `outputSchema` into a directory of
 * its own (`mkdtemp`, 0700, the server's) and passes the CLI its path, but the
 * CLI runs as the person's agent uid behind the launcher (ruling 139) and so
 * could not open it: every Codex run given a schema (the operator's decision
 * plan, a specialist's outcome envelope) failed before its first turn with
 * "Failed to read output schema file ... Permission denied". Live on the AWS
 * calculator board, 2026-09-28, the first operator run of every task.
 *
 * The SDK offers no hook between writing the file and spawning the CLI, so
 * this wraps the one method that does both halves' handover, its exec's
 * `run`, and shares the file for the agent group to read before the spawn.
 * `exec` is private in the SDK's types; `CODEX_SDK_VERIFIED_VERSION` pins the
 * SDK this was read from, and the adapter test drives the real class through
 * it. Called only when a launcher stands in for the CLI.
 */
export function shareOutputSchemaWithAgent(
  codex: CodexSdk,
  share: (file: string) => void = shareFileForAgentsToRead,
): void {
  const parsed = codexWithExecSchema.safeParse(codex);
  if (!parsed.success) {
    throw new Error(
      "The Codex SDK no longer exposes the exec a turn's output schema is shared through; re-verify it against CODEX_SDK_VERIFIED_VERSION.",
    );
  }
  const exec = parsed.data.exec;
  const run = exec.run.bind(exec);
  exec.run = (args) => {
    if (args.outputSchemaFile) share(args.outputSchemaFile);
    return run(args);
  };
}

let cachedFactory: CodexFactory | null = null;
async function realFactory(): Promise<CodexFactory> {
  if (cachedFactory) return cachedFactory;
  const mod = await import("@openai/codex-sdk");
  cachedFactory = (options) => {
    const codex = new mod.Codex(options);
    if (options?.codexPathOverride) shareOutputSchemaWithAgent(codex);
    return codex;
  };
  return cachedFactory;
}

export function createCodexAdapter(
  deps: CodexAdapterDeps = {},
): RuntimeAdapter {
  return {
    backend: "codex",
    /**
     * Ruling 174: compact the thread a run just left through the CLI's
     * app-server (`thread/compact/start`; neither `exec` nor the SDK has a
     * command for it). The run's forked home is gone by the time a run has
     * exited (`finishCodexRunHome`), so the compaction gets a fork of its own
     * from the principal's SHARED home (ruling 138: seeded with the sign-in of
     * the account the run billed, settled like a run's), with the same
     * credential overlay and the shared summarizer prompt; the rollout it
     * extends lives in the shared home through the fork's links. The sizes are
     * not in the reply; the run service reads them off the rollout the CLI
     * just extended.
     */
    async compact(spec: RunSpec, threadId: string, cb: CompactCallbacks): Promise<CompactOutcome> {
      cb.onPhase?.(RUN_PHASE.compacting, "at the end of the run");
      const baseEnv =
        deps.env ??
        (spec.env
          ? Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            )
          : undefined);
      const env = baseEnv || spec.env ? { ...baseEnv, ...spec.env } : undefined;
      // Its own marker: the run's settle sweep must not reap the app-server.
      if (env?.[RUN_MARKER_ENV]) Object.assign(env, compactionMarkerEnv(spec.runId));
      // Ruling 138: the compaction bills the account the run billed, so it runs
      // in a private fork of the shared home like the run did (ruling 145),
      // seeded with THAT account's sign-in. The shared home holds no sign-in of
      // an account connected since the ruling, and may hold an earlier
      // account's that is not the one this run billed.
      const sharedHome = spec.env?.CODEX_HOME;
      let compactHome: CodexRunHome | null = null;
      let outcome: CompactOutcome;
      try {
        if (env && sharedHome) {
          compactHome = prepareCodexRunHome(
            sharedHome,
            codexCompactionHomeId(spec.runId),
            agentOwner(spec.agent),
            spec.accountHome ?? sharedHome,
          );
          env.CODEX_HOME = compactHome.dir;
          env.CODEX_SQLITE_HOME = compactHome.sharedHome;
        }
        const config: ThreadResumeConfig = {};
        const compaction = codexCompactionConfig(spec.kind);
        if (compaction.compact_prompt) config.compact_prompt = compaction.compact_prompt;
        const input: Parameters<typeof compactCodexThread>[0] = {
          threadId,
          cwd: spec.workdir,
          config,
        };
        if (spec.model) input.model = spec.model;
        if (env) input.env = env;
        if (deps.spawnAppServer) input.spawn = deps.spawnAppServer;
        // Ruling 139: as the person's own OS user, like the run it compacts.
        if (spec.agent) input.launch = spec.agent;
        outcome = await compactCodexThread(input);
      } catch (error) {
        // A home that could not be built compacts nothing; the run it follows
        // has already settled, so this is the epilogue's failure and no more.
        outcome = { compacted: false, reason: errorMessage(error) };
      } finally {
        if (compactHome) finishCodexRunHome(compactHome, agentOwner(spec.agent));
      }
      if (!outcome.compacted) {
        cb.onLine(
          viberrLine({
            ev: "meta",
            tag: "run·compaction·failed",
            text: `compaction at the end of the run did not happen: ${redactProviderText(outcome.reason)}`,
          }),
        );
      }
      return outcome;
    },
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawTurnCompleted = false;
      let sawFatalError = false;
      /**
       * Ruling 155(d): work the agent started AFTER its last completed turn.
       *
       * `turn.completed` clears it; a new turn or a new item sets it. It is the
       * difference between a transport failure that CUT work short and one that
       * arrived when the agent had already stopped — which is the difference
       * between a failed run and a finished one, and the old flat conjunction
       * below could not tell them apart.
       */
      let workAfterLastTurn = false;
      // F22-08: the SDK streams the real failure reason as a `turn.failed` /
      // `error` event (e.g. "You've hit your usage limit — try again Sep 18"),
      // then throws a bare `"Codex Exec exited with code 1: Reading prompt from
      // stdin..."` with no useful text. Keep the last fatal event's message so
      // the classifier reads the reason the human needs, not the exit banner.
      let lastFatalMessage: string | null = null;
      let interrupted = false;
      let settled = false;
      let idleTimedOut = false;
      let emittedAdapterFailure = false;
      // Ruling 145: the run's private CODEX_HOME, forked from the principal's
      // home at spawn and removed by `settle` — the one exit every outcome
      // takes. Null until the spawn env is built, and for a spec that carries
      // no home at all (nothing to fork from).
      let runHome: CodexRunHome | null = null;
      const abort = new AbortController();
      // Force-settle deadline armed after an abort, so a child that survives
      // SIGTERM cannot leave the row `running` forever. `settle` disarms it.
      let interruptTimer: ReturnType<typeof setTimeout> | null = null;
      const armSettleDeadline = (onTimeout: () => void) => {
        if (interruptTimer) clearTimeout(interruptTimer);
        interruptTimer = setTimeout(() => {
          if (settled) return;
          onTimeout();
        }, INTERRUPT_SETTLE_GRACE_MS);
        interruptTimer.unref?.();
      };

      // R21-4 / G5 (FR28): the live phase/step the run strip renders — the same
      // vocabulary the Claude adapter emits, so the strip reads identically on
      // both backends. `lastStep` sticks through a stretch of reasoning events,
      // marked answered once the tool it names has completed (ruling 166).
      let lastStep: string | null = null;
      const phase = (name: string, step: string | null = lastStep) => {
        cb.onPhase?.(name, step);
      };

      // IDLE (inactivity) timeout, not a wall-clock cap (owner ruling A8): a
      // codex run may legitimately take much longer than the window overall,
      // but if a SINGLE turn/tool produces NO new event for this long, the run
      // is hung (codex has no maxTurns and only settles on `turn.completed`, so
      // without this it stays `running` forever, waiting=agent, invisible to
      // recovery). We abort the thread and settle `error` so the react loop /
      // stuck-loop packet fires and a human is notified.
      const idleMs = codexIdleTimeoutMs();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      /**
       * Ruling 158(a): the stream is not the run's only sign of life. The CLI
       * streams no event for a reasoning step whose summary is empty, and at
       * a high effort one model call reasons for many minutes in such steps,
       * each one a line in the rollout. Live, two Inventory Analysts on
       * `gpt-6-luna` wrote a reasoning step every ten seconds for fifteen
       * minutes and were stopped as hung with the work under way. Set once
       * the rollout tail exists; null (the stream alone) without a shared home.
       */
      let rolloutWrittenAt: (() => number | null) | null = null;
      /** The hang's sentence: it names the rollout only when it was watched. */
      const idleSentence = () =>
        `Codex stopped after ${idleMs} ms without producing an event${rolloutWrittenAt ? " or writing to its session" : ""}.`;
      const armIdle = (delayMs = idleMs) => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled || interrupted) return;
          const writtenAt = rolloutWrittenAt?.() ?? null;
          const quietMs = writtenAt === null ? Infinity : Math.max(0, Date.now() - writtenAt);
          if (quietMs < idleMs) {
            // The model is still working: the window runs from its last write.
            logger.info("codex run quiet on its stream; its rollout is still growing", {
              runId: spec.runId,
              quietMs,
            });
            armIdle(idleMs - quietMs);
            return;
          }
          idleTimedOut = true;
          logger.warn(
            "codex run idle-timeout: no activity within the window",
            {
              runId: spec.runId,
              idleMs,
            },
          );
          try {
            abort.abort();
          } catch {
            // already done
          }
          // If the child ignores the abort (survives SIGTERM), force-settle so
          // the hung run does not sit `running` until the next restart.
          armSettleDeadline(() => {
            logger.warn(
              "codex run did not stop after the idle abort; settling it",
              { runId: spec.runId, graceMs: INTERRUPT_SETTLE_GRACE_MS },
            );
            emitAdapterFailure(
              idleSentence(),
              "idle_timeout",
            );
            settle("error");
          });
        }, delayMs);
      };
      const disarmIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      /**
       * Ruling 142: a settled run leaves no live process. The Codex SDK spawns
       * the CLI itself and signals only it (SIGTERM, never SIGKILL), so the
       * sweep is what reaches a CLI that outlived its abort and everything the
       * model's shell backgrounded — all of it carries this run's marker
       * (`shell_environment_policy.set`, each stdio server's `env`). A run the
       * service did not mark started nothing that could be found.
       */
      const reap = () => {
        if (!spec.env?.[RUN_MARKER_ENV]) return;
        const reapProcesses = deps.reapProcesses ?? reapRunProcesses;
        void reapProcesses({ runIds: [spec.runId] }).catch((error) => {
          logger.warn("codex run reap failed", {
            runId: spec.runId,
            err: toError(error),
          });
        });
      };

      const settle = (outcome: "finished" | "error" | "interrupted") => {
        if (settled) return;
        settled = true;
        disarmIdle();
        if (interruptTimer) {
          clearTimeout(interruptTimer);
          interruptTimer = null;
        }
        // Ruling 145: carry the refreshed sign-in back and drop the run home
        // BEFORE the completion callback runs inside `onExit` — a follow-up
        // run it starts forks its own home from the shared file, which must
        // already hold this run's refresh. Never throws.
        if (runHome) {
          finishCodexRunHome(runHome, agentOwner(spec.agent));
          runHome = null;
        }
        cb.onExit({
          outcome,
          effectiveBackend: "codex",
          sessionId,
        });
        reap();
      };

      /** Persist a canonical, deliberately detail-free fatal event. Raw
       * SDK/CLI stderr is neither logged nor added to the task transcript,
       * because it may contain command arguments or credentials. The classified
       * `kind` (quota/auth/unknown — safe to persist) rides on the display tag
       * as a `·<kind>` suffix (e.g. `error·quota`) so `runFailureReason` routes
       * the escalation from a structured signal, not by re-regexing the generic
       * message text. The raw envelope stays faithful; only the projected
       * display tag is enriched. */
      const emitAdapterFailure = (
        message: string,
        kind: CodexFailureKind = "unknown",
        providerText = "",
        // U35-11: the origin of an `overloaded` failure rides the typed record.
        origin: RunFailureFacts["origin"] = null,
      ) => {
        if (emittedAdapterFailure) return;
        emittedAdapterFailure = true;
        sawFatalError = true;
        // R20-3: append the provider's redacted sentence once, when it adds
        // something the canonical message does not already carry. The `err`
        // line's text is what `runFailureReason` reads and splits on the marker.
        const fullMessage =
          providerText && !message.includes(providerText)
            ? withProviderText(message, providerText)
            : message;
        const event = {
          type: "error",
          message: fullMessage,
        } satisfies ThreadErrorEvent;
        const occurredAt = new Date().toISOString();
        const { display, facts } = projectEnvelope("codex", event, occurredAt);
        // Ruling 155(a): the same typed record the Claude adapter attaches;
        // Codex streams no structured refusal facts, so every field but the
        // kind (and, U35-11, the origin of an overload) is unknown.
        const failure = emptyRunFailureFacts(kind);
        failure.origin = origin;
        cb.onLine({
          raw: JSON.stringify(event),
          display: display
            ? { ...display, tag: `${display.tag}·${kind}`, failure }
            : display,
          facts,
          occurredAt,
        });
      };

      /**
       * Ruling 155(d): did the run's work stand finished when this failure landed?
       *
       * The old gate was `sawTurnCompleted && !sawFatalError` — a conjunction
       * over the WHOLE stream, blind to order. This asks the question that
       * decides the outcome instead: the provider announced a completed turn,
       * and nothing has started since.
       */
      const turnStoodComplete = () => sawTurnCompleted && !workAfterLastTurn;

      /**
       * Record a transport failure that arrived after the turn completed.
       *
       * Deliberately NOT {@link emitAdapterFailure}: that stamps a typed
       * `failure` record onto the line, and `runFailureReason` reads the last
       * such line as the run's cause. This run has no cause — it finished. The
       * drop is still written down, because hiding it would be its own lie, but
       * it is written as what it is.
       */
      const emitPostTurnTransport = (detail: string) => {
        cb.onLine(postTurnTransportLine(detail));
      };

      const run = async () => {
        // Before anything can be awaited: the SDK import, the `codex` spawn and
        // the first turn all run with no event at all, and that window is what
        // the strip used to render blank.
        phase(RUN_PHASE.starting, null);
        const factory = deps.codexFactory ?? (await realFactory());
        // The Codex SDK REPLACES the child env wholesale, so any per-run env
        // (e.g. the specialist's GIT_CEILING_DIRECTORIES) must be overlaid on a
        // COMPLETE env — not `{}`. `deps.env` is the full spawn env; the
        // production adapter factory (createAdapters, runtime-registry) ALWAYS
        // passes it, so the process.env-snapshot fallback below is a safety net
        // for tests / direct construction that omit `deps.env`. Overlaying
        // spec.env on `{}` would strip PATH/HOME and break the spawned `codex`
        // binary (adversarial-review HIGH #3).
        const baseEnv =
          deps.env ??
          (spec.env
            ? Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              )
            : undefined);
        const mergedEnv =
          baseEnv || spec.env ? { ...baseEnv, ...spec.env } : undefined;
        // Ruling 145: `spec.env.CODEX_HOME` is the principal's SHARED home
        // (`runCredentialFor`). The CLI gets a private fork of it for this run
        // — its own `tmp/arg0` helper directory, its own copy of the sign-in —
        // while the state db (`CODEX_SQLITE_HOME`) and, by link, the sessions
        // stay shared, so resume still finds its rollout (F36-3, Q36-11 a).
        // Read from `spec.env`, the credential's own contract — never from the
        // merged env, whose process.env fallback could carry an ambient home.
        const sharedHome = spec.env?.CODEX_HOME;
        if (mergedEnv && sharedHome) {
          runHome = prepareCodexRunHome(
            sharedHome,
            spec.runId,
            agentOwner(spec.agent),
            // Ruling 138: the sign-in of the account this run bills.
            spec.accountHome ?? sharedHome,
          );
          mergedEnv.CODEX_HOME = runHome.dir;
          mergedEnv.CODEX_SQLITE_HOME = runHome.sharedHome;
        }
        const config = codexConfigForRun(spec);
        const codexOptions: CodexOptions = { config };
        if (mergedEnv) codexOptions.env = mergedEnv;
        // Ruling 139: the SDK spawns `codexPathOverride` with the argv it
        // builds, so the launcher stands in for the CLI and execs the SDK's own
        // vendored binary (`VIBERR_LAUNCH_EXEC`) as the principal's uid. The
        // SDK prepends its helper directories to PATH only when it resolves
        // the binary itself, so an override carries them here.
        if (spec.agent && mergedEnv) {
          const vendor = codexVendor();
          codexOptions.codexPathOverride = spec.agent.launcher;
          codexOptions.env = launchEnv(
            spec.agent,
            vendor.binary,
            withPathDirs(mergedEnv, vendor.pathDirs),
          );
        }
        const codex = factory(codexOptions);
        // Ruling 144: no OS confinement from Viberr. Every Codex run starts
        // `danger-full-access` — the mode that installs neither bubblewrap nor
        // the network seccomp filter, and so has neither F36-1's "bwrap: No
        // permissions to create a new namespace" nor F36-11's `EPERM` on every
        // synchronous child process. The boundary is Viberr's: the contract,
        // the isolated per-engagement checkout, the delivery gate and the
        // revision-bound verdicts. `attachmentsWritableDir` needs no
        // `--add-dir` here (full access already writes it), and the operator's
        // OS network is no longer forced off — the header comment says what
        // that costs.
        const reasoningEffort = resolveCodexReasoningEffort(spec.effort);
        const threadOptions: ThreadOptions = {
          model: spec.model,
          sandboxMode: "danger-full-access",
          workingDirectory: spec.workdir,
          skipGitRepoCheck: true,
          // There is no interactive approval channel in a server run. "never"
          // returns denied operations to the model instead of hanging forever.
          approvalPolicy: "never",
        };
        // Absent when the spec's tier is not one this SDK accepts, so the CLI
        // applies its own default rather than being handed an empty value.
        // startRun always resolves a Codex run's tier to a listed one (ruling
        // 149), so this guards a spec built outside it.
        if (reasoningEffort) {
          threadOptions.modelReasoningEffort = reasoningEffort;
        }
        // Web SEARCH still follows the grant on BOTH kinds (pass-24 B-2, owner
        // ruling): it is the CLI's own tool, not the OS sandbox, so ruling 144
        // does not touch it. A Codex operator that HOLDS `use-web-search-fetch`
        // gets web search, matching the Claude operator; a withheld grant
        // disables it.
        if (spec.webSearchWithheld) {
          // P14-RT-06: a run whose `use-web-search-fetch` grant is withheld loses
          // Codex's web search too. Claude removes WebFetch/WebSearch from the
          // run; Codex has no denylist channel. Network access stays ON for
          // specialists: declared MCP servers and the workspace's own tooling are
          // not the egress this capability governs.
          threadOptions.webSearchMode = "disabled";
        }
        const thread = spec.resumeSessionId
          ? codex.resumeThread(spec.resumeSessionId, threadOptions)
          : codex.startThread(threadOptions);
        // Ruling 165(b): a Viberr run is ONE Codex turn, whose usage the SDK
        // streams once, at its end, so the strip read Turns 0 and Tokens
        // "pending" for the whole run. The rollout records each model call
        // the moment it completes; it is read on every event below. Opened
        // before the CLI spawns, so a resumed thread's earlier runs stay out.
        const usageTail = sharedHome ? codexUsageTail(sharedHome, spec.resumeSessionId ?? null) : null;
        if (usageTail) rolloutWrittenAt = () => usageTail.lastWriteMs(sessionId);

        try {
          armIdle();
          const turnOptions: TurnOptions = { signal: abort.signal };
          // Structured-output operator: constrain the final message to the
          // decision-plan schema so the caller can parse + execute it.
          if (spec.outputSchema) turnOptions.outputSchema = spec.outputSchema;
          const { events } = await thread.runStreamed(spec.prompt, turnOptions);
          // The model calls the rollout has recorded: a Codex run's Turns.
          let calls = 0;
          // Ruling 161(b): the account reading the last line carried.
          let sentLimit: string | null = null;
          for await (const event of events) {
            armIdle(); // reset the inactivity window on every event
            const occurredAt = new Date().toISOString();
            let { display, facts } = projectEnvelope(
              "codex",
              event,
              occurredAt,
            );
            if (facts.sessionId) sessionId = facts.sessionId;
            const type = event.type;
            const live = usageTail?.read(sessionId) ?? null;
            if (type === "turn.completed") {
              // A new thread's figure is its one turn's total and stands. A
              // resumed thread's is the THREAD's running total, every earlier
              // run's calls included, so the run stores its turn's own from
              // the rollout; the raw line keeps the CLI's. The last call's
              // record is on disk before the SDK streams this event (100 of
              // 100 runs of the pinned CLI).
              if (live && spec.resumeSessionId) {
                ({ display, facts } = projectEnvelope(
                  "codex",
                  { ...event, usage: live.usage },
                  occurredAt,
                ));
              }
            } else if (live && live.calls > calls) {
              // Provider figures, not an estimate: the sink folds them as the
              // run's usage from the first call on.
              const { input_tokens, cached_input_tokens, output_tokens } = live.usage;
              facts.usage = { input_tokens, cached_input_tokens, output_tokens, outputEstimated: false };
            }
            if (live) {
              calls = live.calls;
              facts.turns = calls;
            }
            // Ruling 161(b): the account's usage window, from the same rollout
            // lines, rides the line when it changes, and the sink records it
            // as Claude's `rate_limit_event` is recorded.
            const limit = usageTail?.rateLimit() ?? null;
            if (limit && JSON.stringify(limit) !== sentLimit) {
              sentLimit = JSON.stringify(limit);
              facts.rateLimit = limit;
            }
            if (type === "turn.started" || type === "item.started") {
              // Ruling 155(d): something is in flight again.
              workAfterLastTurn = true;
            }
            if (type === "turn.completed") {
              sawTurnCompleted = true;
              workAfterLastTurn = false;
            }
            // Item-level errors are explicitly non-fatal in the SDK. Only the
            // two top-level failure events poison the terminal outcome.
            if (type === "turn.failed" || type === "error") {
              sawFatalError = true;
              // Decode the reason at this boundary (F22-08) — never narrow the
              // raw event shape with typeof.
              const parsed = fatalEventMessageSchema.parse(event);
              const msg = parsed.error?.message ?? parsed.message ?? null;
              if (msg) lastFatalMessage = msg;
            }
            const emitted = {
              raw: JSON.stringify(event),
              display,
              facts,
              occurredAt,
            };
            cb.onLine(emitted);
            // R21-4: the strip's live row. `turn N` is the honest fallback until
            // the run invokes its first tool — a number that climbs is what
            // tells a human the run is alive. The service throttles the writes.
            // Ruling 166: a tool stays named while it runs; once its result lands the
            // step says the model is composing again, instead of the finished call.
            const update = stepUpdateForLine(emitted);
            if (update?.kind === "tool") lastStep = update.step;
            else if (update?.kind === "answered" && lastStep) lastStep = answeredStep(lastStep);
            phase(RUN_PHASE.working, lastStep ?? `turn ${calls + 1}`);
          }
          phase(RUN_PHASE.finishing, null);
          // Thread id lands after the first turn — capture it as the session.
          if (thread.id) sessionId = thread.id;
        } catch (error) {
          disarmIdle();
          // An idle-timeout aborts the same way an interrupt does; distinguish
          // them so a hung run settles `error` (→ react/stuck-packet) while a
          // user interrupt stays `interrupted`.
          if (idleTimedOut) {
            // Classified so the timeline copy can say "hung", not "failed" —
            // and so it reads the same as the Claude idle guard (P13-RT-11).
            emitAdapterFailure(
              idleSentence(),
              "idle_timeout",
            );
            return settle("error");
          }
          if (interrupted) return settle("interrupted");
          // Ruling 155(d): the turn had completed and nothing was in flight, so
          // the iterator threw on teardown, not on the work. Live this was the
          // socket dying under Viberr's OWN end-of-run compaction — its
          // housekeeping turning a finished run into a failed one.
          if (turnStoodComplete()) {
            const thrown = classifyCodexFailure(error, "execution", lastFatalMessage);
            logger.info("codex transport dropped after the turn completed", {
              runId: spec.runId,
              runOutcome: "finished",
            });
            emitPostTurnTransport(thrown.providerText || thrown.message);
            if (thread.id) sessionId = thread.id;
            return settle("finished");
          }
          logger.error("codex thread error", {
            runId: spec.runId,
            err: safeCodexError(error),
          });
          // F22-08: classify on the streamed reason when the SDK captured one
          // (the thrown error is only the exit banner); the raw event message is
          // the fallback cause.
          const failure = classifyCodexFailure(
            error,
            "execution",
            lastFatalMessage,
          );
          emitAdapterFailure(failure.message, failure.kind, failure.providerText, failure.origin);
          return settle("error");
        }

        if (interrupted) return settle("interrupted");
        if (sawTurnCompleted && !sawFatalError) return settle("finished");
        // Ruling 155(d): a fatal event that landed AFTER the completed turn, with
        // nothing started since. Same judgement as the catch above — the work
        // stood finished, so the drop is transport and the run is not failed.
        if (turnStoodComplete()) {
          emitPostTurnTransport(lastFatalMessage ?? "the provider stream ended in an error");
          return settle("finished");
        }
        // A fatal `turn.failed` / `error` event can arrive WITHOUT the iterator
        // throwing (F22-08): classify it from the event message so the failure
        // is surfaced instead of settling error silently.
        if (sawFatalError && lastFatalMessage) {
          const failure = classifyCodexFailure(
            lastFatalMessage,
            "execution",
            lastFatalMessage,
          );
          emitAdapterFailure(failure.message, failure.kind, failure.providerText, failure.origin);
        } else if (!sawFatalError) {
          emitAdapterFailure("Codex ended before reporting turn completion.");
        }
        return settle("error");
      };

      void run().catch((error) => {
        logger.error("codex run crashed", {
          runId: spec.runId,
          err: safeCodexError(error),
        });
        const failure = classifyCodexFailure(error, "start");
        emitAdapterFailure(failure.message, failure.kind, failure.providerText, failure.origin);
        settle("error");
      });

      return {
        runId: spec.runId,
        interrupt() {
          if (interrupted || settled) return;
          interrupted = true;
          try {
            abort.abort();
          } catch {
            // Already completed.
          }
          // The abort SIGTERMs the child; if it does not die, the iterator never
          // ends and the run would sit `running` until the next restart's orphan
          // sweep — force-settle after a grace so Stop is never a no-op.
          armSettleDeadline(() => {
            logger.warn(
              "codex run did not stop after an interrupt; settling it",
              { runId: spec.runId, graceMs: INTERRUPT_SETTLE_GRACE_MS },
            );
            settle("interrupted");
          });
        },
      };
    },
  };
}
