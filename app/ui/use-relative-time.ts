import { useEffect, useState } from "react";
import { formatRelative } from "~/shared/dates/format";

/**
 * Live relative timestamp ("2m ago") for client components.
 *
 * UI-20: call sites used to invoke `formatRelative(iso)` straight inside
 * render, which has two defects — the SSR pass uses the SERVER's clock (so the
 * hydrated markup can disagree with the browser), and the value then never ages
 * because nothing re-renders. This hook re-renders once on mount (replacing the
 * server-clock string with the viewer's own) and then every 30s, so a card left
 * open keeps telling the truth. Pair it with `suppressHydrationWarning` on the
 * element that renders the returned string.
 *
 * Returns "" for a null timestamp — callers branch on the raw value for their
 * own "never" copy.
 */
export function useRelativeTime(iso: string | null | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    tick((n) => n + 1);
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [iso]);
  return iso ? formatRelative(iso) : "";
}
