import { Icon } from "~/ui/icon";
import { MarkdownDoc, type DocView } from "~/ui/markdown-doc";
import type { RefusalShake } from "~/ui/use-refusal-shake";
import { lineCount, type DocDraft } from "./store-browser-derive";

/**
 * The open document card's regions (ruling 689(e), the split of
 * `store-browser.tsx`): its body (the loading or failed read, the rendered
 * document, or the raw text), the notes slot a refused or failed save speaks
 * in, and the foot. Each takes the slot its markup held in `DocumentCard` and
 * calls no hook, so the card's markup, and every id React derives from its
 * place in the tree, are what they were. The editor's state stays with
 * `useDocEditor`, the refusal's with `StoreBrowser`.
 */

/** The card's body: the read in flight or failed, the rendered document, or
 *  the raw text (ruling 614). */
export function DocumentBody({
  doc,
  view,
  unread,
  fileName,
  onEdit,
}: {
  doc: DocDraft;
  view: DocView;
  /** An existing document whose read has not answered, or failed. */
  unread: boolean;
  fileName: string;
  onEdit: (next: DocDraft) => void;
}) {
  if (unread) {
    return doc.err ? (
      <div className="doc-blank" role="alert">
        <Icon name="alert" />
        {doc.err}
      </div>
    ) : (
      <div className="doc-blank">
        <Icon name="loader" className="spin" />
        Loading document…
      </div>
    );
  }
  if (view === "preview") {
    return doc.body.trim() ? (
      /* Scrolls on its own, so it takes focus and a name: a keyboard
         reaches all of a long document (WCAG 2.1.1). */
      <div
        className="doc-preview"
        tabIndex={0}
        role="region"
        aria-label={
          "Preview of " +
          (doc.existing || doc.name.trim() ? fileName : "the new document")
        }
      >
        <MarkdownDoc text={doc.body} />
      </div>
    ) : (
      <p className="doc-blank">
        {doc.existing ? "This document is empty." : "Nothing to preview yet."}
      </p>
    );
  }
  return (
    <>
      <label className="vh" htmlFor="fm-doc-body">
        Document contents
      </label>
      <textarea
        id="fm-doc-body"
        className="doc-src"
        // Where `field-sizing` is unsupported the rows size it; the sheet
        // caps both at the preview's height.
        rows={Math.min(24, Math.max(8, lineCount(doc.body) + 1))}
        value={doc.body}
        placeholder={"# Title\n\nWhat your agents must know."}
        onChange={(e) => onEdit({ ...doc, body: e.target.value, err: null })}
      />
    </>
  );
}

/** One box, never two: a refused save speaks in the same slot the server's
 *  own sentence uses (ruling 147). */
export function DocumentNotes({
  nameInvalid,
  err,
  refusal,
}: {
  /** Ruling 147: a refused save of a nameless draft marks the name field. */
  nameInvalid: boolean;
  err: string | null;
  /** The refusal counter the alert is keyed on, and its one shake (451(g)). */
  refusal: { count: number; shake: RefusalShake };
}) {
  return (
    <div className="doc-notes">
      {nameInvalid ? (
        <div
          key={`refused-${refusal.count}`}
          id="fm-doc-err"
          className={"form-err" + (refusal.shake.shake ? " refused" : "")}
          onAnimationEnd={refusal.shake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          Give the document a file name.
        </div>
      ) : (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </div>
  );
}

/** The card's foot: what state the text is in, beside Close (or Cancel) and
 *  Save. */
export function DocumentFoot({
  doc,
  changed,
  unread,
  meta,
  saving,
  onCancel,
  onSave,
}: {
  doc: DocDraft;
  /** Ruling 147(d): an opened document saves only once its text changed. */
  changed: boolean;
  unread: boolean;
  meta: string;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="doc-foot">
      <span className="doc-state">
        {changed ? (
          <>
            <span className="doc-dot" />
            Unsaved changes
          </>
        ) : (
          meta
        )}
      </span>
      <button type="button" className="btn ghost sm" onClick={onCancel}>
        {doc.existing && !changed ? "Close" : "Cancel"}
      </button>
      <button
        type="button"
        className="btn sm primary"
        // Ruling 147: the in-flight states, the truncated hard block (a
        // data-safety refusal whose reason is rendered above) and, for an
        // opened document, nothing changed (147(d)) disable this; a
        // nameless draft is refused instead.
        disabled={doc.truncated || saving || unread || (doc.existing && !changed)}
        aria-busy={saving}
        onClick={onSave}
      >
        {saving ? "Saving…" : "Save document"}
      </button>
    </div>
  );
}
