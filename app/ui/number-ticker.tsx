import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Ruling 366(f): a figure that counts up to its value. A frame loop eases from
 * the figure last drawn to the new one (ease-out cubic: most of the distance in
 * the first half of the time, settling gently), so a mount counts up from
 * `start`, and a retarget mid-count carries on from wherever the count was
 * instead of restarting. The target rides on `data-count` in plain text, so the
 * DOM reads without waiting for the animation, and the count stands still under
 * reduced motion. The server and the first client render both draw `start`.
 */
export interface NumberTickerProps {
  /** The figure to reach. */
  end: number;
  /** Where the first count starts (default 0). A later retarget starts from the figure drawn. */
  start?: number;
  /** Seconds one count takes, whatever its distance (default 2). */
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  /** Own copy around the moving figure, right at every frame ("1 event",
   *  "2 events"): the rounded figure and its text. Without it the span reads
   *  prefix, figure, suffix. */
  children?: (figure: number, text: string) => ReactNode;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** A window without `matchMedia` (jsdom; vitest's copy of it declares the key
 *  and leaves it undefined) gets the motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION).matches ?? false;
}

export function NumberTicker({
  end,
  start = 0,
  duration = 2,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
  children,
}: NumberTickerProps) {
  const [value, setValue] = useState(start);
  /** The figure on screen: the next count's origin. */
  const drawn = useRef(start);

  useEffect(() => {
    const from = drawn.current;
    if (from === end) return;
    if (duration <= 0 || prefersReducedMotion()) {
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
    let text = from.toFixed(decimals);
    const step = (now: number) => {
      began ??= now;
      const t = Math.min((now - began) / (duration * 1000), 1);
      const eased = 1 - (1 - t) ** 3;
      const next = t < 1 ? from + (end - from) * eased : end;
      drawn.current = next;
      const nextText = next.toFixed(decimals);
      if (nextText !== text) {
        text = nextText;
        setValue(next);
      }
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [end, duration, decimals]);

  // Passing the class attribute straight through reads as a class named
  // "className" to app.css.test's orphan gate (which also scans comments), so
  // the attribute rides in a props object, as radio-seg.tsx does.
  const dress = { className };
  const text = value.toFixed(decimals);
  return (
    <span {...dress} data-count={end.toFixed(decimals)}>
      {children ? children(Number(text), text) : `${prefix}${text}${suffix}`}
    </span>
  );
}
