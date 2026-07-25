import type { LogLine } from "~/features/runtime/runtime-types";

/** Normalize provider wire envelopes into console lines and persisted facts. */

// ------------------------------------------------------------ helpers

/** `HH:MM:SS` in the local wall clock from an ISO instant (or now). */
export function clockOf(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Extracted facts a projected envelope carries beyond the display line. */
export interface EnvelopeFacts {
  sessionId?: string | null;
  model?: string | null;
  /** Cumulative usage this envelope reports (claude result / codex turn). */
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  } | null;
  /** Dollar cost — claude result only. */
  costUsd?: number | null;
  /** Turn count reported by a result/turn.completed envelope. */
  turns?: number | null;
  /** True when a claude result / codex turn.failed signals agent-level error. */
  isError?: boolean;
  /** True when this is a terminal result envelope (claude result). */
  isResult?: boolean;
}

/** What the normalizer returns: the display line + any facts to fold into the run row. */
export interface ProjectedEnvelope {
  display: LogLine | null;
  facts: EnvelopeFacts;
}

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Human-readable summary of an assistant/user content array. */
function summarizeContent(content: unknown): string {
  if (!Array.isArray(content)) return str(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Json;
    if (b.type === "text") parts.push(str(b.text));
    else if (b.type === "tool_result") parts.push(str(b.content));
  }
  return parts.join("\n");
}

/**
 * Project one real wire envelope (parsed JSON) → LogLine + facts. Tolerant:
 * unknown types produce a `meta` line, never throw (both vendors add event
 * types between minor versions — runtime-adapters.md gotcha 9).
 */
export function projectEnvelope(
  backend: "claude" | "codex",
  raw: unknown,
  occurredAtIso?: string,
): ProjectedEnvelope {
  const t = clockOf(occurredAtIso);
  if (!raw || typeof raw !== "object") {
    return { display: { t, ev: "meta", tag: "unknown", text: str(raw) }, facts: {} };
  }
  const e = raw as Json;
  const type = str(e.type);

  if (backend === "codex") return projectCodex(e, type, t);
  return projectClaude(e, type, t);
}

function projectClaude(e: Json, type: string, t: string): ProjectedEnvelope {
  switch (type) {
    case "system": {
      const subtype = str(e.subtype);
      if (subtype === "init") {
        const mcp = Array.isArray(e.mcp_servers)
          ? (e.mcp_servers as Json[]).flatMap((m) => {
              const name = str(m.name);
              return name ? [name] : [];
            })
          : [];
        const tools = Array.isArray(e.tools) ? e.tools.length : 0;
        const sid = str(e.session_id);
        const model = str(e.model);
        const text =
          `session ${sid.slice(0, 8)} · ${model} · ${tools} tools` +
          (mcp.length ? ` · mcp: ${mcp.join(", ")}` : "") +
          (e.cwd ? ` · cwd ${str(e.cwd)}` : "");
        return {
          display: { t, ev: "init", tag: "system·init", text },
          facts: { sessionId: sid || null, model: model || null },
        };
      }
      // api_retry / compact_boundary / … — surface as a dim meta line.
      return { display: { t, ev: "meta", tag: `system·${subtype || "event"}`, text: str(e.error ?? e.subtype) }, facts: {} };
    }
    case "assistant": {
      const msg = (e.message ?? {}) as Json;
      const content = Array.isArray(msg.content) ? (msg.content as Json[]) : [];
      const toolUse = content.find((b) => b?.type === "tool_use");
      if (toolUse) {
        const name = str(toolUse.name);
        const input = (toolUse.input ?? null) as Record<string, unknown> | null;
        const text = summarizeToolInput(name, input);
        return { display: { t, ev: "tool", tag: "tool_use", name, text, input }, facts: {} };
      }
      const text = summarizeContent(content);
      return { display: { t, ev: "text", tag: "assistant", text }, facts: {} };
    }
    case "user": {
      const msg = (e.message ?? {}) as Json;
      const content = Array.isArray(msg.content) ? (msg.content as Json[]) : [];
      const result = content.find((b) => b?.type === "tool_result");
      const isError = !!result?.is_error;
      const text = summarizeContent(content);
      return { display: { t, ev: isError ? "err" : "out", tag: "tool_result", text }, facts: {} };
    }
    case "result": {
      const usage = (e.usage ?? {}) as Json;
      const inTok = num(usage.input_tokens);
      const cached = num(usage.cache_read_input_tokens);
      const outTok = num(usage.output_tokens);
      const cost = num(e.total_cost_usd);
      const turns = num(e.num_turns);
      const isError = !!e.is_error;
      const subtype = str(e.subtype);
      const durSec = Math.round(num(e.duration_ms) / 1000);
      const text = isError
        ? `${subtype || "error"} · ${turns} turns`
        : `success · ${turns} turns · ${durSec}s · $${cost.toFixed(2)}`;
      return {
        display: {
          t,
          ev: "result",
          tag: "result",
          text,
          stats: {
            subtype: isError ? subtype : undefined,
            dur: num(e.duration_ms),
            api: num(e.duration_api_ms),
            turns,
            cost,
            in: inTok,
            cached,
            out: outTok,
          },
        },
        facts: {
          usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok },
          costUsd: cost,
          turns,
          isError,
          isResult: true,
        },
      };
    }
    default:
      return { display: { t, ev: "meta", tag: type || "unknown", text: str(e) }, facts: {} };
  }
}

function summarizeToolInput(name: string, input: Record<string, unknown> | null): string {
  if (!input) return "";
  if (name === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") {
    return input.pattern + (typeof input.path === "string" ? " " + input.path : "");
  }
  return JSON.stringify(input);
}

function projectCodex(e: Json, type: string, t: string): ProjectedEnvelope {
  switch (type) {
    case "thread.started": {
      const sid = str(e.thread_id);
      return {
        display: { t, ev: "init", tag: "thread.started", text: `thread ${sid.slice(0, 13)}… started` },
        facts: { sessionId: sid || null },
      };
    }
    case "turn.started":
      return { display: { t, ev: "meta", tag: "turn.started", text: "turn started" }, facts: {} };
    case "turn.completed": {
      const usage = (e.usage ?? {}) as Json;
      const inTok = num(usage.input_tokens);
      const cached = num(usage.cached_input_tokens);
      const outTok = num(usage.output_tokens);
      const text =
        `in ${(inTok / 1000).toFixed(1)}k (cached ${(cached / 1000).toFixed(1)}k) · out ${(outTok / 1000).toFixed(1)}k tokens`;
      return {
        display: { t, ev: "result", tag: "turn.completed", text, usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok } },
        // Each completed turn counts as one turn (codex has no cumulative
        // num_turns); the adapter overrides this with a running count for a
        // multi-turn run, so the live Turns counter isn't stuck at 0.
        facts: { usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok }, turns: 1 },
      };
    }
    case "turn.failed": {
      const err = (e.error ?? {}) as Json;
      return { display: { t, ev: "err", tag: "turn.failed", text: str(err.message) }, facts: { isError: true } };
    }
    case "error":
      return { display: { t, ev: "err", tag: "error", text: str(e.message) }, facts: { isError: true } };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = (e.item ?? {}) as Json;
      const itemType = str(item.type);
      const completed = type === "item.completed";
      switch (itemType) {
        case "reasoning":
          return completed
            ? { display: { t, ev: "think", tag: "reasoning", text: str(item.text) }, facts: {} }
            : { display: null, facts: {} };
        case "agent_message":
          return completed
            ? { display: { t, ev: "text", tag: "agent_message", text: str(item.text) }, facts: {} }
            : { display: null, facts: {} };
        case "command_execution": {
          if (type === "item.started") {
            return { display: { t, ev: "tool", tag: "command_execution", name: "exec", text: cleanCommand(str(item.command)) }, facts: {} };
          }
          if (completed) {
            const exit = num(item.exit_code);
            const out = str(item.aggregated_output).replace(/\n$/, "");
            return { display: { t, ev: exit ? "err" : "out", tag: "aggregated_output", text: out, exit }, facts: {} };
          }
          return { display: null, facts: {} };
        }
        case "file_change": {
          const changes = Array.isArray(item.changes) ? (item.changes as { path: string; kind: "add" | "update" | "delete" }[]) : [];
          const text = summarizeChanges(changes);
          return completed ? { display: { t, ev: "diff", tag: "file_change", text, changes }, facts: {} } : { display: null, facts: {} };
        }
        case "error":
          // The Codex SDK explicitly defines ErrorItem as non-fatal. Surface it
          // as an error-looking timeline row, but do not poison an otherwise
          // successful turn; only top-level `turn.failed` / `error` do that.
          return { display: { t, ev: "err", tag: "error", text: str(item.message) }, facts: {} };
        case "mcp_tool_call": {
          // P14-RT-07: an MCP call is a TOOL call, and the console must say
          // which one. The default branch below projected it as a dim `meta`
          // line whose text read `item.text ?? item.query` — neither of which an
          // McpToolCallItem carries — so every Codex MCP call rendered as an
          // empty row while Claude logged tool name + input. `item.started`
          // carries the server/tool/arguments, so log it there (mirroring
          // command_execution) and log the failure on completion.
          const name = `${str(item.server)}.${str(item.tool)}`;
          if (type === "item.started") {
            return {
              display: {
                t,
                ev: "tool",
                tag: "mcp_tool_call",
                name,
                text: summarizeMcpArguments(item.arguments),
                input: isRecord(item.arguments) ? item.arguments : null,
              },
              facts: {},
            };
          }
          if (completed) {
            const error = isRecord(item.error) ? str(item.error.message) : "";
            // A successful call already has its `item.started` row; only the
            // failure adds information worth a second line.
            return error
              ? { display: { t, ev: "err", tag: "mcp_tool_call", name, text: error }, facts: {} }
              : { display: null, facts: {} };
          }
          return { display: null, facts: {} };
        }
        case "web_search":
          // Same fix, same reason: the query IS the content of the row.
          return completed
            ? {
                display: {
                  t,
                  ev: "tool",
                  tag: "web_search",
                  name: "web_search",
                  text: str(item.query),
                },
                facts: {},
              }
            : { display: null, facts: {} };
        default:
          // todo_list and any item type a future SDK adds — completed only, meta.
          return completed
            ? { display: { t, ev: "meta", tag: itemType || "item", text: str(item.text ?? item.query ?? "") }, facts: {} }
            : { display: null, facts: {} };
      }
    }
    default:
      return { display: { t, ev: "meta", tag: type || "unknown", text: str(e) }, facts: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The console row for an MCP call's arguments — the same "show the useful
 *  field, else the JSON" rule `summarizeToolInput` applies on Claude. */
function summarizeMcpArguments(args: unknown): string {
  if (args == null) return "";
  if (!isRecord(args)) return str(args);
  for (const key of ["query", "path", "url", "name", "message"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return JSON.stringify(args);
}

function cleanCommand(command: string): string {
  // Codex wraps commands as `bash -lc "<cmd>"`; show the inner command.
  const m = /^bash -lc (.+)$/.exec(command);
  if (m) {
    try {
      return JSON.parse(m[1]!);
    } catch {
      return m[1]!;
    }
  }
  return command;
}

function summarizeChanges(changes: { path: string; kind: string }[]): string {
  if (!changes.length) return "no changes";
  const files = changes.length;
  return `${files} file${files === 1 ? "" : "s"} · ${changes.map((c) => c.path).join(", ")}`;
}
