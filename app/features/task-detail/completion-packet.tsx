import { useId } from "react";
import type { CompletionVerdictRow, CompletionView } from "~/server/tasks/completion-packet.server";
import { COMPLETION_NOTES, COMPLETION_SMALL_CHANGE_LINES } from "~/shared/completion-packet";
import { Collapsible } from "~/ui/collapsible";
import { Icon, type IconName } from "~/ui/icon";
import { LocalRelative } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { AttachmentThumb } from "./attachment-image";
import { fileExtension, fileFamily } from "./attachment-kind";
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
 *
 * Ruling 668 (owner, 2026-10-06): the same card is the task's result once it
 * is accepted. It carries what Operator said to weigh, what the work assumed
 * and what is missing, and, for a task delivered as files, the files that are
 * the result. A task delivered as a revision shows no files: its pull request
 * holds them, so the result names the pull request, the change's size and the
 * paths it changed.
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
  sourcesBase = null,
  verdictSatisfiedBy = null,
  diff = null,
  standalone = false,
  result = null,
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
}) {
  const id = useId();
  const lightbox = useAttachmentLightbox();
  const { packet, change, paths } = view;
  const subject = view.subjectSha ?? "the delivered files";
  const Title = standalone ? "h2" : "h3";
  const Label = standalone ? "h3" : "h4";
  const href = (name: string) => `${attachmentsBase}/${encodeURIComponent(name)}`;
  const shots = attachmentsBase && packet ? packet.screenshots : [];
  const files = attachmentsBase && packet ? packet.files : [];
  const sources = view.sources ?? null;
  // Listed where there is a route to open one by, as the files are.
  const sourceRows = sourcesBase && sources ? sources.shown : [];
  const small = change?.small ?? false;
  // On an accepted task nobody is still owed a verdict.
  const verdicts = result ? view.verdicts.filter((v) => v.result !== "pending") : view.verdicts;
  const notes = packet
    ? COMPLETION_NOTES.flatMap(({ key, label }) => {
        const text = packet[key];
        return text ? [{ key, label, text }] : [];
      })
    : [];

  const section = (
    <section className="cmp" aria-labelledby={`${id}-h`} data-comment-anchor="completion">
      <div className="cmp-head">
        <Title id={`${id}-h`} className="cmp-title">
          {result ? "Result" : "Completion"}
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

      {files.length > 0 ? (
        <>
          <Label className="cmp-k">Files</Label>
          <ul className="cmp-files">
            {files.map((f) => {
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
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {packet && packet.hiddenFiles > 0 ? (
        <p className="cmp-none">
          {plural(packet.hiddenFiles, "result file", "result files")} Operator named{" "}
          {packet.hiddenFiles === 1 ? "is" : "are"} not shown: attachments are for project
          members, and a file removed since is gone.
        </p>
      ) : null}

      {/* Ruling 690: what the result rests on. A fact it states from outside
          is checked against these, kept as the run read them; a result that
          is files says so when it rests on none. */}
      {sources ? (
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
      ) : null}

      {notes.map((note) => (
        <div key={note.key} className="cmp-note">
          <Label className="cmp-k">{note.label}</Label>
          <div className="cmp-summary md-body">
            <Markdown text={note.text} headingBase={standalone ? 4 : 5} />
          </div>
        </div>
      ))}

      {result && verdicts.length === 0 && !verdictSatisfiedBy ? null : (
        <Label className="cmp-k">Reviewers</Label>
      )}
      {verdicts.length === 0 && !verdictSatisfiedBy ? (
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

      {change || diff || (result && (result.pr || paths)) ? (
        <>
          <Label className="cmp-k">Changes</Label>
          {change || result?.pr ? (
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
          ) : null}
          {packet?.changes ? (
            <div className="cmp-summary md-body">
              <Markdown text={packet.changes} headingBase={standalone ? 4 : 5} />
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
      ) : null}
    </section>
  );

  return standalone ? <div className="packet cmp-card">{section}</div> : section;
}
