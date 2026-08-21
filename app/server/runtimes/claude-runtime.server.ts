import { z } from "zod";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import {
  phaseStepForLine,
  RUN_PHASE,
  type RunCallbacks,
  type RunHandle,
  type RunSpec,
  type RuntimeAdapter,
} from "./adapter.server";
import { SESSION_MISSING_RE } from "./session-export.server";
import { isSdkSkillName } from "./skill-mount.server";
import { projectEnvelope } from "./wire-format.server";
import { redactProviderText } from "~/server/secrets/git-output-redact.server";

/**
 * Claude Code adapter — the OFFICIAL Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, verified v0.3.x). `query()` returns a
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
 * Auth: ANTHROPIC_API_KEY (env). The SDK factory is injectable so tests
 * drive a fake async generator — real Claude is NEVER invoked in tests.
 */

/** The subset of the SDK we depend on (kept narrow + injectable). */
export interface ClaudeQueryOptions {
  cwd?: string;
  model?: string;
  /** Reasoning effort: 'low'|'medium'|'high'|'xhigh'|'max' (default high). */
  effort?: string;
  maxTurns?: number;
  permissionMode?: string;
  resume?: string;
  includePartialMessages?: boolean;
  env?: Record<string, string>;
  abortController?: AbortController;
  /** Custom system prompt. A string REPLACES the default (operator: tools-only,
   *  no coding harness). The append-preset form keeps Claude Code's default
   *  scaffolding and appends the persona (specialists: they DO write code). */
  systemPrompt?:
    | string
    | { type: "preset"; preset: "claude_code"; append?: string };
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
  /** Which filesystem settings to load. `[]` = SDK isolation mode: none of the
   *  host's `~/.claude` settings tiers leak in. `['project']` names the run's
   *  own WORKSPACE (cwd = the task checkout, whose `.claude` Viberr strips and
   *  rewrites) — the only project source a governed run may see. Never `'user'`
   *  or `'local'`: those are the host machine's tiers (F13). */
  settingSources?: string[];
  /** Skills to enable — a CONTEXT FILTER, not a sandbox. `[]` = none listed, so
   *  the model sees no skill and the Skill tool rejects every one. A name list
   *  enables exactly those (matched on the SKILL.md `name` / directory name) and
   *  hides the rest, including the SDK's own bundled set. Setting this option
   *  auto-adds the `Skill` tool to `allowedTools`. */
  skills?: string[];
  /** Local plugins to load for the session. `[]` = load NONE — closes the
   *  plugin-marketplace leak channel that `settingSources`/`skills` don't cover
   *  (F13), so a host-installed plugin's slash-commands/skills never reach a
   *  Viberr run. */
  plugins?: { type: "local"; path: string }[];
  /** R18-3: `true` = ignore ambient MCP config (repo `.mcp.json`, user MCP,
   *  plugin MCP) — only the servers Viberr passes via `mcpServers` reach the run.
   *  Governance parity with `settingSources`, for the MCP catalog channel. */
  strictMcpConfig?: boolean;
  /** Policy-tier settings enforced on the spawned process without writing
   *  root-owned files. Viberr uses ONE key — see `MANAGED_SETTINGS` below. */
  managedSettings?: { claudeMdExcludes?: string[] };
}

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
}

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
  const m = model.toLowerCase().trim();
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
export function resolveClaudeEffort(effort?: string): string | undefined {
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
 * same window the Codex adapter uses (owner ruling A8).
 *
 * P13-RT-11: Claude had NO timer of any kind. `maxTurns` bounds turns, not
 * wall-clock or idle time, and a `for await` over a stalled SDK stream never
 * settles — so a partitioned network or a hung stdio MCP (`npx …`) left the run
 * `running` forever, the task `waiting: agent`, the delivering single-flight
 * refusing every later delivering run on that task, and the board showing an
 * "agent working" badge until the NEXT process restart ran finalizeOrphanedRuns.
 *
 * (Read from the raw process env rather than `getEnv()`: the validated env
 * schema is owned by another workstream this pass. Behaviour is identical —
 * `loadEnvFile` has already folded `.env` into process.env.)
 */
const DEFAULT_CLAUDE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export function claudeIdleTimeoutMs(): number {
  const raw = process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLAUDE_IDLE_TIMEOUT_MS;
}

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
 * believes it is read-only and is not, so `operator-run` imports this one and
 * `capability-denylist-markers.test.ts` pins the join.
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
 * Denied for SUPPORTING (non-delivering, `kind: "reviewer"`) specialist runs
 * (F10-12 / F10-04, owner ruling "supporting agents read-only by default"). A
 * supporting engagement researches, reviews, tests, or advises — it is NOT the
 * delivering agent and must be physically unable to mutate the shared workspace
 * or reach the remote. Only the single `delivers: true` engagement writes and
 * delivers. Deny wins under bypassPermissions, so this removes the file-write
 * built-ins and every git/gh mutation command while keeping Read/Grep/Glob and
 * Bash-for-read-only-validation. (`sed -i`/shell redirection stay reachable —
 * the same honest Bash limitation the deliverer has; on Codex this list is
 * advisory since R22 removed the read-only sandbox.) Closes the VIB-30 class where
 * a review agent committed, pushed, and opened a PR with no delivery linkage.
 */
const SUPPORTING_DENIED_BUILTINS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git checkout -b:*)",
  "Bash(git checkout -B:*)",
  "Bash(git switch -c:*)",
  "Bash(git switch -C:*)",
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
 */
export function nativeSkillNames(skills?: readonly string[]): string[] {
  if (!skills?.length) return [];
  return [...new Set(skills)].filter(isSdkSkillName);
}

/**
 * Policy-tier settings for a run that opens `settingSources: ['project']`.
 *
 * HONEST NOTE — an ACCEPTED, UNVERIFIED mitigation. `'project'` is also the
 * source that loads CLAUDE.md memory files, so enabling it to reach the skills
 * Viberr mounted also lets the CHECKED-OUT REPOSITORY's `CLAUDE.md` become
 * system-prompt-tier instruction. That is a real trust-boundary crossing: the
 * codex leg deliberately closes the same door with `project_doc_max_bytes: 0`,
 * and the Claude leg used to get it for free from `settingSources: []`.
 * `claudeMdExcludes` is the SDK's documented switch for exactly this (it applies
 * to the User/Project/Local memory tiers), so we pass it — but it has NOT been
 * verified live against a real run, and it cannot be verified from a unit test.
 * Treat the ingress as OPEN until someone reads a run's system prompt and
 * confirms otherwise; the deterministic guarantees of this change are the
 * stripped-and-rewritten `.claude` catalog and the `skills` filter, not this.
 */
const MANAGED_SETTINGS = {
  claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/**"],
} satisfies NonNullable<ClaudeQueryOptions["managedSettings"]>;

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
    /** `assistant` envelopes: this step's usage counters. Anything that is not
     *  a finite number counts as 0, exactly as the run row folds it. */
    message: z
      .object({
        usage: z.object({
          input_tokens: z.number().catch(0),
          output_tokens: z.number().catch(0),
          cache_read_input_tokens: z.number().catch(0),
        }),
      })
      .nullable()
      .catch(null),
  })
  .catch({ type: null, subtype: null, result: null, message: null });
type ClaudeEnvelope = z.infer<typeof claudeEnvelopeSchema>;

/** The live token counters one streamed step contributes. */
interface StepUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

/**
 * Per-step usage from a Claude `assistant` envelope, or null when the envelope
 * is not an assistant message or carries no usage at all. Used to grow the live
 * token counter during a run (the final `result` envelope supplies the
 * authoritative totals).
 */
function assistantUsage(envelope: ClaudeEnvelope): StepUsage | null {
  if (envelope.type !== "assistant") return null;
  const usage = envelope.message?.usage;
  if (!usage) return null;
  const { input_tokens, output_tokens, cache_read_input_tokens } = usage;
  if (input_tokens === 0 && output_tokens === 0 && cache_read_input_tokens === 0) {
    return null;
  }
  return {
    input_tokens,
    output_tokens,
    cached_input_tokens: cache_read_input_tokens,
  };
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
  /** P13-D-2: `--resume <id>` against a transcript Claude Code has swept
   *  ("No conversation found with session ID …"). `resumeRun`'s pre-flight
   *  probe normally re-anchors before we get here; this covers the SDK finding
   *  out first. Not an auth class — the credential is fine. */
  | "session_missing"
  | "unknown";

/** Turn cap for a claude run — a RUNAWAY guard, not a work budget. The old
 *  hard-coded 50 cut off legitimate dev runs mid-delivery (observed live:
 *  a completed implementation died at turn 51 on `gh --version`). Default is
 *  deliberately huge (owner ruling 2026-07-17) — real runs should never hit
 *  it; deployments tune it with VIBERR_CLAUDE_MAX_TURNS in .env. */
const DEFAULT_CLAUDE_MAX_TURNS = 2000;
function resolveMaxTurns(): number {
  const raw = getEnv().VIBERR_CLAUDE_MAX_TURNS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAUDE_MAX_TURNS;
}

/** The classifier's whole output: the routing class, the canonical sentence a
 *  human reads, and the provider's own words after redaction. */
interface ClaudeFailure {
  kind: ClaudeFailureKind;
  message: string;
  providerText: string;
}

/** The `code` a Node spawn failure carries (`EBADF`/`ENOENT`/…). Anything that
 *  is not an object with a string `code` decodes to "" and matches no arm — the
 *  same thing the previous property read did. */
const spawnErrorCodeSchema = z
  .object({ code: z.string() })
  .transform((thrown) => thrown.code)
  .catch("");

function classifyClaudeError(cause: unknown): ClaudeFailure {
  const code = spawnErrorCodeSchema.parse(cause);
  if (code === "EBADF" || code === "EMFILE" || code === "ENFILE") {
    // R20-3: these three name the real cause already (host resource exhaustion,
    // not a provider verdict), so there is no separate provider sentence to add.
    return {
      kind: "unknown",
      message:
        "The agent process could not be started (the host ran out of file handles). No work was performed.",
      providerText: "",
    };
  }
  if (code === "ENOENT") {
    return {
      kind: "unknown",
      message:
        "The agent runtime executable was not found. Check the deployment's Claude CLI/SDK install.",
      providerText: "",
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
    };
  }
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(raw)) {
    return {
      kind: "quota",
      // Role-neutral: this classifier runs for operator AND specialist/reviewer
      // runs, so it must not say "the coordinating model" (misleads a human
      // triaging a failed delivery run toward the operator).
      message:
        "The Claude model is over its usage quota. Retry after the limit resets.",
      providerText,
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
        "The model credential was rejected. Review the configured Claude authentication.",
      providerText,
    };
  }
  return {
    kind: "unknown",
    message: "The agent run did not complete. Review the runtime configuration.",
    providerText,
  };
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): RuntimeAdapter {
  return {
    backend: "claude",
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawResult = false;
      let resultIsError = false;
      let resultSubtype: string | null = null;
      /** The failing RESULT envelope's own error prose, kept only long enough to
       *  classify it (P14-RT-10) — it is never persisted or logged raw. */
      let resultErrorText: string | null = null;
      let interrupted = false;
      let settled = false;
      let idleTimedOut = false;
      let queryHandle: ClaudeQuery | null = null;

      // R21-4 / G5 (FR28): the live phase/step the run strip renders. `lastStep`
      // sticks so a stretch of model thinking still shows the tool the run is
      // waiting on, instead of blanking the column.
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
      const disarmIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
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
        }, idleMs);
      };

      /** Persist a redaction-safe classified reason line, then settle error. */
      const settleError = (cause: unknown) => {
        if (settled) return;
        try {
          const failure = classifyClaudeError(cause);
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
                  ? `${failure.message}\n\nThe provider reported: ${failure.providerText}`
                  : failure.message,
            },
            facts: {},
            occurredAt: new Date().toISOString(),
          });
        } catch {
          // Never let the reason line block finalization.
        }
        settle("error");
      };

      const settle = (outcome: "finished" | "error" | "interrupted") => {
        if (settled) return;
        settled = true;
        disarmIdle();
        cb.onExit({ outcome, effectiveBackend: "claude", sessionId });
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
        // The granted skills Viberr MOUNTED into this run's workspace (empty for
        // a run with no grants, no checkout, or a Codex profile — see below).
        const nativeSkills = nativeSkillNames(spec.skills);
        const options: ClaudeQueryOptions = {
          cwd: spec.workdir,
          // Fully autonomous: bypass ALL permission prompts so a
          // server-spawned run never blocks waiting for approval (there is no
          // human at the CLI). acceptEdits still gated non-edit tools like
          // Bash; bypassPermissions runs unattended end-to-end.
          permissionMode: spec.autonomous ? "bypassPermissions" : "default",
          // A runaway guard, NOT a work budget: 50 cut off real dev runs
          // mid-delivery (a finished implementation died at turn 51). Default
          // generous; override per deployment with VIBERR_CLAUDE_MAX_TURNS.
          maxTurns: resolveMaxTurns(),
          // SDK isolation: never load the host machine's ~/.claude settings
          // tiers into a Viberr run — a run must see exactly the resources its
          // profile grants, not the operator-user's personal Claude Code
          // settings/plugins/skills. `plugins: []` names ZERO local plugins
          // (defense-in-depth for the plugin channel, F13) on EVERY run.
          //
          // Two shapes, decided by whether Viberr mounted any granted skill:
          //
          //  · NO granted skills (operator runs, Codex profiles, a run with no
          //    checkout) — `settingSources: []` drops every filesystem settings
          //    tier and `skills: []` lists none. HONEST LIMIT (docker-verified
          //    2026-07-18): `skills: []` does NOT give an empty skill SET — the
          //    SDK compiles ~16 first-party skills into its binary and a
          //    standalone deployment (pristine CLAUDE_CONFIG_DIR, no host
          //    ~/.claude) still lists all 16 in the run's init. That is why
          //    `BASE_DENIED_BUILTINS` denies the `Skill` TOOL, making them
          //    UNINVOKABLE.
          //
          //  · GRANTED skills mounted — `settingSources: ['project']` so the SDK
          //    discovers `<cwd>/.claude/skills/<name>`, and `skills: [<names>]`
          //    enables exactly those. The filter is what replaces the blanket
          //    `Skill` deny: an unlisted skill (every bundled one included) is
          //    hidden from the model and REJECTED by the Skill tool. The project
          //    source is the run's own workspace checkout, whose `.claude` was
          //    stripped and rewritten by `mountGrantedSkills` moments earlier —
          //    and cwd is the repo root, so the SDK's parent walk stops there and
          //    can never reach the data root or a host `.claude` above it. Still
          //    NEVER `'user'`/`'local'`: those are the host tiers F13 closed.
          //    See MANAGED_SETTINGS for the CLAUDE.md ingress this opens.
          settingSources: nativeSkills.length ? ["project"] : [],
          skills: nativeSkills,
          plugins: [],
          // R18-3 (governance parity with settingSources): only Viberr-granted
          // MCP servers reach a run — ignore a repo `.mcp.json`, user MCP config,
          // and plugin MCP. Viberr passes its granted external MCPs + the
          // in-process toolkit via `mcpServers`; nothing ambient should widen it.
          strictMcpConfig: true,
        };
        // Only NAME a model when we have a real id/alias; otherwise let the SDK
        // (and the subscription) pick its default.
        if (resolvedModel) options.model = resolvedModel;
        // Pass the profile's chosen reasoning effort when it is one the SDK
        // accepts; otherwise the SDK uses its default (high). Narrowed rather
        // than forwarded raw so a Codex-only tier ("minimal") never reaches the
        // Claude union (P13-RT-08).
        const effort = resolveClaudeEffort(spec.effort);
        if (effort) options.effort = effort;
        // Only for the run that opened `settingSources: ['project']` — see the
        // MANAGED_SETTINGS docstring for the ingress this closes.
        if (nativeSkills.length) options.managedSettings = MANAGED_SETTINGS;
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
        if (spec.systemPrompt) {
          if (spec.kind === "operator") {
            options.systemPrompt = spec.systemPrompt;
          } else {
            options.systemPrompt = {
              type: "preset",
              preset: "claude_code",
              append: spec.systemPrompt,
            };
          }
        }
        if (spec.mcpServers) options.mcpServers = spec.mcpServers;
        if (spec.allowedTools && spec.allowedTools.length) {
          options.allowedTools = spec.allowedTools;
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
          ...(spec.kind === "operator" ? OPERATOR_READ_ONLY_DENIED_TOOLS : []),
          // Supporting/reviewing runs are read-only for the repo (F10-12).
          ...(spec.kind === "reviewer" ? SUPPORTING_DENIED_BUILTINS : []),
          ...(spec.disallowedTools ?? []),
        ];
        if (denied.length) options.disallowedTools = denied;

        const q = queryFn({ prompt: singlePrompt(spec.prompt), options });
        queryHandle = q;

        // Live usage accumulation so the run row GROWS during streaming instead
        // of staying 0 until the final result. Claude assistant messages carry
        // per-step usage (input = the growing context size, output = tokens for
        // that step); we surface a cumulative view — max input, summed output,
        // and a per-message turn count — which the sink folds and the result
        // envelope then overwrites with the authoritative totals.
        let liveTurns = 0;
        let liveOut = 0;
        let liveIn = 0;
        let liveCached = 0;

        try {
          armIdle();
          for await (const message of q) {
            armIdle(); // reset the inactivity window on every message
            const occurredAt = new Date().toISOString();
            const { display, facts } = projectEnvelope("claude", message, occurredAt);
            const envelope = claudeEnvelopeSchema.parse(message);
            if (facts.sessionId) sessionId = facts.sessionId;
            if (facts.isResult) {
              sawResult = true;
              resultIsError = !!facts.isError;
              resultSubtype = envelope.subtype;
              resultErrorText = envelope.result;
            } else {
              const u = assistantUsage(envelope);
              if (u) {
                liveTurns += 1;
                liveOut += u.output_tokens;
                liveIn = Math.max(liveIn, u.input_tokens);
                liveCached = Math.max(liveCached, u.cached_input_tokens);
                facts.usage = {
                  input_tokens: liveIn,
                  cached_input_tokens: liveCached,
                  output_tokens: liveOut,
                };
                facts.turns = liveTurns;
              }
            }
            const emitted = { raw: JSON.stringify(message), display, facts, occurredAt };
            cb.onLine(emitted);
            // R21-4: the strip's live row. `turn N` is the honest fallback until
            // the run invokes its first tool — a number that climbs is what
            // tells a human the run is alive. The service throttles the writes.
            const step = phaseStepForLine(emitted);
            if (step) lastStep = step;
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
          logger.error("claude query error", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
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
        // A turn-capped run is CUT OFF, not failed by the task — without this
        // classified reason line it surfaced as `run·error·unknown` with
        // "review the runtime configuration" copy (observed live: a completed
        // implementation died at turn 51 running `gh --version`).
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
        } else if (sawResult && resultIsError) {
          // P14-RT-10: a run the SDK ends with an `is_error` result (rather than
          // a thrown stream error) used to settle `error` carrying no classified
          // line at all — the result line's own tag is `result`, which
          // `runFailureReason` never matches, so a quota/auth failure delivered
          // this way lost its `retry_other_backend` recovery option and got the
          // generic "run ended in an error" copy. Classify it the same way a
          // thrown error is classified; the raw text never leaves this scope.
          const failure = classifyClaudeError(
            new Error(resultErrorText ?? resultSubtype ?? ""),
          );
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
                  ? `${failure.message}\n\nThe provider reported: ${failure.providerText}`
                  : failure.message,
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
          err: error instanceof Error ? error : new Error(String(error)),
        });
        settleError(error);
      });

      return {
        runId: spec.runId,
        interrupt() {
          if (interrupted || settled) return;
          interrupted = true;
          disarmIdle();
          void queryHandle?.interrupt().catch(() => {
            // The generator may already have completed.
          });
        },
      };
    },
  };
}
