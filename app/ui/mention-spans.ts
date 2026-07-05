/**
 * Locate `@mention` spans in a string, matching either a KNOWN mentionable
 * display name (which may contain spaces — e.g. "@Arda Kaya") or, as a
 * fallback, the single-token grammar the server routes on (`@word`). Shared by
 * the composer highlight backdrop and the rendered-comment markdown renderer so
 * a mention is highlighted as ONE unit — the whole name — in both places.
 *
 * A mention starts at an `@` that is at the start of the string or follows
 * whitespace. Known names are tried longest-first (so "@Arda Kaya" wins over
 * "@Arda"), and only when the char after the name is a boundary (end / space /
 * light punctuation) so "@Arda" does not match inside "@Ardavan". When no known
 * name matches, the `@[A-Za-z][\w-]*` token is highlighted (unchanged behavior,
 * so single-token handles and unknown mentions still light up).
 */

export interface MentionSpan {
  /** Index of the `@`. */
  start: number;
  /** Index just past the mention. */
  end: number;
}

const TOKEN_RE = /^[A-Za-z][\w-]*/;

function boundaryBefore(text: string, at: number): boolean {
  return at === 0 || /\s/.test(text[at - 1]!);
}

function boundaryAfter(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || /[.,!?;:)\]]/.test(ch);
}

export function findMentionSpans(text: string, names: string[]): MentionSpan[] {
  // De-dupe + sort known names longest-first for greedy matching.
  const sorted = Array.from(new Set(names.filter((n) => n && n.trim().length > 0)))
    .map((n) => n.toLowerCase())
    .sort((a, b) => b.length - a.length);

  const spans: MentionSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !boundaryBefore(text, i)) continue;
    const after = text.slice(i + 1);
    const afterLower = after.toLowerCase();

    let len = 0;
    for (const nm of sorted) {
      if (afterLower.startsWith(nm) && boundaryAfter(after[nm.length])) {
        len = nm.length;
        break;
      }
    }
    if (len === 0) {
      const m = TOKEN_RE.exec(after);
      if (m) len = m[0].length;
    }
    if (len > 0) {
      spans.push({ start: i, end: i + 1 + len });
      i += len; // skip the matched body (loop's i++ moves past the last char)
    }
  }
  return spans;
}
