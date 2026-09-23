import { useSyncExternalStore, type ReactNode } from "react";
import {
  formatCalendarDate,
  formatDayDotTime,
  formatDayDotTimeUTC,
  formatRelative,
  utcDayKey,
} from "~/shared/dates/format";

/**
 * Hydration-safe timestamp text. The server's timezone and the viewer's can
 * differ, so rendering the viewer-local form on both sides hydrates to
 * different text — a recoverable React #418 that forces a full client
 * re-render of the page. First paint is the UTC form, identical on server
 * and client by construction; the viewer-local rendering replaces it as soon as
 * hydration commits. A stamp mounted after that renders local at once.
 */
export function LocalDayDotTime({ iso }: { iso: string }) {
  const local = useHydrated();
  return <>{local ? formatDayDotTime(iso) : formatDayDotTimeUTC(iso)}</>;
}

/**
 * True after hydration. For timezone-dependent text that cannot render its
 * viewer-local form during SSR: render a timezone-DETERMINISTIC form (UTC, or
 * the raw stored value) while this is false, and the local form after.
 *
 * Ruling 454: false only on the server and during hydration, where React uses
 * the server snapshot and then re-renders once with the client's. A component
 * that mounts later (a client navigation, a new row, a console opened on
 * demand) reads true on its first render. The per-mount effect this replaced
 * made every such mount commit twice and swap all of its stamps after the
 * first paint, where a "Sep 24 · 11:02" visibly shrank to "14:02".
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, clientSnapshot, serverSnapshot);
}

/** Hydration is the only change, and React observes it without a store. */
function subscribeToNothing(): () => void {
  return () => {};
}
function clientSnapshot(): boolean {
  return true;
}
function serverSnapshot(): boolean {
  return false;
}

/**
 * Hydration-safe calendar date ("Jul 3, 2027"). `formatCalendarDate` is
 * host-zone by construction — on the client the host IS the viewer, which is
 * the point of a calendar date — so near midnight a UTC server and the viewer
 * disagree on the DAY, the same text mismatch `LocalDayDotTime` guards. First
 * paint is the timezone-neutral UTC day key, marked as such ("2027-07-03
 * (UTC)", the insights page's form); the effect swaps in the local calendar
 * date. A missing or unreadable value renders `fallback` (nothing by default),
 * never the word "null". Pass 34, C6.
 */
export function LocalCalendarDate({
  iso,
  fallback = null,
}: {
  iso: string | null;
  fallback?: ReactNode;
}) {
  const local = useHydrated();
  const day = iso ? utcDayKey(iso) : "";
  if (!day) return <>{fallback}</>;
  return <>{local ? formatCalendarDate(iso) : `${day} (UTC)`}</>;
}

/**
 * Hydration-safe relative stamp ("2m ago"). Relative text depends on NOW, so
 * server render and hydration can straddle a minute boundary and mismatch
 * intermittently. There is no timezone-free deterministic form here — both
 * sides first render a non-breaking space, and an effect fills in the client
 * text. The blank lasts one hydration frame.
 */
export function LocalRelative({ iso }: { iso: string }) {
  const ready = useHydrated();
  return <>{ready ? formatRelative(iso) : " "}</>;
}
