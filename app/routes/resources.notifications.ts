import type { Route } from "./+types/resources.notifications";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { listNotifications } from "~/server/projections/notifications.server";
import { BELL_LIST_CAP } from "~/features/shell/top-bell";

/**
 * GET /resources/notifications — the bell popover's list (ruling 454, owner
 * decision 2026-09-24, FL-4 / SRV-6). Pages used to ship the newest hundred
 * notifications with every document and every revalidation, for a popover
 * that is closed at first paint: 62 % of Home's payload on the demo seed.
 * Pages now carry the bell's counts (`bellCounts`), and the bell loads this
 * when the pointer or focus reaches it and when it opens, and again whenever
 * the page has re-read the counts since (`top-bell.tsx`).
 *
 * The viewer's own rows only; the same `listNotifications` the /notifications
 * page reads, capped at `BELL_LIST_CAP` (UI-14: the popover discloses the cap).
 */

/** The bell loads this itself: a page revalidation never reloads it. */
export function shouldRevalidate(): boolean {
  return false;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return {
    notifications: listNotifications(getDb(), user.id, { limit: BELL_LIST_CAP }),
  };
}
