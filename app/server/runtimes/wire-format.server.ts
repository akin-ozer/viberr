import type { LogLine } from "~/features/runtime/runtime-types";

/**
 * The wire-format contract (runs.md §5.4). Two directions:
 *
 * 1. `projectEnvelope(raw)` — the NORMALIZER: takes a real Claude stream-json
 *    or Codex JSONL envelope and derives the friendly `LogLine` the console
 *    renders. This is the authoritative parser both real adapters use.
 *
 * 2. `rawLineFromDisplay(...)` — the INVERSE: reconstructs a plausible wire
 *    envelope from a display line. Only the simulated backend uses it (to
 *    fabricate authentic-looking raw_json); real adapters persist the actual
 *    envelope instead. Kept faithful to the mock's `rawLine` so raw mode is
 *    uniform across real + simulated runs.
 *
 * `raw_json` in the DB is ALWAYS the real (or simulated-but-wire-shaped)
 * envelope — never a re-serialization of the display model.
 */

// ------------------------------------------------------------ helpers

/** Deterministic FNV-1a-ish id (mock `fakeId`) — simulated backend only. */
export function fakeId(sid: string | null, i: number, prefix: string, len: number): string {
  let h = 2166136261;
  const seed = (sid || "seed") + ":" + i;
  for (let k = 0; k < seed.length; k++) {
    h ^= seed.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  const AB = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789";
  let s = "";
  for (let k = 0; k < len; k++) {
    h = Math.imul(h ^ (h >>> 13), 1597334677);
    s += AB[Math.abs(h) % AB.length];
  }
  return prefix + s;
}

/** Index of the nearest preceding `tool` line, or -1 (mock `lastToolIdx`). */
export function lastToolIdx(lines: LogLine[], i: number): number {
  for (let k = i - 1; k >= 0; k--) if (lines[k]!.ev === "tool") return k;
  return -1;
}

// -------------------------------------------------- display → wire (sim)

export interface RawLineContext {
  backend: "claude" | "codex";
  sid: string | null;
  model: string;
  op: boolean;
}

/**
 * Reconstruct the raw wire envelope for a display line (mock `rawLine`,
 * runs.md §5.4). Simulated backend uses this to produce authentic raw_json.
 */
export function rawLineFromDisplay(
  ctx: RawLineContext,
  l: LogLine,
  i: number,
  lines: LogLine[],
): string {
  const J = JSON.stringify;
  const sid = ctx.sid;
  if (ctx.backend === "codex") {
    switch (l.ev) {
      case "init":
        return J({ type: "thread.started", thread_id: sid });
      case "meta":
        return J({ type: "turn.started" });
      case "think":
        return J({ type: "item.completed", item: { id: "item_" + i, type: "reasoning", text: l.text } });
      case "tool":
        return J({
          type: "item.started",
          item: {
            id: "item_" + i,
            type: "command_execution",
            command: "bash -lc " + J(l.text),
            aggregated_output: "",
            exit_code: null,
            status: "in_progress",
          },
        });
      case "out":
      case "err": {
        const k = lastToolIdx(lines, i);
        return J({
          type: "item.completed",
          item: {
            id: "item_" + (k >= 0 ? k : i),
            type: "command_execution",
            command: k >= 0 ? "bash -lc " + J(lines[k]!.text) : undefined,
            aggregated_output: l.text + "\n",
            exit_code: l.exit || 0,
            status: l.exit ? "failed" : "completed",
          },
        });
      }
      case "diff":
        return J({ type: "item.completed", item: { id: "item_" + i, type: "file_change", changes: l.changes || [], status: "completed" } });
      case "result":
        return J({ type: "turn.completed", usage: l.usage || {} });
      default:
        return J({ type: "item.completed", item: { id: "item_" + i, type: "agent_message", text: l.text } });
    }
  }
  // Claude
  switch (l.ev) {
    case "init":
      return J({
        type: "system",
        subtype: "init",
        cwd: "/work/viberr",
        session_id: sid,
        model: ctx.model,
        permissionMode: "acceptEdits",
        tools: ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch", "TodoWrite"],
        mcp_servers: ctx.op
          ? [{ name: "viberr-task-store", status: "connected" }]
          : [
              { name: "github", status: "connected" },
              { name: "filesystem", status: "connected" },
            ],
      });
    case "tool": {
      const input = l.input || (l.name === "Bash" ? { command: l.text } : { file_path: l.text });
      return J({
        type: "assistant",
        message: {
          id: fakeId(sid, i, "msg_01", 22),
          type: "message",
          role: "assistant",
          model: ctx.model,
          content: [{ type: "tool_use", id: fakeId(sid, i, "toolu_01", 22), name: l.name, input }],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        session_id: sid,
      });
    }
    case "out":
    case "err": {
      const k = lastToolIdx(lines, i);
      return J({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: fakeId(sid, k >= 0 ? k : i, "toolu_01", 22),
              content: l.text,
              is_error: l.ev === "err",
            },
          ],
        },
        session_id: sid,
      });
    }
    case "result": {
      const s = l.stats || { dur: 0, api: 0, turns: 0, cost: 0, in: 0, cached: 0, out: 0 };
      return J({
        type: "result",
        subtype: s.subtype || "success",
        is_error: !!s.subtype && s.subtype !== "success",
        duration_ms: s.dur,
        duration_api_ms: s.api,
        num_turns: s.turns,
        total_cost_usd: s.cost,
        usage: { input_tokens: s.in, cache_read_input_tokens: s.cached, output_tokens: s.out },
        session_id: sid,
      });
    }
    default:
      return J({
        type: "assistant",
        message: {
          id: fakeId(sid, i, "msg_01", 22),
          type: "message",
          role: "assistant",
          model: ctx.model,
          content: [{ type: "text", text: l.text }],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        session_id: sid,
      });
  }
}

// -------------------------------------------------- wire → display (parse)

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
          ? (e.mcp_servers as Json[]).map((m) => str(m.name)).filter(Boolean)
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
        facts: { usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok } },
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
          return { display: { t, ev: "err", tag: "error", text: str(item.message) }, facts: { isError: true } };
        default:
          // web_search / mcp_tool_call / todo_list — completed only, meta.
          return completed
            ? { display: { t, ev: "meta", tag: itemType || "item", text: str(item.text ?? item.query ?? "") }, facts: {} }
            : { display: null, facts: {} };
      }
    }
    default:
      return { display: { t, ev: "meta", tag: type || "unknown", text: str(e) }, facts: {} };
  }
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
