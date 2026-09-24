import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { useLocation, useNavigate, useFetcher } from "react-router";
import { pageTitle } from "~/shared/page-title";
import { z } from "zod";
import type { Route } from "./+types/notifications";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
import { decisionsRequiring } from "~/server/projections/decisions.server";
import { sseScopes } from "~/features/live-updates/event-types";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { useCsrfToken } from "~/ui/csrf-input";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";
import { NotificationsPage } from "~/features/notifications/notifications-page";
import type { NotificationPageItem } from "~/features/notifications/notifications-page-helpers";

/**
 * /notifications — URL-addressable PageOverlay route (phase-4 shell
 * decision, kept). Phase 9C fills it with the full notifications.jsx
 * surface: "Waiting on you" packet/approval cards, "Everything else"
 * day-grouped stream, All/Unread filter, mark-all-read. Read mutations go
 * through the ONE existing /notifications/read action; row clicks navigate
 * for real, cross-project included (against the store's real projects — the
 * ruling-9 stub projects exist only in the demo seed).
 */

export function meta() {
  return [{ title: pageTitle("Notifications") }];
}

/** Overlay routes are opened from the shell with the path to return to in
 *  history state (top-bell, user-menu). Browser history state survives reloads
 *  and back/forward and is not the app's to trust, so it is parsed here rather
 *  than asserted. */
const overlayReturnState = z
  .object({ returnTo: z.string().optional().catch(undefined) })
  .catch({});

/** Most-recent notifications the page loads. The list is capped (no paging
 *  past it), so the loader over-fetches by one to detect when the window is
 *  full and surfaces `truncated` — the truncation used to be silent (P12/RU-4). */
const NOTIF_PAGE_LIMIT = 200;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const rows = listNotifications(db, user.id, { limit: NOTIF_PAGE_LIMIT + 1 });
  const truncated = rows.length > NOTIF_PAGE_LIMIT;
  return {
    notifications: truncated ? rows.slice(0, NOTIF_PAGE_LIMIT) : rows,
    unread: countUnreadNotifications(db, user.id),
    truncated,
    limit: NOTIF_PAGE_LIMIT,
    // D-3 (pass 24): the AUTHORITATIVE count of decisions this viewer must act on
    // — the SAME source the home hero's "N decisions waiting on you" uses. The
    // "Waiting on you" panel used to count notification ROWS (`needsTotal`), which
    // misses a decision whose watcher set predates the viewer's authority (a later
    // promotion), or one past the row window — so home said "1 waiting" while this
    // page said "nothing". The header now states this number; the row list still
    // shows the rows that exist, with the shortfall disclosed.
    decisionCount: decisionsRequiring(db, user.id).mine.length,
  };
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { notifications, unread, truncated, limit, decisionCount } = loaderData;
  const navigate = useNavigate();
  const location = useLocation();
  const readFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // R14-3: mark-all-read owns its own fetcher. Sharing one with the row read
  // meant a row click ABORTED an in-flight mark-all, and React Router drops an
  // aborted submission's result — so the row's own success then spoke for the
  // mark-all, and the mark-all's failure branch was unreachable.
  const readAllFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // Mark-all-read toast fires on the server RESULT, not on submit: a failed
  // POST reports the failure, not a false success (P11-40). The result can only
  // be a mark-all's now, so no submit-time flag has to scope it.
  useFetcherResult(readAllFetcher, (data) => {
    push(
      data.ok
        ? "All notifications marked read"
        : (data.error ?? "Marking notifications read failed. Try again"),
      // P13-D-10: the failure branch rendered the success tick (the bell's
      // twin handler in top-bell.tsx already passed the kind).
      data.ok ? "success" : "error",
    );
  });

  // New rows / packet-resolution auto-reads land live (the badge in the
  // shells is already SSE-wired; the overlay subscribes on its own since
  // it renders without the workspace shell underneath).
  useLiveUpdates([sseScopes.user()]);

  const close = () => {
    const { returnTo } = overlayReturnState.parse(location.state);
    navigate(returnTo ?? "/");
  };

  const markRead = (id: string) => {
    const item = notifications.find((n) => n.id === id);
    if (!item || !item.unread) return; // monotonic — nothing to do
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read");
    fd.append("id", id);
    readFetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const markAllRead = () => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read-all");
    readAllFetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const openItem = (n: NotificationPageItem) => {
    // B-FD6: the destination is resolved ONCE in `listNotifications` (null when
    // the row concerns no live surface, an F18-1 orphan whose project is gone
    // included). Re-deriving it here as `projectSlug && taskKey` is what made
    // project-scoped rows render as live controls that navigate nowhere.
    if (n.href) navigate(n.href);
  };

  return (
    <PageOverlay label="Notifications" onClose={close}>
      <NotificationsPage
        items={notifications}
        unread={unread}
        decisionCount={decisionCount}
        truncated={truncated}
        limit={limit}
        onRead={markRead}
        onReadAll={markAllRead}
        onOpen={openItem}
      />
    </PageOverlay>
  );
}

/** Ruling 454: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/notifications");
