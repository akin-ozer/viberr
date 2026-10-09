import { z } from "zod";
import { changedSpans, diffSteps, type TextSpan } from "~/shared/line-diff";
import { normalizeWorkspacePaths } from "~/shared/workspace-paths";
import type { LogLine } from "./runtime-types";

/**
 * Ruling 168: an agent's file edit, read as a diff on its own console row.
 *
 * Claude's `Edit` carries the text it replaces and the text that replaces it,
 * `MultiEdit` a list of such pairs, and `Write` the whole file it writes. The
 * row used to print the path and a link, `+ old_string, new_string`, that
 * opened the two strings one above the other; the owner called it dated
 * (2026-09-26). Now the row draws what changed, the way agent tools and code
 * review do: the lines removed and added, tinted, with the words that changed
 * inside a changed line marked, three unchanged lines around each change and
 * longer unchanged runs folded behind a count.
 *
 * What the record does not carry is not drawn. An edit names strings, not
 * places, so its lines have no numbers; a `Write` numbers its lines, since
 * they are the whole file; and a `Write` claims no `+N −M`, because the record
 * does not say what the file held before.
 */

/** One line of the diff: kept, removed or added. */
export interface DiffLine {
  kind: "ctx" | "del" | "add";
  text: string;
  /** The words that changed, when a removed line pairs with an added one. */
  spans: readonly TextSpan[] | null;
  /** The line's number in a written file; null on an edit. */
  num: number | null;
}

/** Unchanged lines folded behind a count, opened in place. */
export interface DiffFold {
  kind: "fold";
  lines: DiffLine[];
}

/** Where one of a `MultiEdit`'s edits begins. */
export interface DiffEditMark {
  kind: "edit";
  n: number;
  of: number;
  /** The edit replaces every occurrence of its text. */
  everywhere: boolean;
}

export type DiffRow = DiffLine | DiffFold | DiffEditMark;

export interface EditDiff {
  /** The file as the call named it. */
  path: string;
  /** What the row prints: repo-relative inside a task's checkout. */
  shown: string;
  /** Lines added and removed, over every edit; null for a `Write`. */
  added: number | null;
  removed: number | null;
  /** A `Write`'s line count. */
  written: number | null;
  /** An `Edit` that replaces every occurrence of its text. */
  everywhere: boolean;
  rows: DiffRow[];
  /** The arguments the diff shows in full, which the row's link then leaves
   *  out (ruling 168 names only what a reader cannot see). */
  drawn: readonly string[];
}

/** Unchanged lines kept on each side of a change. */
const CONTEXT = 3;
/** A run shorter than this is shown rather than folded. */
const MIN_FOLD = 2;

const oneEdit = z.object({
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
const editInput = oneEdit.extend({ file_path: z.string() });
const multiEditInput = z.object({ file_path: z.string(), edits: z.array(oneEdit).min(1) });
const writeInput = z.object({ file_path: z.string(), content: z.string() });

/** A text's lines; a trailing newline ends the last line rather than
 *  opening an empty one, and an empty text has none. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The lines one edit keeps, removes and adds, in reading order: a change's
 *  removed lines, then its added ones, each pair marked word by word. */
function editLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const out: DiffLine[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    const pairs = dels.map((del, i) => (i < adds.length ? changedSpans(del, adds[i]!) : null));
    dels.forEach((text, i) => out.push({ kind: "del", text, spans: pairs[i]?.before ?? null, num: null }));
    adds.forEach((text, i) => out.push({ kind: "add", text, spans: pairs[i]?.after ?? null, num: null }));
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  for (const step of diffSteps(a, b)) {
    if (step === "same") {
      flush();
      out.push({ kind: "ctx", text: a[i]!, spans: null, num: null });
      i += 1;
      j += 1;
    } else if (step === "del") {
      dels.push(a[i]!);
      i += 1;
    } else {
      adds.push(b[j]!);
      j += 1;
    }
  }
  flush();
  return out;
}

/** An edit's lines with the unchanged runs past `CONTEXT` folded. */
function folded(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let run: DiffLine[] = [];
  let changed = false;
  const close = (last: boolean) => {
    const keepHead = changed ? CONTEXT : 0;
    const keepTail = last ? 0 : CONTEXT;
    if (!changed && last) {
      // No change at all (an edit to identical text): nothing to fold around.
      rows.push(...run);
    } else if (run.length - keepHead - keepTail >= MIN_FOLD) {
      rows.push(...run.slice(0, keepHead));
      rows.push({ kind: "fold", lines: run.slice(keepHead, run.length - keepTail) });
      rows.push(...run.slice(run.length - keepTail));
    } else {
      rows.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "ctx") {
      run.push(line);
      continue;
    }
    if (run.length) close(false);
    changed = true;
    rows.push(line);
  }
  if (run.length) close(true);
  return rows;
}

/** Lines added and removed. */
interface LineCounts {
  added: number;
  removed: number;
}

function counts(rows: readonly DiffRow[]): LineCounts {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}

/** A tool row's file edit as a diff, or null for any other row. */
export function editDiff(line: LogLine): EditDiff | null {
  if (line.ev !== "tool" || !line.input) return null;
  if (line.name === "Edit") {
    const edit = editInput.safeParse(line.input);
    if (!edit.success) return null;
    const rows = folded(editLines(edit.data.old_string, edit.data.new_string));
    return {
      path: edit.data.file_path,
      shown: normalizeWorkspacePaths(edit.data.file_path),
      ...counts(rows),
      written: null,
      everywhere: edit.data.replace_all === true,
      rows,
      drawn: ["old_string", "new_string"],
    };
  }
  if (line.name === "MultiEdit") {
    const multi = multiEditInput.safeParse(line.input);
    if (!multi.success) return null;
    const of = multi.data.edits.length;
    const rows = multi.data.edits.flatMap((edit, n): DiffRow[] => [
      { kind: "edit", n: n + 1, of, everywhere: edit.replace_all === true },
      ...folded(editLines(edit.old_string, edit.new_string)),
    ]);
    return {
      path: multi.data.file_path,
      shown: normalizeWorkspacePaths(multi.data.file_path),
      ...counts(rows),
      written: null,
      // Each edit's own marker says it, where it applies.
      everywhere: false,
      rows,
      drawn: ["edits"],
    };
  }
  if (line.name === "Write") {
    const write = writeInput.safeParse(line.input);
    if (!write.success) return null;
    const rows = linesOf(write.data.content).map(
      (text, i): DiffLine => ({ kind: "ctx", text, spans: null, num: i + 1 }),
    );
    return {
      path: write.data.file_path,
      shown: normalizeWorkspacePaths(write.data.file_path),
      added: null,
      removed: null,
      written: rows.length,
      everywhere: false,
      rows,
      drawn: ["content"],
    };
  }
  return null;
}

/** Rows drawn before the rest waits behind "Show N more lines". Exported with
 *  no importer on purpose: module-local, it grows both Controller pages'
 *  closures by a byte (ruling 11's ratchet). */
export const PREVIEW_ROWS = 10;

/**
 * How many rows the closed diff draws, and how many lines the rest holds (a
 * fold counts the lines inside it). A diff only a couple of rows past the
 * preview is drawn whole: "Show 1 more line" is a click for nothing.
 */
export interface DiffPreview {
  /** Rows the closed diff draws. */
  shown: number;
  /** Lines the rest holds; 0 when the diff is drawn whole. */
  more: number;
}

export function diffPreview(rows: readonly DiffRow[]): DiffPreview {
  if (rows.length <= PREVIEW_ROWS + 2) return { shown: rows.length, more: 0 };
  let more = 0;
  for (const row of rows.slice(PREVIEW_ROWS)) {
    if (row.kind === "fold") more += row.lines.length;
    else if (row.kind !== "edit") more += 1;
  }
  return { shown: PREVIEW_ROWS, more };
}
