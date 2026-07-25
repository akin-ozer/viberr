import type { LogLine } from "./runtime-types";

/**
 * P14-WL-02 — wire telemetry in the human-facing console.
 *
 * Both vendors interleave bookkeeping envelopes with the actual run: Claude
 * emits a `system` event per thinking-token accounting tick, Codex emits
 * `rate_limit_event` on every turn. Neither carries a projection case, so both
 * fall through to the tolerant default (`ev: "meta"`, `tag: <wire type>`,
 * `text: <the whole JSON>`) and render as ordinary timeline rows — live, one
 * task's console was dozens of `system·thinking_tokens` lines and raw
 * `rate_limit_event` blobs between the two tool calls a reader came for.
 *
 * The stored line is never touched: the console COLLAPSES consecutive telemetry
 * rows into one row that says how many there were, and the `{ } raw` toggle
 * still prints every stored envelope verbatim. Hiding without saying so would
 * be the same dishonesty in the other direction.
 */

/**
 * Wire tags that carry no run information — pure accounting, emitted per turn
 * or per tick. Everything else stays a normal row, including `system·api_retry`
 * and `system·compact_boundary`, which DO tell a reader something happened.
 */
const TELEMETRY_TAGS: ReadonlySet<string> = new Set([
  // Claude: `system` envelopes whose subtype is token accounting.
  "system·thinking_tokens",
  "system·token_count",
  // Codex: emitted on every turn with the account's remaining quota window.
  "rate_limit_event",
  "token_count",
]);

/** True when this line is vendor bookkeeping rather than run content. */
export function isTelemetryLine(line: LogLine): boolean {
  return line.ev === "meta" && TELEMETRY_TAGS.has(line.tag);
}

/** One console entry: a real row, or a collapsed telemetry block. */
export type ConsoleEntry<T> =
  | { kind: "line"; line: T }
  | { kind: "telemetry"; count: number; tags: string[] };

/**
 * Collapse runs of telemetry lines. `raw` mode passes the array through
 * untouched — the raw toggle's whole contract is "what the provider sent".
 */
export function collapseTelemetry<T extends { display: LogLine }>(
  rows: readonly T[],
  raw: boolean,
): ConsoleEntry<T>[] {
  if (raw) return rows.map((line) => ({ kind: "line", line }));
  const out: ConsoleEntry<T>[] = [];
  for (const row of rows) {
    if (!isTelemetryLine(row.display)) {
      out.push({ kind: "line", line: row });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "telemetry") {
      last.count += 1;
      if (!last.tags.includes(row.display.tag)) last.tags.push(row.display.tag);
      continue;
    }
    out.push({ kind: "telemetry", count: 1, tags: [row.display.tag] });
  }
  return out;
}

/** The collapsed row's own copy — names what was folded and where it went. */
export function telemetryLabel(entry: {
  count: number;
  tags: string[];
}): string {
  return (
    `${entry.count} telemetry event${entry.count === 1 ? "" : "s"} ` +
    `(${entry.tags.join(", ")}) — token and rate-limit accounting, hidden here; ` +
    `“{ } raw” shows them`
  );
}
