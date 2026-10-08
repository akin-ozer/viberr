import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useFetcher } from "react-router";
import type { PrDiffFile } from "~/server/github/pr-diff.server";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import {
  diffRows,
  noteLine,
  noteRange,
  type DiffRow,
  type NoteLine,
  type NoteRow,
} from "~/shared/diff-rows";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/**
 * Ruling 484 (pass 40, F40-54): the Changes panel's body, loaded when a person
 * opens the panel (`changes-slot.tsx` is what the task page ships).
 *
 * It reads the delivered revision's files and patches (`task-changes.ts`),
 * draws each file's hunks with the line numbers a note quotes, and lets the
 * person leave a note on any line: the number is the button. The notes go to
 * the delivering agent as ONE comment through the task's `review-notes` intent,
 * which is the comment door, so the agent resumes on it as it would on the same
 * words typed in the composer. Code is drawn in the mono face, unhighlighted: a
 * hunk is a window onto a file, not a file, so the attachment reader's Shiki
 * pass (ruling 363, whole-file grammars) would colour it wrongly as often as
 * not.
 *
 * Ruling 509: a note may cover several lines of one hunk, as a GitHub review
 * comment can. A person drags the mouse across the numbers, or opens a note and
 * shift-clicks another number (Shift+Enter from the keyboard), and the note
 * reaches the agent as `path:start-end`. A line still carries one note, so a
 * range stops before a line that has one, and pressing any line of a note
 * opens it.
 *
 * Ruling 696(e) split the body and a file along the task page's recipe, a pure
 * structural refactor: the body's stale notice and foot, and a file's left-out
 * patch, are hook-free components below the one that draws them, and a file's
 * own read is its hook `useFilePatch`. The read's failure stays in the body.
 */

export interface ChangesBodyProps {
  /** `/projects/<slug>/tasks/<KEY>/changes`. The notes post to the route that
   *  renders the panel, the task page (`review-notes`), as the composer's
   *  comment does. */
  url: string;
  /** The delivered revision the page knows now (SSE keeps it current). */
  revisionSha: string;
  githubHost: string;
}

/** One pending note, bound to the revision it was written on. It covers the
 *  rows `start` to `end` of one hunk (one row for a note on one line), and no
 *  other note covers any of them. */
interface PanelNote {
  /** The last line's identity, `lineKey`. */
  key: string;
  path: string;
  start: NoteRow;
  end: NoteRow;
  body: string;
}

/** The open note editor: the rows it covers in one file, the row a
 *  shift-click extends from, the note it rewrites (null for a new one) and
 *  the text it opens with. `id` is new for each note opened, so an editor
 *  never keeps another note's text. */
interface Draft {
  id: number;
  path: string;
  anchor: number;
  start: NoteRow;
  end: NoteRow;
  edits: string | null;
  text: string;
}

type SendResult = { ok: true; toast?: string } | { ok: false; error?: string };

const STATUS_LABEL = new Map([
  ["added", "added"],
  ["removed", "deleted"],
  ["renamed", "renamed"],
  ["modified", "modified"],
  ["copied", "copied"],
]);

/** A line's identity in the panel: file, side and number. */
function lineKey(path: string, side: "new" | "old", line: number): string {
  return `${side}:${line}:${path}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How the panel names the lines a note covers: "line 5", "line 5, removed",
 *  "lines 3 to 9", or both ends when the range runs from a removed line to an
 *  added one ("removed line 4 to line 7"). */
function spanLabel(start: NoteLine, end: NoteLine): string {
  const removed = end.side === "old" ? ", removed" : "";
  if (start.side !== end.side) {
    const one = (at: NoteLine) => `${at.side === "old" ? "removed line" : "line"} ${at.line}`;
    return `${one(start)} to ${one(end)}`;
  }
  return start.line === end.line
    ? `line ${end.line}${removed}`
    : `lines ${start.line} to ${end.line}${removed}`;
}

/** A label that opens a line of its own. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A note as the `review-notes` intent reads it: a note on several lines also
 *  names its first line and that line's side (ruling 509). */
function postedNote({ path, start, end, body }: PanelNote) {
  const note = { path, line: end.line, side: end.side, body };
  return start.row === end.row ? note : { ...note, startLine: start.line, startSide: start.side };
}

export function ChangesBody({ url, revisionSha, githubHost }: ChangesBodyProps) {
  const read = useFetcher<TaskChangesView>();
  const loadRead = read.load;
  useEffect(() => {
    void loadRead(url);
  }, [loadRead, url]);
  const view = read.data;
  const reading = read.state !== "idle";

  const [notes, setNotes] = useState<PanelNote[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // What the open editor holds, kept out of state so a keystroke redraws the
  // editor alone, not every file; a range change carries it to the editor's
  // new row.
  const typed = useRef("");
  const opened = useRef(0);
  // The number button pressed last, so closing the editor hands focus back.
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeEditor = () => {
    setDraft(null);
    opener.current?.focus();
  };
  const openDraft = (next: Omit<Draft, "id">, button: HTMLButtonElement) => {
    opener.current = button;
    typed.current = next.text;
    opened.current += 1;
    setDraft({ ...next, id: opened.current });
  };
  // A drag's release calls the moveDraft of the render the drag began in, and
  // a key pressed during the drag may have saved, closed or replaced that note
  // since. The note is re-ranged only while it is still the one open: a note
  // opened since has a newer id, and one closed since stays closed.
  const moveDraft = (start: NoteRow, end: NoteRow, anchor: number, button: HTMLButtonElement) => {
    if (draft?.id !== opened.current) return;
    opener.current = button;
    setDraft((open) => open && { ...open, anchor, start, end, text: typed.current });
  };

  const send = useFetcher<SendResult>();
  const csrf = useCsrfToken();
  const push = useToast();
  const sending = send.state !== "idle";
  useFetcherResult(send, (data) => {
    if (!data.ok) return;
    setNotes([]);
    if (data.toast) push(data.toast);
  });
  const sendError =
    send.state === "idle" && send.data && !send.data.ok ? send.data.error : null;

  if (view === undefined) {
    return (
      <p className="empty sm" role="status">
        Reading the pull request from GitHub…
      </p>
    );
  }
  if (!view.ok) {
    // Drawn here, not in a component of its own: this `div` sits in the slot
    // the body's `div` fills, so a read that fails and then succeeds (or the
    // reverse) keeps the same node, as before ruling 696(e).
    return (
      <div className="chg-fail" role="alert">
        <p>{view.reason}</p>
        <button
          type="button"
          className="btn sm"
          disabled={reading}
          aria-busy={reading || undefined}
          onClick={() => void loadRead(url)}
        >
          <GlyphSwap rest="refresh" alt="loader" on={reading} spinAlt />
          {reading ? "Reading…" : "Try again"}
        </button>
      </div>
    );
  }

  const recipient = view.recipient;
  const stale = view.headSha !== revisionSha;
  const prFiles = `${githubHost}/${view.repo}/pull/${view.prNumber}/files`;

  const saveNote = (body: string) => {
    if (!draft) return;
    const { path, start, end, edits } = draft;
    const key = lineKey(path, end.side, end.line);
    setNotes((all) => [
      ...all.filter((n) => n.key !== edits && n.key !== key),
      { key, path, start, end, body },
    ]);
    closeEditor();
  };
  const removeNote = (key: string) => setNotes((all) => all.filter((n) => n.key !== key));
  const submit = () => {
    if (notes.length === 0 || sending) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "review-notes");
    fd.set("headSha", view.headSha);
    fd.set("notes", JSON.stringify(notes.map(postedNote)));
    void send.submit(fd, { method: "post" });
  };

  return (
    <div className="chg-body">
      <p className="chg-meta">
        {plural(view.files.length, "file", "files")} changed on{" "}
        <a href={prFiles} target="_blank" rel="noopener noreferrer">
          PR #{view.prNumber}
          <Icon name="ext" />
        </a>{" "}
        at <span className="mono">{view.headSha.slice(0, 7)}</span>.
        {view.moreFiles
          ? " GitHub lists more changed files than one read carries; the rest are on GitHub."
          : null}
      </p>
      {stale ? (
        <ChangesStaleNotice
          revisionSha={revisionSha}
          readSha={view.headSha}
          noteCount={notes.length}
          reading={reading}
          onReread={() => {
            setNotes([]);
            setDraft(null);
            void loadRead(url);
          }}
        />
      ) : null}
      {recipient === null ? (
        <p className="chg-note-off">
          No deployed agent delivers this task, so a note would reach nobody. Comment on the
          timeline instead.
        </p>
      ) : null}
      <div className="chg-files">
        {view.files.map((file, i) => (
          <FileDiff
            key={file.path}
            file={file}
            url={url}
            defaultOpen={i < 5}
            canNote={recipient !== null && !stale}
            notes={notes.filter((n) => n.path === file.path)}
            draft={draft?.path === file.path ? draft : null}
            onOpen={openDraft}
            onMove={moveDraft}
            onText={(text) => {
              typed.current = text;
            }}
            onCancel={closeEditor}
            onSave={saveNote}
            onRemove={removeNote}
          />
        ))}
      </div>
      {recipient !== null ? (
        <ChangesFoot
          recipientName={recipient.name}
          noteCount={notes.length}
          sending={sending}
          stale={stale}
          sendError={sendError}
          onDiscard={() => {
            setNotes([]);
            setDraft(null);
          }}
          onSend={submit}
        />
      ) : null}
    </div>
  );
}

/** A revision delivered after the read: the notes are on the one read, and
 *  reading the new one discards them. */
function ChangesStaleNotice({
  revisionSha,
  readSha,
  noteCount,
  reading,
  onReread,
}: {
  /** The delivered revision the page knows now. */
  revisionSha: string;
  /** The revision the read holds. */
  readSha: string;
  noteCount: number;
  reading: boolean;
  onReread: () => void;
}) {
  return (
    <div className="chg-stale" role="status">
      <p>
        A new revision, <span className="mono">{revisionSha.slice(0, 7)}</span>, was
        delivered after these changes were read.
        {noteCount > 0
          ? ` Your ${plural(noteCount, "note is", "notes are")} on ${readSha.slice(0, 7)}.`
          : null}
      </p>
      <button
        type="button"
        className="btn sm"
        disabled={reading}
        onClick={onReread}
      >
        {noteCount > 0
          ? `Discard ${plural(noteCount, "note", "notes")} and read the new revision`
          : "Read the new revision"}
      </button>
    </div>
  );
}

/** The notes' count, their Discard and their Send to the deliverer, and why
 *  the last send was refused. */
function ChangesFoot({
  recipientName,
  noteCount,
  sending,
  stale,
  sendError,
  onDiscard,
  onSend,
}: {
  recipientName: string;
  noteCount: number;
  sending: boolean;
  /** A newer revision was delivered: the notes cannot go. */
  stale: boolean;
  sendError: string | null | undefined;
  onDiscard: () => void;
  onSend: () => void;
}) {
  return (
    <div className="chg-foot">
      <p className="chg-count" role="status">
        {noteCount === 0
          ? "No notes yet. Select a line number to add one, or drag across several."
          : `${plural(noteCount, "note", "notes")} for @${recipientName}, sent as one comment.`}
      </p>
      <div className="chg-foot-acts">
        <button
          type="button"
          className="btn sm ghost"
          disabled={noteCount === 0 || sending}
          onClick={onDiscard}
        >
          Discard notes
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={noteCount === 0 || sending || stale}
          aria-busy={sending || undefined}
          onClick={onSend}
        >
          <GlyphSwap rest="send" alt="loader" on={sending} spinAlt />
          {sending ? "Sending…" : `Send to @${recipientName}`}
        </button>
      </div>
      {sendError ? (
        <p className="form-err" role="alert">
          <Icon name="alert" />
          {sendError}
        </p>
      ) : null}
    </div>
  );
}

/** What a file's lines need from the panel: this file's notes, the open
 *  editor when it is in this file, and the doors that change them. */
interface NoteProps {
  canNote: boolean;
  notes: readonly PanelNote[];
  draft: Draft | null;
  onOpen: (draft: Omit<Draft, "id">, button: HTMLButtonElement) => void;
  onMove: (start: NoteRow, end: NoteRow, anchor: number, button: HTMLButtonElement) => void;
  onText: (text: string) => void;
  onCancel: () => void;
  onSave: (body: string) => void;
  onRemove: (key: string) => void;
}

interface FileDiffProps extends NoteProps {
  file: PrDiffFile;
  url: string;
  defaultOpen: boolean;
}

/** A patch the panel's read left out for size, read on its own when the
 *  person asks: the file's patch from either read, why the panel's read left
 *  it out, and that one read's state and failure. */
function useFilePatch(file: PrDiffFile, url: string) {
  const one = useFetcher<TaskChangesView>();
  const loaded =
    one.data?.ok === true ? (one.data.files.find((f) => f.path === file.path) ?? null) : null;
  return {
    patch: file.patch ?? loaded?.patch ?? null,
    omitted: loaded?.patchOmitted ?? file.patchOmitted,
    loading: one.state !== "idle",
    failure: one.data !== undefined && !one.data.ok ? one.data.reason : null,
    load: () => void one.load(`${url}?path=${encodeURIComponent(file.path)}`),
  };
}

/** One changed file: its counts in the summary, its hunks inside. A patch the
 *  panel's read left out for size loads on its own. */
function FileDiff({ file, url, defaultOpen, ...lines }: FileDiffProps) {
  const { patch, omitted, loading, failure, load } = useFilePatch(file, url);
  const rows = useMemo(() => (patch === null ? [] : diffRows(patch)), [patch]);
  const status = STATUS_LABEL.get(file.status) ?? file.status;
  const fileNotes = lines.notes.length;

  return (
    <details className="chg-file" open={defaultOpen}>
      <summary>
        <Icon name="chevron" className="disc-chev" />
        <span className="chg-status" data-status={file.status}>
          {status}
        </span>
        <span className="chg-path mono">
          {file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
        </span>
        <span className="chg-counts mono">
          <span className="diff-add">+{file.additions}</span>{" "}
          <span className="diff-del">−{file.deletions}</span>
        </span>
        {fileNotes > 0 ? (
          <span className="chg-file-notes">{plural(fileNotes, "note", "notes")}</span>
        ) : null}
      </summary>
      {patch !== null ? (
        <DiffLines path={file.path} rows={rows} {...lines} />
      ) : omitted === "budget" ? (
        <PatchOmitted loading={loading} failure={failure} onLoad={load} />
      ) : (
        <p className="chg-omitted">
          GitHub shows no line changes for this file: a binary file, or one too large for
          GitHub to diff.
        </p>
      )}
    </details>
  );
}

/** A file whose changes are larger than the panel's read carries: its own
 *  read, and why that failed. */
function PatchOmitted({
  loading,
  failure,
  onLoad,
}: {
  loading: boolean;
  failure: string | null;
  onLoad: () => void;
}) {
  return (
    <div className="chg-omitted">
      <p>This file&rsquo;s changes are larger than one read carries.</p>
      <button
        type="button"
        className="btn sm"
        disabled={loading}
        aria-busy={loading || undefined}
        onClick={onLoad}
      >
        <GlyphSwap rest="file" alt="loader" on={loading} spinAlt />
        {loading ? "Loading…" : "Load this file"}
      </button>
      {failure ? (
        <p className="form-err" role="alert">
          <Icon name="alert" />
          {failure}
        </p>
      ) : null}
    </div>
  );
}

interface DiffLinesProps extends NoteProps {
  path: string;
  rows: DiffRow[];
}

/** A mouse drag across the numbers, before it is released: the row it started
 *  on, the rows it covers so far, whether it re-ranges the open note (it
 *  started on one of that note's rows) and the button it started on. */
interface Drag {
  anchor: number;
  start: NoteRow;
  end: NoteRow;
  moves: boolean;
  from: HTMLButtonElement;
}

function DiffLines({
  path,
  rows,
  canNote,
  notes,
  draft,
  onOpen,
  onMove,
  onText,
  onCancel,
  onSave,
  onRemove,
}: DiffLinesProps) {
  // The note on each row: a line carries one note.
  const cover = new Map<number, PanelNote>();
  for (const note of notes) {
    for (let row = note.start.row; row <= note.end.row; row += 1) cover.set(row, note);
  }
  const inDraft = (row: number) =>
    draft !== null && row >= draft.start.row && row <= draft.end.row;
  /** The rows a note being drawn may not take: every other note's. The note
   *  the editor rewrites (`edits`) gives its own rows up. */
  const takenBy = (edits: string | null) => (row: number) => {
    const note = cover.get(row);
    return note !== undefined && note.key !== edits;
  };

  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as the last pointer event left it, for the release, which can
  // arrive before React has drawn the last move.
  const live = useRef<Drag | null>(null);
  // The rows, and the lines a new note may not take, as the last render drew
  // them: the release is the render's that began the drag. Written in an
  // effect to keep render pure.
  const latest = useRef({ rows, taken: takenBy(null) });
  useEffect(() => {
    latest.current = { rows, taken: takenBy(null) };
  });
  const moveDrag = (next: Drag | null) => {
    live.current = next;
    setDrag(next);
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const release = (e: globalThis.PointerEvent) => {
      const done = live.current;
      moveDrag(null);
      if (!done) return;
      // Released on the button it started on, one line long: that is the
      // button's own click, which follows.
      const onOrigin = e.target instanceof Node && done.from.contains(e.target);
      if (onOrigin && done.start.row === done.end.row) return;
      const { anchor, start, end, from } = done;
      if (done.moves) {
        onMove(start, end, anchor, from);
        return;
      }
      // A key pressed during the drag may have saved a note on a line it
      // crossed (the open editor holds its lines only once it is saved): the
      // new note stops before that line, as it would had the drag begun after.
      const far = anchor === start.row ? end.row : start.row;
      const range = noteRange(latest.current.rows, anchor, far, latest.current.taken);
      if (range) onOpen({ path, anchor, ...range, edits: null, text: "" }, from);
    };
    const drop = () => moveDrag(null);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") moveDrag(null);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", drop);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", drop);
      window.removeEventListener("keydown", escape);
    };
    // The doors are the panel's; the drag reads its own state from `live`, and
    // the notes from `latest`.
  }, [dragging]);

  /** A primary mouse press on a number starts a drag. A finger or a stylus on
   *  the numbers pans the page instead, and a modified press is a click. */
  const startDrag = (row: number, e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const moves = inDraft(row);
    const range = noteRange(rows, row, row, takenBy(moves ? (draft?.edits ?? null) : null));
    // Another note's line: its click opens that note.
    if (!range) return;
    moveDrag({ anchor: row, ...range, moves, from: e.currentTarget });
  };
  const trackDrag = (e: PointerEvent<HTMLOListElement>) => {
    const over = e.target instanceof Element ? e.target.closest("[data-row]") : null;
    if (!drag || !over) return;
    const range = noteRange(
      rows,
      drag.anchor,
      Number(over.getAttribute("data-row")),
      takenBy(drag.moves ? (draft?.edits ?? null) : null),
    );
    if (range && (range.start.row !== drag.start.row || range.end.row !== drag.end.row)) {
      moveDrag({ ...drag, ...range });
    }
  };
  const press = (row: number, e: MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    if (e.shiftKey && draft) {
      // Shift extends the open note from where it began, as a text selection
      // does from its anchor.
      const range = noteRange(rows, draft.anchor, row, takenBy(draft.edits));
      if (range) onMove(range.start, range.end, draft.anchor, button);
      return;
    }
    // A line of the open note: it is already open.
    if (inDraft(row)) return;
    const note = cover.get(row);
    if (note) {
      const { start, end, key, body } = note;
      onOpen({ path, anchor: start.row, start, end, edits: key, text: body }, button);
      return;
    }
    const range = noteRange(rows, row, row, takenBy(null));
    if (range) onOpen({ path, anchor: row, ...range, edits: null, text: "" }, button);
  };

  const selected = drag ?? draft;
  return (
    <ol className="chg-lines" onPointerOver={dragging ? trackDrag : undefined}>
      {rows.map((row, i) => {
        if (row.kind === "hunk" || row.kind === "meta") {
          return (
            <li key={i} data-row={i} className={row.kind === "hunk" ? "chg-hunk" : "chg-nl"}>
              <code>{row.text}</code>
            </li>
          );
        }
        const quoted = noteLine(row);
        const note = cover.get(i);
        // The note the editor rewrites is drawn as the editor, not as itself.
        const shown = note && note.key !== draft?.edits ? note : undefined;
        return (
          <li key={i} data-row={i}>
            <div
              className="chg-row"
              data-kind={row.kind}
              data-sel={(selected && i >= selected.start.row && i <= selected.end.row) || undefined}
              data-noted={shown ? true : undefined}
            >
              {canNote && quoted ? (
                <button
                  type="button"
                  className="chg-num"
                  aria-label={
                    note
                      ? `Edit the note on ${path} ${spanLabel(note.start, note.end)}`
                      : `Add a note on ${path} ${spanLabel(quoted, quoted)}`
                  }
                  aria-expanded={inDraft(i)}
                  onPointerDown={(e) => startDrag(i, e)}
                  onClick={(e) => press(i, e)}
                >
                  {quoted.line}
                </button>
              ) : (
                <span className="chg-num">{quoted?.line ?? ""}</span>
              )}
              <span className="chg-mark" aria-hidden="true">
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
              </span>
              {row.kind !== "ctx" ? (
                <span className="vh">{row.kind === "add" ? "added: " : "removed: "}</span>
              ) : null}
              <code className="chg-code">{row.text}</code>
            </div>
            {shown && shown.end.row === i ? (
              <div className="chg-note">
                <Icon name="message" />
                <p className="chg-note-text">
                  {shown.start.row !== shown.end.row ? (
                    <span className="chg-where">
                      {capitalized(spanLabel(shown.start, shown.end))}
                    </span>
                  ) : null}
                  {shown.body}
                </p>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={`Remove the note on ${path} ${spanLabel(shown.start, shown.end)}`}
                  onClick={() => onRemove(shown.key)}
                >
                  Remove
                </button>
              </div>
            ) : null}
            {draft && draft.end.row === i ? (
              <NoteEditor
                key={draft.id}
                label={`Note on ${path} ${spanLabel(draft.start, draft.end)}`}
                range={
                  draft.start.row !== draft.end.row
                    ? capitalized(spanLabel(draft.start, draft.end))
                    : null
                }
                initial={draft.text}
                rewrites={draft.edits !== null}
                focusKey={`${draft.start.row}:${draft.end.row}`}
                onText={onText}
                onCancel={onCancel}
                onSave={onSave}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function NoteEditor({
  label,
  range,
  initial,
  rewrites,
  focusKey,
  onText,
  onCancel,
  onSave,
}: {
  label: string;
  /** The lines a note on several covers, shown above the box; null for one. */
  range: string | null;
  initial: string;
  /** True when the note already exists and this editor rewrites it. */
  rewrites: boolean;
  /** Changes when the note's lines do, so the box takes focus again. */
  focusKey: string;
  onText: (text: string) => void;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);
  const body = text.trim();
  return (
    <div className="chg-edit">
      {range ? <p className="chg-where">{range}</p> : null}
      <textarea
        ref={ref}
        className="goal-textarea"
        aria-label={label}
        rows={3}
        maxLength={4000}
        value={text}
        placeholder={
          range ? "What should change on these lines?" : "What should change on this line?"
        }
        onChange={(e) => {
          setText(e.target.value);
          onText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body) {
            e.preventDefault();
            onSave(body);
          }
        }}
      />
      <div className="goal-edit-actions">
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={!body}
          onClick={() => onSave(body)}
        >
          {rewrites ? "Save note" : "Add note"}
        </button>
      </div>
    </div>
  );
}
