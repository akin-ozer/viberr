import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import {
  backendRunMark,
  type TaskRunPrincipalView,
} from "./run-principal-view";

/**
 * Pure logic for the comment composer's @-mention autocomplete: detecting an
 * active @token at the caret, filtering the mentionable directory against it,
 * splitting a label for match highlighting, and computing the text/caret after
 * an insertion. All framework-free so they unit-test directly.
 *
 * Token grammar (mirrors the server's `MENTION_RE = /@([A-Za-z][\w-]*)/g`, and
 * the composer only triggers once ≥1 char follows the `@`):
 *   - the char before `@` is start-of-string or whitespace, then
 *   - `@`, then `[\w-]*` up to the caret.
 * The dropdown opens only when the token has at least ONE query character.
 */

// -------------------------------------------------------------- suggestions

/** Which group a suggestion belongs to (drives the row glyph). */
export type MentionKind = "agent" | "reserved" | "user";

/** One flattened, rankable suggestion for the dropdown. */
export interface MentionSuggestion {
  kind: MentionKind;
  /** The handle inserted (without the leading `@`). */
  handle: string;
  /** Primary row label (agent/user display name, or reserved handle). */
  name: string;
  /** Muted secondary text (role / label / email). */
  sub: string;
  /** Agent/reserved backend for the glyph (undefined → user Avatar). */
  backend?: string;
  /** Reserved rows render the operator/shield glyph. */
  operator?: boolean;
  /** Avatar initials for user rows. */
  initials?: string;
  /** Ruling 121: a caveat about what this handle would actually DO, appended
   *  to the sub-line. Today only the `@claude` / `@codex` backend handles carry
   *  one: mentioning them starts a run on the TASK OWNER's account, so a row
   *  whose backend the owner has not connected promises a run that refuses. */
  note?: string;
}

/**
 * Flatten the loader's mentionables into one rankable list: agents, then
 * reserved, then users (the group precedence the goal specifies).
 *
 * `runPrincipal` (ruling 121) is the task owner whose accounts a mention-driven
 * run would bill. The rows stay OFFERED when the owner cannot run a backend —
 * a comment posts either way, and hiding the handle would leave the human
 * guessing why `@codex` does nothing — but they carry the reason, in the same
 * voice the run controls use. Absent (a bare render, a surface with no task)
 * means nothing is claimed either way.
 */
export function flattenMentionables(
  m: Mentionables,
  runPrincipal?: TaskRunPrincipalView | null,
): MentionSuggestion[] {
  const out: MentionSuggestion[] = [];
  for (const a of m.agents) {
    out.push({
      kind: "agent",
      handle: a.handle,
      name: a.name,
      sub: a.role,
      backend: a.backend,
    });
  }
  for (const r of m.reserved) {
    const row: MentionSuggestion = {
      kind: "reserved",
      handle: r.handle,
      name: r.handle,
      sub: r.label,
      operator: r.handle === "operator" || r.handle === "agent",
    };
    // Only the two backend handles carry a backend glyph; every other reserved
    // row (operator/agent) renders the shield instead, so `backend` stays
    // ABSENT rather than undefined.
    if (r.handle === "claude") row.backend = "claude";
    if (r.handle === "codex") row.backend = "codex";
    // Only the backend handles start a run on a person's account, so only they
    // can be refused for want of one.
    if (runPrincipal !== undefined && (row.backend === "claude" || row.backend === "codex")) {
      const mark = backendRunMark(runPrincipal, row.backend);
      if (mark) row.note = mark;
    }
    out.push(row);
  }
  for (const u of m.users) {
    out.push({
      kind: "user",
      handle: u.handle,
      name: u.name,
      sub: u.email,
      initials: initialsOf(u.name),
    });
  }
  return out;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

// ------------------------------------------------------------ token detect

export interface MentionToken {
  /** The lowercased query typed after `@` (never empty when opening). */
  query: string;
  /** Index of the `@` in the source text. */
  start: number;
  /** Index just past the token (the caret position). */
  end: number;
}

/**
 * Detect an active @token immediately left of the caret. Returns null unless
 * there is an `@` that (a) starts the string or follows whitespace, (b) is
 * followed by at least one `[\w-]` char, and (c) runs unbroken up to the caret.
 * The query is lowercased for case-insensitive matching.
 */
export function detectMentionToken(
  text: string,
  caret: number,
): MentionToken | null {
  // Walk left from the caret over the token body `[\w-]`.
  let i = caret;
  while (i > 0 && /[\w-]/.test(text[i - 1]!)) i -= 1;
  // The char at i-1 must be the `@`.
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  // The char before `@` must be start-of-string or whitespace.
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null;
  const query = text.slice(i, caret);
  // Trigger only once at least one char follows the `@`.
  if (query.length === 0) return null;
  return { query: query.toLowerCase(), start: at, end: caret };
}

// --------------------------------------------------------------- filtering

/**
 * Filter + rank suggestions against a query (case-insensitive). Prefix matches
 * on handle/name rank above substring matches; group order (agents, reserved,
 * users) is the stable tie-breaker. Capped at `limit` (default 8).
 */
export function filterMentions<T extends MentionSuggestion>(
  all: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, limit);
  const scored: { s: T; rank: number; order: number }[] = [];
  all.forEach((s, order) => {
    const handle = s.handle.toLowerCase();
    const name = s.name.toLowerCase();
    let rank = -1;
    if (handle.startsWith(q) || name.startsWith(q)) rank = 0;
    else if (handle.includes(q) || name.includes(q)) rank = 1;
    if (rank >= 0) scored.push({ s, rank, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return scored.slice(0, limit).map((x) => x.s);
}

// --------------------------------------------------------------- highlight

/** A label split into [before, match, after] for highlighting the typed
 *  substring. `match` is empty when the query does not occur in the label. */
export interface HighlightParts {
  before: string;
  match: string;
  after: string;
}

/** Split `label` around the first case-insensitive occurrence of `query`. */
export function splitHighlight(label: string, query: string): HighlightParts {
  if (!query) return { before: label, match: "", after: "" };
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return { before: label, match: "", after: "" };
  return {
    before: label.slice(0, idx),
    match: label.slice(idx, idx + query.length),
    after: label.slice(idx + query.length),
  };
}

// ------------------------------------------------------------- insertion

export interface InsertResult {
  text: string;
  /** Caret position after the inserted `@handle ` (past the trailing space). */
  caret: number;
}

/**
 * Replace the active token `[start, end)` with `@<mention> ` (trailing space so
 * the next word starts fresh). `mention` is the DISPLAY name the user picked
 * (e.g. "Arda Kaya", "dev", "operator"), not the lowercased handle — so the
 * comment reads with the real name and highlights as one chip. The server still
 * routes it (users by first-name / email local-part; agents by name). Returns
 * the new text + caret.
 */
export function insertMention(
  text: string,
  token: MentionToken,
  mention: string,
): InsertResult {
  const insert = `@${mention} `;
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}
