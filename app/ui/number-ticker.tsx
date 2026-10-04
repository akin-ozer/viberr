import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Ruling 366(f): a figure that counts up to its value. A frame loop eases from
 * the figure last drawn to the new one over two seconds (ease-out cubic: most
 * of the distance in the first half of the time, settling gently), so a mount
 * counts up from zero, and a retarget mid-count carries on from wherever the
 * count was instead of restarting. The target rides on `data-count` in plain
 * text, so the DOM reads without waiting for the animation, and the count
 * stands still under reduced motion. The server and the first client render
 * both draw zero.
 */
export interface NumberTickerProps {
  /** The figure to reach. */
  end: number;
  /** Own copy around the moving figure, right at every frame ("1 event",
   *  "2 events"): the rounded figure and its text. Without it the span reads
   *  the figure alone. */
  children?: (figure: number, text: string) => ReactNode;
}

/** Seconds one count takes, whatever its distance. */
const DURATION_S = 2;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** A window without `matchMedia` (jsdom; vitest's copy of it declares the key
 *  and leaves it undefined) gets the motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION).matches ?? false;
}

export function NumberTicker({ end, children }: NumberTickerProps) {
  const [value, setValue] = useState(0);
  /** The figure on screen: the next count's origin. */
  const drawn = useRef(0);

  useEffect(() => {
    const from = drawn.current;
    if (from === end) return;
    if (prefersReducedMotion()) {
      drawn.current = end;
      setValue(end);
      return;
    }
    let frame = 0;
    let began: number | null = null;
    // Ruling 457 (LIVE-7): the float moves every frame, the text only when a
    // digit does. `drawn` keeps the float, so a retarget still eases on from
    // where the count really is; React hears only the frames that change the
    // text, which draws the same pixels with one commit per figure instead of
    // one per frame (126 for a +1).
    let text = from.toFixed(0);
    const step = (now: number) => {
      began ??= now;
      const t = Math.min((now - began) / (DURATION_S * 1000), 1);
      const eased = 1 - (1 - t) ** 3;
      const next = t < 1 ? from + (end - from) * eased : end;
      drawn.current = next;
      const nextText = next.toFixed(0);
      if (nextText !== text) {
        text = nextText;
        setValue(next);
      }
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [end]);

  const text = value.toFixed(0);
  return (
    <span data-count={end.toFixed(0)}>
      {children ? children(Number(text), text) : text}
    </span>
  );
}
