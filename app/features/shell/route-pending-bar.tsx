import { useEffect, useState } from "react";
import { useNavigation } from "react-router";

/**
 * P13-D-36 (UX-8 / F13-04) — the app's only route-level pending indicator.
 *
 * React Router's navigation/fetcher pending state is the default loading mechanism
 * (docs/architecture/decisions.md, UI porting rules), and loading feedback keeps
 * layout stable. Before this,
 * `useNavigation` appeared in exactly two lines of the whole tree, both inside
 * `app/routes/login.tsx`: there was no HydrateFallback, no skeleton, and the one
 * global busy affordance (`.ico.spin`) was wired to *fetcher* states only.
 *
 * Blast radius is small but real: of every loader under `app/routes/`, only
 * `project.github.tsx` awaits the network, so clicking "GitHub" in the rail on a
 * slow connection looked like a dead click for up to the 20 s client timeout.
 * React Router keeps the current page painted throughout, so nothing goes blank
 * — this is about feedback, not layout.
 *
 * Two deliberate narrowings:
 *   - `navigation.location != null` restricts this to real navigations. SSE live
 *     updates revalidate through `useRevalidator` (see
 *     `features/live-updates/use-live-updates.ts`), which must never paint a
 *     progress bar over an idle page.
 *   - nothing mounts until `delayMs` has passed, so the sub-100 ms client
 *     navigations that make up almost every click never flash a bar.
 */

/** Long enough that an ordinary client navigation completes unannounced.
 *  Exported with no importer on purpose: exported, the build inlines it at its
 *  one use; module-local, it ships as a variable, 8 B more on every route
 *  closure the ruling-457 ratchet budgets (measured for ruling 458(g)). */
export const ROUTE_PENDING_DELAY_MS = 220;

export function RoutePendingBar({
  delayMs = ROUTE_PENDING_DELAY_MS,
}: {
  delayMs?: number;
}) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle" && navigation.location != null;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [pending, delayMs]);

  if (!shown) return null;
  // An indeterminate progressbar carries its whole meaning in the role + label,
  // so it needs no text node (and this repo has no visually-hidden utility to
  // invent one with).
  return (
    <div
      className="route-pending"
      role="progressbar"
      aria-label="Loading the next page"
    >
      <span className="rp-fill" />
    </div>
  );
}
