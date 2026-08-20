import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import { prettySize } from "~/features/kb-browser/tree";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";

/**
 * R19-19 — the task's attachments: files an agent's browser saved
 * (screenshots, PDFs), listed newest-first from the canonical
 * `attachments/` directory.
 *
 * D8: when empty it used to render NOTHING at all, so a user promised browser
 * evidence had no surface telling them none arrived. Now it renders a real
 * empty state (what's absent, why it matters, what happens next) — but ONLY
 * when the task has a browser-capable agent (`browserExpected`); on the tasks
 * that never touch the feature it still stays silent, which is what kept an
 * empty "Attachments (0)" from being noise on every task.
 * Member-gated upstream: the loader ships `[]` to non-members (same bar as the
 * run console), and the serving route re-checks membership on every fetch.
 */

/** Image-typed attachment names — these render as previews (the panel's
 * thumbnail grid, and the timeline's producing-comment strip). */
export const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export function AttachmentsPanel({
  base,
  attachments,
  producers = {},
  browserExpected = false,
}: {
  /** `/projects/<slug>/tasks/<KEY>/attachments` — built by the route, which is
   *  the one place that actually knows the URL params. */
  base: string;
  attachments: TaskAttachmentEntry[];
  /** Attachment name → who saved it (from the timeline event that claims the
   *  name — the same event renders the file as a chip in place). A name with
   *  no claiming event gets no producer line rather than a guess. */
  producers?: Record<string, { actor: string; occurredAt: string }>;
  /** D8: a deployed agent holds `use-browser`, so browser evidence is promised
   *  for this task even before the first file lands. */
  browserExpected?: boolean;
}) {
  if (attachments.length === 0) {
    if (!browserExpected) return null;
    return (
      <section className="panel" data-comment-anchor="attachments">
        <div className="panel-head">
          <Icon name="file" />
          <h2>Attachments</h2>
        </div>
        <p className="empty">
          No attachments yet. A browser-capable agent on this task saves the
          screenshots and files it captures here, and none have landed. They appear
          the next time such an agent runs and produces evidence.
        </p>
      </section>
    );
  }
  const href = (name: string) => `${base}/${encodeURIComponent(name)}`;
  const images = attachments.filter((a) => IMAGE_RE.test(a.name));
  const files = attachments.filter((a) => !IMAGE_RE.test(a.name));
  return (
    <section className="panel" data-comment-anchor="attachments">
      <div className="panel-head">
        <Icon name="file" />
        <h2>Attachments</h2>
        <span className="right sub">
          {attachments.length === 1 ? "1 file" : `${attachments.length} files`}
        </span>
      </div>
      {images.length > 0 && (
        <div className="attach-grid">
          {images.map((a) => (
            <a
              key={a.name}
              className="attach-thumb"
              href={href(a.name)}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open attachment ${a.name} (${prettySize(a.size)})`}
            >
              {/* The route serves whitelisted image types inline, sandboxed. */}
              <img src={href(a.name)} alt={a.name} loading="lazy" />
              <span className="attach-meta">
                <span className="attach-name">{a.name}</span>
                <span className="attach-size">{prettySize(a.size)}</span>
              </span>
              {producers[a.name] && (
                // The producing message renders the same file as a chip, so the
                // time here is what ties the two together on a long timeline.
                <span className="attach-by">
                  added by {producers[a.name].actor} ·{" "}
                  <LocalDayDotTime iso={producers[a.name].occurredAt} />
                </span>
              )}
            </a>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a
          key={a.name}
          className="attach-file"
          href={href(a.name)}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="file" />
          <span className="attach-name">{a.name}</span>
          {producers[a.name] && (
            <span className="attach-by">
              by {producers[a.name].actor} ·{" "}
              <LocalDayDotTime iso={producers[a.name].occurredAt} />
            </span>
          )}
          <span className="attach-size">{prettySize(a.size)}</span>
        </a>
      ))}
    </section>
  );
}
