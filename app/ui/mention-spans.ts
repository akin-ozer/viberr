/**
 * Locate `@mention` spans in a string, matching either a KNOWN mentionable
 * display name (which may contain spaces — e.g. "@Arda Kaya", "@Docs Writer")
 * or, as a fallback, the single-token grammar `@word`. Shared by the composer
 * highlight backdrop, the rendered-comment markdown renderer AND the server-side
 * routing resolvers, so "highlighted as a mention" and "actually routed" are the
 * same rule (P13-LV-11/LV-12: the composer inserted the display name, the
 * renderer highlighted it, and the server — which only ever parsed single
 * tokens — silently routed it nowhere).
 *
 * A mention starts at an `@` that is at the start of the string or follows
 * whitespace. Known names are tried longest-first (so "@Arda Kaya" wins over
 * "@Arda"), and only when the char after the name is a boundary (end / space /
 * light punctuation) so "@Arda" does not match inside "@Ardavan".
 */

export interface MentionSpan {
  /** Index of the `@`. */
  start: number;
  /** Index just past the mention. */
  end: number;
  /** The matched body, lowercased (no leading `@`). */
  handle: string;
  /** True when the body matched a KNOWN mentionable name/handle. */
  known: boolean;
}

const TOKEN_RE = /^[A-Za-z][\w-]*/;

/**
 * Handles that ALWAYS route, on every task, without being in a caller's list:
 * the generic role/backend handles the server resolver honours. They count as
 * "known" so `@operator` chips even where a component has no mentionables prop.
 */
export const RESERVED_MENTION_HANDLES = [
  "operator",
  "agent",
  "claude",
  "codex",
] as const;

function boundaryBefore(text: string, at: number): boolean {
  return at === 0 || /\s/.test(text[at - 1]!);
}

function boundaryAfter(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || /[.,!?;:)\]]/.test(ch);
}

export function findMentionSpans(text: string, names: string[]): MentionSpan[] {
  // Ruling 454 (CS-5): every span starts at an `@`, so a text without one has
  // none — answered before the name list is built and sorted, which the
  // composer's per-keystroke transform and every server resolver pay for.
  if (!text.includes("@")) return [];
  // De-dupe + sort known names longest-first for greedy matching. The reserved
  // role handles are always known — they route on every task.
  const sorted = Array.from(
    new Set(
      [...names, ...RESERVED_MENTION_HANDLES].filter(
        (n) => n && n.trim().length > 0,
      ),
    ),
  )
    .map((n) => n.toLowerCase())
    .sort((a, b) => b.length - a.length);

  const spans: MentionSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !boundaryBefore(text, i)) continue;
    const after = text.slice(i + 1);
    const afterLower = after.toLowerCase();

    let len = 0;
    let known = false;
    for (const nm of sorted) {
      if (afterLower.startsWith(nm) && boundaryAfter(after[nm.length])) {
        len = nm.length;
        known = true;
        break;
      }
    }
    if (len === 0) {
      const m = TOKEN_RE.exec(after);
      if (m) len = m[0].length;
    }
    if (len > 0) {
      spans.push({
        start: i,
        end: i + 1 + len,
        handle: afterLower.slice(0, len),
        known,
      });
      i += len; // skip the matched body (loop's i++ moves past the last char)
    }
  }
  return spans;
}

/**
 * Every mention body in `text`, lowercased and de-duplicated: known multi-word
 * names matched whole, everything else by the single-token grammar. This is the
 * ONE function the server-side resolvers use to decide what a comment tagged.
 */
export function extractMentions(text: string, known: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of findMentionSpans(text, known)) {
    if (seen.has(span.handle)) continue;
    seen.add(span.handle);
    out.push(span.handle);
  }
  return out;
}
