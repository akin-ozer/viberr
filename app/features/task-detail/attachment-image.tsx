import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Icon } from "~/ui/icon";

/**
 * An attachment `<img>` that degrades to a labeled placeholder when the serving
 * route cannot return the picture: the file was rotated or removed on disk
 * (404), is over the route's 50 MB inline cap (413), or is a type the route
 * refuses to render inline. Before this, any of those painted the browser's
 * broken-image glyph inside the tile.
 *
 * This is NOT a membership guard. Every surface that renders these tiles
 * (task-detail-page) and the serving route both authorize through
 * `assertProjectAction("any-member")`, so a viewer who sees a tile already
 * passes the tile's request.
 * The failure this covers (missing/oversized/unsupported file) hits members
 * too, which is exactly why it belongs on the image itself.
 *
 * `onFailedChange` lets the enclosing tile (`AttachmentThumb`) reflect the
 * failure in the anchor's accessible name — the anchor's `aria-label` otherwise
 * replaces this placeholder's own label, so a screen reader would announce a
 * broken tile exactly like a working one.
 */
function AttachmentImage({
  src,
  alt,
  onFailedChange,
}: {
  src: string;
  alt: string;
  onFailedChange?: (failed: boolean) => void;
}) {
  const [failed, setFailed] = useState(false);
  // A fresh src is a fresh attempt — if the tile is re-keyed to a re-saved file
  // (same name, new size), start hopeful again rather than latching the old
  // failure. (A same-name/same-size heal after a transient blip still needs a
  // reload; the serving route has no writer coordination to detect it here.)
  useEffect(() => {
    setFailed(false);
    onFailedChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  if (failed) {
    return (
      <span className="attach-broken" aria-hidden="true">
        <Icon name="file" />
        <span className="attach-broken-note">preview unavailable</span>
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        setFailed(true);
        onFailedChange?.(true);
      }}
    />
  );
}

/**
 * A clickable attachment thumbnail: the serving-route link (which the lightbox
 * intercepts), the image (or its failed-load placeholder), and whatever caption
 * a surface stacks under it. Owning the failed state HERE is what lets the
 * anchor's accessible name say "preview unavailable" on a broken tile — the
 * placeholder's own label is otherwise swallowed by the anchor's `aria-label`.
 */
export function AttachmentThumb({
  variant,
  href,
  name,
  openLabel,
  onOpen,
  children,
}: {
  /** Which surface's tile chrome to wear: the side panel or the timeline. */
  variant: "panel" | "timeline";
  href: string;
  name: string;
  /** The working-state accessible name, e.g. `Open attachment shot.png (2 MB)`. */
  openLabel: string;
  onOpen: (e: ReactMouseEvent<HTMLElement>) => void;
  /** The caption/meta stacked under the image. */
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      className={variant === "timeline" ? "tl-attach-thumb" : "attach-thumb"}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={failed ? `${name} (preview unavailable)` : openLabel}
      onClick={onOpen}
    >
      <AttachmentImage src={href} alt={name} onFailedChange={setFailed} />
      {children}
    </a>
  );
}
