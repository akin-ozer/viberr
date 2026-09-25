import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { PrDiffFile } from "~/server/github/pr-diff.server";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import { diffRows, type DiffRow } from "~/shared/diff-rows";
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

/** One pending note, bound to the revision it was written on. */
interface PanelNote {
  key: string;
  path: string;
  line: number;
  side: "new" | "old";
  body: string;
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

export function ChangesBody({ url, revisionSha, githubHost }: ChangesBodyProps) {
  const read = useFetcher<TaskChangesView>();
  const loadRead = read.load;
  useEffect(() => {
    void loadRead(url);
  }, [loadRead, url]);
  const view = read.data;
  const reading = read.state !== "idle";

  const [notes, setNotes] = useState<PanelNote[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  // The number button that opened the editor, so closing it hands focus back.
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeEditor = () => {
    setEditing(null);
    opener.current?.focus();
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
  const byLine = new Map(notes.map((n) => [n.key, n]));
  const prFiles = `${githubHost}/${view.repo}/pull/${view.prNumber}/files`;

  const saveNote = (note: PanelNote) => {
    setNotes((all) => [...all.filter((n) => n.key !== note.key), note]);
    closeEditor();
  };
  const removeNote = (key: string) => setNotes((all) => all.filter((n) => n.key !== key));
  const submit = () => {
    if (notes.length === 0 || sending) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "review-notes");
    fd.set("headSha", view.headSha);
    fd.set(
      "notes",
      JSON.stringify(notes.map(({ path, line, side, body }) => ({ path, line, side, body }))),
    );
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
        <div className="chg-stale" role="status">
          <p>
            A new revision, <span className="mono">{revisionSha.slice(0, 7)}</span>, was
            delivered after these changes were read.
            {notes.length > 0
              ? ` Your ${plural(notes.length, "note is", "notes are")} on ${view.headSha.slice(0, 7)}.`
              : null}
          </p>
          <button
            type="button"
            className="btn sm"
            disabled={reading}
            onClick={() => {
              setNotes([]);
              setEditing(null);
              void loadRead(url);
            }}
          >
            {notes.length > 0
              ? `Discard ${plural(notes.length, "note", "notes")} and read the new revision`
              : "Read the new revision"}
          </button>
        </div>
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
            notes={byLine}
            editing={editing}
            onEdit={(key, button) => {
              opener.current = button;
              setEditing(key);
            }}
            onCancel={closeEditor}
            onSave={saveNote}
            onRemove={removeNote}
          />
        ))}
      </div>
      {recipient !== null ? (
        <div className="chg-foot">
          <p className="chg-count" role="status">
            {notes.length === 0
              ? "No notes yet. Select a line number to add one."
              : `${plural(notes.length, "note", "notes")} for @${recipient.name}, sent as one comment.`}
          </p>
          <div className="chg-foot-acts">
            <button
              type="button"
              className="btn sm ghost"
              disabled={notes.length === 0 || sending}
              onClick={() => {
                setNotes([]);
                setEditing(null);
              }}
            >
              Discard notes
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={notes.length === 0 || sending || stale}
              aria-busy={sending || undefined}
              onClick={submit}
            >
              <GlyphSwap rest="send" alt="loader" on={sending} spinAlt />
              {sending ? "Sending…" : `Send to @${recipient.name}`}
            </button>
          </div>
          {sendError ? (
            <p className="form-err" role="alert">
              <Icon name="alert" />
              {sendError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface FileDiffProps {
  file: PrDiffFile;
  url: string;
  defaultOpen: boolean;
  canNote: boolean;
  notes: ReadonlyMap<string, PanelNote>;
  editing: string | null;
  onEdit: (key: string, button: HTMLButtonElement) => void;
  onCancel: () => void;
  onSave: (note: PanelNote) => void;
  onRemove: (key: string) => void;
}

/** One changed file: its counts in the summary, its hunks inside. A patch the
 *  panel's read left out for size loads on its own. */
function FileDiff({
  file,
  url,
  defaultOpen,
  canNote,
  notes,
  editing,
  onEdit,
  onCancel,
  onSave,
  onRemove,
}: FileDiffProps) {
  const one = useFetcher<TaskChangesView>();
  const loaded =
    one.data?.ok === true ? (one.data.files.find((f) => f.path === file.path) ?? null) : null;
  const patch = file.patch ?? loaded?.patch ?? null;
  const oneFailed = one.data !== undefined && !one.data.ok ? one.data.reason : null;
  const rows = useMemo(() => (patch === null ? [] : diffRows(patch)), [patch]);
  const status = STATUS_LABEL.get(file.status) ?? file.status;
  const fileNotes = [...notes.values()].filter((n) => n.path === file.path).length;

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
        <DiffLines
          path={file.path}
          rows={rows}
          canNote={canNote}
          notes={notes}
          editing={editing}
          onEdit={onEdit}
          onCancel={onCancel}
          onSave={onSave}
          onRemove={onRemove}
        />
      ) : (loaded?.patchOmitted ?? file.patchOmitted) === "budget" ? (
        <div className="chg-omitted">
          <p>This file&rsquo;s changes are larger than one read carries.</p>
          <button
            type="button"
            className="btn sm"
            disabled={one.state !== "idle"}
            aria-busy={one.state !== "idle" || undefined}
            onClick={() => void one.load(`${url}?path=${encodeURIComponent(file.path)}`)}
          >
            <GlyphSwap rest="file" alt="loader" on={one.state !== "idle"} spinAlt />
            {one.state !== "idle" ? "Loading…" : "Load this file"}
          </button>
          {oneFailed ? (
            <p className="form-err" role="alert">
              <Icon name="alert" />
              {oneFailed}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="chg-omitted">
          GitHub shows no line changes for this file: a binary file, or one too large for
          GitHub to diff.
        </p>
      )}
    </details>
  );
}

interface DiffLinesProps {
  path: string;
  rows: DiffRow[];
  canNote: boolean;
  notes: ReadonlyMap<string, PanelNote>;
  editing: string | null;
  onEdit: (key: string, button: HTMLButtonElement) => void;
  onCancel: () => void;
  onSave: (note: PanelNote) => void;
  onRemove: (key: string) => void;
}

function DiffLines({
  path,
  rows,
  canNote,
  notes,
  editing,
  onEdit,
  onCancel,
  onSave,
  onRemove,
}: DiffLinesProps) {
  return (
    <ol className="chg-lines">
      {rows.map((row, i) => {
        if (row.kind === "hunk" || row.kind === "meta") {
          return (
            <li key={i} className={row.kind === "hunk" ? "chg-hunk" : "chg-nl"}>
              <code>{row.text}</code>
            </li>
          );
        }
        const side = row.kind === "del" ? "old" : "new";
        const line = row.kind === "del" ? row.oldLine : row.newLine;
        const key = line === null ? null : lineKey(path, side, line);
        const note = key === null ? undefined : notes.get(key);
        const where = `${path} line ${line ?? ""}${side === "old" ? ", removed" : ""}`;
        return (
          <li key={i}>
            <div className="chg-row" data-kind={row.kind}>
              {canNote && key !== null && line !== null ? (
                <button
                  type="button"
                  className="chg-num"
                  aria-label={note ? `Edit the note on ${where}` : `Add a note on ${where}`}
                  aria-expanded={editing === key}
                  onClick={(e) => onEdit(key, e.currentTarget)}
                >
                  {line}
                </button>
              ) : (
                <span className="chg-num">{line ?? ""}</span>
              )}
              <span className="chg-mark" aria-hidden="true">
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
              </span>
              {row.kind !== "ctx" ? (
                <span className="vh">{row.kind === "add" ? "added: " : "removed: "}</span>
              ) : null}
              <code className="chg-code">{row.text}</code>
            </div>
            {note && editing !== key ? (
              <div className="chg-note">
                <Icon name="message" />
                <p className="chg-note-text">{note.body}</p>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={`Remove the note on ${where}`}
                  onClick={() => onRemove(note.key)}
                >
                  Remove
                </button>
              </div>
            ) : null}
            {key !== null && line !== null && editing === key ? (
              <NoteEditor
                label={`Note on ${where}`}
                initial={note?.body ?? ""}
                onCancel={onCancel}
                onSave={(body) => onSave({ key, path, line, side, body })}
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
  initial,
  onCancel,
  onSave,
}: {
  label: string;
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const body = text.trim();
  return (
    <div className="chg-edit">
      <textarea
        ref={ref}
        className="goal-textarea"
        aria-label={label}
        rows={3}
        maxLength={4000}
        value={text}
        placeholder="What should change on this line?"
        onChange={(e) => setText(e.target.value)}
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
          {initial ? "Save note" : "Add note"}
        </button>
      </div>
    </div>
  );
}
