/**
 * Repair for prose the operator MODEL emits through tool-call / plan JSON
 * strings (timeline comments, packet titles/bodies/observations/options,
 * agent prompt directives). Models sometimes double-escape newlines in the
 * strings they emit, so the text arrives carrying literal `\n` two-char
 * sequences ("**Plan — ATL-1**\n\nObserved: …") that would render verbatim
 * in the UI timeline. Nothing downstream can repair this, so it is fixed
 * here — at the model→store boundary — before the text persists.
 *
 * Heuristic (deliberately pragmatic — see finding #23): treat `\n` as an
 * escaped newline only when the whole string looks like mis-escaped
 * single-line prose:
 *   · it contains NO real newline (a properly transmitted multi-line string
 *     keeps its literal `\n`s — there they are deliberate content), and
 *   · it contains NO fenced code block (code may legitimately spell `\n`),
 * and then only where the run of `\n`s sits directly between prose
 * characters. Neighbouring whitespace, backslashes, and backticks disqualify
 * a run, so `C:\\net`-style doubled backslashes and inline `` `\n` `` code
 * spans survive.
 *
 * A run of TWO OR MORE `\n` is an unambiguous paragraph break and always
 * converts. A SINGLE `\n` is ambiguous with a Windows path separator (`\node`,
 * `\network`), so it converts only when it is NOT followed by a word character
 * continuing a path segment — a list marker (`- `), other punctuation, or the
 * end of the string are safe; `\node` is left intact. Known blind spots
 * (accepted): a lone trailing `\n` after a space, and a `\n` inside a
 * multi-word inline code span.
 */

const ESCAPED_NEWLINE_RUN = /(^|[^\s\\`])((?:\\n)+)(?=([^\s\\`]|$))/g;

export function normalizeEscapedNewlines(text: string): string {
  if (!text.includes("\\n") || text.includes("\n") || text.includes("```")) {
    return text;
  }
  return text.replace(
    ESCAPED_NEWLINE_RUN,
    (match: string, before: string, run: string, after: string) => {
      const count = run.length / 2;
      // A single \n followed by a word char is more likely a path separator
      // (`\node`) than a line break — leave it as the model wrote it.
      if (count < 2 && after && /\w/.test(after)) return match;
      return before + "\n".repeat(count);
    },
  );
}
