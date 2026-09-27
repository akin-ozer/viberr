import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "~/ui/icon";

/** Content taller than this (px) clamps by default with a "Show more" toggle. */
const COLLAPSE_MAX = 340;

/** How much of a clamped box is in plain sight: the rest is under the fade,
 *  whose mask (`.md-collapse > .clamped` in app.css) turns at the same 78%. */
export const CLEAR_PART = 0.78;

/**
 * A box that clamps when it's very tall, so one long thing can't dominate the
 * page: a long agent reply on the timeline, a task's long list of attachments
 * (ruling 510). Measures the content's full height after mount; if it exceeds
 * COLLAPSE_MAX it renders clamped (with a soft fade) behind a Show more / Show
 * less toggle. Expanding restores the full content verbatim — nothing is
 * removed, only the view. SSR-safe: starts un-clamped (matches the server
 * render), then the effect measures on the client and clamps.
 *
 * Ruling 510: a keyboard user who moves focus under the fade opens the box.
 * The links there stay in the tab order, and focusing one scrolled the clamped
 * box so the link sat behind the fade, where its ring was too faint to follow.
 */
export function Collapsible({
  className,
  contentKey,
  max = COLLAPSE_MAX,
  children,
}: {
  /** The clamped box's own classes; `clamped` joins them while it clamps. */
  className: string;
  /** Changes whenever the content does. A clamped box keeps its height
   *  whatever its content does, so the resize observer alone can't tell. */
  contentKey: string | number;
  /** The clamped height (px). Ruling 521: a reviewer's reason on the
   *  completion packet folds at a few lines, not at a comment's height. */
  max?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight reports the FULL content height even while clamped by
    // max-height, so this stays correct in both states.
    const measure = () => setOverflowing(el.scrollHeight > max + 24);
    measure();
    // The first measure above is the whole contract on a host that provides no
    // ResizeObserver (jsdom); only the re-measure on resize is lost.
    if (!("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentKey, max]);

  const clamped = overflowing && !expanded;
  return (
    <div className="md-collapse">
      <div
        ref={ref}
        className={className + (clamped ? " clamped" : "")}
        style={clamped ? { maxHeight: max } : undefined}
        onFocus={(event) => {
          if (!clamped || !event.target.matches(":focus-visible")) return;
          // Something in plain sight keeps the fold: closing an attachment's
          // card hands focus back to its row, by keyboard more often than not.
          const box = event.currentTarget.getBoundingClientRect();
          const clear = box.top + box.height * CLEAR_PART;
          if (event.target.getBoundingClientRect().bottom > clear) setExpanded(true);
        }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          className="md-collapse-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon name="chevron" />
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
