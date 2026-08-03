import { useEffect, useState } from "react";
import {
  formatDayDotTime,
  formatDayDotTimeUTC,
  formatRelative,
} from "~/shared/dates/format";

/**
 * Hydration-safe timestamp text. The server's timezone and the viewer's can
 * differ, so rendering the viewer-local form on both sides hydrates to
 * different text — a recoverable React #418 that forces a full client
 * re-render of the page. First paint is the UTC form, identical on server
 * and client by construction; an effect swaps in the viewer-local rendering.
 */
export function LocalDayDotTime({ iso }: { iso: string }) {
  const local = useHydrated();
  return <>{local ? formatDayDotTime(iso) : formatDayDotTimeUTC(iso)}</>;
}

/**
 * True after hydration. For timezone-dependent text that cannot render its
 * viewer-local form during SSR: render a timezone-DETERMINISTIC form (UTC, or
 * the raw stored value) while this is false, and the local form after.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
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
