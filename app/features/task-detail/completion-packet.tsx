import { useId } from "react";
import type { CompletionVerdictRow, CompletionView } from "~/server/tasks/completion-packet.server";
import { COMPLETION_SMALL_CHANGE_LINES } from "~/shared/completion-packet";
import { Collapsible } from "~/ui/collapsible";
import { Icon, type IconName } from "~/ui/icon";
import { LocalRelative } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { AttachmentThumb } from "./attachment-image";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { ChangesPanel } from "./changes-slot";

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
 */
export interface CompletionDiff {
  url: string;
  githubHost: string;
  prNumber: number;
  revisionSha: string;
  delivererName: string | null;
}

const RESULT_ICON = {
  approve: "checkcircle",
  request_changes: "xcircle",
  pending: "clock",
} as const satisfies Record<CompletionVerdictRow["result"], IconName>;

function resultWord(result: "approve" | "request_changes"): string {
  return result === "approve" ? "Approved" : "Requested changes";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function VerdictRow({ row, subject }: { row: CompletionVerdictRow; subject: string }) {
  return (
    <li className="cmp-verdict" data-result={row.result}>
      <Icon name={RESULT_ICON[row.result]} />
      <div className="cmp-verdict-main">
        <p className="cmp-verdict-line">
          <strong>{row.name}</strong>
          <span className="cmp-verdict-word">
            {row.result === "pending" ? `No verdict on ${subject} yet` : resultWord(row.result)}
          </span>
          {row.at ? (
            <span className="cmp-when">
              <LocalRelative iso={row.at} />
            </span>
          ) : null}
          {!row.required ? (
            <Pill quiet sm>
              not required
            </Pill>
          ) : null}
        </p>
        {row.reason ? (
          <Collapsible className="cmp-reason md-body" contentKey={row.reason} max={72}>
            <Markdown text={row.reason} headingBase={6} />
          </Collapsible>
        ) : null}
        {row.earlier ? (
          <p className="cmp-earlier">
            <span className="cmp-stale-tag">Stale</span>
            {resultWord(row.earlier.result)}
            {row.earlier.sha ? (
              <>
                {" on "}
                <span className="mono">{row.earlier.sha}</span>
              </>
            ) : null}{" "}
            <LocalRelative iso={row.earlier.at} />, before the work under review was delivered.
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function CompletionPacket({
  view,
  attachmentsBase,
  verdictSatisfiedBy = null,
  diff = null,
  standalone = false,
}: {
  view: CompletionView;
  /** The attachments serving route's base, or null where there is none. */
  attachmentsBase: string | null;
  /** R19-B: a person's GitHub approval that carries the verdict gate. */
  verdictSatisfiedBy?: string | null;
  /** The diff reader's read, while the review PR is open on the delivered
   *  revision; null leaves the change as its size and summary. */
  diff?: CompletionDiff | null;
  /** Its own card, for an offer made as a recommendation rather than as a
   *  decision; inside the decision card otherwise. */
  standalone?: boolean;
}) {
  const id = useId();
  const lightbox = useAttachmentLightbox();
  const { packet, verdicts, change } = view;
  const subject = view.subjectSha ?? "the delivered files";
  const Title = standalone ? "h2" : "h3";
  const Label = standalone ? "h3" : "h4";
  const href = (name: string) => `${attachmentsBase}/${encodeURIComponent(name)}`;
  const shots = attachmentsBase && packet ? packet.screenshots : [];
  const small = change?.small ?? false;

  const section = (
    <section className="cmp" aria-labelledby={`${id}-h`} data-comment-anchor="completion">
      <div className="cmp-head">
        <Title id={`${id}-h`} className="cmp-title">
          Completion
        </Title>
        {packet ? (
          <span className="cmp-by">
            Summarized by Operator <LocalRelative iso={packet.at} />
          </span>
        ) : null}
        {view.subjectSha ? <span className="cmp-sha mono">{view.subjectSha}</span> : null}
      </div>

      {packet === null ? (
        <p className="cmp-none">
          Operator has not summarized this work yet. The verdicts and the change below are
          current.
        </p>
      ) : (
        <>
          {packet.staleFor !== null ? (
            <p className="cmp-stale" role="note">
              <Icon name="alert" />
              <span>
                Operator wrote this for earlier work
                {packet.staleFor ? (
                  <>
                    {" ("}
                    <span className="mono">{packet.staleFor}</span>
                    {")"}
                  </>
                ) : null}
                , before {subject} was delivered.
              </span>
            </p>
          ) : null}
          <div className="cmp-summary md-body">
            <Markdown text={packet.summary} headingBase={standalone ? 4 : 5} />
          </div>
        </>
      )}

      <Label className="cmp-k">Reviewers</Label>
      {verdicts.length === 0 && !verdictSatisfiedBy ? (
        <p className="cmp-none">No reviewer is engaged on this task, and none has given a verdict.</p>
      ) : (
        <ul className="cmp-verdicts">
          {verdicts.map((row) => (
            <VerdictRow key={row.profileId} row={row} subject={subject} />
          ))}
          {verdictSatisfiedBy ? (
            <li className="cmp-verdict" data-result="approve">
              <Icon name="github" />
              <div className="cmp-verdict-main">
                <p className="cmp-verdict-line">{verdictSatisfiedBy}</p>
              </div>
            </li>
          ) : null}
        </ul>
      )}

      {shots.length > 0 ? (
        <>
          <Label className="cmp-k">Screenshots</Label>
          <div className="attach-grid cmp-shots">
            {shots.map((s) => (
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
      {packet && packet.hiddenScreenshots > 0 ? (
        <p className="cmp-none">
          {plural(packet.hiddenScreenshots, "screenshot", "screenshots")} Operator picked{" "}
          {packet.hiddenScreenshots === 1 ? "is" : "are"} not shown: attachments are for project
          members, and a file removed since is gone.
        </p>
      ) : null}

      {change || diff ? (
        <>
          <Label className="cmp-k">Changes</Label>
          {change ? (
            <p className="cmp-stat">
              {plural(change.files, "file", "files")} changed
              <span className="cmp-add">+{change.add}</span>
              <span className="cmp-del">−{change.del}</span>
              {!small ? (
                <>
                  <span className="cmp-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="cmp-over">
                    Over {COMPLETION_SMALL_CHANGE_LINES} lines, so this is Operator&apos;s summary
                  </span>
                </>
              ) : null}
            </p>
          ) : null}
          {packet?.changes ? (
            <div className="cmp-summary md-body">
              <Markdown text={packet.changes} headingBase={standalone ? 4 : 5} />
            </div>
          ) : null}
          {diff ? (
            <ChangesPanel
              inline
              defaultOpen={small}
              url={diff.url}
              githubHost={diff.githubHost}
              prNumber={diff.prNumber}
              revisionSha={diff.revisionSha}
              delivererName={diff.delivererName}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );

  return standalone ? <div className="packet cmp-card">{section}</div> : section;
}
