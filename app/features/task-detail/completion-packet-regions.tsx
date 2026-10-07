import type { CompletionVerdictRow, CompletionView } from "~/server/tasks/completion-packet.server";
import { COMPLETION_SMALL_CHANGE_LINES } from "~/shared/completion-packet";
import { Collapsible } from "~/ui/collapsible";
import { Icon, type IconName } from "~/ui/icon";
import { LocalRelative } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { ChangesPanel } from "./changes-slot";
import type { CompletionDiff, CompletionResult } from "./completion-packet";

/**
 * The completion packet's sections (ruling 689(e), the split of
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
