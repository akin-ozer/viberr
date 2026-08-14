import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import { prettySize } from "~/features/kb-browser/tree";
import { Icon } from "~/ui/icon";

/**
 * R19-19 — the task's attachments: files an agent's browser saved
 * (screenshots, PDFs), listed newest-first from the canonical
 * `attachments/` directory.
 *
 * Renders NOTHING when the task has no attachments — an empty "Attachments
 * (0)" panel on every task would be noise for a feature most tasks never use.
 * Member-gated upstream: the loader ships `[]` to non-members (same bar as the
 * run console), and the serving route re-checks membership on every fetch.
 */

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export function AttachmentsPanel({
  base,
  attachments,
}: {
  /** `/projects/<slug>/tasks/<KEY>/attachments` — built by the route, which is
   *  the one place that actually knows the URL params. */
  base: string;
  attachments: TaskAttachmentEntry[];
}) {
  if (attachments.length === 0) return null;
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
          <span className="attach-size">{prettySize(a.size)}</span>
        </a>
      ))}
    </section>
  );
}
