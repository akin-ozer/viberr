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

/** A line as a note quotes it: which file it is numbered in, and its number. */
export interface NoteLine {
  /** `old` = a removed line, numbered in the file as it was. */
  side: "new" | "old";
  line: number;
}

/** A row a note can sit on: its index in the rows, and the line it quotes. */
export interface NoteRow extends NoteLine {
  row: number;
}

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

/** The line a row quotes: the new file's number for an added or context line,
 *  the old file's for a removed one. Null for a row a note cannot sit on (a
 *  hunk header, the no-newline marker, a line under a header that did not
 *  parse). */
export function noteLine(row: DiffRow): NoteLine | null {
  if (row.kind === "hunk" || row.kind === "meta") return null;
  if (row.kind === "del") return row.oldLine === null ? null : { side: "old", line: row.oldLine };
  return row.newLine === null ? null : { side: "new", line: row.newLine };
}

/**
 * Ruling 509: the rows one note covers when a person drags or shift-clicks from
 * row `from` towards row `to`, first row first. The run stops at its hunk's
 * edge, because the lines between two hunks are not in the patch, and before
 * any row `taken` says another note covers, because a line carries one note.
 * Both ends are rows a note can sit on; a no-newline marker inside the run is
 * passed over. Null when `from` itself cannot carry the note.
 */
export function noteRange(
  rows: readonly DiffRow[],
  from: number,
  to: number,
  taken: (row: number) => boolean,
): { start: NoteRow; end: NoteRow } | null {
  const origin = rows[from];
  const quoted = origin ? noteLine(origin) : null;
  if (quoted === null || taken(from)) return null;
  const anchor: NoteRow = { row: from, ...quoted };
  const step = to < from ? -1 : 1;
  let reach = anchor;
  for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
    const row = rows[i];
    if (!row || row.kind === "hunk" || taken(i)) break;
    const line = noteLine(row);
    if (line !== null) reach = { row: i, ...line };
  }
  return step > 0 ? { start: anchor, end: reach } : { start: reach, end: anchor };
}
