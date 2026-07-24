import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { projectEnvelope } from "./wire-format.server";

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
  /** In-process SDK MCP servers (operator governance tools). */
  mcpServers?: Record<string, unknown>;
  /** Auto-approve allowlist. NOTE: this does NOT remove other tools from the
   *  model's context — it only skips the permission prompt. Use `tools` to
   *  restrict the available built-in set. */
  allowedTools?: string[];
  /** Tool denylist — removes tools from the model's context entirely; binds
   *  even under bypassPermissions. */
  disallowedTools?: string[];
  /** Which filesystem settings to load. `[]` = SDK isolation mode: none of the
   *  host's `~/.claude` settings tiers leak in. */
  settingSources?: string[];
  /** Skills to enable. `[]` = none listed → the model sees no skills and the
   *  Skill tool rejects them (a context filter). Viberr injects its own skill
   *  as system-prompt text, so a run needs no SDK-discovered skills. */
  skills?: string[];
  /** Local plugins to load for the session. `[]` = load NONE — closes the
   *  plugin-marketplace leak channel that `settingSources`/`skills` don't cover
   *  (F13), so a host-installed plugin's slash-commands/skills never reach a
   *  Viberr run. */
  plugins?: { type: "local"; path: string }[];
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
 * Built-in tools an operator run may never use: it coordinates the task and
 * writes only through its governance MCP tools — it never edits files, runs
 * shell commands, or spawns sub-agents that could. Denied tools are removed
 * from the model's context, so this holds even under bypassPermissions.
 */
const OPERATOR_DENIED_BUILTINS = [
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
 * the same honest Bash limitation the deliverer has; the Codex side gets a true
 * read-only sandbox, which is strictly stronger.) Closes the VIB-30 class where
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
 * `notifyTaskWatchers`; the workspace clone = the runtime; skills = injected as
 * prompt TEXT). All are empirically UNUSED (0 invocations across every real run).
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
  "Skill", // viberr injects each agent's declared skill as system-prompt text
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
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (params: { prompt: string | AsyncIterable<unknown>; options?: ClaudeQueryOptions }) => ClaudeQuery;
  };
  cachedQuery = mod.query as unknown as ClaudeQueryFn;
  return cachedQuery;
}

/**
 * Per-step usage from a Claude `assistant` message (`message.message.usage`), or
 * null when the message is not an assistant message or carries no usage. Used to
 * grow the live token counter during a run (the final `result` envelope supplies
 * the authoritative totals).
 */
function assistantUsage(
  message: unknown,
): { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { type?: unknown; message?: { usage?: Record<string, unknown> } };
  if (m.type !== "assistant") return null;
  const u = m.message?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inTok = n(u.input_tokens);
  const outTok = n(u.output_tokens);
  const cached = n(u.cache_read_input_tokens);
  if (inTok === 0 && outTok === 0 && cached === 0) return null;
  return { input_tokens: inTok, output_tokens: outTok, cached_input_tokens: cached };
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
type ClaudeFailureKind = "quota" | "auth" | "unknown";

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

function classifyClaudeError(error: unknown): {
  kind: ClaudeFailureKind;
  message: string;
} {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EBADF" || code === "EMFILE" || code === "ENFILE") {
    return {
      kind: "unknown",
      message:
        "The agent process could not be started (the host ran out of file handles). No work was performed.",
    };
  }
  if (code === "ENOENT") {
    return {
      kind: "unknown",
      message:
        "The agent runtime executable was not found. Check the deployment's Claude CLI/SDK install.",
    };
  }
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(raw)) {
    return {
      kind: "quota",
      // Role-neutral: this classifier runs for operator AND specialist/reviewer
      // runs, so it must not say "the coordinating model" (misleads a human
      // triaging a failed delivery run toward the operator).
      message:
        "The Claude model is over its usage quota. Retry after the limit resets.",
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
    };
  }
  return {
    kind: "unknown",
    message: "The agent run did not complete. Review the runtime configuration.",
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
      let interrupted = false;
      let settled = false;
      let queryHandle: ClaudeQuery | null = null;

      /** Persist a redaction-safe classified reason line, then settle error. */
      const settleError = (error: unknown) => {
        if (settled) return;
        try {
          const failure = classifyClaudeError(error);
          cb.onLine({
            raw: "",
            display: {
              t: new Date().toISOString().slice(11, 19),
              ev: "err",
              tag: `run·error·${failure.kind}`,
              text: failure.message,
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
        cb.onExit({ outcome, effectiveBackend: "claude", sessionId });
      };

      const run = async () => {
        const queryFn = deps.queryFn ?? (await realQuery());
        const resolvedModel = resolveClaudeModel(spec.model);
        const options: ClaudeQueryOptions = {
          cwd: spec.workdir,
          // Only set model when we have a real id/alias; otherwise let the SDK
          // (and the subscription) pick its default.
          ...(resolvedModel ? { model: resolvedModel } : {}),
          // Pass the profile's chosen reasoning effort when present; otherwise
          // the SDK uses its default (high).
          ...(spec.effort ? { effort: spec.effort } : {}),
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
          // tiers into a Viberr run — Viberr injects each agent's declared
          // skill/KB as system-prompt text, so a run must see exactly the
          // agent's declared resources, not the operator-user's personal Claude
          // Code settings/plugins. `settingSources: []` drops the host settings
          // tiers; `plugins: []` names ZERO local plugins (defense-in-depth for
          // the plugin channel, F13).
          //
          // HONEST LIMIT (docker-verified 2026-07-18): `skills: []` does NOT give
          // an empty skill set. The SDK compiles ~16 first-party skills into its
          // binary, and a standalone deployment (pristine CLAUDE_CONFIG_DIR, no
          // host ~/.claude) STILL lists all 16 in the run's init and exposes the
          // `Skill` tool. It is NOT the once-assumed "server nested in a Claude
          // Code session" dev artifact — it is present in production. We cannot
          // strip them from the init list here, so isolation is enforced the only
          // way we can: `BASE_DENIED_BUILTINS` denies the `Skill` TOOL for every
          // run, making those bundled skills UNINVOKABLE (see that constant).
          settingSources: [],
          skills: [],
          plugins: [],
        };
        if (spec.resumeSessionId) options.resume = spec.resumeSessionId;
        // Base adapter env, overlaid with any per-run env (e.g. the specialist's
        // GIT_CEILING_DIRECTORIES workspace confinement).
        if (deps.env || spec.env) {
          options.env = { ...(deps.env ?? {}), ...(spec.env ?? {}) };
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
          if (typeof spec.systemPrompt === "string" && spec.kind !== "operator") {
            options.systemPrompt = {
              type: "preset",
              preset: "claude_code",
              append: spec.systemPrompt,
            };
          } else {
            options.systemPrompt = spec.systemPrompt;
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
          ...BASE_DENIED_BUILTINS,
          ...(spec.kind === "operator" ? OPERATOR_DENIED_BUILTINS : []),
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
          for await (const message of q) {
            const occurredAt = new Date().toISOString();
            const { display, facts } = projectEnvelope("claude", message, occurredAt);
            if (facts.sessionId) sessionId = facts.sessionId;
            if (facts.isResult) {
              sawResult = true;
              resultIsError = !!facts.isError;
              resultSubtype =
                (message as { subtype?: string }).subtype ?? null;
            } else {
              const u = assistantUsage(message);
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
            cb.onLine({ raw: JSON.stringify(message), display, facts, occurredAt });
          }
        } catch (error) {
          // AbortError from interrupt() is expected; anything else is a fault.
          if (interrupted) return settle("interrupted");
          logger.error("claude query error", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
          });
          return settleError(error);
        }

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
          void queryHandle?.interrupt().catch(() => {
            // The generator may already have completed.
          });
        },
      };
    },
  };
}
