import { Fragment } from "react";
import type {
  CompletionFilePage,
  CompletionVerdictRow,
  CompletionView,
  ResultSources,
} from "~/server/tasks/completion-packet.server";
import type { TookCard } from "~/server/tasks/what-it-took.server";
import { COMPLETION_SMALL_CHANGE_LINES } from "~/shared/completion-packet";
import { pageCaptureView } from "~/shared/page-capture";
import { Collapsible } from "~/ui/collapsible";
import { Icon, type IconName } from "~/ui/icon";
import { LocalRelative } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { AttachmentThumb } from "./attachment-image";
import type { useAttachmentLightbox } from "./attachment-lightbox";
import { ChangesPanel } from "./changes-slot";
import type { CompletionDiff, CompletionResult } from "./completion-packet";

/**
 * The completion packet's sections (ruling 695(e), the split of
 * `completion-packet.tsx` along the task-page recipe): its head, Operator's
 * summary, the notes on what is not shown, the reviewers' verdicts and the
 * change. Each takes the slot its markup held in `CompletionPacket`'s section
 * and calls no hook: the packet owns its `useId` and the lightbox and hands
 * them in, so the markup, and every id React derives from its place in the
 * tree, are what they were.
 */

type CompletionPacketBody = NonNullable<CompletionView["packet"]>;

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

/** `.cmp-head`: the card's title, when Operator summarized it, and the sha. */
export function CompletionHead({
  id,
  standalone,
  result,
  packet,
  subjectSha,
}: {
  id: string;
  standalone: boolean;
  result: CompletionResult | null;
  packet: CompletionPacketBody | null;
  subjectSha: string | null;
}) {
  const Title = standalone ? "h2" : "h3";
  return (
    <div className="cmp-head">
      <Title id={`${id}-h`} className="cmp-title">
        {result ? "Result" : "Completion"}
      </Title>
      {packet ? (
        <span className="cmp-by">
          Summarized by Operator <LocalRelative iso={packet.at} />
        </span>
      ) : null}
      {subjectSha ? <span className="cmp-sha mono">{subjectSha}</span> : null}
    </div>
  );
}

/** Operator's summary, marked when it was written for earlier work. */
export function CompletionSummary({
  packet,
  subject,
  headingBase,
}: {
  packet: CompletionPacketBody;
  subject: string;
  headingBase: number;
}) {
  return (
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
        <Markdown text={packet.summary} headingBase={headingBase} />
      </div>
    </>
  );
}

/** The result files Operator named that this viewer cannot open. */
export function HiddenFilesNote({ count }: { count: number }) {
  return (
    <p className="cmp-none">
      {plural(count, "result file", "result files")} Operator named{" "}
      {count === 1 ? "is" : "are"} not shown: attachments are for project
      members, and a file removed since is gone.
    </p>
  );
}

/** The screenshots Operator picked that this viewer cannot open. */
/**
 * Ruling 691: Viberr's pictures of a result file that is a page, under its
 * row, and the reason one is missing.
 */
export function FilePagePictures({
  page,
  fileName,
  href,
  lightbox,
}: {
  page: CompletionFilePage;
  fileName: string;
  /** The attachments route's URL for a stored name. */
  href: (name: string) => string;
  /** The packet's `useAttachmentLightbox()`. */
  lightbox: ReturnType<typeof useAttachmentLightbox>;
}) {
  return (
    <>
      {page.shots.length > 0 ? (
        <div className="attach-grid cmp-shots">
          {page.shots.map((s) => {
            const view = pageCaptureView(s.view);
            // The version is for the browser's cache alone (the
            // route ignores it): a rework replaces the picture
            // under the same name.
            const url = `${href(s.name)}?v=${encodeURIComponent(s.at)}`;
            return (
              <AttachmentThumb
                key={s.name}
                variant="panel"
                href={url}
                name={s.name}
                openLabel={`Open the ${view.id} picture of ${fileName}`}
                onOpen={lightbox({ name: s.name, url })}
              >
                <span className="cmp-caption">
                  {view.label}
                  {s.cut ? ", the top of a longer page" : ""}
                </span>
              </AttachmentThumb>
            );
          })}
        </div>
      ) : null}
      {page.note ? (
        <p className="cmp-none">
          {page.shots.length > 0 ? "Not every picture of this page was made" : "No picture of this page"}
          : {page.note}
        </p>
      ) : null}
    </>
  );
}

/**
 * Ruling 690: what the result rests on. A fact it states from outside is
 * checked against these, kept as the run read them; a result that is files
 * says so when it rests on none. Listed where there is a route to open one
 * by, as the files are.
 */
export function CompletionSources({
  Label,
  sources,
  sourcesBase,
  lightbox,
}: {
  Label: "h3" | "h4";
  sources: ResultSources;
  sourcesBase: string | null;
  /** The packet's `useAttachmentLightbox()`. */
  lightbox: ReturnType<typeof useAttachmentLightbox>;
}) {
  const sourceRows = sourcesBase ? sources.shown : [];
  return (
    <>
      <Label className="cmp-k">Sources</Label>
      <p className="cmp-none">
        {sources.count === 0
          ? "This result rests on no kept source."
          : `This result rests on ${plural(sources.count, "kept source", "kept sources")}.`}
      </p>
      {sourceRows.length > 0 ? (
        <ul className="cmp-files">
          {sourceRows.map((source) => {
            const url = `${sourcesBase}/${encodeURIComponent(source.id)}`;
            return (
              <li key={source.id}>
                <a
                  className="attach-file cmp-file"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={lightbox({ name: source.name, url })}
                >
                  <span className="cmp-file-ext">{source.id}</span>
                  <span className="cmp-file-main">
                    <span className="cmp-file-name">{source.title}</span>
                    <span className="cmp-file-what">{source.from}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      {sourceRows.length > 0 && sources.count > sourceRows.length ? (
        <p className="cmp-none">
          and {sources.count - sourceRows.length} more, listed under Sources.
        </p>
      ) : null}
    </>
  );
}

/** Ruling 693: what the task took, as the server phrased it. */
export function CompletionTook({ Label, took }: { Label: "h3" | "h4"; took: TookCard }) {
  return (
    <>
      <Label className="cmp-k">What it took</Label>
      {took.facts.length > 0 ? (
        <p className="cmp-stat">
          {took.facts.map((fact, i) => (
            <Fragment key={fact}>
              {i > 0 ? (
                <span className="cmp-sep" aria-hidden="true">
                  ·
                </span>
              ) : null}
              <span>{fact}</span>
            </Fragment>
          ))}
        </p>
      ) : null}
      {took.notes.map((note) => (
        <p key={note} className="cmp-none">
          {note}
        </p>
      ))}
    </>
  );
}

export function HiddenScreenshotsNote({ count }: { count: number }) {
  return (
    <p className="cmp-none">
      {plural(count, "screenshot", "screenshots")} Operator picked{" "}
      {count === 1 ? "is" : "are"} not shown: attachments are for project
      members, and a file removed since is gone.
    </p>
  );
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

/** Where each reviewer stands, and the GitHub approval that carries the gate. */
export function CompletionVerdicts({
  verdicts,
  verdictSatisfiedBy,
  result,
  subject,
}: {
  verdicts: CompletionVerdictRow[];
  verdictSatisfiedBy: string | null;
  result: CompletionResult | null;
  subject: string;
}) {
  return verdicts.length === 0 && !verdictSatisfiedBy ? (
    result ? null : (
      <p className="cmp-none">No reviewer is engaged on this task, and none has given a verdict.</p>
    )
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
  );
}

/** The change: its pull request and size, Operator's summary of it, the paths
 *  it changed (ruling 668) and, while it is under review, the diff reader. */
export function CompletionChanges({
  Label,
  packet,
  change,
  small,
  paths,
  diff,
  result,
  headingBase,
}: {
  Label: "h3" | "h4";
  packet: CompletionPacketBody | null;
  change: CompletionView["change"];
  small: boolean;
  paths: CompletionView["paths"];
  diff: CompletionDiff | null;
  result: CompletionResult | null;
  headingBase: number;
}) {
  return (
    <>
      <Label className="cmp-k">Changes</Label>
      {change || result?.pr ? <ChangeStat change={change} small={small} result={result} /> : null}
      {packet?.changes ? (
        <div className="cmp-summary md-body">
          <Markdown text={packet.changes} headingBase={headingBase} />
        </div>
      ) : null}
      {result && paths && paths.shown.length > 0 ? (
        <Collapsible className="cmp-paths" contentKey={paths.shown.length} max={120}>
          <ul>
            {paths.shown.map((path) => (
              <li key={path} className="mono">
                {path}
              </li>
            ))}
          </ul>
          {paths.more > 0 || paths.truncated ? (
            <p className="cmp-none">
              {paths.more > 0 ? `And ${plural(paths.more, "more path", "more paths")}. ` : ""}
              The pull request lists every file.
            </p>
          ) : null}
        </Collapsible>
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
  );
}

/** `.cmp-stat`: the accepted pull request, the change's size, and whether the
 *  card shows Operator's summary in place of the whole change. */
function ChangeStat({
  change,
  small,
  result,
}: {
  change: CompletionView["change"];
  small: boolean;
  result: CompletionResult | null;
}) {
  return (
    <p className="cmp-stat">
      {result?.pr ? (
        <>
          {result.pr.url ? (
            <a className="linkish" href={result.pr.url} target="_blank" rel="noreferrer">
              PR #{result.pr.number}
            </a>
          ) : (
            <span>PR #{result.pr.number}</span>
          )}
          <span>{result.pr.merged ? "merged" : "accepted, merge pending"}</span>
          {change ? (
            <span className="cmp-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
        </>
      ) : null}
      {change ? (
        <>
          {plural(change.files, "file", "files")} changed
          <span className="cmp-add">+{change.add}</span>
          <span className="cmp-del">−{change.del}</span>
        </>
      ) : null}
      {change && !small && !result ? (
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
  );
}
