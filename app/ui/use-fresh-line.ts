import { useState } from "react";

/**
 * Ruling 451(a), amended by ruling 459: whether a live status line has changed
 * since it was first painted — AnimatePresence's `initial={false}`, by hand.
 *
 * The words on screen when the page, dock or strip opens are not news, so they
 * stand still (`data-fresh` absent); every line after them rises in, including
 * one that repeats them (Working, then Compacting context, then Working again;
 * the same tool called twice). So this is a latch, not a comparison with the
 * first words: once the line has changed it stays fresh, and `data-fresh` only
 * ever arrives with a newly keyed line, never on one already standing (adding
 * it to a standing node would start its animation). Server and client both
 * start unlatched, so hydration agrees. Same set-state-in-render shape as
 * `useRefusalShake`.
 */
export function useFreshLine(line: string): boolean {
  const [first, setFirst] = useState<string | null>(line);
  const fresh = first === null || line !== first;
  if (fresh && first !== null) setFirst(null);
  return fresh;
}
