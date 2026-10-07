import { countLabel } from "~/shared/text/plural";
import { prettySize } from "~/shared/text/byte-size";
import { isMarkdownName } from "~/ui/code-language";
import type { DocView } from "~/ui/markdown-doc";

/**
 * What the store browser's document card reads off the open draft (ruling
 * 695(e), the split of `store-browser.tsx`): whether the read has answered,
 * whether the text changed, the name it saves under, whether it renders as
 * markdown and in which view, and the line that sums the saved text up. Pure
 * functions of the draft, no React; `DocumentCard` calls `documentCardState`
 * once per render and hands its regions what they read.
 */

/** The in-place document editor's state (P14-KM-08 / UI-59 / UI-60 / UI-61). */
export interface DocDraft {
  /** Store-relative folder holding the document. */
  dir: string[];
  /** File name — fixed once the document exists on disk. */
  name: string;
  body: string;
  existing: boolean;
  /** Ruling 614: the body as the read returned it, so the card knows whether
   *  anything changed. Null until the read answers (and after a read that
   *  failed); always null for a new document. */
  saved: string | null;
  /** The on-disk file exceeded the read cap, so this body is a partial copy. */
  truncated: boolean;
  /** Ruling 663: the version the read returned. The save sends it back, and
   *  the server refuses the save once the file is no longer that version, so
   *  a correction an agent merged meanwhile is not wiped. Null for a new
   *  document and until the read answers. */
  version: string | null;
  /** Ruling 614: rendered or raw. An existing markdown file opens rendered; a
   *  new document opens raw, since there is nothing to render yet. */
  view: DocView;
  err: string | null;
}

/** The name a new document is saved under: `writeStoreDoc` gives a name with
 *  no extension `.md`. */
export function draftFileName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

/** Lines as the attachment reader's gutter counts them (ruling 363): a
 *  trailing newline ends the last line rather than opening an empty one. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** What the document card shows for a draft, beyond the draft itself. */
export interface DocumentCardState {
  /** An existing document whose read has not answered, or failed. */
  unread: boolean;
  /** Ruling 147(d): an opened document saves only once its text changed. */
  changed: boolean;
  /** The name the document has, or saves under. */
  fileName: string;
  /** Whether the card offers the Preview / Raw switch. */
  markdown: boolean;
  /** The view in force: a document that is not markdown is always raw. */
  view: DocView;
  /** The foot's summary of the saved text: lines and size, "" until read. */
  meta: string;
}

/** `sizeBytes` is the file's size as the tree lists it; null for a new
 *  document. */
export function documentCardState(doc: DocDraft, sizeBytes: number | null): DocumentCardState {
  const unread = doc.existing && doc.saved === null;
  const changed = doc.existing && doc.saved !== null && doc.body !== doc.saved;
  const fileName = doc.existing ? doc.name : draftFileName(doc.name);
  // A nameless draft is markdown until it is named otherwise: the server
  // saves a bare name as `.md`.
  const markdown = doc.existing || doc.name.trim() ? isMarkdownName(fileName) : true;
  const view: DocView = markdown ? doc.view : "raw";
  const meta =
    doc.saved === null
      ? ""
      : [
          doc.truncated ? null : countLabel(lineCount(doc.saved), "line"),
          sizeBytes === null ? null : prettySize(sizeBytes),
        ]
          .filter(Boolean)
          .join(" · ");
  return { unread, changed, fileName, markdown, view, meta };
}
