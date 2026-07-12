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
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Task",
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

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): RuntimeAdapter {
  return {
    backend: "claude",
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawResult = false;
      let resultIsError = false;
      let interrupted = false;
      let settled = false;
      let queryHandle: ClaudeQuery | null = null;

      const settle = (outcome: "finished" | "error" | "interrupted") => {
        if (settled) return;
        settled = true;
        cb.onExit({ outcome, effectiveBackend: "claude", simulated: false, sessionId });
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
          maxTurns: 50,
          // SDK isolation: never load the host machine's ~/.claude settings
          // tiers into a Viberr run, and enable ZERO skills — Viberr injects
          // its own skill/KB as system-prompt text, so a run must see exactly
          // the agent's declared resources, not the operator-user's personal
          // Claude Code skills/plugins (`settingSources` alone does NOT filter
          // plugin skills — `skills: []` does).
          //
          // `plugins: []` names ZERO local plugins for the run — defense-in-depth
          // for the plugin channel (F13) on top of settingSources/skills.
          //
          // Isolation boundary (verified, honest): in a STANDARD deployment (a
          // standalone node process with a pristine CLAUDE_CONFIG_DIR under the
          // data root) these three empty levers mean a run sees ONLY the agent's
          // declared skills/KB (injected as prompt text) — no host resources.
          // The ONE case they can't cover is running the server from INSIDE an
          // active Claude Code/Desktop session: the spawned `claude` subprocess
          // inherits that parent session's managed toolset/marketplace at the
          // PROCESS level (above any SDK option), so a dev sees the parent's
          // slash-commands/tools in the run. That's a dev-only condition — a real
          // deployment has no such parent — and it can't be closed from here.
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
          ...(spec.kind === "operator" ? OPERATOR_DENIED_BUILTINS : []),
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
          return settle("error");
        }

        if (interrupted) return settle("interrupted");
        if (sawResult && !resultIsError) return settle("finished");
        return settle("error");
      };

      // Fire the async loop; failures surface through settle("error").
      void run().catch((error) => {
        logger.error("claude run crashed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
        settle("error");
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
