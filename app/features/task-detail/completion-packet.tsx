import { useId } from "react";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import type { TookCard } from "~/server/tasks/what-it-took.server";
import { Markdown } from "~/ui/markdown";
import { AttachmentThumb } from "./attachment-image";
import { fileExtension, fileFamily } from "./attachment-kind";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { completionCard } from "./completion-packet-derive";
import {
  CompletionChanges,
  CompletionHead,
  CompletionSources,
  CompletionSummary,
  CompletionTook,
  CompletionVerdicts,
  FilePagePictures,
  HiddenFilesNote,
  HiddenScreenshotsNote,
} from "./completion-packet-regions";

/**
 * Ruling 521: the completion packet, on the decision that offers the task for
 * acceptance (or on its own card when the offer is a recommendation).
 *
 * Owner, 2026-09-27: "up to date reviewer verdicts should be visible on a
 * completion to done packet summarized by Operator, including the UI
 * screenshots, code changes (if small full if not summary of code changes)".
 * Operator's summary and the screenshots it picked come from the packet it
 * wrote; each reviewer's verdict and the change are read live, so a verdict
 * that lands after the summary shows as it stands, and a verdict on earlier
 * work is marked stale rather than counted. A change of at most
 * `COMPLETION_SMALL_CHANGE_LINES` lines opens whole; a larger one shows
 * Operator's summary of it, with the diff one press away.
 *
 * Ruling 668 (owner, 2026-10-06): the same card is the task's result once it
 * is accepted. It carries what Operator said to weigh, what the work assumed
 * and what is missing, and, for a task delivered as files, the files that are
 * the result. A task delivered as a revision shows no files: its pull request
 * holds them, so the result names the pull request, the change's size and the
 * paths it changed.
 *
 * Ruling 693: under the reviewers the card says what the task took: its runs
 * and their agent time, their cost, the times a person was asked and the work
 * was sent back, and the wall time to the first delivery and to acceptance.
 * The server builds the phrases and the sentences saying what they miss
 * (`what-it-took.server.ts`), so this draws them and formats nothing. It
 * stays on the Result card.
 *
 * Ruling 691: a result file that is a page (HTML or markdown) carries Viberr's
 * own pictures of it under its row, at a desktop and a phone width, or the
 * reason there is none. The source still opens from the row; the picture is
 * what a reader of the page gets. Operator names none of them.
 */
export interface CompletionDiff {
  url: string;
  githubHost: string;
  prNumber: number;
  revisionSha: string;
  delivererName: string | null;
}

/** Ruling 668: the card as the result of an accepted task. */
export interface CompletionResult {
  /** The task's pull request, or null for a task that has none. `url` is
   *  null once the project has given its repository up (ruling 667): the
   *  record stays, with nowhere to link. */
  pr: { number: number; url: string | null; merged: boolean } | null;
}

export function CompletionPacket({
  view,
  attachmentsBase,
  sourcesBase = null,
  verdictSatisfiedBy = null,
  diff = null,
  standalone = false,
  result = null,
  took = null,
}: {
  view: CompletionView;
  /** The attachments serving route's base, or null where there is none. */
  attachmentsBase: string | null;
  /** Ruling 690: the route that serves a kept source by its id, or null
   *  where there is none: the card then says how many and lists none. */
  sourcesBase?: string | null;
  /** R19-B: a person's GitHub approval that carries the verdict gate. */
  verdictSatisfiedBy?: string | null;
  /** The diff reader's read, while the review PR is open on the delivered
   *  revision; null leaves the change as its size and summary. */
  diff?: CompletionDiff | null;
  /** Its own card, for an offer made as a recommendation rather than as a
   *  decision; inside the decision card otherwise. */
  standalone?: boolean;
  /** Ruling 668: the task is accepted, so this is its result. */
  result?: CompletionResult | null;
  /** Ruling 693: what the task took and what that figure misses, or null for
   *  a viewer the loader sent none. */
  took?: TookCard | null;
}) {
  const id = useId();
  const lightbox = useAttachmentLightbox();
  const { packet } = view;
  // What the card reads off its props (completion-packet-derive.ts).
  const card = completionCard(view, attachmentsBase, verdictSatisfiedBy, diff, result);
  const Label = standalone ? "h3" : "h4";
  const headingBase = standalone ? 4 : 5;
  const href = (name: string) => `${attachmentsBase}/${encodeURIComponent(name)}`;

  const section = (
    <section className="cmp" aria-labelledby={`${id}-h`} data-comment-anchor="completion">
      <CompletionHead
        id={id}
        standalone={standalone}
        result={result}
        packet={packet}
        subjectSha={view.subjectSha}
      />

      {packet === null ? (
        <p className="cmp-none">
          Operator has not summarized this work yet. The verdicts and the change below are
          current.
        </p>
      ) : (
        <CompletionSummary packet={packet} subject={card.subject} headingBase={headingBase} />
      )}

      {card.files.length > 0 ? (
        <>
          <Label className="cmp-k">Files</Label>
          <ul className="cmp-files">
            {card.files.map((f) => {
              const ext = fileExtension(f.name);
              return (
                <li key={f.name}>
                  <a
                    className="attach-file cmp-file"
                    href={href(f.name)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={lightbox({ name: f.name, url: href(f.name) })}
                  >
                    <span className="cmp-file-ext" data-kind={fileFamily(f.name)} aria-hidden="true">
                      {ext.length > 0 && ext.length <= 5 ? ext : "file"}
                    </span>
                    <span className="cmp-file-main">
                      <span className="cmp-file-name">{f.name}</span>
                      {f.caption ? <span className="cmp-file-what">{f.caption}</span> : null}
                    </span>
                  </a>
                  {f.page ? (
                    <FilePagePictures page={f.page} fileName={f.name} href={href} lightbox={lightbox} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {card.hiddenFiles > 0 ? <HiddenFilesNote count={card.hiddenFiles} /> : null}

      {view.sources ? (
        <CompletionSources
          Label={Label}
          sources={view.sources}
          sourcesBase={sourcesBase}
          lightbox={lightbox}
        />
      ) : null}

      {card.notes.map((note) => (
        <div key={note.key} className="cmp-note">
          <Label className="cmp-k">{note.label}</Label>
          <div className="cmp-summary md-body">
            <Markdown text={note.text} headingBase={headingBase} />
          </div>
        </div>
      ))}

      {card.reviewersHeaded ? <Label className="cmp-k">Reviewers</Label> : null}
      <CompletionVerdicts
        verdicts={card.verdicts}
        verdictSatisfiedBy={verdictSatisfiedBy}
        result={result}
        subject={card.subject}
      />

      {took && took.facts.length + took.notes.length > 0 ? (
        <CompletionTook Label={Label} took={took} />
      ) : null}

      {card.shots.length > 0 ? (
        <>
          <Label className="cmp-k">Screenshots</Label>
          <div className="attach-grid cmp-shots">
            {card.shots.map((s) => (
              <AttachmentThumb
                key={s.name}
                variant="panel"
                href={href(s.name)}
                name={s.name}
                openLabel={`Open screenshot ${s.name}`}
                onOpen={lightbox({ name: s.name, url: href(s.name) })}
              >
                <span className="cmp-caption">{s.caption || s.name}</span>
              </AttachmentThumb>
            ))}
          </div>
        </>
      ) : null}
      {card.hiddenScreenshots > 0 ? <HiddenScreenshotsNote count={card.hiddenScreenshots} /> : null}

      {card.changesShown ? (
        <CompletionChanges
          Label={Label}
          packet={packet}
          change={view.change}
          small={card.small}
          paths={view.paths}
          diff={diff}
          result={result}
          headingBase={headingBase}
        />
      ) : null}
    </section>
  );

  return standalone ? <div className="packet cmp-card">{section}</div> : section;
}
