import { useFetcher } from "react-router";
import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { prettySize } from "~/shared/text/byte-size";
import { Collapsible } from "~/ui/collapsible";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { AttachmentThumb } from "./attachment-image";
import { IMAGE_RE } from "~/ui/picked-files";
import { useAttachmentLightbox } from "./attachment-lightbox";

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
 * Member-gated upstream: the task page is members-only (R15-4), and the
 * serving route re-checks membership on every fetch.
 *
 * F39-6 (pass 39): a PERSON can put a file here now. The panel therefore also
 * renders when the viewer may attach one — previously it stayed silent on every
 * task without a browser-capable agent, which was right when agents were the
 * only writers and is wrong now: the one surface that would tell a human they
 * may attach a fixture was the one that did not exist.
 */

export function AttachmentsPanel({
  base,
  attachments,
  total,
  producers = {},
  browserExpected = false,
  canAttach = false,
}: {
  /** `/projects/<slug>/tasks/<KEY>/attachments` — built by the route, which is
   *  the one place that actually knows the URL params. */
  base: string;
  attachments: TaskAttachmentEntry[];
  /** C8: the store's TRUE file count, from `countTaskAttachments`
   *  (task-attachments.server.ts) — `listTaskAttachments` caps its return at
   *  100, so on a heavily-evidenced task `attachments.length` alone can't
   *  tell the panel it's showing a partial list. Optional and defaults to
   *  `attachments.length` (no truncation note) so a caller that hasn't wired
   *  the true count through yet renders exactly as before. */
  total?: number;
  /** Attachment name → who saved it (from the timeline event that claims the
   *  name — the same event renders the file as a chip in place). A name with
   *  no claiming event gets no producer line rather than a guess. */
  producers?: Record<string, { actor: string; occurredAt: string }>;
  /** D8: a deployed agent holds `use-browser`, so browser evidence is promised
   *  for this task even before the first file lands. */
  browserExpected?: boolean;
  /** F39-6: the viewer holds `attach-file` on this project and the task is not
   *  archived, so the drop control renders. */
  canAttach?: boolean;
}) {
  // Image previews open the in-app lightbox on a plain click (owner request
  // 2026-08-21); the anchors stay real links for modified clicks. Called
  // before the empty-state return — hooks run unconditionally.
  const lightbox = useAttachmentLightbox();
  if (attachments.length === 0) {
    if (!browserExpected && !canAttach) return null;
    return (
      <section className="panel" data-comment-anchor="attachments">
        <div className="panel-head">
          <Icon name="file" />
          <h2>Attachments</h2>
        </div>
        {/* Ruling 625: left-aligned with the panel's title and as tall as its
            sentence, not a centred empty box over a left-aligned button. */}
        <p className="attach-empty">
          {browserExpected
            ? "No attachments yet. A browser-capable agent on this task saves the screenshots and files it captures here, and none have landed. They appear the next time such an agent runs and produces evidence."
            : "No attachments yet. Anything you attach here is read by the agents that run on this task: a fixture, a transcript, a spec they would otherwise have to guess at."}
        </p>
        {canAttach && <AttachFile />}
      </section>
    );
  }
  const href = (name: string) => `${base}/${encodeURIComponent(name)}`;
  const images = attachments.filter((a) => IMAGE_RE.test(a.name));
  const files = attachments.filter((a) => !IMAGE_RE.test(a.name));
  // C8: only render the caveat when the store actually holds more than the
  // list shows — an unset `total` (caller hasn't wired it through) or a
  // `total` equal to the list length is not a truncation.
  const moreNotShown = total !== undefined && total > attachments.length;
  return (
    <section className="panel" data-comment-anchor="attachments">
      <div className="panel-head">
        <Icon name="file" />
        <h2>Attachments</h2>
        <span className="right sub">
          {attachments.length === 1 ? "1 file" : `${attachments.length} files`}
        </span>
      </div>
      {canAttach && <AttachFile />}
      {/* Ruling 510: a long list folds the way a long comment does, clamped
          behind Show more / Show less, so fifteen files don't push the
          timeline a screen down. The heading, its count and the attach control
          stay above the fold. */}
      <Collapsible className="attach-list" contentKey={attachments.length}>
        {moreNotShown && (
          <p className="ntf-truncated sub">
            Showing the most recent {attachments.length} of {total} files.
            Older ones aren't listed here.
          </p>
        )}
        {images.length > 0 && (
          <div className="attach-grid">
            {images.map((a) => (
              // Keyed by name+size so a re-saved file (new size) remounts and
              // clears a stale "preview unavailable" (broken-tile recovery). The
              // route serves whitelisted image types inline, sandboxed; a
              // rotated/oversized/unsupported file degrades to a placeholder.
              <AttachmentThumb
                key={`${a.name}:${a.size}`}
                variant="panel"
                href={href(a.name)}
                name={a.name}
                openLabel={`Open attachment ${a.name} (${prettySize(a.size)})`}
                onOpen={lightbox({ name: a.name, url: href(a.name) })}
              >
                <span className="attach-meta">
                  <span className="attach-name" title={a.name}>{a.name}</span>
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
              </AttachmentThumb>
            ))}
          </div>
        )}
        {files.map((a) => (
          // Ruling 105 (+ addendum): a plain click opens the in-app card for
          // EVERY kind — text files render read-only, anything else shows a
          // no-preview note; both carry the Download button.
          <a
            key={a.name}
            className="attach-file"
            href={href(a.name)}
            target="_blank"
            rel="noreferrer"
            onClick={lightbox({ name: a.name, url: href(a.name) })}
          >
            <Icon name="file" />
            {/* Ruling 478(b) (F40-32): the name takes its own line on a phone
                (app.css), and the whole name rides on a hover where a long one
                is still cut. */}
            <span className="attach-name" title={a.name}>{a.name}</span>
            {producers[a.name] && (
              <span className="attach-by">
                by {producers[a.name].actor} ·{" "}
                <LocalDayDotTime iso={producers[a.name].occurredAt} />
              </span>
            )}
            <span className="attach-size">{prettySize(a.size)}</span>
          </a>
        ))}
      </Collapsible>
    </section>
  );
}

/**
 * F39-6: one file, one submit. A label wrapping a hidden input rather than a
 * button that clicks one, so the control is reachable by keyboard and by a
 * screen reader without any script; the fetcher posts the same `attach-file`
 * intent a `curl` would.
 *
 * Ruling 574: the picker offers any kind of file; the writer refuses only a
 * name it cannot store and a file over the size cap.
 */
function AttachFile() {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const csrf = useCsrfToken();
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <div className="attach-add">
      {/* Ruling 368: the upload in flight is `aria-busy` (the sheet's .7 busy
          step) with the loader spinning, the same shape as every busy button.
          Ruling 459: the file mark and the loader share one cell (GlyphSwap)
          and trade in place. */}
      <label className={`btn ghost sm${busy ? " busy" : ""}`} aria-busy={busy || undefined}>
        <GlyphSwap rest="file" alt="loader" on={busy} spinAlt />
        {busy ? "Attaching…" : "Attach a file"}
        <input
          type="file"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            const body = new FormData();
            body.set("intent", "attach-file");
            body.set("_csrf", csrf);
            body.set("file", file);
            fetcher.submit(body, {
              method: "post",
              encType: "multipart/form-data",
            });
            // Let the same file be chosen again after a refused upload.
            event.currentTarget.value = "";
          }}
        />
      </label>
      <span className="fine">
        Agents on this task read what you attach here.
      </span>
      {error && <p className="form-err">{error}</p>}
    </div>
  );
}
