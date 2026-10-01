import { Icon } from "./icon";
import { Markdown } from "./markdown";

/**
 * Ruling 614: a markdown file opens rendered, and its raw text is one switch
 * away at the top of the document.
 *
 * The two places a person opens a `.md` file to read it share these pieces:
 * the store browser's document card (a knowledge base's or a skill's files)
 * and the task attachment reader. Both used to show the file as source — the
 * browser as a bare textarea, the reader as highlighted code — so a document
 * written to be read arrived as its markup. Which files render is
 * `isMarkdownName` (`code-language.ts`).
 */

/** What a document shows: its rendered form, or its raw text. */
export type DocView = "preview" | "raw";

/**
 * The Preview / Raw switch at the top of a document. The app's segmented
 * control (`.seg`) with the pressed state the board's layout switch carries
 * (UI-58): a view choice, not a form value.
 */
export function DocViewToggle({
  view,
  onChange,
}: {
  view: DocView;
  onChange: (next: DocView) => void;
}) {
  return (
    <div className="seg doc-view" role="group" aria-label="Document view">
      <button
        type="button"
        className={view === "preview" ? "on" : ""}
        aria-pressed={view === "preview"}
        onClick={() => onChange("preview")}
      >
        <Icon name="eye" />
        Preview
      </button>
      <button
        type="button"
        className={view === "raw" ? "on" : ""}
        aria-pressed={view === "raw"}
        onClick={() => onChange("raw")}
      >
        <Icon name="code" />
        Raw
      </button>
    </div>
  );
}

/**
 * A markdown document set for reading: the comment renderer (GFM, raw HTML
 * escaped, so a document's bytes never execute) in the document type
 * (`.md-doc`). Both surfaces sit under a level-2 heading (the browser's dialog
 * title, the task page's sections), so the document's top heading renders at
 * level 3 and its deeper ones follow (ruling 478(f)); the type is set by that
 * rendered level.
 */
export function MarkdownDoc({
  text,
  attachmentNames,
  attachmentsBase,
}: {
  text: string;
  /** A task attachment's siblings and their serving route, so a report's
   *  `![](shot.png)` shows the task's own picture: the comment renderer's
   *  repair, which links only names the task has. Absent, links render as
   *  written. */
  attachmentNames?: ReadonlySet<string>;
  attachmentsBase?: string;
}) {
  return (
    <div className="md-body md-doc">
      <Markdown
        text={text}
        headingBase={3}
        attachmentNames={attachmentNames}
        attachmentsBase={attachmentsBase}
      />
    </div>
  );
}
