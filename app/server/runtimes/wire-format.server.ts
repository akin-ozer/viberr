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
  /** Cumulative usage this envelope reports (claude result / codex turn, or
   *  the Claude adapter's live fold). `outputEstimated` (F35-1) says whether
   *  `output_tokens` is the PROVIDER's figure (a result / turn.completed) or
   *  the adapter's estimate from the streamed text: the sink keeps an estimate
   *  as a monotone lower bound and lets a provider figure REPLACE it. */
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    outputEstimated: boolean;
  } | null;
  /** Dollar cost — claude result only. */
  costUsd?: number | null;
  /** Turn count reported by a result/turn.completed envelope. */
  turns?: number | null;
  /** True when a claude result / codex turn.failed signals agent-level error. */
  isError?: boolean;
  /** True when this is a terminal result envelope (claude result). */
  isResult?: boolean;
  /** Ruling 130(a): the assistant envelope's `error` code (`oauth_org_not_allowed`,
   *  `rate_limit`, …) when the provider streamed its API-error banner. */
  apiError?: string | null;
  /** Ruling 130(a): the result envelope's `api_error_status` (403, 429, …). */
  apiErrorStatus?: number | null;
  /** Ruling 130(a): the result envelope's `terminal_reason` (`api_error`, …). */
  terminalReason?: string | null;
  /** A `rate_limit_event`'s live quota reading (claude only today) — folded
   *  into the instance-wide backend-quota store by the sink, so approaching
   *  exhaustion is visible BEFORE a run fails on it (pass-29 gap 3.2). */
  rateLimit?: {
    status: string;
    rateLimitType: string;
    utilization: number | null;
    resetsAt: number | null;
    isUsingOverage: boolean;
  } | null;
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

/**
 * Ruling 175: one model's totals in a result's `modelUsage` (sdk.d.ts
 * `ModelUsage`), the fields the fold reads. `inputTokens` is the uncached slice
 * and the two cache figures are disjoint from it, the same split as `usage`.
 */
const claudeModelUsageEntry = z.object({
  inputTokens: wireCount,
  outputTokens: wireCount,
  cacheReadInputTokens: wireCount,
  cacheCreationInputTokens: wireCount,
  costUSD: wireCount,
});

/** `modelUsage` keyed by model id. Tolerant per model: an entry that does not
 *  parse is dropped, never the whole map. */
const claudeModelUsage = z
  .record(z.string(), claudeModelUsageEntry.nullable().catch(null))
  .transform((byModel) =>
    Object.entries(byModel).flatMap(([model, entry]) => (entry ? [{ model, ...entry }] : [])),
  )
  .catch(() => []);

const claudeEnvelopeFields = z.object({
  type: wireText,
  subtype: wireText,
  error: absentableWireText,
  session_id: wireText,
  model: wireText,
  cwd: wireTextOrBlank,
  tools: z.array(z.unknown()).catch(() => []),
  mcp_servers: z.array(z.object({ name: wireText }).catch(() => ({ name: "" }))).catch(() => []),
  /** Two shapes share the key: the API message object of an `assistant`/`user`
   *  envelope (its `content` blocks), and the plain rejection SENTENCE of a
   *  `system/permission_denied` frame (SDK ≥ 0.3.223) — read as `text`. */
  message: z
    .union([
      z.string().transform((text) => ({ content: claudeBlocks.parse([]), text })),
      z.object({ content: claudeBlocks }).transform((m) => ({ content: m.content, text: "" })),
    ])
    .catch(() => ({ content: claudeBlocks.parse([]), text: "" })),
  /** `system/permission_denied`: the tool the run was refused, and why (the
   *  deciding component's reason and its kind — `rule`, `mode`, `classifier`…). */
  tool_name: wireTextOrBlank,
  decision_reason: wireTextOrBlank,
  decision_reason_type: wireTextOrBlank,
  usage: z
    .object({
      input_tokens: wireCount,
      cache_creation_input_tokens: wireCount,
      cache_read_input_tokens: wireCount,
      output_tokens: wireCount,
    })
    .catch(() => ({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    })),
  total_cost_usd: wireCount,
  /** Ruling 175: every call the query made, per model — main loop, subagents,
   *  sidechains, compaction. The SDK calls it "the correct field for token/cost
   *  accounting"; `usage` is the main loop only. */
  modelUsage: claudeModelUsage,
  num_turns: wireCount,
  duration_ms: wireCount,
  duration_api_ms: wireCount,
  is_error: wireFlag,
  /** Ruling 130(a): the result's HTTP status when the API refused the run, and
   *  the SDK's terminal reason. Nullable on purpose: absent is "not sent". */
  api_error_status: z.number().nullable().catch(null),
  terminal_reason: wireText,
  /** `rate_limit_event` payload — the SDK's live utilization report. Nullable
   *  numbers (not wireCount) on purpose: a missing utilization must read as
   *  "not reported", never as a fabricated 0% that looks like a fresh quota. */
  rate_limit_info: z
    .object({
      status: wireText,
      rateLimitType: wireText,
      utilization: z.number().nullable().catch(null),
      resetsAt: z.number().nullable().catch(null),
      isUsingOverage: wireFlag,
    })
    .nullable()
    .catch(null),
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
/** One model's share of a Claude result, in the run row's terms. */
export interface ModelUsageShare {
  model: string;
  /** The whole prompt: uncached slice + cache writes + cache reads. */
  in: number;
  cached: number;
  out: number;
  cost: number;
}

/** What a Claude result folds to, in the run row's terms. */
interface ClaudeResultUsage {
  inTok: number;
  cached: number;
  outTok: number;
  costUsd: number;
  models: ModelUsageShare[];
}

/**
 * Ruling 175: a Claude result's tokens and cost, from `modelUsage` when it
 * carries any figure, else from `usage` and `total_cost_usd`. The row's
 * `input_tokens` is the WHOLE prompt (uncached + cache writes + cache reads)
 * and `cached_input_tokens` its cache-read subset on both paths, so a row
 * written before the ruling and one written after mean the same thing; only
 * the calls counted grew (subagents, sidechains, compaction).
 */
function foldClaudeResultUsage(e: ClaudeEnvelope): ClaudeResultUsage {
  const models = e.modelUsage.map((m) => ({
    model: m.model,
    in: m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens,
    cached: m.cacheReadInputTokens,
    out: m.outputTokens,
    cost: m.costUSD,
  }));
  const counted = models.some((m) => m.in > 0 || m.out > 0 || m.cost > 0);
  if (!counted) {
    return {
      inTok:
        e.usage.input_tokens + e.usage.cache_creation_input_tokens + e.usage.cache_read_input_tokens,
      cached: e.usage.cache_read_input_tokens,
      outTok: e.usage.output_tokens,
      costUsd: e.total_cost_usd,
      models: [],
    };
  }
  const sum = (pick: (m: ModelUsageShare) => number) => models.reduce((n, m) => n + pick(m), 0);
  return {
    inTok: sum((m) => m.in),
    cached: sum((m) => m.cached),
    outTok: sum((m) => m.out),
    costUsd: sum((m) => m.cost),
    models,
  };
}

/** The result line's token clause, one shape on both backends: the whole
 *  prompt, its cache-read subset, the output. */
function usageText(inTok: number, cached: number, outTok: number): string {
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  return `in ${k(inTok)} (cached ${k(cached)}) · out ${k(outTok)} tokens`;
}

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
    case "rate_limit_event": {
      // The SDK's live quota report. Previously fell through to the
      // unknown-envelope row (raw JSON, client-side telemetry bucket) and was
      // read by nobody; the reading now rides facts so the sink can fold it
      // into the backend-quota store. The display stays a dim meta line under
      // the SAME tag the client already groups as telemetry.
      const info = e.rate_limit_info;
      const pct =
        info?.utilization != null
          ? `${Math.round(info.utilization * 100)}%`
          : "utilization not reported";
      // Ruling 130(a): the display names the window, the STATUS and the reset
      // instant (absolute UTC, never relative). A REJECTED reading is the one
      // a human must see, so it carries its own tag suffix: the console's
      // telemetry collapse keys on the bare `rate_limit_event` tag.
      const rejected = info?.status === "rejected";
      const reset =
        info?.resetsAt != null ? ` · resets ${absoluteUtc(info.resetsAt)}` : "";
      return {
        display: {
          t,
          ev: rejected ? "err" : "meta",
          tag: rejected ? "rate_limit_event·rejected" : "rate_limit_event",
          text: info
            ? `rate limit · ${info.rateLimitType || "window"} · ${info.status || "status not reported"} · ${pct}${info.isUsingOverage ? " · overage" : ""}${reset}`
            : "rate limit event",
        },
        facts: info ? { rateLimit: info } : {},
      };
    }
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
      // SDK ≥ 0.3.223: a tool call the permission layer REFUSED — a deny rule
      // (`Bash(git push:*)` on a supporting run, a grant-derived deny), the
      // mode, or a prompt nobody was there to answer. The run went on, but a
      // human reading the console must see the attempt and the refusal (a
      // supporting agent reaching for `git push` is the VIB-30 class), so it is
      // an error-class line named after the tool, never a dim meta row. The
      // Claude adapter writes one in this shape itself (`source: "viberr"`,
      // `decision_reason_type: "hook"`) for its PreToolUse capability hook,
      // whose denies the SDK reports as a tool result only (Option D PR 5).
      if (e.subtype === "permission_denied") {
        const reason = e.decision_reason || e.message.text;
        const by = e.decision_reason_type ? ` by ${e.decision_reason_type}` : "";
        // The tool rides `name` (rendered bold before the text, like a tool
        // line), so the text names it only when there is none to render.
        const text = `${e.tool_name ? "" : "tool call "}denied${by}${reason ? `: ${reason}` : ""}`;
        return {
          display: e.tool_name
            ? { t, ev: "err", tag: "permission_denied", name: e.tool_name, text }
            : { t, ev: "err", tag: "permission_denied", text },
          facts: {},
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
      // Ruling 130(a): the provider streams its API-error banner ("You are not
      // allowed to …") as an assistant message carrying an `error` code. It is
      // an error line, never the agent's reply, so it can never be selected as
      // the reply comment.
      if (e.error) {
        return {
          display: {
            t,
            ev: "err",
            tag: `assistant·${e.error}`,
            text: summarizeContent(content) || e.error,
          },
          facts: { apiError: e.error },
        };
      }
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
      // Claude reports the prompt in three DISJOINT figures: the uncached slice
      // (`input_tokens`, two tokens per call on every real run), the tokens
      // written to the prompt cache and the tokens read back from it. Codex's
      // `input_tokens` is the whole prompt with its cache subsets inside it,
      // and every reader of the run row (the strip's Tokens, Insights) adds
      // input to output as "tokens processed". So the row's `input_tokens` is
      // the WHOLE prompt on both backends and `cached_input_tokens` the
      // cache-read subset of it. Before this the Claude row held the uncached
      // slice alone, and the strip read a median 60x below the provider's own
      // total on the runs this instance had stored.
      //
      // Ruling 175: the figures come from `modelUsage`, which covers every call
      // the query made, subagents and compaction included; `usage` covers the
      // main loop only and undercounted any run that delegated. Same column
      // semantics either way. `usage` (and `total_cost_usd`) remain the
      // fallback for a result without per-model figures — an older CLI, or a
      // crash result whose `modelUsage` came back empty or zeroed.
      const fold = foldClaudeResultUsage(e);
      const { inTok, cached, outTok } = fold;
      const durSec = Math.round(e.duration_ms / 1000);
      // U34-1: the SDK ends an API-refused run with `subtype: "success"` and
      // `is_error: true`, which printed "result · success" one line above the
      // failure. An error result's label is its subtype unless that subtype is
      // "success", in which case it is "error"; the API status and terminal
      // reason follow when the SDK sent them.
      const outcome = e.is_error
        ? e.subtype && e.subtype !== "success"
          ? e.subtype
          : "error"
        : "success";
      const text = e.is_error
        ? `${outcome} · ${e.num_turns} turns` +
          (e.api_error_status != null ? ` · api ${e.api_error_status}` : "") +
          (e.terminal_reason ? ` · ${e.terminal_reason}` : "")
        : `success · ${e.num_turns} turns · ${durSec}s · $${fold.costUsd.toFixed(2)} · ${usageText(inTok, cached, outTok)}` +
          (fold.models.length > 1 ? ` · ${fold.models.length} models` : "");
      const stats: NonNullable<LogLine["stats"]> = {
        subtype: e.is_error ? outcome : undefined,
        dur: e.duration_ms,
        api: e.duration_api_ms,
        turns: e.num_turns,
        cost: fold.costUsd,
        in: inTok,
        cached,
        out: outTok,
      };
      // The per-model breakdown lives on the line, not in a column.
      if (fold.models.length) stats.models = fold.models;
      return {
        display: { t, ev: "result", tag: "result", text, stats },
        facts: {
          usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok, outputEstimated: false },
          costUsd: fold.costUsd,
          turns: e.num_turns,
          isError: e.is_error,
          isResult: true,
          apiErrorStatus: e.api_error_status,
          terminalReason: e.terminal_reason || null,
        },
      };
    }
    default:
      return null;
  }
}

/** An epoch-seconds instant as absolute UTC (`2026-09-03 11:50 UTC`). */
function absoluteUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return String(epochSeconds);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
      const text = usageText(inTok, cached, outTok);
      return {
        display: { t, ev: "result", tag: "turn.completed", text, usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok } },
        // Each completed turn counts as one turn (codex has no cumulative
        // num_turns); the adapter overrides this with a running count for a
        // multi-turn run, so the live Turns counter isn't stuck at 0.
        facts: { usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: outTok, outputEstimated: false }, turns: 1 },
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
