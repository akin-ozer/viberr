import { formatRelative } from "~/shared/dates/format";
import { useClock } from "./use-clock";

/**
 * Live relative timestamp ("2m ago") for client components.
 *
 * UI-20: call sites used to invoke `formatRelative(iso)` straight inside
 * render, which has two defects — the SSR pass uses the SERVER's clock (so the
 * hydrated markup can disagree with the browser), and the value then never ages
 * because nothing re-renders. This hook re-renders once after hydration
 * (replacing the server-clock string with the viewer's own) and then every
 * 30s, so a card left open keeps telling the truth. Pair it with
 * `suppressHydrationWarning` on the element that renders the returned string.
 *
 * Ruling 11 (RF-9): the 30 s tick is the shared clock (`use-clock.ts`), one
 * interval for every stamp on the page instead of one per stamp.
 *
 * Returns "" for a null timestamp — callers branch on the raw value for their
 * own "never" copy.
 */
export function useRelativeTime(iso: string | null | undefined): string {
  const now = useClock(30_000);
  if (!iso) return "";
  // Null on the server and during hydration: the render's own clock, which the
  // re-render right after hydration replaces with the viewer's.
  return now === null ? formatRelative(iso) : formatRelative(iso, new Date(now));
}
