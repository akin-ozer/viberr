import type { TaskSourceRow } from "~/server/tasks/task-sources.server";
import { prettySize } from "~/shared/text/byte-size";
import { Collapsible } from "~/ui/collapsible";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { useAttachmentLightbox } from "./attachment-lightbox";

/**
 * Ruling 690: the sources a task keeps, apart from its files.
 *
 * A source is what an agent read to state a fact in the result: a page as it
 * fetched it, a repository file at a commit, an API answer, a command's
 * output. It is kept under an id and never overwritten, so what a reviewer
 * checks a claim against is what the run saw, not the page as it reads today.
 * The Attachments panel above holds the files of the work; this one holds
 * what the work rests on.
 *
 * Each row is the id, the title the agent gave it, where the agent said it
 * came from (as text, never a link: it is the agent's statement, and the kept
 * copy is the thing to open), and who kept it, when, and its size. A row
 * opens the kept copy in the reader card every task file opens in, so a kept
 * HTML page shows as its source text and never renders on the app's origin
 * (ruling 363). The card offers no Remove: a kept source is not removed.
 *
 * Silent on a task that keeps none, as the attachments panel is on a task
 * that never had a file. Member-gated upstream: the task page is
 * members-only (R15-4), and the serving route checks membership on every read.
 * Drawn with the attachment list's and the result card's classes only.
 */
export function SourcesPanel({
  base,
  sources,
  total,
}: {
  /** `/projects/<slug>/tasks/<KEY>/sources`, built by the route. */
  base: string;
  /** The newest sources, newest first. */
  sources: TaskSourceRow[];
  /** How many the task keeps in all, when that is more than are listed. */
  total: number;
}) {
  const lightbox = useAttachmentLightbox();
  if (sources.length === 0) return null;
  const count = Math.max(total, sources.length);
  return (
    <section className="panel" data-comment-anchor="sources">
      <div className="panel-head">
        <Icon name="file" />
        <h2>Sources</h2>
        <span className="right sub">{count === 1 ? "1 source" : `${count} sources`}</span>
      </div>
      {/* Ruling 510: a long list folds, as the attachments list does. */}
      <Collapsible className="attach-list" contentKey={sources.length}>
        {count > sources.length && (
          <p className="ntf-truncated sub">
            Showing the newest {sources.length} of {count} sources.
          </p>
        )}
        <ul className="cmp-files">
          {sources.map((source) => {
            // By id: the route serves a source under its id, whatever name
            // the agent saved it under.
            const url = `${base}/${encodeURIComponent(source.id)}`;
            return (
              <li key={source.id}>
                <a
                  className="attach-file cmp-file"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={lightbox({ name: source.name, url })}
                >
                  {/* The id is the row's name for it, read out with the rest:
                      it is what a result cites. */}
                  <span className="cmp-file-ext">{source.id}</span>
                  <span className="cmp-file-main">
                    <span className="cmp-file-name">{source.title}</span>
                    <span className="cmp-file-what">{source.from}</span>
                    {/* The card family's byline, which wraps: `.attach-by`
                        in a file row is one line cut with an ellipsis on a
                        phone (ruling 478(b)), and cut the size off here. */}
                    <span className="cmp-by">
                      kept by {source.by} · <LocalDayDotTime iso={source.keptAt} /> ·{" "}
                      {prettySize(source.bytes)}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </Collapsible>
    </section>
  );
}
