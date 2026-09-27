import { z } from "zod";
import { withProviderText } from "~/shared/provider-marker";
import {
  LOCAL_NETWORK_FAILURE_RE,
  emptyRunFailureFacts,
  formatUsd,
  localNetworkFailureCode,
  type RunFailureFacts,
  type RunFailureKind,
} from "~/shared/run-failure";
import { splitClaudeVariant } from "~/shared/model-ids";
import { formatAbsoluteUTC } from "~/shared/dates/format";
import { wholeThousands } from "~/shared/text/thousands";
import { countLabel } from "~/shared/text/plural";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import {
  answeredStep,
  postTurnTransportLine,
  RUN_PHASE,
  stepUpdateForLine,
  type CompactCallbacks,
  type CompactOutcome,
  type RunCallbacks,
  type RunHandle,
  type RunSpec,
  type RunSteering,
  type RuntimeAdapter,
} from "./adapter.server";
import { COMPLETION_COMPACT_INSTRUCTIONS } from "./context-policy.server";
import { SESSION_MISSING_RE } from "./session-export.server";
import { isSdkSkillName, skillPluginInPlace } from "./skill-mount.server";
import { projectEnvelope, type EnvelopeFacts } from "./wire-format.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { redactProviderText } from "~/server/secrets/git-output-redact.server";
import {
  spawnClaudeCli,
  type ClaudeCli,
  type ClaudeSpawnedProcess,
  type ClaudeSpawnRequest,
  type SpawnCli,
} from "./claude-spawn.server";
import {
  reapRunProcesses,
  RUN_MARKER_ENV,
  RUN_REAP_GRACE_MS,
  type ReapRunProcesses,
  type ReapTargets,
  type SignalProcess,
  compactionMarkerEnv,
} from "./run-processes.server";
import { bashDenyPrefixes, deniedPrefixFor } from "./bash-policy.server";
import { bashDenyReason } from "~/server/tasks/specialist-tool-policy";
import {
  claudeSystemPromptBlocks,
  dynamicPromptText,
  isPromptPrefix,
  sortedNames,
  sortedRecord,
  staticPromptText,
} from "./prompt-prefix.server";
import { errorMessage, toError } from "~/shared/errors";

/**
 * Claude Code adapter — the OFFICIAL Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, verified v0.3.280, bundling Claude Code
 * 2.1.280: every option below, the `Query` methods called on it, the result
 * and init fields read and the native-binary resolver `backend-login` mirrors
 * were re-checked against it; its `opus` alias resolves to `claude-opus-5-5`,
 * where 2.1.261's resolved to `claude-opus-5`). `query()` returns a
 * `Query` (async generator of `SDKMessage`) whose yielded objects are the
 * SAME envelopes documented in runtime-adapters.md §1.3 (system·init with
 * session_id/model/tools, assistant/user with tool_use/tool_result blocks,
 * final result with usage/total_cost_usd/num_turns) — so each yielded
 * message is persisted as raw_json via `JSON.stringify(message)` and
 * projected through the shared normalizer (projectEnvelope).
 *
 * Interrupt: the SDK's `Query.interrupt()` — only available in STREAMING
 * INPUT mode (the docs on the `Query` interface say so), so we feed the
 * prompt as an async iterable of one SDKUserMessage. Resume: `options.resume
 * = <session_id>`. Autonomous: `options.permissionMode = 'bypassPermissions'`.
 * Success is gated on the final result's `is_error`, NOT any exit code.
 *
 * Auth: whatever the run's CREDENTIAL PRINCIPAL connected (ruling 127) — the
 * hosted sign-in the bundled `claude` binary holds inside that person's
 * `CLAUDE_CONFIG_DIR`, or a Console `ANTHROPIC_API_KEY` they pasted. Both
 * arrive on `spec.env`, assembled by `runCredentialFor` in the run service;
 * this adapter reads no credential of its own. The SDK factory is injectable
 * so tests drive a fake async generator — real Claude is NEVER invoked.
 */

/** The subset of the SDK we depend on (kept narrow + injectable). */
export interface ClaudeQueryOptions {
  cwd?: string;
  model?: string;
  /** Reasoning effort: 'low'|'medium'|'high'|'xhigh'|'max' (default high). */
  effort?: string;
  maxTurns?: number;
  /** Ruling 175: the instance's spending cap per run. The SDK ends a query
   *  that exceeds it with an `error_max_budget_usd` result (sdk.d.ts). */
  maxBudgetUsd?: number;
  permissionMode?: string;
  /** Ruling 174: the SDK declares this "must be set to `true` when using
   *  `permissionMode: 'bypassPermissions'`" (sdk.d.ts), defaults it to false
   *  and forwards it to the CLI. The pinned CLI does not enforce it yet; the
   *  day one does, a run without it would lose bypass and every tool with it. */
  allowDangerouslySkipPermissions?: boolean;
  /** Who answers a permission prompt (SDK ≥ 0.3.259). `"none"` declares what
   *  is true of every Viberr run: it is server-spawned with no human at the
   *  CLI and no `canUseTool` callback, so anything the permission mode would
   *  otherwise ASK about is denied at once, and the model is told the session
   *  has no approval surface instead of being left to retry. Under
   *  `bypassPermissions` nothing prompts, so this only binds on the
   *  `permissionMode: "default"` seam (a non-autonomous spec), where the SDK
   *  used to fall back to the same denial without stating it. The mode, the
   *  deny rules and hooks still decide; this never widens a run. */
  permissionPrompts?: "host" | "none";
  resume?: string;
  includePartialMessages?: boolean;
  env?: Record<string, string>;
  abortController?: AbortController;
  /** Custom system prompt. A string (or a `string[]` split at the SDK's
   *  dynamic boundary, ruling 370) REPLACES the default (operator: tools-only,
   *  no coding harness); the custom OBJECT form is the same text recorded on
   *  the session's first request (`snapshot`, the controller). The
   *  append-preset form keeps Claude Code's default scaffolding and appends
   *  the persona (specialists: they DO write code); `excludeDynamicSections`
   *  moves the preset's per-directory sections into the first user message so
   *  every dispatch of one profile shares one system-prompt cache entry
   *  (ruling 371). */
  systemPrompt?:
    | string
    | string[]
    | { type: "custom"; prompt: string | string[]; snapshot?: boolean }
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
        excludeDynamicSections?: boolean;
        snapshot?: boolean;
      };
  /** In-process SDK MCP servers (operator governance tools) plus the profile's
   *  declared external ones — forwarded exactly as `RunSpec` carries them. The
   *  SDK owns their shape (an `sdk` entry is a live server INSTANCE, not data);
   *  this adapter never inspects a declaration. */
  mcpServers?: RunSpec["mcpServers"];
  /** Auto-approve allowlist. NOTE: this does NOT remove other tools from the
   *  model's context — it only skips the permission prompt. `disallowedTools`
   *  below is the ONLY restriction channel this adapter has (D5/pass-16: this
   *  line used to point at a `tools` option, which is not in this interface, is
   *  passed nowhere, and would have read as a fence that does not exist). */
  allowedTools?: string[];
  /** Tool denylist — removes tools from the model's context entirely; binds
   *  even under bypassPermissions. */
  disallowedTools?: string[];
  /** Which filesystem settings to load. ALWAYS `[]` on a Viberr run (SDK
   *  isolation mode): none of the host's `~/.claude` tiers leak in, and no
   *  project source is opened over the checkout either — since ruling 180 the
   *  granted skills arrive through `plugins`, so nothing under cwd needs
   *  reading. Never `'user'` or `'local'` (the host machine's tiers, F13) and
   *  never `'project'` (the repository under review's own `.claude` and
   *  CLAUDE.md at system-prompt tier). */
  settingSources?: string[];
  /** Skills to enable — a CONTEXT FILTER, not a sandbox. `[]` = none listed, so
   *  the model sees no skill and the Skill tool rejects every one. A name list
   *  enables exactly those (a plugin's skills by their qualified
   *  `<plugin>:<name>`) and hides the rest, including the SDK's own bundled
   *  set. Setting this option auto-adds the `Skill` tool to `allowedTools`. */
  skills?: string[];
  /** Local plugins to load for the session. Ruling 180: exactly the run's own
   *  skill plugin when it mounted any (`RunSpec.skillPlugin`), else `[]` —
   *  which also closes the plugin-marketplace leak channel (F13): a
   *  host-installed plugin's slash-commands/skills never reach a Viberr run.
   *  `skipMcpDiscovery` keeps a plugin from carrying MCP servers of its own. */
  plugins?: { type: "local"; path: string; skipMcpDiscovery?: boolean }[];
  /** R18-3: `true` = ignore ambient MCP config (repo `.mcp.json`, user MCP,
   *  plugin MCP) — only the servers Viberr passes via `mcpServers` reach the run.
   *  Governance parity with `settingSources`, for the MCP catalog channel. */
  strictMcpConfig?: boolean;
  /** Ruling 174: Viberr spawns the CLI itself, as the leader of its own
   *  process group (`claude-spawn.server.ts`), instead of the SDK's local
   *  spawn. */
  spawnClaudeCodeProcess?: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
  /** Ruling 101(e), amended (Option D PR 5): the PreToolUse hook that refuses a
   *  Bash command reaching one of the run's argument-level denies, however it
   *  is wrapped, with a reason the model reads. It only ever denies.
   *  Ruling 371/373: the `SessionStart` hook on the `compact` source that hands
   *  the run its anchor back after a compaction, and the `PreCompact` hook that
   *  names the wait on the strip.
   *  Ruling 527: the `PostToolBatch` hook that hands a controller turn the
   *  steering messages waiting for it, and the `Stop` hook that closes its
   *  steering once the model has written its final answer. */
  hooks?: {
    PreToolUse?: { matcher: string; hooks: ClaudePreToolUseHook[] }[];
    SessionStart?: { matcher: string; hooks: ClaudeSessionStartHook[] }[];
    PreCompact?: { hooks: ClaudePreCompactHook[] }[];
    PostToolBatch?: { hooks: ClaudePostToolBatchHook[] }[];
    Stop?: { hooks: ClaudeStopHook[] }[];
  };
}

/** The SDK's `SessionStart` callback, narrowed to the one answer Viberr gives:
 *  pinned context after a compaction. */
export type ClaudeSessionStartHook = (
  input: { hook_event_name: string; source?: string },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<{
  hookSpecificOutput?: { hookEventName: "SessionStart"; additionalContext: string };
}>;

/** The SDK's `PreCompact` callback; its `custom_instructions` is input, so
 *  Viberr's hook only observes. */
export type ClaudePreCompactHook = (
  input: { hook_event_name: string; trigger?: string },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, never>>;

/** Ruling 527: the SDK's `PostToolBatch` callback, fired once when every tool
 *  call of a batch has answered and before the next model request, narrowed to
 *  the one answer Viberr gives: text the model reads beside those results. */
export type ClaudePostToolBatchHook = (
  input: { hook_event_name: string },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<{
  hookSpecificOutput?: { hookEventName: "PostToolBatch"; additionalContext: string };
}>;

/** Ruling 527: the SDK's `Stop` callback, fired when the model ends its turn;
 *  Viberr's hook only observes (an `additionalContext` here would keep the
 *  turn going past its final answer). */
export type ClaudeStopHook = (
  input: { hook_event_name: string },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, never>>;

/** The SDK's `PreToolUse` callback, narrowed to the fields Viberr's hook reads
 *  and the one answer it gives. */
export type ClaudePreToolUseHook = (
  input: { hook_event_name: string; tool_input?: unknown },
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<ClaudeHookAnswer>;

/** No decision (`{}`) leaves the call to the mode and the deny rules; a deny
 *  stops it and hands the model the reason as the tool's result. */
export interface ClaudeHookAnswer {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** The Bash tool's input, read only for the command line. */
const bashCommandSchema = z.object({ command: z.string() });

export interface ClaudeQuery extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<void>;
}

export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: ClaudeQueryOptions;
}) => ClaudeQuery;

interface ClaudeAdapterDeps {
  /** Injected `query` (default: the real SDK, imported lazily). */
  queryFn?: ClaudeQueryFn;
  env?: Record<string, string>;
  /** Ruling 174 seams: the spawn under the detached CLI, the signal it sends
   *  its group, and the sweep that runs once the run has settled. Default: the
   *  real ones. A fake `queryFn` never calls `spawnClaudeCodeProcess`, so
   *  without a test driving it none of these is reached. */
  spawnCli?: SpawnCli;
  signalProcess?: SignalProcess;
  reapProcesses?: ReapRunProcesses;
}

/** The two exit errors the SDK builds from the CLI's exit (sdk.mjs
 *  `getProcessExitError`), which carry a `. stderr: <tail>` suffix only when
 *  the SDK spawned the CLI itself. */
const CLI_EXIT_ERROR_RE = /^Claude Code process (?:exited with code|terminated by signal)/;

/**
 * Resolve the app's model label to something the SDK/CLI accepts. Agent
 * profiles carry friendly labels ("claude-sonnet") that are NOT valid model
 * ids and make a real run fail ("model may not exist"). Map family labels to
 * the short aliases the CLI understands (`sonnet`/`opus`/`haiku`, which
 * resolve to the latest of that tier the account can use); pass real dated
 * ids through; return undefined for anything unknown so the SDK falls back to
 * the subscription's default model.
 */
export function resolveClaudeModel(model?: string): string | undefined {
  if (!model) return undefined;
  // Pass 34 (F34-7): split the bracketed context-window variant off FIRST,
  // resolve the base through the ordinary rules (dated test included) and
  // re-append the variant verbatim. `opus[1m]` used to hit the
  // `includes("opus")` arm and reach the SDK as `opus`, so the person who
  // picked a 1M-context model ran a 200k one; and `claude-opus[1m]` would
  // otherwise match the dated branch on the digit inside the bracket and be
  // forwarded unchanged, which is not an SDK id.
  const { base, variant } = splitClaudeVariant(model.trim());
  const resolved = resolveClaudeBase(base);
  if (resolved === undefined) return undefined;
  return variant ? `${resolved}${variant}` : resolved;
}

/** The variant-free half of {@link resolveClaudeModel}. */
function resolveClaudeBase(model: string): string | undefined {
  const m = model.toLowerCase().trim();
  if (!m) return undefined;
  // A versioned/dated real id (e.g. claude-sonnet-4-5) — use as-is.
  if (m.startsWith("claude-") && /\d/.test(m)) return model;
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  return undefined;
}

/**
 * Do not cast arbitrary profile strings into the SDK's effort union — the
 * mirror of `resolveCodexReasoningEffort` (P13-RT-08).
 *
 * `options.effort` is typed `'low'|'medium'|'high'|'xhigh'|'max' | number` in
 * the SDK, but the adapter used to forward `spec.effort` raw. A profile created
 * on Codex with `effort: "minimal"` and later switched to Claude (the effort
 * picker only refetches on backend change, so the stored value survives) then
 * shipped a value that is not in the Claude union — best case the CLI ignores
 * it, worst case the run 400s and the human sees a generic `run·error·unknown`.
 * Unknown → dropped, so the SDK applies its own default.
 */
function resolveClaudeEffort(effort?: string): string | undefined {
  switch (effort) {
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
 * Idle (inactivity) timeout for a claude run in ms — the window a single
 * turn/tool may produce no message before the run is treated as hung.
 * Overridable via VIBERR_CLAUDE_IDLE_TIMEOUT_MS; defaults to 15 minutes, the
 * same window the Codex adapter uses (owner ruling A8; the default and the
 * parse live in the env schema, ruling 458(j)).
 *
 * P13-RT-11: Claude had NO timer of any kind. `maxTurns` bounds turns, not
 * wall-clock or idle time, and a `for await` over a stalled SDK stream never
 * settles — so a partitioned network or a hung stdio MCP (`npx …`) left the run
 * `running` forever, the task `waiting: agent`, the delivering single-flight
 * refusing every later delivering run on that task, and the board showing an
 * "agent working" badge until the NEXT process restart ran finalizeOrphanedRuns.
 *
 * C3 (pass 31): this used to read the raw process env, with a note deferring to
 * "another workstream" that owned the env schema — an ownership fact, not a
 * technical reason, and the schema has declared this variable since. It reads
 * the validated env now, like its Codex twin (`codexIdleTimeoutMs`) and
 * `resolveMaxTurns`. A test that sets the variable must call
 * `resetEnvCacheForTests()`, because `getEnv()` caches per process.
 */
function claudeIdleTimeoutMs(): number {
  return getEnv().VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
}

/**
 * How long a cooperative stop is given to take effect before the adapter
 * ABORTS the SDK subprocess. `interrupt()` is a cooperative control request to
 * the CLI; a wedged one never answers, and it also disarms the idle guard, so
 * without this the run has no watchdog left at all. Short, because a human is
 * watching a Stop they just pressed.
 */
export const INTERRUPT_GRACE_MS = 20_000;

/**
 * After the cooperative grace elapses the adapter aborts the SDK's
 * AbortController, which tears the child down (SIGTERM, then SIGKILL ~5s later,
 * to the CLI's whole process group since ruling 174). That abort ends the
 * stream, and the loop's own catch settles the run once the process is
 * actually gone — the point being that a settled run no longer leaves a live
 * process writing the workspace (the settle sweep, `reapRunProcesses`, takes
 * what the group signal cannot name). This second window is only a backstop
 * for the case the aborted generator never unblocks; it must outlast the SDK's
 * SIGTERM→SIGKILL escalation.
 */
export const INTERRUPT_ABORT_GRACE_MS = 10_000;

/**
 * Built-in tools an operator run may never use: it coordinates the task and
 * writes only through its governance MCP tools — it never edits files, runs
 * shell commands, or spawns sub-agents that could. Denied tools are removed
 * from the model's context, so this holds even under bypassPermissions.
 *
 * F21-3: THE single source. This list used to exist twice — here (bound per
 * `kind: "operator"` run) and again in `operator-run.server.ts` (stated where
 * the run is built), as two unguarded literals with nothing tying them
 * together. Two copies of a confinement list is one copy away from a run that
 * believes it is read-only and is not, so `operator-run` imports this one.
 *
 * Defined HERE rather than in `operator-run` because this module is a leaf of
 * the runtime graph: `operator-run` already imports the run service (which
 * reaches this file through the registry), so pointing the dependency the other
 * way would close a cycle around a module-level `const`.
 *
 * `Read`/`Grep`/`Glob` deliberately survive — the operator's whole repository
 * view (R19-1) is reading — and so does the tool-loading path.
 */
export const OPERATOR_READ_ONLY_DENIED_TOOLS = [
  // Repo-mutation built-ins — the operator coordinates, it never writes code.
  // (`Task` moved to BASE_DENIED_BUILTINS: no run may spawn ungoverned subagents.)
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
] as const;

/**
 * Denied for SUPPORTING (non-delivering, `kind: "reviewer"`) specialist runs:
 * the DELIVERY commands only.
 *
 * Parity ruling (owner, 2026-08-31) narrowed this list. F10-12's original
 * kind-based denylist also removed the file-write built-ins from every
 * supporting run regardless of grants; the owner ruled that write posture is
 * GRANTS-derived on both backends ("reviewer is just a type of an agent —
 * some agents should be able to write, some don't, related to their
 * work/assignment"), so the local-write denies now ride the run's
 * grant-derived `spec.disallowedTools` (resolveSpecialistDisallowedTools
 * denies Edit/Write/… exactly when `execute-code-or-write-repo` is withheld)
 * — a supporting agent GRANTED the family may edit its own isolated checkout
 * (P8 isolation + sha-bound verdicts keep those edits out of the delivered
 * branch and the review record).
 *
 * What stays kind-based is DELIVERY: reaching the remote belongs to the single
 * `delivers: true` engagement plus the server-owned gate, whatever the
 * profile's grants say — a supporting run pushing or opening a PR is the
 * VIB-30 class (a review agent committed, pushed, and opened a PR with no
 * delivery linkage). Deny wins under bypassPermissions, so these bind. On
 * Codex neither half has a tool-layer channel: ruling 185 starts every thread
 * `danger-full-access`, so the grants-derived write posture is advisory there,
 * and the remote stays out of reach regardless (agents hold no credential;
 * delivery is server-owned).
 */
const SUPPORTING_DELIVERY_DENIED_BUILTINS = [
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr merge:*)",
] as const;

/**
 * Denied for EVERY Viberr run (operator + specialist + reviewer).
 *
 * These are Claude Agent SDK built-ins COMPILED INTO the
 * `@anthropic-ai/claude-agent-sdk` binary. `skills: []`/`settingSources: []`
 * don't strip them — verified 2026-07-18 by running a standalone Docker
 * deployment (pristine CLAUDE_CONFIG_DIR, no host ~/.claude, non-root): the run
 * init still listed and EXPOSED all of them, so the leak is production, not the
 * once-assumed "dev-nested in a Claude Code session" artifact.
 *
 * We deny the ones that either (a) have NO Codex analog — allowing them breaks
 * the "Codex and Claude work the same from viberr's eye" parity, since a Codex
 * specialist on the same task literally cannot do it — or (b) bypass a concern
 * viberr already OWNS (orchestration = the operator; notifications =
 * `notifyTaskWatchers`; the workspace clone = the runtime). All are empirically
 * UNUSED (0 invocations across every real run).
 *
 * DELIBERATELY NOT DENIED: `ToolSearch` (the operator loads its deferred
 * `mcp__viberr__*` governance tools through it — 137 real calls; denying it
 * breaks the operator), the coding toolset (Bash/Read/Write/Edit/Grep/Glob/
 * Notebook — specialists do real work), web tools (WebFetch/WebSearch), and the
 * `mcp__*` channel (the backend-agnostic way viberr grants real capabilities to
 * BOTH backends). If viberr ever wants a scheduled/recurring-task capability
 * (the "Cron on a not-yet-Done task" idea), the parity-correct form is a governed
 * `mcp__viberr__schedule_*` tool + capability toggle, not the Claude Cron tool.
 */
const BASE_DENIED_BUILTINS = [
  // Denied for a run that mounts NO skill of its own (see `nativeSkills` in
  // `start`): the SDK compiles ~16 first-party skills into its binary, and with
  // no `skills` filter of ours to hide them the only fence left is denying the
  // tool. A run that DOES carry granted skills drops this entry and passes
  // `skills: [<granted names>]` instead — the filter rejects every unlisted
  // skill (bundled ones included) at the tool boundary.
  "Skill",
  // The subagent-spawning family — a denied-tools run must not be able to spawn
  // an SDK subagent (`claude`/`general-purpose`/…) that would inherit an
  // UNRESTRICTED toolset (Bash/Write/Edit) and bypass this very denylist. Under
  // `bypassPermissions` the denylist is the only gate, so all spawn entrypoints
  // are closed: the synchronous `Task` AND the async task family (verified
  // present in the production docker init — `TaskCreate`/`TaskGet`/… leaked past
  // the singular `Task` deny). Orchestration is the operator's job.
  //
  // SDK 0.3.233 took the task-tracking tools (`TaskCreate`/`TaskGet`/
  // `TaskUpdate`/`TaskList`, `TodoWrite`) OUT of the default tool surface on
  // Opus 4.8, Sonnet 5, Fable 5 and newer models; they are still exposed on
  // older models and whenever a run names them, and `TaskOutput`/`TaskStop`
  // (the background-task pair) were never part of that change. The entries
  // stay: a deny for a tool that is absent costs nothing, and the fence must
  // not depend on which model a profile picked.
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "Workflow", // self-orchestration bypasses the operator
  "CronCreate", // scheduling is viberr's job (a future mcp__viberr__schedule_* cap)
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "Monitor",
  "PushNotification", // notifications are notifyTaskWatchers' job
  "SendMessage",
  "DesignSync", // unrelated first-party plugin
  "EnterWorktree", // the runtime manages the task's workspace clone
  "ExitWorktree",
] as const;

/**
 * The exact skill names THIS run may enable — deduped, and filtered through the
 * SDK's own naming rules.
 *
 * The mount already validates every name it writes ({@link isSdkSkillName}), so
 * this is the belt to that braces: `query()` THROWS BEFORE STARTING on a value
 * that cannot be an exact skill name, and a run must never die because a store
 * folder was called `my skill (v2)`. Re-checking at the adapter boundary means
 * no caller — present or future — can turn a bad name into a failed run. An
 * empty result puts the run back on the fully-isolated defaults.
 *
 * SDK 0.3.221 made that throw explicit: delimiters, control characters and the
 * wildcard form are rejected by name, and `skills: 'all'` is the only way to
 * enable every skill — a form this adapter must never send, since "all" would
 * include the SDK's bundled set the filter exists to hide.
 */
function nativeSkillNames(skills?: readonly string[]): string[] {
  if (!skills?.length) return [];
  return [...new Set(skills)].filter(isSdkSkillName);
}

/** What the start could enable natively, and what it had to drop. */
export interface NativeSkillsOutcome {
  native: string[];
  dropped: string[];
}

/**
 * The skills THIS run enables natively — the names above, gated on the one
 * precondition the native channel cannot run without: the run's plugin
 * directory (ruling 180) still holds the manifest the CLI reads.
 *
 * The plugin is built beside the checkout by `mountGrantedSkills` moments
 * before the spawn, and the checkout's neighbourhood is writable by the agent
 * of any live run on the task. A plugin that went missing in between must not
 * be handed to the SDK as if it loaded: the CLI would start with a
 * `--plugin-dir` that resolves to nothing, the filter would list qualified
 * names nothing provides, and the persona — written on the mount's word —
 * would announce skills the model cannot invoke. So the adapter re-checks at
 * start and enables NO native skill when the plugin is gone: the run keeps the
 * fully isolated shape and `Skill` stays denied.
 *
 * What that costs, stated rather than implied. When the MOUNT fails it reports
 * no mounted skills, and the caller's persona then injects every grant as
 * prompt text — the same fallback a run with no checkout gets. When the plugin
 * goes missing AFTER the mount (this seam's own case), the persona has already
 * been written on the assumption the skills mounted, so they are announced to
 * the agent and not enabled. C02-R7 (pass 32) closes that last gap where it
 * can be closed — in the adapter, at start: it appends a correction to the
 * system prompt naming the skills it could not enable
 * (`droppedSkillsNotice`). The agent then treats them as unavailable instead
 * of invoking a name that never loads.
 */
function nativeSkillsOutcome(spec: RunSpec): NativeSkillsOutcome {
  const granted = nativeSkillNames(spec.skills);
  if (granted.length === 0) return { native: [], dropped: [] };
  if (skillPluginInPlace(spec.skillPlugin)) return { native: granted, dropped: [] };
  logger.warn(
    "the run's skill plugin is missing — starting with NO native skills",
    { runId: spec.runId, plugin: spec.skillPlugin?.path ?? null, skills: granted },
  );
  return { native: [], dropped: granted };
}

/** The system-prompt correction for skills the persona announced as attached
 *  but the adapter could not enable (see `nativeSkillsOutcome`). */
function droppedSkillsNotice(dropped: readonly string[]): string {
  return (
    "\n\n---\n# Attached skills could NOT be enabled on this run\n\n" +
    `The skills named above as attached to this run (${dropped.join(", ")}) ` +
    "could NOT be enabled: the plugin directory Viberr built for them was gone " +
    "by the time this run started, and Viberr enables no skill it cannot " +
    "account for. Treat them as unavailable — do not invoke them by name — " +
    "and say so in your report if the work needed them."
  );
}

/** One streaming-input user message (enables Query.interrupt()). */
async function* singlePrompt(prompt: string): AsyncGenerator<unknown> {
  yield {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    session_id: "",
  };
}

let cachedQuery: ClaudeQueryFn | null = null;
async function realQuery(): Promise<ClaudeQueryFn> {
  if (cachedQuery) return cachedQuery;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  // SAFETY: same function, seen through the deliberately narrower seam above —
  // `unknown` stands in for the SDK message/option unions this adapter does not
  // depend on. TS refuses the plain assignment on exactly one point, the
  // contravariant prompt parameter (`AsyncIterable<unknown>` is not an
  // `AsyncIterable<SDKUserMessage>`), and the only prompt this adapter ever
  // passes is `singlePrompt`, which yields that exact SDKUserMessage shape.
  cachedQuery = query as ClaudeQueryFn;
  return cachedQuery;
}

/** The three block shapes that carry OUTPUT the model wrote: prose, its
 *  thinking, and a tool call's arguments. Every other block kind (a
 *  `tool_result` the SDK echoes, an image) reads as empty and estimates 0. */
const claudeContentBlock = z
  .object({
    type: z.string().catch(""),
    text: z.string().catch(""),
    thinking: z.string().catch(""),
    input: z.record(z.string(), z.json().catch(null)).nullable().catch(null),
  })
  .catch({ type: "", text: "", thinking: "", input: null });
type ClaudeContentBlock = z.infer<typeof claudeContentBlock>;

/** Characters of model output per token, the rough figure the live estimate
 *  divides by (F35-1). English prose and JSON both sit near it; the result's
 *  own `output_tokens` replaces the estimate when the run ends. */
const OUTPUT_CHARS_PER_TOKEN = 4;

/**
 * F35-1: a lower-bound ESTIMATE of the output tokens one streamed envelope's
 * content blocks represent: the text, the thinking and the JSON of a tool
 * call's input, at ~4 characters per token, rounded up. The SDK's per-envelope
 * `usage.output_tokens` is the `message_start` placeholder (1 to 3 per API
 * message), so a run that wrote 20k characters of files read "49 tokens" for
 * twelve minutes; this reads a few thousand, which is the right order.
 */
function estimateOutputTokens(blocks: ClaudeContentBlock[]): number {
  let chars = 0;
  for (const block of blocks) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "tool_use" && block.input) chars += JSON.stringify(block.input).length;
  }
  return Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN);
}

/**
 * The fields the ADAPTER itself reads off a streamed SDK envelope, decoded once
 * per message at the stream boundary (the console line is projected separately
 * by `projectEnvelope`, which decodes the same envelope for its own purposes).
 *
 * Every field is independently tolerant — a junk one reads as absent and never
 * ends a run — because both vendors add envelope shapes between minor versions
 * (runtime-adapters.md gotcha 9). A non-object message decodes to all-absent.
 */
const claudeEnvelopeSchema = z
  .object({
    type: z.string().nullable().catch(null),
    /** `result` envelopes: the SDK's own terminal sub-classification. */
    subtype: z.string().nullable().catch(null),
    /** `result` envelopes: the failure prose. Blank prose is no prose — the
     *  classifier falls back to the subtype rather than to an empty string. */
    result: z
      .string()
      .refine((text) => text.trim() !== "")
      .nullable()
      .catch(null),
    /** Ruling 130(a): the assistant envelope's API-error code, the result's
     *  HTTP status and terminal reason, and a rate-limit reading's status,
     *  window and reset. Read only to classify; never persisted raw. */
    error: z.string().nullable().catch(null),
    api_error_status: z.number().nullable().catch(null),
    terminal_reason: z.string().nullable().catch(null),
    rate_limit_info: z
      .object({
        status: z.string().nullable().catch(null),
        rateLimitType: z.string().nullable().catch(null),
        resetsAt: z.number().nullable().catch(null),
      })
      .nullable()
      .catch(null),
    /** Set on every envelope a subagent (the Agent tool) produced. Their
     *  usage is not part of the result's `usage` (main loop only), so the live
     *  fold leaves them out too. */
    parent_tool_use_id: z.string().nullable().catch(null),
    /** `assistant` envelopes: the content blocks THIS envelope carries
     *  (F35-1: the live output estimate is read off them, because the usage's
     *  `output_tokens` is a placeholder until the result). The prompt figures
     *  are read once, at the wire boundary (`facts.cache`, ruling 369). */
    message: z
      .object({
        content: z.array(claudeContentBlock).catch(() => []),
      })
      .nullable()
      .catch(null),
  })
  .catch({
    type: null,
    subtype: null,
    result: null,
    error: null,
    api_error_status: null,
    terminal_reason: null,
    rate_limit_info: null,
    parent_tool_use_id: null,
    message: null,
  });
/**
 * Ruling 371: the dynamic tail of a specialist's prompt split rides its FIRST
 * user message, ahead of the instruction, so the preset's system prompt (the
 * static block as its append) stays byte-identical across the tasks one
 * profile is dispatched on. The heading tells the model what it is reading.
 */
function withDynamicTail(dynamic: string, prompt: string): string {
  if (!dynamic.trim()) return prompt;
  return `# This run's context (Viberr, this run only)${dynamic}\n\n---\n\n${prompt}`;
}

/**
 * Turn a Claude-run failure into a short, REDACTION-SAFE reason line. The raw
 * error can echo argv, env, or credentials, so only classified phrases are
 * surfaced — never the raw message. Persisted as a terminal `err` log line so
 * the run panel shows WHY a run errored and `runFailureReason` (agent-reply)
 * can classify the escalation packet (F-SPAWN3 / A3). Recognizes the spawn-time
 * crash class (EBADF/ENOENT/EMFILE) distinctly so a host-resource failure reads
 * as "could not start", not a generic error.
 */
/** The redaction-safe failure class the adapter derives from the raw error
 *  BEFORE discarding it, mirroring the codex adapter (F7-RUN1). The class rides
 *  the err line's tag as a `·<kind>` suffix so `runFailureReason` classifies
 *  auth/quota without re-regexing the deliberately-generic message text (the
 *  auth message says "authentication", which the downstream prose regex misses
 *  — the symmetric bug the codex fix noted). */
type ClaudeFailureKind =
  | "quota"
  | "auth"
  /** The provider could not serve the run (see `RunFailureKind`): the SDK
   *  gave up after repeated 529s (`api_error_status: 529`, SDK ≥ 0.3.223) or
   *  a 5xx, or the assistant banner carried `overloaded` / `server_error`.
   *  Its own class because the remedy is a plain retry — the account, the
   *  window and the task are all fine — which is what neither `quota` nor
   *  `unknown` ("review the runtime configuration") says. */
  | "overloaded"
  /** P13-D-2: `--resume <id>` against a transcript Claude Code has swept
   *  ("No conversation found with session ID …"). `resumeRun`'s pre-flight
   *  probe normally re-anchors before we get here; this covers the SDK finding
   *  out first. Not an auth class — the credential is fine. */
  | "session_missing"
  | "unknown";

/** Turn cap for a claude run — a RUNAWAY guard, not a work budget; deployments
 *  tune it with VIBERR_CLAUDE_MAX_TURNS in .env. Why the default of 2000 is
 *  deliberately huge, and the parse of a set value, live in the env schema
 *  (ruling 458(j)). */
function resolveMaxTurns(): number {
  return getEnv().VIBERR_CLAUDE_MAX_TURNS;
}

/** The classifier's whole output: the routing class, the canonical sentence a
 *  human reads, and the provider's own words after redaction. */
interface ClaudeFailure {
  kind: ClaudeFailureKind;
  message: string;
  providerText: string;
  /** Ruling 130(a): the machine facts, attached to the terminal line. */
  facts: RunFailureFacts;
}

/**
 * Ruling 130(a): what the stream said about the failure BEFORE the prose is
 * consulted. `rateLimit` is the last `rate_limit_event` reading; `apiError`
 * the last assistant envelope's error code; `apiErrorStatus` and
 * `terminalReason` the result's own fields.
 */
interface FailureEvidence {
  rateLimit: { status: string | null; rateLimitType: string | null; resetsAt: number | null } | null;
  apiError: string | null;
  apiErrorStatus: number | null;
  terminalReason: string | null;
}

const NO_EVIDENCE: FailureEvidence = {
  rateLimit: null,
  apiError: null,
  apiErrorStatus: null,
  terminalReason: null,
};

const QUOTA_API_ERRORS = new Set(["rate_limit", "billing_error"]);
/** `account_on_hold` joined the SDK's assistant-error union in the 0.3.221–261
 *  range: the provider refuses the account itself (a billing hold), so the
 *  remedy is the auth one — a different account or an API key — never a retry. */
const AUTH_API_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold"]);
/** The provider's own capacity/side failures; classified `overloaded`. */
const OVERLOAD_API_ERRORS = new Set(["overloaded", "server_error"]);
/** A result the SDK ended on a provider-side status: 529 (overloaded) or any
 *  other 5xx it stopped retrying. 4xx statuses are the account's (quota/auth). */
function isProviderSideStatus(status: number | null): boolean {
  return status !== null && status >= 500 && status <= 599;
}

/** The facts record for a classified kind: the window and reset ride ONLY on
 *  a REJECTED reading, so a transient 429 names no instant. */
function failureFacts(kind: RunFailureKind, evidence: FailureEvidence): RunFailureFacts {
  const facts = emptyRunFailureFacts(kind);
  facts.apiError = evidence.apiError;
  facts.apiErrorStatus = evidence.apiErrorStatus;
  facts.terminalReason = evidence.terminalReason;
  if (evidence.rateLimit?.status === "rejected") {
    facts.windowRejected = true;
    facts.window = evidence.rateLimit.rateLimitType;
    facts.resetsAt =
      evidence.rateLimit.resetsAt != null
        ? new Date(evidence.rateLimit.resetsAt * 1000).toISOString()
        : null;
  }
  return facts;
}

/** The `code` a Node spawn failure carries (`EBADF`/`ENOENT`/…). Anything that
 *  is not an object with a string `code` decodes to "" and matches no arm — the
 *  same thing the previous property read did. */
const spawnErrorCodeSchema = z
  .object({ code: z.string() })
  .transform((thrown) => thrown.code)
  .catch("");

/**
 * Ruling 130(a): classify a failure from the STRUCTURED envelope evidence
 * first (a rejected rate-limit reading, the assistant envelope's error code,
 * the result's HTTP status) and from prose second, in this order: spawn codes
 * → session_missing → quota → auth → unknown. The prose regexes stay as the
 * fallback for a thrown stream error with no envelope evidence.
 */
function classifyClaudeError(cause: unknown, evidence: FailureEvidence = NO_EVIDENCE): ClaudeFailure {
  const code = spawnErrorCodeSchema.parse(cause);
  if (code === "EBADF" || code === "EMFILE" || code === "ENFILE") {
    // R20-3: these three name the real cause already (host resource exhaustion,
    // not a provider verdict), so there is no separate provider sentence to add.
    return {
      kind: "unknown",
      message:
        "The agent process could not be started (the host ran out of file handles). No work was performed.",
      providerText: "",
      facts: failureFacts("unknown", evidence),
    };
  }
  if (code === "ENOENT") {
    return {
      kind: "unknown",
      message:
        "The agent runtime executable was not found. Check the deployment's Claude CLI/SDK install.",
      providerText: "",
      facts: failureFacts("unknown", evidence),
    };
  }
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  // R20-3 (F20-4): the provider's own redacted sentence, surfaced beside the
  // canonical message for the quota/auth/unknown arms (the earlier arms already
  // name their cause). See git-output-redact:redactProviderText.
  const providerText = redactProviderText(cause);
  // P13-D-2 before the auth branch: a swept transcript must never be narrated
  // as a rejected credential.
  if (SESSION_MISSING_RE.test(raw)) {
    return {
      kind: "session_missing",
      message:
        "The Claude session could not be resumed — its transcript no longer exists (provider retention). Nothing is wrong with the credential; the conversation history is gone. Re-run the agent to start a fresh session anchored on task.md.",
      providerText: "",
      facts: failureFacts("session_missing", evidence),
    };
  }
  const rejectedWindow = evidence.rateLimit?.status === "rejected";
  // A run the SDK ended on a PROVIDER-side status (529/5xx) ended there, so an
  // earlier assistant banner (`rate_limit` retried through, say) does not
  // re-route it to the account's window — except a REJECTED reading, which is
  // the provider's explicit statement that the window is spent and wins.
  const providerSide = isProviderSideStatus(evidence.apiErrorStatus);
  const quotaByEvidence =
    rejectedWindow ||
    (!providerSide && evidence.apiError !== null && QUOTA_API_ERRORS.has(evidence.apiError)) ||
    evidence.apiErrorStatus === 429;
  if (
    quotaByEvidence ||
    /usage limit|quota|rate limit|too many requests|\b429\b|session limit|weekly limit|monthly limit|out of credits|credit balance/i.test(
      raw,
    )
  ) {
    const facts = failureFacts("quota", evidence);
    const window = facts.window ? facts.window.replace(/_/g, " ") : null;
    return {
      kind: "quota",
      // Role-neutral: this classifier runs for operator AND specialist/reviewer
      // runs, so it must not say "the coordinating model" (misleads a human
      // triaging a failed delivery run toward the operator).
      message: facts.windowRejected
        ? `The Claude account is over its usage quota: its ${window ?? "usage"} window is spent${facts.resetsAt ? ` and reopens at ${formatAbsoluteUTC(facts.resetsAt)}` : ""}. Wait for it, or switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.`
        : "The Claude account is over its usage quota. Retry after the limit resets, or switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.",
      providerText,
      facts,
    };
  }
  const authByEvidence =
    (!providerSide && evidence.apiError !== null && AUTH_API_ERRORS.has(evidence.apiError)) ||
    evidence.apiErrorStatus === 401 ||
    evidence.apiErrorStatus === 403;
  if (
    authByEvidence ||
    /unauthor|forbidden|invalid.*(?:key|token|credential)|\b401\b|\b403\b|not logged in|authenticate|authentication/i.test(
      raw,
    )
  ) {
    const facts = failureFacts("auth", evidence);
    const orgRestricted = evidence.apiError === "oauth_org_not_allowed";
    const onHold = evidence.apiError === "account_on_hold";
    return {
      kind: "auth",
      message: orgRestricted
        ? `The Claude account was refused by the provider (${evidence.apiErrorStatus ?? 403} oauth_org_not_allowed): the organization this account belongs to does not allow it here. Switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.`
        : onHold
          ? `The Claude account was refused by the provider (${evidence.apiErrorStatus ? `${evidence.apiErrorStatus} ` : ""}account_on_hold): the account itself is on hold, so no run can bill it until the hold is lifted. Switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.`
          : `The Claude credential was rejected${evidence.apiErrorStatus ? ` (${evidence.apiErrorStatus}${evidence.apiError ? ` ${evidence.apiError}` : ""})` : ""}. Switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.`,
      providerText,
      facts,
    };
  }
  // U35-11 (pass 35): a connection that failed BEFORE the provider answered.
  // The CLI reports a TLS verification error, a refused socket or a DNS
  // failure as "API Error: Unable to connect to API (<code>)" under the same
  // `server_error` banner an overload uses, with NO HTTP status (nothing
  // answered), so the overload arm below narrated it as "the provider failed
  // on its own side" while the deployment's own network path was the fault.
  // Same class (the remedy is the same retry; nothing about the account or
  // the task is wrong), its own origin and its own sentence. A run the
  // provider DID answer with a 5xx is never read as local, whatever its prose.
  if (!providerSide && LOCAL_NETWORK_FAILURE_RE.test(raw)) {
    const facts = failureFacts("overloaded", evidence);
    facts.origin = "local";
    const code = localNetworkFailureCode(raw);
    return {
      kind: "overloaded",
      message: `Claude could not be reached from this deployment: the connection failed before the provider answered${code ? ` (${code})` : ""}. Nothing about the account or the task is wrong; check this deployment's network path (TLS, DNS, proxy) and retry in a few minutes.`,
      providerText,
      facts,
    };
  }
  // The provider's side, not the account's: the SDK gave up after repeated
  // 529s (`api_error_status: 529`, structural since SDK 0.3.223) or another
  // 5xx, or the banner said `overloaded` / `server_error`. Prose covers the
  // thrown-stream case with the same signatures the run projection has always
  // read as "the backend was unavailable" (`BACKEND_UNAVAILABLE_SIGNATURES`).
  const overloadByEvidence =
    providerSide ||
    (evidence.apiError !== null && OVERLOAD_API_ERRORS.has(evidence.apiError));
  if (
    overloadByEvidence ||
    /overloaded|\b5(?:0[023]|29)\b|temporarily unavailable|service unavailable|server error/i.test(
      raw,
    )
  ) {
    const facts = failureFacts("overloaded", evidence);
    facts.origin = "provider";
    const status = evidence.apiErrorStatus;
    const overloaded =
      status === 529 || evidence.apiError === "overloaded" || /overloaded|\b529\b/i.test(raw);
    return {
      kind: "overloaded",
      // Role-neutral, like the quota arm. Names the fact (the provider, not
      // the account) and the one honest remedy: a retry. The packet builder
      // adds "on the other backend now" only when the owner has it connected.
      message: overloaded
        ? `Claude could not serve this run: the provider was overloaded${status ? ` (HTTP ${status})` : ""}. Nothing about the account or the task is wrong; retry in a few minutes.`
        : `Claude could not serve this run: the provider failed on its own side${status ? ` (HTTP ${status})` : ""}. Nothing about the account or the task is wrong; retry in a few minutes.`,
      providerText,
      facts,
    };
  }
  return {
    kind: "unknown",
    message: "The agent run did not complete. Review the runtime configuration.",
    providerText,
    facts: failureFacts("unknown", evidence),
  };
}


/** What `assembleClaudeOptions` needs from the caller beyond the spec: the
 *  per-run resolutions the adapter made and the seams a query drives. */
interface AssembleContext {
  resolvedModel: ReturnType<typeof resolveClaudeModel>;
  nativeSkills: string[];
  droppedSkills: string[];
  skillPlugin: RunSpec["skillPlugin"] | undefined;
  spawn: (request: ClaudeSpawnRequest) => ClaudeSpawnedProcess;
  phase: (name: string, step: string | null) => void;
  emitPolicyDenied: (command: string, reason: string, toolUseId: string | undefined) => void;
  /** Ruling 527: the run's steering channel and the console's record of each
   *  delivery. Null on the completion compaction, whose single request is
   *  past the turn's final answer. */
  steering: { channel: RunSteering; onDelivered: (count: number) => void } | null;
  abortController: AbortController;
}

/** What `assembleClaudeOptions` returns: the SDK options and the first prompt. */
interface AssembledClaudeQuery {
  options: ClaudeQueryOptions;
  prompt: string;
}

/**
 * The query options a run of `spec` is started with, and its first prompt.
 * ONE builder for the run and for the completion compaction that follows it
 * (ruling 376): the compaction request must carry the same tools, system
 * prompt and servers as the run, or it is a different prefix and the cache it
 * was meant to read is missed.
 */
function assembleClaudeOptions(
  spec: RunSpec,
  deps: ClaudeAdapterDeps,
  ctx: AssembleContext,
): AssembledClaudeQuery {
  const { resolvedModel, nativeSkills, droppedSkills, skillPlugin } = ctx;
  const options: ClaudeQueryOptions = {
    cwd: spec.workdir,
    // Fully autonomous: bypass ALL permission prompts so a
    // server-spawned run never blocks waiting for approval (there is no
    // human at the CLI). acceptEdits still gated non-edit tools like
    // Bash; bypassPermissions runs unattended end-to-end.
    permissionMode: spec.autonomous ? "bypassPermissions" : "default",
    // Nobody answers a prompt here, on ANY run: the process that would
    // is this server, and it passes no `canUseTool`. Stated to the SDK
    // (≥ 0.3.259) so a tool the mode would ask about is denied at once
    // with a reason the model can act on, instead of the unstated
    // headless fallback. Binds only on the `default` seam; bypass never
    // prompts. Deny rules and `disallowedTools` are unaffected.
    permissionPrompts: "none",
    // A runaway guard, NOT a work budget: 50 cut off real dev runs
    // mid-delivery (a finished implementation died at turn 51). Default
    // generous; override per deployment with VIBERR_CLAUDE_MAX_TURNS.
    maxTurns: resolveMaxTurns(),
    // SDK isolation: never load the host machine's ~/.claude settings
    // tiers into a Viberr run — a run must see exactly the resources its
    // profile grants, not the operator-user's personal Claude Code
    // settings/plugins/skills. `settingSources: []` on EVERY run: no host
    // tier, and no project source over the checkout either (ruling 180),
    // so the repository under review's `.claude` and CLAUDE.md never
    // reach the model at system-prompt tier.
    //
    // Two shapes, decided by whether Viberr mounted any granted skill:
    //
    //  · NO granted skills (operator runs, Codex profiles, a run with no
    //    checkout) — `skills: []` lists none and `plugins: []` names ZERO
    //    local plugins (defense-in-depth for the plugin channel, F13).
    //    HONEST LIMIT (docker-verified 2026-07-18): `skills: []` does NOT
    //    give an empty skill SET — the SDK compiles ~16 first-party
    //    skills into its binary and a standalone deployment (pristine
    //    CLAUDE_CONFIG_DIR, no host ~/.claude) still lists all 16 in the
    //    run's init. That is why `BASE_DENIED_BUILTINS` denies the
    //    `Skill` TOOL, making them UNINVOKABLE.
    //
    //  · GRANTED skills mounted — ruling 180 (F36-9): the run's plugin
    //    directory (`<checkout>/../.viberr-plugins/<runId>/`, built by
    //    `mountGrantedSkills` moments earlier) is the ONE local plugin,
    //    and `skills: ["<plugin>:<name>", …]` enables exactly its skills
    //    by their qualified names. The filter is what replaces the
    //    blanket `Skill` deny: an unlisted skill (every bundled one
    //    included) is hidden from the model and REJECTED by the Skill
    //    tool. Nothing of Viberr's lives inside the checkout any more,
    //    so the project's own tools (`prettier --check .`) see the tree
    //    exactly as a clean clone. Canaried inside the image 2026-09-11:
    //    the CLI's init lists `viberr:<name>` and the model invokes it.
    settingSources: [],
    // Ruling 370: sorted, so two runs of one profile list the same
    // skills in the same order (enumeration drift was the one measured
    // residual of a shared preset prefix).
    skills: skillPlugin
      ? sortedNames(nativeSkills.map((name) => `${skillPlugin.name}:${name}`))
      : [],
    plugins: skillPlugin
      ? [{ type: "local", path: skillPlugin.path, skipMcpDiscovery: true }]
      : [],
    // R18-3 (governance parity with settingSources): only Viberr-granted
    // MCP servers reach a run — ignore a repo `.mcp.json`, user MCP config,
    // and plugin MCP. Viberr passes its granted external MCPs + the
    // in-process toolkit via `mcpServers`; nothing ambient should widen it.
    strictMcpConfig: true,
  };
  // Ruling 174: the SDK requires this beside `bypassPermissions`
  // (sdk.d.ts) and defaults it to false. Only the autonomous run asks
  // for bypass, so only it carries the acknowledgement.
  if (spec.autonomous) options.allowDangerouslySkipPermissions = true;
  // Ruling 174: the CLI leads its own process group, so every signal the
  // SDK sends it reaches the MCP servers it starts, and the settle sweep
  // can name the group. The handle is this run's alone.
  options.spawnClaudeCodeProcess = (request) => ctx.spawn(request);
  // Ruling 175: the instance's spending cap, when one is set. The SDK
  // stops the query past it and says so with `error_max_budget_usd`.
  if (spec.maxSpendUsd) options.maxBudgetUsd = spec.maxSpendUsd;
  // Only NAME a model when we have a real id/alias; otherwise let the SDK
  // (and the subscription) pick its default.
  if (resolvedModel) options.model = resolvedModel;
  // Pass the profile's chosen reasoning effort when it is one the SDK
  // accepts; otherwise the SDK uses its default (high). Narrowed rather
  // than forwarded raw so a Codex-only tier ("minimal") never reaches the
  // Claude union (P13-RT-08).
  const effort = resolveClaudeEffort(spec.effort);
  if (effort) options.effort = effort;
  if (spec.resumeSessionId) options.resume = spec.resumeSessionId;
  // Base adapter env, overlaid with any per-run env (e.g. the specialist's
  // GIT_CEILING_DIRECTORIES workspace confinement).
  if (deps.env || spec.env) {
    options.env = { ...deps.env, ...spec.env };
  }
  // System prompt strategy differs by run kind:
  //  · OPERATOR — its persona REPLACES the default. The operator never
  //    writes code; it only uses the in-process viberr MCP tools, so it
  //    must not carry Claude Code's coding harness/tool scaffolding.
  //  · SPECIALIST (primary/reviewer) — its persona is APPENDED to the
  //    `claude_code` preset, so the agent keeps the default coding
  //    harness (it DOES implement/test) with its persona layered on top.
  //    Replacing it (the old behavior) stripped the scaffolding and made a
  //    coding agent run on persona prose alone.
  // The instruction the first user message carries. A specialist's
  // prompt split puts its dynamic tail here (ruling 371).
  let prompt = spec.prompt;
  if (spec.systemPrompt) {
    // C02-R7: the persona announced the mounted skills; when the start
    // could not enable them, the correction rides the run — on the
    // dynamic side, since it varies per run (ruling 370).
    const correction = droppedSkills.length > 0 ? droppedSkillsNotice(droppedSkills) : "";
    const split = isPromptPrefix(spec.systemPrompt)
      ? {
          static: spec.systemPrompt.static,
          dynamic: correction
            ? [...spec.systemPrompt.dynamic, correction]
            : spec.systemPrompt.dynamic,
        }
      : null;
    if (spec.kind === "operator") {
      // Ruling 370: a fresh session per turn, so nothing to record; the
      // static block caches across tasks behind the SDK's boundary.
      options.systemPrompt = split
        ? claudeSystemPromptBlocks(split)
        : spec.systemPrompt + correction;
    } else if (spec.kind === "controller") {
      // Ruling 373: coordination machinery like the operator (its
      // persona REPLACES the coding harness), resumed on every turn —
      // so the prompt is recorded on the session's first request and
      // reused until compaction (`snapshot`).
      options.systemPrompt = {
        type: "custom",
        prompt: split ? claudeSystemPromptBlocks(split) : spec.systemPrompt + correction,
        snapshot: true,
      };
    } else {
      // Ruling 371: the coding harness with the STATIC block appended,
      // its per-directory sections moved out of the system prompt
      // (`excludeDynamicSections`) and the whole thing recorded for the
      // session (`snapshot`); the dynamic tail opens the first user
      // message instead. An edited persona therefore reaches a resumed
      // session only after its next compaction.
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: split ? staticPromptText(split) : spec.systemPrompt + correction,
        excludeDynamicSections: true,
        snapshot: true,
      };
      if (split) prompt = withDynamicTail(dynamicPromptText(split), prompt);
    }
  }
  // Ruling 370: servers in name order, so the init's `mcp_servers` and
  // the tool definitions the SDK sends are the same bytes on every run.
  if (spec.mcpServers) options.mcpServers = sortedRecord(spec.mcpServers);
  if (spec.allowedTools && spec.allowedTools.length) {
    options.allowedTools = sortedNames(spec.allowedTools);
  }
  // Capability confinement via denylist. `disallowedTools` removes tools
  // from the model's context entirely and binds even under
  // bypassPermissions (unlike `allowedTools`, which only auto-approves).
  //   - operator: deny the repo-mutation built-ins so it genuinely can't
  //     write code / touch the repo — its job is the in-process
  //     `mcp__viberr__*` governance tools, which stay available (as does
  //     the tool-loading path). Enforces the PRD contract in code, not
  //     just the persona prompt.
  //   - specialist: deny the git/gh commands for capabilities the profile
  //     withholds (push / PR / merge), computed upstream.
  const denied = [
    // `Skill` leaves the base list for a run that mounted granted skills:
    // denying it would remove the tool from the model's context entirely
    // (deny beats the `skills` option's auto-allow), so the mounted skills
    // would be listed and uninvokable — a silent capability loss. The
    // `skills` filter is the fence for that run instead.
    ...BASE_DENIED_BUILTINS.filter(
      (tool) => tool !== "Skill" || nativeSkills.length === 0,
    ),
    // The controller shares the operator's no-write posture and goes
    // further (no filesystem reads either); its extra denies arrive via
    // spec.disallowedTools from buildControllerRun.
    ...(spec.kind === "operator" || spec.kind === "controller"
      ? OPERATOR_READ_ONLY_DENIED_TOOLS
      : []),
    // Supporting/reviewing runs never touch the remote (VIB-30); their
    // LOCAL write posture is grants-derived via spec.disallowedTools
    // (parity ruling 2026-08-31 — see the constant's doc).
    ...(spec.kind === "reviewer" ? SUPPORTING_DELIVERY_DENIED_BUILTINS : []),
    ...(spec.disallowedTools ?? []),
  ];
  // Ruling 370: sorted and deduplicated for the same reason as the
  // servers above; the rules read the same whatever their order.
  if (denied.length) options.disallowedTools = sortedNames(denied);
  // Ruling 101(e), amended (Option D PR 5): the prefix rules above match a
  // command by its leading words, and the pinned CLI, which already splits
  // `&&` and `;` chains, still let `git -C . push` and `sh -c 'git push'`
  // through (measured 2026-09-11: both refs landed on a local remote). A
  // run with argument-level denies gets a PreToolUse hook that refuses a
  // command reaching one, however wrapped, with a reason the model reads.
  // It runs before the rules and only ever denies, so the rules stay the
  // fence; a run whose Bash is denied outright needs none.
  const bashPrefixes = denied.includes("Bash") ? [] : bashDenyPrefixes(denied);
  if (bashPrefixes.length) {
    const policyHook: ClaudePreToolUseHook = async (input, toolUseId) => {
      const command = bashCommandSchema.safeParse(input.tool_input).data?.command ?? "";
      const prefix = deniedPrefixFor(command, bashPrefixes);
      if (!prefix) return {};
      const reason = bashDenyReason(prefix, denied, spec.kind === "reviewer");
      ctx.emitPolicyDenied(command, reason, toolUseId);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };
    options.hooks = { PreToolUse: [{ matcher: "Bash", hooks: [policyHook] }] };
  }
  // Ruling 371/373: the run's anchor comes back the moment its context
  // has been compacted (the `compact` source of `SessionStart`) — the
  // system prompt survives compaction, tool output and the summary's
  // omissions do not. `PreCompact` only names the wait: the summary
  // request is a full-history model call (131 s on the one stored
  // compaction), and the strip would otherwise show the last tool as
  // still running.
  const anchor = spec.compactAnchor;
  if (anchor) {
    const anchorHook: ClaudeSessionStartHook = async () => ({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: anchor },
    });
    options.hooks = {
      ...options.hooks,
      SessionStart: [{ matcher: "compact", hooks: [anchorHook] }],
    };
  }
  const preCompactHook: ClaudePreCompactHook = async (input) => {
    logger.info("claude run compacting its context", {
      runId: spec.runId,
      trigger: input.trigger ?? null,
    });
    ctx.phase(RUN_PHASE.compacting, null);
    return {};
  };
  options.hooks = { ...options.hooks, PreCompact: [{ hooks: [preCompactHook] }] };
  // Ruling 527: a message the person sends while a controller turn works
  // reaches the model at the turn's next step boundary, beside the results of
  // the tool calls it was waiting on. The SDK's own mid-turn input (a `next`
  // priority user message) is not used: measured on SDK 0.3.280, one that
  // lands while the model writes its final answer starts a second model turn
  // inside the same run, after the result, and neither closing the input nor
  // `cancelAsyncMessage` at the result stopped it. Here the host keeps the
  // messages until a boundary asks, and `Stop` says when no boundary will
  // come again, so every message is read by this turn or starts the next one.
  const steering = ctx.steering;
  if (steering) {
    const deliverHook: ClaudePostToolBatchHook = async () => {
      const delivery = steering.channel.take();
      if (!delivery) return {};
      steering.onDelivered(delivery.count);
      return {
        hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: delivery.text },
      };
    };
    const closeHook: ClaudeStopHook = async () => {
      steering.channel.close();
      return {};
    };
    options.hooks = {
      ...options.hooks,
      PostToolBatch: [{ hooks: [deliverHook] }],
      Stop: [{ hooks: [closeHook] }],
    };
  }
  // The subprocess kill switch: the interrupt/idle watchdogs abort this
  // when the cooperative `interrupt()` goes unanswered (see `armForcedStop`).
  options.abortController = ctx.abortController;
  return { options, prompt };
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): RuntimeAdapter {
  return {
    backend: "claude",
    /**
     * Ruling 376: `/compact` on the session a run just left, built from the
     * same spec so the request reads the run's cached prefix. The boundary the
     * CLI reports becomes the run's own compaction fact (trigger `completion`,
     * sizes from the CLI); the request's cost and tokens add to the run's
     * totals; a refusal ("Not enough messages to compact.") is the outcome's
     * reason, never a thrown error.
     */
    async compact(spec: RunSpec, sessionId: string, cb: CompactCallbacks): Promise<CompactOutcome> {
      const queryFn = deps.queryFn ?? (await realQuery());
      const { native: nativeSkills, dropped: droppedSkills } = nativeSkillsOutcome(spec);
      const phase = (name: string, step: string | null) => cb.onPhase?.(name, step);
      const { options } = assembleClaudeOptions(spec, deps, {
        resolvedModel: resolveClaudeModel(spec.model),
        nativeSkills,
        droppedSkills,
        skillPlugin: nativeSkills.length ? spec.skillPlugin : undefined,
        spawn: (request) =>
          spawnClaudeCli(request, deps.spawnCli, deps.signalProcess, spec.agent ?? null).process,
        phase,
        emitPolicyDenied: () => {},
        steering: null,
        abortController: new AbortController(),
      });
      options.resume = sessionId;
      options.maxTurns = 1;
      // Its own marker: the run's settle sweep must not reap this process.
      if (options.env?.[RUN_MARKER_ENV]) {
        options.env = { ...options.env, ...compactionMarkerEnv(spec.runId) };
      }
      phase(RUN_PHASE.compacting, "at the end of the run");
      const clock = (iso: string) => iso.slice(11, 19);
      const k = (n: number | null) => (n === null ? "?" : wholeThousands(n));
      let outcome: CompactOutcome = {
        compacted: false,
        reason: "the provider reported no compaction boundary",
      };
      let resultText: string | null = null;
      try {
        const q = queryFn({
          prompt: singlePrompt(`/compact ${COMPLETION_COMPACT_INSTRUCTIONS}`),
          options,
        });
        for await (const message of q) {
          const occurredAt = new Date().toISOString();
          const { display, facts } = projectEnvelope("claude", message, occurredAt);
          const envelope = claudeEnvelopeSchema.parse(message);
          // The session is the run's; its init line and the summary the CLI
          // writes as a user message are on the transcript, not the console.
          if (envelope.type === "system" && envelope.subtype === "init") continue;
          if (envelope.type === "user") continue;
          const folded: EnvelopeFacts = {};
          // A message the projector shows nothing for carries nothing here.
          if (!display && !facts.compaction && !facts.isResult) continue;
          const base: LogLine = display ?? {
            t: clock(occurredAt),
            ev: "meta",
            tag: "run·compaction",
            text: "",
          };
          let shown: LogLine = base;
          if (facts.compaction) {
            const compaction = { ...facts.compaction, trigger: "completion" };
            folded.compaction = compaction;
            outcome = {
              compacted: true,
              preTokens: compaction.preTokens,
              postTokens: compaction.postTokens,
            };
            shown = {
              ...base,
              ev: "meta",
              tag: "run·compacted·completion",
              text: `context compacted at the end of the run · ${k(compaction.preTokens)} → ${k(compaction.postTokens)} tokens`,
            };
          } else if (facts.isResult) {
            resultText = envelope.result ?? null;
            if (facts.costUsd != null) folded.costAddUsd = facts.costUsd;
            if (facts.usage && !facts.usage.outputEstimated) {
              folded.usageAdd = {
                input_tokens: facts.usage.input_tokens,
                cached_input_tokens: facts.usage.cached_input_tokens,
                output_tokens: facts.usage.output_tokens,
              };
            }
            shown = {
              ...base,
              ev: "meta",
              tag: "run·compaction·request",
              text:
                `compaction request · ${facts.costUsd != null ? `$${facts.costUsd.toFixed(2)}` : "cost not reported"}` +
                (facts.usage ? ` · ${k(facts.usage.input_tokens + facts.usage.cached_input_tokens)} in, ${k(facts.usage.output_tokens)} out` : ""),
            };
          } else if (envelope.type === "assistant") {
            // The summary call's own figures ride the result line; a per-call
            // cache fact here would read the whole history as this run's last
            // prompt, which the boundary's post size just replaced.
            continue;
          }
          cb.onLine({ raw: JSON.stringify(message), display: shown, facts: folded, occurredAt });
        }
      } catch (error) {
        const reason = errorMessage(error);
        outcome = { compacted: false, reason };
        const occurredAt = new Date().toISOString();
        cb.onLine({
          raw: "",
          display: {
            t: clock(occurredAt),
            ev: "meta",
            tag: "run·compaction·failed",
            text: `compaction at the end of the run did not happen: ${redactProviderText(reason)}`,
          },
          facts: {},
          occurredAt,
        });
      }
      if (!outcome.compacted && resultText) outcome = { compacted: false, reason: resultText };
      return outcome;
    },
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawResult = false;
      let resultIsError = false;
      let resultSubtype: string | null = null;
      /** Ruling 175: what the result says the run spent, for a `max_budget`
       *  cut-off's facts. */
      let resultCostUsd: number | null = null;
      /** The failing RESULT envelope's own error prose, kept only long enough to
       *  classify it (P14-RT-10) — it is never persisted or logged raw. */
      let resultErrorText: string | null = null;
      /** Ruling 130(a): the structured evidence the stream produced, kept for
       *  the classifier. */
      const evidence: FailureEvidence = { ...NO_EVIDENCE };
      let interrupted = false;
      let settled = false;
      let idleTimedOut = false;
      let queryHandle: ClaudeQuery | null = null;
      // Wired into the SDK query options below. Aborting it tears down the
      // spawned CLI subprocess (SIGTERM→SIGKILL, to its whole group since
      // ruling 174) — the real stop lever behind the cooperative
      // `interrupt()`, which a wedged CLI never answers.
      const abortController = new AbortController();
      // This run's CLI once the SDK has spawned it through
      // `spawnClaudeCodeProcess` (ruling 174). Per run, never module state, so
      // two concurrent runs cannot signal each other's group.
      let cli: ClaudeCli | null = null;

      // R21-4 / G5 (FR28): the live phase/step the run strip renders. `lastStep`
      // sticks so a stretch of model thinking still shows the tool the run is
      // waiting on, instead of blanking the column — and, once that tool has
      // answered, names it as answered (ruling 348).
      let lastStep: string | null = null;
      const phase = (name: string, step: string | null = lastStep) => {
        cb.onPhase?.(name, step);
      };

      // IDLE (inactivity) guard, not a wall-clock cap — the same shape the
      // codex adapter has used since owner ruling A8 (P13-RT-11). A claude run
      // may legitimately take hours; but if the SDK stream produces NO message
      // for this long it is hung, and nothing else would ever settle it.
      const idleMs = claudeIdleTimeoutMs();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      /** Deadline for a cooperative interrupt a wedged CLI never answers. */
      let interruptTimer: ReturnType<typeof setTimeout> | null = null;
      const disarmIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      /**
       * Escalate a stop the cooperative `interrupt()` did not achieve. After the
       * grace window ABORT the SDK subprocess (SIGTERM→SIGKILL) so the stream
       * ends for real and the loop's own catch settles the run once the process
       * is gone — a settled run must never leave a live process writing the
       * workspace. `onBackstop` runs only if even the abort never unblocks the
       * generator, so the row cannot hang `running` forever. `settle` clears
       * `interruptTimer`, so a real exit at any point cancels the escalation.
       */
      const armForcedStop = (onBackstop: () => void) => {
        if (interruptTimer) clearTimeout(interruptTimer);
        interruptTimer = setTimeout(() => {
          if (settled) return;
          logger.warn(
            "claude run did not stop cooperatively — aborting the subprocess",
            { runId: spec.runId, graceMs: INTERRUPT_GRACE_MS },
          );
          try {
            abortController.abort();
          } catch {
            // Already aborted / nothing to tear down.
          }
          // Ruling 174: the abort ends the SDK's stdin and SIGTERMs the CLI
          // after its own grace; the group hears it now, so the stdio MCP
          // servers the CLI started stop with it rather than outliving a CLI
          // that is past answering. The SDK's SIGKILL, and the settle sweep,
          // reach the same group.
          cli?.signalGroup("SIGTERM");
          interruptTimer = setTimeout(() => {
            if (settled) return;
            logger.warn(
              "claude subprocess abort did not settle the run — forcing it",
              { runId: spec.runId, graceMs: INTERRUPT_ABORT_GRACE_MS },
            );
            onBackstop();
          }, INTERRUPT_ABORT_GRACE_MS);
          interruptTimer.unref?.();
        }, INTERRUPT_GRACE_MS);
        interruptTimer.unref?.();
      };
      const armIdle = () => {
        disarmIdle();
        idleTimer = setTimeout(() => {
          if (settled || interrupted) return;
          idleTimedOut = true;
          logger.warn("claude run idle-timeout — no activity within the window", {
            runId: spec.runId,
            idleMs,
          });
          // Same channel a user interrupt uses; `idleTimedOut` distinguishes
          // the two so a hung run settles `error` (→ react/stuck packet) while
          // a human interrupt stays `interrupted`.
          void queryHandle?.interrupt().catch(() => {
            // Generator may already have completed.
          });
          // A hung stream will not answer the cooperative interrupt either, so
          // escalate to a real subprocess abort; the backstop settles `error`.
          armForcedStop(settleIdleTimeout);
        }, idleMs);
      };

      /**
       * The SDK appends the CLI's stderr tail to its exit error only when it
       * spawned the CLI itself. Viberr's spawn keeps the same tail, so the
       * classifier reads the sentence it always read — a resume whose session
       * is gone is named on stderr, and without it `session_missing` would fall
       * to `unknown`. The error's own properties ride along unchanged.
       */
      const withCliStderr = (cause: Error): Error => {
        const tail = cli?.stderrTail();
        if (!tail) return cause;
        if (!CLI_EXIT_ERROR_RE.test(cause.message) || cause.message.includes(". stderr: ")) {
          return cause;
        }
        const enriched = Object.assign(new Error(`${cause.message}. stderr: ${tail}`), cause);
        enriched.name = cause.name;
        return enriched;
      };

      /**
       * The console's record of a PreToolUse deny (Option D PR 5). The SDK
       * sends no `system/permission_denied` frame for a hook's decision, so
       * Viberr writes one in that frame's shape, marked as its own, and it
       * projects exactly as a rule's deny does: an error line naming the tool.
       */
      const emitPolicyDenied = (command: string, reason: string, toolUseId: string | undefined) => {
        const occurredAt = new Date().toISOString();
        const envelope = {
          type: "system",
          subtype: "permission_denied",
          source: "viberr",
          tool_name: "Bash",
          tool_use_id: toolUseId ?? "",
          // The SDK's own word for a hook's decision; the reason names the policy.
          decision_reason_type: "hook",
          decision_reason: reason,
          message: `Permission to use Bash with command ${command} has been denied.`,
        };
        const { display, facts } = projectEnvelope("claude", envelope, occurredAt);
        cb.onLine({ raw: JSON.stringify(envelope), display, facts, occurredAt });
      };

      /** Ruling 527: the console's record of a steering delivery, at the step
       *  it happened. The SDK echoes nothing for a hook's context, so without
       *  this line the log would show the model reacting to words it never
       *  shows arriving. */
      const emitSteered = (count: number) => {
        const occurredAt = new Date().toISOString();
        cb.onLine({
          raw: "",
          display: {
            t: occurredAt.slice(11, 19),
            ev: "meta",
            tag: "run·steered",
            text: `${countLabel(count, "new message")} from the person went into this turn here`,
          },
          facts: {},
          occurredAt,
        });
      };

      /** Persist a redaction-safe classified reason line, then settle error. */
      const settleError = (cause: unknown) => {
        if (settled) return;
        try {
          const failure = classifyClaudeError(
            cause instanceof Error ? withCliStderr(cause) : cause,
            evidence,
          );
          cb.onLine({
            raw: "",
            display: {
              t: new Date().toISOString().slice(11, 19),
              ev: "err",
              tag: `run·error·${failure.kind}`,
              // R20-3: append the provider's redacted sentence once (the marker
              // is what runFailureReason splits back off).
              text:
                failure.providerText &&
                !failure.message.includes(failure.providerText)
                  ? withProviderText(failure.message, failure.providerText)
                  : failure.message,
              failure: failure.facts,
            },
            facts: {},
            occurredAt: new Date().toISOString(),
          });
        } catch {
          // Never let the reason line block finalization.
        }
        settle("error");
      };

      /**
       * Ruling 174: a settled run leaves no live process. The CLI gets its own
       * exit first (the SDK closes it after the result, and its shutdown stops
       * the commands it tracks), bounded by the reap grace; then the sweep
       * signals its group and every process carrying this run's marker —
       * the `&` a finished command left, the command a SIGKILLed CLI was still
       * running, the Chromium a browser MCP launched. Nothing was spawned when
       * the SDK never called `spawnClaudeCodeProcess`, so there is nothing to
       * sweep.
       */
      const reap = () => {
        const spawned = cli;
        if (!spawned) return;
        const reapProcesses =
          deps.reapProcesses ??
          ((targets: ReapTargets) =>
            reapRunProcesses(targets, deps.signalProcess ? { signal: deps.signalProcess } : {}));
        void (async () => {
          await spawned.exited(RUN_REAP_GRACE_MS);
          const targets: ReapTargets = {
            runIds: spec.env?.[RUN_MARKER_ENV] ? [spec.runId] : [],
            groupLeader: spawned.pid,
          };
          // Ruling 460: the group leader is the launcher; its hard kill differs.
          if (spec.agent) targets.launched = true;
          await reapProcesses(targets);
        })().catch((error) => {
          logger.warn("claude run reap failed", {
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
        cb.onExit({ outcome, effectiveBackend: "claude", sessionId });
        reap();
      };

      /** A hung stream: one classified terminal line, then settle `error` so the
       *  react loop / stuck-loop packet fires and a human is notified. */
      const settleIdleTimeout = () => {
        if (settled) return;
        const now = new Date().toISOString();
        try {
          cb.onLine({
            raw: "",
            display: {
              t: now.slice(11, 19),
              ev: "err",
              tag: "run·error·idle_timeout",
              text:
                `The run produced no output for ${idleMs} ms and was stopped as hung — ` +
                "not a task failure. Re-prompt the agent to continue from its " +
                "session, or raise VIBERR_CLAUDE_IDLE_TIMEOUT_MS.",
            },
            facts: {},
            occurredAt: now,
          });
        } catch {
          // Never let the reason line block finalization.
        }
        settle("error");
      };

      const run = async () => {
        // Before anything can be awaited: the SDK module import, the binary
        // spawn and the first provider round-trip all happen with no output at
        // all, and that window is what the strip used to render blank.
        phase(RUN_PHASE.starting, null);
        const queryFn = deps.queryFn ?? (await realQuery());
        const resolvedModel = resolveClaudeModel(spec.model);
        // The granted skills Viberr MOUNTED as this run's plugin (empty for a
        // run with no grants, no checkout, or a Codex profile — see below —
        // and for one whose plugin went missing before the start; those are
        // `dropped`, and the persona is corrected below).
        const { native: nativeSkills, dropped: droppedSkills } = nativeSkillsOutcome(spec);
        // Set only when the outcome enabled something: `nativeSkillsOutcome`
        // answers `native` only for a plugin it found in place.
        const skillPlugin = nativeSkills.length ? spec.skillPlugin : undefined;
        const { options, prompt } = assembleClaudeOptions(spec, deps, {
          resolvedModel,
          nativeSkills,
          droppedSkills,
          skillPlugin,
          spawn: (request) => {
            // Ruling 460: as the principal's own OS user when the run carries
            // a launch; the launcher then leads the group signalled below.
            cli = spawnClaudeCli(request, deps.spawnCli, deps.signalProcess, spec.agent ?? null);
            return cli.process;
          },
          phase,
          emitPolicyDenied,
          steering: spec.steering ? { channel: spec.steering, onDelivered: emitSteered } : null,
          abortController,
        });

        const q = queryFn({ prompt: singlePrompt(prompt), options });
        queryHandle = q;

        // Live usage accumulation so the run row GROWS during streaming instead
        // of staying 0 until the final result. The SDK yields one `assistant`
        // envelope PER CONTENT BLOCK of an API message, each carrying that
        // message's `message_start` usage: the prompt figures (uncached slice,
        // cache writes, cache reads) are final for the call, `output_tokens` is
        // a placeholder of a few tokens, and every block repeats the same
        // numbers under the same `message.id`. So the fold counts each id ONCE
        // and SUMS: every call re-reads its whole prompt, and the sum over
        // distinct ids reproduced `result.usage` exactly on every run this
        // instance had stored. (It used to max the uncached slice and sum the
        // placeholders, which pinned the live strip at a few hundred tokens
        // while the run was at a few million.)
        //
        // Output (F35-1) is ESTIMATED from the blocks each envelope carries
        // (`estimateOutputTokens`), summed per envelope: a block arrives once,
        // so the per-envelope sum is the per-message sum without a second
        // dedupe. The placeholders used to be summed here and read "49 tokens"
        // for twelve minutes of Opus writing 20k characters, then jumped to
        // 54,759 at the result. The estimate is published with
        // `outputEstimated: true`; the sink keeps it as a monotone lower bound
        // and REPLACES it with the result's figure (an estimate may overshoot).
        // Subagent traffic (`parent_tool_use_id`) is left out: the result's
        // `usage` covers the main loop only, and a live figure above the final
        // one would read as a regression.
        //
        // Turns follow the SDK's own `num_turns` counter: one, plus every
        // `user` message that flows through the loop (each tool result is one,
        // so parallel tool calls count separately, and a skill body the SDK
        // injects counts too). That matched `result.num_turns` on every stored
        // run; counting assistant envelopes, as this used to, over-counted on
        // all but the single-turn one.
        let liveUsers = 0;
        let liveTurns = 0;
        let liveOutEstimate = 0;
        let liveIn = 0;
        let liveCached = 0;
        const seenMessages = new Set<string>();

        /**
         * A result that reports a CAP, not a task failure: the turn cap and,
         * since ruling 175, the spending cap. Writes the cut-off's classified
         * line and says whether it did. Without it a turn-capped run surfaced as
         * `run·error·unknown` with "review the runtime configuration" copy
         * (observed live: a completed implementation died at turn 51 running
         * `gh --version`).
         */
        // Ruling 394: the drop that landed after the query's own result.
        const emitPostTurnTransport = (detail: string) => {
          cb.onLine(postTurnTransportLine(detail));
        };
        const emitCutOff = (): boolean => {
          if (resultSubtype === "error_max_turns") {
            const now = new Date().toISOString();
            cb.onLine({
              raw: "",
              display: {
                t: now.slice(11, 19),
                ev: "err",
                tag: "run·error·max_turns",
                text:
                  `The run hit its ${resolveMaxTurns()}-turn cap and was cut off — ` +
                  "not a task failure. Re-prompt the agent to continue from its " +
                  "session, or raise VIBERR_CLAUDE_MAX_TURNS.",
              },
              facts: {},
              occurredAt: now,
            });
            return true;
          }
          if (resultSubtype === "error_max_budget_usd") {
            // Ruling 175: the instance's spending cap cut the run off — like the
            // turn cap, not a task failure. The typed record carries the cap and
            // the spend, so the packet names both without reading this prose.
            const now = new Date().toISOString();
            const failure = emptyRunFailureFacts("max_budget");
            if (spec.maxSpendUsd) failure.spendCapUsd = spec.maxSpendUsd;
            if (resultCostUsd !== null) failure.spentUsd = resultCostUsd;
            cb.onLine({
              raw: "",
              display: {
                t: now.slice(11, 19),
                ev: "err",
                tag: "run·error·max_budget",
                text:
                  `The run reached ${spec.maxSpendUsd ? `its ${formatUsd(spec.maxSpendUsd)} spending cap` : "its spending cap"}` +
                  `${resultCostUsd !== null ? ` after spending ${formatUsd(resultCostUsd)}` : ""} and was cut off — ` +
                  "not a task failure. Re-prompt the agent to continue from its session, or " +
                  "raise the cap in Instance settings (Max spend per Claude run).",
                failure,
              },
              facts: {},
              occurredAt: now,
            });
            return true;
          }
          return false;
        };

        try {
          armIdle();
          for await (const message of q) {
            armIdle(); // reset the inactivity window on every message
            const occurredAt = new Date().toISOString();
            const { display, facts } = projectEnvelope("claude", message, occurredAt);
            const envelope = claudeEnvelopeSchema.parse(message);
            if (facts.sessionId) sessionId = facts.sessionId;
            // Ruling 130(a): keep the last rate-limit reading, the last API
            // error code and the result's status/terminal reason for the classifier.
            if (envelope.type === "rate_limit_event" && envelope.rate_limit_info) {
              evidence.rateLimit = envelope.rate_limit_info;
            }
            if (envelope.type === "assistant" && envelope.error) {
              evidence.apiError = envelope.error;
            }
            if (facts.isResult) {
              sawResult = true;
              resultIsError = !!facts.isError;
              resultSubtype = envelope.subtype;
              resultErrorText = envelope.result;
              resultCostUsd = facts.costUsd ?? null;
              evidence.apiErrorStatus = envelope.api_error_status;
              evidence.terminalReason = envelope.terminal_reason;
            } else if (envelope.type === "user") {
              liveUsers += 1;
              liveTurns = 1 + liveUsers;
              facts.turns = liveTurns;
            } else if (envelope.type === "assistant" && !envelope.parent_tool_use_id) {
              // Ruling 369: the call's prompt-cache figures were read once at
              // the wire boundary. One API message yields one envelope per
              // content block, all carrying the same figures under the same
              // id: the first one counts, and the repeats are stripped so the
              // sink folds exactly one fact per call.
              const u = facts.cache ?? null;
              if (u) {
                const firstOfMessage =
                  u.messageId === null || !seenMessages.has(u.messageId);
                if (firstOfMessage) {
                  if (u.messageId !== null) seenMessages.add(u.messageId);
                  liveIn += u.promptTokens;
                  liveCached += u.cacheRead;
                } else {
                  facts.cache = null;
                }
              }
              const estimate = estimateOutputTokens(envelope.message?.content ?? []);
              liveOutEstimate += estimate;
              if (u || estimate > 0) {
                liveTurns = Math.max(liveTurns, 1);
                facts.usage = {
                  input_tokens: liveIn,
                  cached_input_tokens: liveCached,
                  output_tokens: liveOutEstimate,
                  outputEstimated: true,
                };
                facts.turns = liveTurns;
              }
            }
            const emitted = { raw: JSON.stringify(message), display, facts, occurredAt };
            cb.onLine(emitted);
            // R21-4: the strip's live row. `turn N` is the honest fallback until
            // the run invokes its first tool — a number that climbs is what
            // tells a human the run is alive. The service throttles the writes.
            // Ruling 348: a tool stays named while it runs; once its result lands the
            // step says the model is composing again, instead of the finished call.
            const update = stepUpdateForLine(emitted);
            if (update?.kind === "tool") lastStep = update.step;
            else if (update?.kind === "answered" && lastStep) lastStep = answeredStep(lastStep);
            phase(RUN_PHASE.working, lastStep ?? `turn ${liveTurns}`);
          }
        } catch (error) {
          disarmIdle();
          // The idle guard aborts the same way an interrupt does; distinguish
          // them so a hung run settles `error` while a user interrupt stays
          // `interrupted` (P13-RT-11).
          if (idleTimedOut) return settleIdleTimeout();
          // AbortError from interrupt() is expected; anything else is a fault.
          if (interrupted) return settle("interrupted");
          // A cut-off result arrived and THEN the stream threw: once a result
          // is an error and the CLI exits non-zero after it, the SDK swaps the
          // exit error for "Claude Code returned an error result: <text>"
          // (sdk.mjs `readMessages`), measured live on the spending cap (ruling
          // 175). The result is the truth, so a capped run stays a cut-off; any
          // other thrown error is classified from the throw, as before.
          if (emitCutOff()) {
            logger.info("claude run cut off by a cap", { runId: spec.runId, subtype: resultSubtype });
            return settle("error");
          }
          // Ruling 394: the SDK's terminal `result` had already landed and it
          // was not an error, so the query finished and the stream threw on
          // teardown. The Codex half of this ruling is the one the ax-clone
          // board demonstrated; this is the same gate on the same reasoning,
          // and `sawResult` is stronger evidence still — Claude emits exactly
          // one result, at the end of the whole query, so nothing can be in
          // flight behind it.
          if (sawResult && !resultIsError) {
            logger.info("claude stream threw after its result", {
              runId: spec.runId,
              runOutcome: "finished",
            });
            emitPostTurnTransport(errorMessage(error));
            return settle("finished");
          }
          logger.error("claude query error", {
            runId: spec.runId,
            err: toError(error),
          });
          return settleError(error);
        }
        disarmIdle();
        // The stream is done; the terminal classification + finalize below is
        // what the strip is waiting on now.
        phase(RUN_PHASE.finishing, null);

        // A stream that ENDS (rather than throwing) after the abort still has
        // to report the hang, not a plain "no result" error.
        if (idleTimedOut) return settleIdleTimeout();
        if (interrupted) return settle("interrupted");
        if (sawResult && !resultIsError) return settle("finished");
        // A capped run is CUT OFF, not failed by the task (see `emitCutOff`);
        // the run still settles `error` below.
        if (!emitCutOff() && sawResult && resultIsError) {
          // P14-RT-10: a run the SDK ends with an `is_error` result (rather than
          // a thrown stream error) used to settle `error` carrying no classified
          // line at all — the result line's own tag is `result`, which
          // `runFailureReason` never matches, so a quota/auth failure delivered
          // this way lost its `retry_other_backend` recovery option and got the
          // generic "run ended in an error" copy. Classify it the same way a
          // thrown error is classified; the raw text never leaves this scope.
          //
          // The prose is the result's own text, else its subtype when that
          // names a failure. An API-refused run ends `is_error: true` under
          // `subtype: "success"` (U34-1), and with no prose that word used to
          // become the cause — and so the "provider's own sentence" appended to
          // the human line ("The provider reported: success"). No prose is no
          // prose: the structured evidence classifies, and nothing is quoted.
          const resultProse =
            resultErrorText ?? (resultSubtype && resultSubtype !== "success" ? resultSubtype : "");
          const failure = classifyClaudeError(new Error(resultProse), evidence);
          const now = new Date().toISOString();
          cb.onLine({
            raw: "",
            display: {
              t: now.slice(11, 19),
              ev: "err",
              tag: `run·error·${failure.kind}`,
              // R20-3: same provider-sentence append as settleError.
              text:
                failure.providerText &&
                !failure.message.includes(failure.providerText)
                  ? withProviderText(failure.message, failure.providerText)
                  : failure.message,
              failure: failure.facts,
            },
            facts: {},
            occurredAt: now,
          });
        }
        return settle("error");
      };

      // Fire the async loop; failures surface through settleError (which
      // persists a redaction-safe reason line before finalizing — A3).
      void run().catch((error) => {
        logger.error("claude run crashed", {
          runId: spec.runId,
          err: toError(error),
        });
        settleError(error);
      });

      return {
        runId: spec.runId,
        interrupt() {
          if (interrupted || settled) return;
          interrupted = true;
          // First the cooperative control request: a responsive CLI ends its
          // stream cleanly. Disarming the idle guard here used to leave the run
          // with NO watchdog — `interrupt()` is cooperative, a wedged CLI never
          // answers, and the idle callback returns early once `interrupted` is
          // set — so the row sat `running` with no process until the next
          // restart's orphan sweep, and the earlier fix only SETTLED the row
          // without stopping the child, which could then keep writing the
          // workspace under a successor run or a reclaim rmSync. Escalate to a
          // real subprocess abort instead; the backstop settles `interrupted`.
          disarmIdle();
          void queryHandle?.interrupt().catch(() => {
            // The generator may already have completed.
          });
          armForcedStop(() => settle("interrupted"));
        },
      };
    },
  };
}
