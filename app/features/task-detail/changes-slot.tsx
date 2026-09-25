import { useId, useState, type ComponentType } from "react";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import type { ChangesBodyProps } from "./changes-panel";

/**
 * Ruling 484 (pass 40, F40-54): the task page's Changes panel, as the page
 * ships it: a heading, one sentence and a Show changes button. The reader
 * (`changes-panel.tsx`: the diff drawing, the line notes, their send) is its
 * own chunk, fetched when the button is pressed or reached, so a task page
 * that nobody reviews pays nothing for it (ruling 457's task route budget); and
 * the files themselves are read from GitHub only when it opens.
 *
 * The body stays mounted once opened, so hiding the panel keeps unsent notes.
 * A chunk that fails to arrive (offline, a stale deploy) says so and lets the
 * button try again, never the page's error boundary.
 */

let bodyModule: Promise<typeof import("./changes-panel")> | null = null;

/** Starts (once) fetching the body's chunk. A failed fetch is forgotten, so
 *  the next press retries. */
function loadBody(): Promise<typeof import("./changes-panel")> {
  if (!bodyModule) {
    const pending = import("./changes-panel");
    bodyModule = pending;
    pending.then(
      () => undefined,
      () => {
        bodyModule = null;
      },
    );
  }
  return bodyModule;
}

export function ChangesPanel({
  prNumber,
  revisionSha,
  delivererName,
  ...body
}: ChangesBodyProps & {
  prNumber: number;
  /** The deliverer's display name, for the lede; null when none. */
  delivererName: string | null;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [Body, setBody] = useState<ComponentType<ChangesBodyProps> | null>(null);
  const [chunk, setChunk] = useState<"idle" | "loading" | "failed">("idle");
  const fetchBody = () => {
    if (Body) return;
    setChunk("loading");
    loadBody().then(
      (m) => {
        setBody(() => m.ChangesBody);
        setChunk("idle");
      },
      () => setChunk("failed"),
    );
  };
  const loading = open && chunk === "loading";

  return (
    <section className="panel chg-panel" aria-labelledby={`${id}-h`} data-comment-anchor="changes">
      <div className="panel-head">
        <Icon name="pr" />
        <h2 id={`${id}-h`}>Changes</h2>
        <span className="right mono faint">{revisionSha.slice(0, 7)}</span>
      </div>
      <p className="chg-lede">
        The delivered revision on PR #{prNumber}. Read each file and leave a note on any
        line: the notes go to {delivererName ? `@${delivererName}` : "the delivering agent"}{" "}
        as one comment.
      </p>
      <button
        type="button"
        className="btn sm"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        aria-busy={loading || undefined}
        onPointerEnter={() => void loadBody().catch(() => undefined)}
        onFocus={() => void loadBody().catch(() => undefined)}
        onClick={() => {
          if (open && chunk === "failed") return fetchBody();
          const next = !open;
          setOpen(next);
          if (next) fetchBody();
        }}
      >
        <GlyphSwap rest="chevron" alt="loader" on={loading} spinAlt />
        {!open ? "Show changes" : chunk === "failed" ? "Try again" : "Hide changes"}
      </button>
      <div id={`${id}-body`} className="chg-slot" hidden={!open}>
        {Body ? (
          <Body {...body} revisionSha={revisionSha} />
        ) : chunk === "failed" ? (
          <p className="form-err" role="alert">
            <Icon name="alert" />
            The changes reader could not be loaded. Try again.
          </p>
        ) : open ? (
          <p className="empty sm" role="status">
            Loading the changes reader…
          </p>
        ) : null}
      </div>
    </section>
  );
}
