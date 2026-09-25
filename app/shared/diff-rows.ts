/**
 * Ruling 484: a unified-diff patch (GitHub's `pulls/{n}/files` `patch`) as the
 * rows the Changes panel draws, each with the line numbers a note quotes.
 *
 * A hunk header `@@ -a,b +c,d @@ …` sets both counters; a context line
 * advances both, an added line the new one, a removed line the old one. The
 * "\ No newline at end of file" marker belongs to the line before it and
 * advances nothing. A malformed header leaves the counters where they were
 * rather than inventing numbers, and a line outside any hunk carries none.
 */

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | {
      kind: "add" | "del" | "ctx";
      /** The line in the file as it was (null on an added line). */
      oldLine: number | null;
      /** The line in the file as delivered (null on a removed line). */
      newLine: number | null;
      /** The line's text, without its +/-/space marker. */
      text: string;
    };

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const lines = patch.split(/\r?\n/);
  // A trailing newline ends the last line; it does not open an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      } else {
        oldLine = null;
        newLine = null;
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line.slice(1).trim() });
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      rows.push({ kind: "add", oldLine: null, newLine, text });
      if (newLine !== null) newLine += 1;
    } else if (marker === "-") {
      rows.push({ kind: "del", oldLine, newLine: null, text });
      if (oldLine !== null) oldLine += 1;
    } else {
      // A context line (a space marker, or an empty line some producers emit
      // for a blank context line).
      rows.push({ kind: "ctx", oldLine, newLine, text: marker === " " ? text : line });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
    }
  }
  return rows;
}
