import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "~/ui/icon";
import { scrollingBox } from "~/ui/use-hash-target";

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
 * render), then the layout effect measures on the client and clamps before the
 * browser paints a client render.
 *
 * Ruling 510: a keyboard user who moves focus under the fade opens the box.
 * The links there stay in the tab order, and focusing one scrolled the clamped
 * box so the link sat behind the fade, where its ring was too faint to follow.
 *
 * Ruling 522: a comment's pictures, under its card, fold with its text. The
 * comment then owns the state (`open`, `onOpenChange`) and counts what else the
 * toggle hides (`more`, six images), and the toggle shows for them even when
 * the text itself is short.
 */
export function Collapsible({
  className,
  contentKey,
  max = COLLAPSE_MAX,
  children,
  open,
  onOpenChange,
  more = null,
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
  /** Ruling 522: the fold's state, held by whoever folds something else with
   *  this box. Absent, the box keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Ruling 522: what the toggle hides outside the box; null for nothing. */
  more?: Hidden | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [ownOpen, setOwnOpen] = useState(false);
  const expanded = open ?? ownOpen;
  const setExpanded = onOpenChange ?? setOwnOpen;

  useLayoutEffect(() => {
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
      {(overflowing || more) && (
        <FoldToggle open={expanded} onOpenChange={setExpanded} cut={overflowing} more={more} />
      )}
    </div>
  );
}

/** Ruling 522: what a fold hides beyond its box, as its toggle counts it. */
export interface Hidden {
  count: number;
  /** Already agreeing with the count: "images", "file". */
  noun: string;
}

/**
 * The fold's one control: "Show more" / "Show less" with `aria-expanded`.
 *
 * Ruling 522: it counts what it hides beyond its box ("Show more · +6 images",
 * or "Show 6 more images" when the box itself is whole), and closing keeps it
 * where it was on screen. What folds above it (a long reply's
 * text, the rows of pictures a toggle under them hides) otherwise pulled it up
 * by that height: a person who read to the end and pressed Show less watched
 * it leave the screen, and the next entry sat under the pointer.
 */
export function FoldToggle({
  open,
  onOpenChange,
  cut = true,
  more = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether its own box is cut short; false when only `more` is hidden. */
  cut?: boolean;
  /** What it hides beyond its box; null for nothing. */
  more?: Hidden | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // Where the toggle stood when it was pressed to close, in the box that
  // scrolls it; the layout effect after the fold scrolls it back there.
  const closing = useRef<{ box: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const was = closing.current;
    closing.current = null;
    const button = ref.current;
    if (!was || !button) return;
    was.box.scrollTop += button.getBoundingClientRect().top - was.top;
  }, [open]);

  return (
    <button
      ref={ref}
      type="button"
      className="md-collapse-toggle"
      aria-expanded={open}
      onClick={(event) => {
        const button = event.currentTarget;
        const box = open ? scrollingBox(button) : null;
        closing.current = box ? { box, top: button.getBoundingClientRect().top } : null;
        onOpenChange(!open);
      }}
    >
      <Icon name="chevron" />
      {open ? (
        "Show less"
      ) : !cut && more ? (
        `Show ${more.count} more ${more.noun}`
      ) : (
        <>
          {/* The space is the accessible name's; the flex gap draws it. */}
          Show more{more && " "}
          {more && <span className="md-collapse-more">· +{more.count} {more.noun}</span>}
        </>
      )}
    </button>
  );
}

/**
 * Ruling 522: how many tiles of a wrapping strip (`ref`) stand on its first
 * line, so the rest can fold. Every tile of the strip takes one width, so the
 * line holds as many as fit side by side with the gap between them; that
 * holds whether the rest are drawn or not, so the count survives the fold and
 * follows the strip's width. Infinity until measured: the server's render and
 * the first client render draw every tile. A strip laid out at no width (no
 * layout engine, or a hidden ancestor) keeps Infinity until it has one.
 */
export function useFirstRow(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [perRow, setPerRow] = useState(Infinity);
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const measure = () => {
      const tile = strip.firstElementChild?.getBoundingClientRect().width ?? 0;
      if (tile <= 0) return;
      const style = getComputedStyle(strip);
      const px = (value: string) => parseFloat(value) || 0;
      const gap = px(style.columnGap);
      // The content box, to the fraction of a pixel: `clientWidth` rounds, and
      // a strip a hair narrower than four tiles holds three.
      const room =
        strip.getBoundingClientRect().width -
        px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth);
      // A hair of slack the other way, for a strip exactly four tiles wide.
      setPerRow(Math.max(1, Math.floor((room + gap) / (tile + gap) + 1e-6)));
    };
    measure();
    if (!("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [count]);
  return { ref, perRow };
}
