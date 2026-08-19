import { z } from "zod";
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

// ------------------------------------------------------ wire decoding

/**
 * The schemas below decode a provider envelope at its only boundary — this
 * module. Every field carries a fallback on purpose: both vendors add envelope
 * types and fields between minor versions (runtime-adapters.md gotcha 9), so a
 * schema that could REJECT would turn one moved field into a lost console line.
 * An envelope type neither switch knows falls through to a meta row carrying the
 * raw JSON, which is why nothing here throws.
 */

/** Wire text: a string rides through, an absent field reads empty, and any other
 *  shape renders as its JSON so a field that changed type stays visible. */
const wireText = z
  .union([
    z.string(),
    z.null().transform(() => ""),
    z.undefined().transform(() => ""),
    z.unknown().transform((value) => JSON.stringify(value)),
  ])
  .catch("");

/** Wire text that REMEMBERS absence, for the fields the projection falls back
 *  across (`item.text ?? item.query`) — empty is not the same as missing. */
const absentableWireText = z
  .union([
    z.string(),
    z.null().transform(() => undefined),
    z.undefined(),
    z.unknown().transform((value) => JSON.stringify(value)),
  ])
  .optional();

/** Wire text whose emptiness mirrors the WIRE value's own falsiness, for the
 *  fields the projection appends only when the provider filled them. */
const wireTextOrBlank = z
  .union([
    z.string(),
    z.null().transform(() => ""),
    z.undefined().transform(() => ""),
    z.unknown().transform((value) => (value ? JSON.stringify(value) : "")),
  ])
  .catch("");

/** A field only a real string can fill: the summarizers below distinguish an
 *  empty string (present, shown) from a missing one (skipped). */
const wireStringOrAbsent = z.string().optional().catch(undefined);

/** Wire counter: finite numbers only, so a garbled token count reads 0 instead
 *  of poisoning the arithmetic that renders it. */
const wireCount = z.number().catch(0);

/** Wire flag: the provider's own truthiness, unchanged; absent reads false. */
const wireFlag = z.coerce.boolean().catch(false);

/** One value inside a tool-call payload. Tolerance is per VALUE on purpose: a
 *  field the JSON round-trip could not represent must cost that one field, not
 *  the whole map — the same "never lose a line" stance the envelopes take. */
const wireJson = z.json().catch(null);

/** A tool-call input map — carried to the raw view, never interpreted here. */
const wireToolInput = z.record(z.string(), wireJson).nullable().catch(null);

/** MCP call arguments as the row needs them: the object the SDK documents, or —
 *  when the provider sent something else — only the text of what it did send,
 *  since a non-object cannot be carried in the line's `input` map. */
const wireMcpArguments = z.union([
  z.record(z.string(), wireJson).transform((record) => ({ record, text: null })),
  wireText.transform((text) => ({ record: null, text })),
]);

/** Any envelope's nested error object; absent or malformed reads as no error. */
const wireError = z
  .object({ message: wireText })
  .nullable()
  .catch(null);

// ------------------------------------------------------ claude envelopes

/** One block of a Claude message's `content` array. */
const claudeBlock = z.object({
  type: wireText,
  text: wireText,
  /** `tool_result` content is free-form — a string, or blocks shown as JSON. */
  content: wireText,
  name: wireText,
  input: wireToolInput,
  is_error: wireFlag,
});
type ClaudeBlock = z.infer<typeof claudeBlock>;

/** A block that is not a keyed object carries no type, so every branch below
 *  skips it — the same outcome the hand decoder's object check produced. */
const claudeBlocks = z.array(claudeBlock.catch(() => claudeBlock.parse({}))).catch(() => []);

const claudeEnvelopeFields = z.object({
  type: wireText,
  subtype: wireText,
  error: absentableWireText,
  session_id: wireText,
  model: wireText,
  cwd: wireTextOrBlank,
  tools: z.array(z.unknown()).catch(() => []),
  mcp_servers: z.array(z.object({ name: wireText }).catch(() => ({ name: "" }))).catch(() => []),
  message: z.object({ content: claudeBlocks }).catch(() => ({ content: [] })),
  usage: z
    .object({
      input_tokens: wireCount,
      cache_read_input_tokens: wireCount,
      output_tokens: wireCount,
    })
    .catch(() => ({ input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })),
  total_cost_usd: wireCount,
  num_turns: wireCount,
  duration_ms: wireCount,
  duration_api_ms: wireCount,
  is_error: wireFlag,
});
/** A payload that is not a keyed object at all decodes to the empty envelope,
 *  which carries no type and therefore lands on the unknown-envelope row. */
const claudeEnvelope = claudeEnvelopeFields.catch(() => claudeEnvelopeFields.parse({}));
type ClaudeEnvelope = z.infer<typeof claudeEnvelopeFields>;

// ------------------------------------------------------- codex envelopes

/** The SDK's closed set of `file_change` kinds. */
const FILE_CHANGE_KINDS = ["add", "update", "delete"] as const;

const codexFileChange = z.object({
  path: wireText,
  // A kind outside the SDK's three reads as an edit: the file DID change, and
  // this row's job is to say which files, not to invent a fourth verb.
  kind: z.enum(FILE_CHANGE_KINDS).catch("update"),
});
type FileChange = z.infer<typeof codexFileChange>;

const codexItem = z.object({
  type: wireText,
  text: absentableWireText,
  query: absentableWireText,
  message: wireText,
  command: wireText,
  exit_code: wireCount,
  aggregated_output: wireText,
  changes: z
    .array(codexFileChange.catch(() => codexFileChange.parse({})))
    .catch(() => []),
  server: wireText,
  tool: wireText,
  arguments: wireMcpArguments,
  error: wireError,
});

const codexEnvelopeFields = z.object({
  type: wireText,
  thread_id: wireText,
  message: wireText,
  usage: z
    .object({
      input_tokens: wireCount,
      cached_input_tokens: wireCount,
      output_tokens: wireCount,
    })
    .catch(() => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })),
  error: wireError,
  item: codexItem.catch(() => codexItem.parse({})),
});
/** Same fallback contract as `claudeEnvelope`. */
const codexEnvelope = codexEnvelopeFields.catch(() => codexEnvelopeFields.parse({}));
type CodexEnvelope = z.infer<typeof codexEnvelopeFields>;

// ------------------------------------------------------------ projection

/**
 * Project one real wire envelope (parsed JSON) → LogLine + facts. Tolerant:
 * unknown types produce a `meta` line, never throw (both vendors add event
 * types between minor versions — runtime-adapters.md gotcha 9).
 *
 * `raw` STAYS `unknown`, and the `no-unknown-parameters` waiver below is the
 * considered answer, not an oversight. The rule's remedy — "parse at the I/O
 * boundary before calling this function" — has no target here, because this
 * function IS that boundary: `claudeEnvelope`/`codexEnvelope` are total (every
 * field `.catch()`es, see the note above) and every branch past line one reads a
 * decoded `ClaudeEnvelope`/`CodexEnvelope`, never this parameter. What flows in
 * is `AsyncGenerator<unknown>` from the Claude SDK seam and a `ThreadEvent` from
 * the Codex one, so no annotation narrower than `unknown` accepts both.
 *
 * The two alternatives were costed and both regress:
 *   · taking the DECODED envelope loses the raw text `unknownEnvelope` renders,
 *     so an event type this build has never seen would print a fabricated
 *     full-shape object instead of the provider's own envelope — the one line a
 *     human has to read when a vendor ships a new event;
 *   · taking the wire LINE (`string`) forces a JSON round-trip per console line
 *     on both adapters' hottest path, to buy a type the schemas re-widen on the
 *     very next statement.
 */
export function projectEnvelope(
  backend: "claude" | "codex",
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- see above
  raw: unknown,
  occurredAtIso?: string,
): ProjectedEnvelope {
  const t = clockOf(occurredAtIso);
  if (backend === "codex") {
    const e = codexEnvelope.parse(raw);
    return projectCodex(e, t) ?? unknownEnvelope(e.type, wireText.parse(raw), t);
  }
  const e = claudeEnvelope.parse(raw);
  return projectClaude(e, t) ?? unknownEnvelope(e.type, wireText.parse(raw), t);
}

/** An envelope type this build does not know — shown verbatim, never dropped. */
function unknownEnvelope(type: string, text: string, t: string): ProjectedEnvelope {
  return { display: { t, ev: "meta", tag: type || "unknown", text }, facts: {} };
}

/** `null` → the envelope type is unrecognized; the caller renders it raw. */
function projectClaude(e: ClaudeEnvelope, t: string): ProjectedEnvelope | null {
  switch (e.type) {
    case "system": {
      if (e.subtype === "init") {
        const mcp = e.mcp_servers.flatMap((m) => (m.name ? [m.name] : []));
        const text =
          `session ${e.session_id.slice(0, 8)} · ${e.model} · ${e.tools.length} tools` +
          (mcp.length ? ` · mcp: ${mcp.join(", ")}` : "") +
          (e.cwd ? ` · cwd ${e.cwd}` : "");
        return {
          display: { t, ev: "init", tag: "system·init", text },
          facts: { sessionId: e.session_id || null, model: e.model || null },
        };
      }
      // api_retry / compact_boundary / … — surface as a dim meta line.
      return {
        display: {
          t,
          ev: "meta",
          tag: `system·${e.subtype || "event"}`,
          text: e.error ?? e.subtype,
        },
        facts: {},
      };
    }
    case "assistant": {
      const content = e.message.content;
      const toolUse = content.find((b) => b.type === "tool_use");
      if (toolUse) {
        const text = summarizeToolInput(toolUse.name, toolUse.input);
        return {
          display: { t, ev: "tool", tag: "tool_use", name: toolUse.name, text, input: toolUse.input },
          facts: {},
        };
      }
      return { display: { t, ev: "text", tag: "assistant", text: summarizeContent(content) }, facts: {} };
    }
    case "user": {
      const content = e.message.content;
      const isError = content.find((b) => b.type === "tool_result")?.is_error ?? false;
      const text = summarizeContent(content);
      return { display: { t, ev: isError ? "err" : "out", tag: "tool_result", text }, facts: {} };
    }
    case "result": {
      const inTok = e.usage.input_tokens;
      const cached = e.usage.cache_read_input_tokens;
      const outTok = e.usage.output_tokens;
      const durSec = Math.round(e.duration_ms / 1000);
      const text = e.is_error
        ? `${e.subtype || "error"} · ${e.num_turns} turns`
        : `success · ${e.num_turns} turns · ${durSec}s · $${e.total_cost_usd.toFixed(2)}`;
      return {
        display: {
          t,
          ev: "result",
          tag: "result",
          text,
          stats: {
            subtype: e.is_error ? e.subtype : undefined,
            dur: e.duration_ms,
            api: e.duration_api_ms,
            turns: e.num_turns,
            cost: e.total_cost_usd,
            in: inTok,
            cached,
            out: outTok,
          },
        },
        facts: {
          usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok },
          costUsd: e.total_cost_usd,
          turns: e.num_turns,
          isError: e.is_error,
          isResult: true,
        },
      };
    }
    default:
      return null;
  }
}

/** Human-readable summary of an assistant/user content array. */
function summarizeContent(content: ClaudeBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_result") parts.push(block.content);
  }
  return parts.join("\n");
}

/** The fields a tool input is summarized BY; anything else renders as its JSON. */
const toolInputSummary = z.object({
  command: wireStringOrAbsent,
  file_path: wireStringOrAbsent,
  pattern: wireStringOrAbsent,
  path: wireStringOrAbsent,
});

function summarizeToolInput(name: string, input: LogLine["input"]): string {
  if (!input) return "";
  const summary = toolInputSummary.parse(input);
  if (name === "Bash" && summary.command !== undefined) return summary.command;
  if (summary.file_path !== undefined) return summary.file_path;
  if (summary.pattern !== undefined) {
    return summary.pattern + (summary.path !== undefined ? " " + summary.path : "");
  }
  return JSON.stringify(input);
}

/** `null` → the envelope type is unrecognized; the caller renders it raw. */
function projectCodex(e: CodexEnvelope, t: string): ProjectedEnvelope | null {
  switch (e.type) {
    case "thread.started":
      return {
        display: {
          t,
          ev: "init",
          tag: "thread.started",
          text: `thread ${e.thread_id.slice(0, 13)}… started`,
        },
        facts: { sessionId: e.thread_id || null },
      };
    case "turn.started":
      return { display: { t, ev: "meta", tag: "turn.started", text: "turn started" }, facts: {} };
    case "turn.completed": {
      const inTok = e.usage.input_tokens;
      const cached = e.usage.cached_input_tokens;
      const outTok = e.usage.output_tokens;
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
    case "turn.failed":
      return { display: { t, ev: "err", tag: "turn.failed", text: e.error?.message ?? "" }, facts: { isError: true } };
    case "error":
      return { display: { t, ev: "err", tag: "error", text: e.message }, facts: { isError: true } };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = e.item;
      const completed = e.type === "item.completed";
      switch (item.type) {
        case "reasoning":
          return completed
            ? { display: { t, ev: "think", tag: "reasoning", text: item.text ?? "" }, facts: {} }
            : { display: null, facts: {} };
        case "agent_message":
          return completed
            ? { display: { t, ev: "text", tag: "agent_message", text: item.text ?? "" }, facts: {} }
            : { display: null, facts: {} };
        case "command_execution": {
          if (e.type === "item.started") {
            return { display: { t, ev: "tool", tag: "command_execution", name: "exec", text: cleanCommand(item.command) }, facts: {} };
          }
          if (completed) {
            const out = item.aggregated_output.replace(/\n$/, "");
            return { display: { t, ev: item.exit_code ? "err" : "out", tag: "aggregated_output", text: out, exit: item.exit_code }, facts: {} };
          }
          return { display: null, facts: {} };
        }
        case "file_change": {
          const text = summarizeChanges(item.changes);
          return completed ? { display: { t, ev: "diff", tag: "file_change", text, changes: item.changes }, facts: {} } : { display: null, facts: {} };
        }
        case "error":
          // The Codex SDK explicitly defines ErrorItem as non-fatal. Surface it
          // as an error-looking timeline row, but do not poison an otherwise
          // successful turn; only top-level `turn.failed` / `error` do that.
          return { display: { t, ev: "err", tag: "error", text: item.message }, facts: {} };
        case "mcp_tool_call": {
          // P14-RT-07: an MCP call is a TOOL call, and the console must say
          // which one. The default branch below projected it as a dim `meta`
          // line whose text read `item.text ?? item.query` — neither of which an
          // McpToolCallItem carries — so every Codex MCP call rendered as an
          // empty row while Claude logged tool name + input. `item.started`
          // carries the server/tool/arguments, so log it there (mirroring
          // command_execution) and log the failure on completion.
          const name = `${item.server}.${item.tool}`;
          if (e.type === "item.started") {
            const args = item.arguments;
            return {
              display: {
                t,
                ev: "tool",
                tag: "mcp_tool_call",
                name,
                text: args.record === null ? args.text : summarizeMcpArguments(args.record),
                input: args.record,
              },
              facts: {},
            };
          }
          if (completed) {
            const error = item.error?.message ?? "";
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
                  text: item.query ?? "",
                },
                facts: {},
              }
            : { display: null, facts: {} };
        default:
          // todo_list and any item type a future SDK adds — completed only, meta.
          return completed
            ? { display: { t, ev: "meta", tag: item.type || "item", text: item.text ?? item.query ?? "" }, facts: {} }
            : { display: null, facts: {} };
      }
    }
    default:
      return null;
  }
}

/** The fields an MCP call's arguments are summarized BY, in priority order. */
const mcpArgumentSummary = z.object({
  query: wireStringOrAbsent,
  path: wireStringOrAbsent,
  url: wireStringOrAbsent,
  name: wireStringOrAbsent,
  message: wireStringOrAbsent,
});

/** The console row for an MCP call's arguments — the same "show the useful
 *  field, else the JSON" rule `summarizeToolInput` applies on Claude. */
function summarizeMcpArguments(args: LogLine["input"]): string {
  if (args == null) return "";
  const summary = mcpArgumentSummary.parse(args);
  for (const value of [summary.query, summary.path, summary.url, summary.name, summary.message]) {
    if (value !== undefined && value.trim()) return value;
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

function summarizeChanges(changes: FileChange[]): string {
  if (!changes.length) return "no changes";
  const files = changes.length;
  return `${files} file${files === 1 ? "" : "s"} · ${changes.map((c) => c.path).join(", ")}`;
}
