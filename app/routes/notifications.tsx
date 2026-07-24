import { useRef } from "react";
import { useLocation, useNavigate, useFetcher } from "react-router";
import type { Route } from "./+types/notifications";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
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
 * for real, cross-project included (ruling 9 seeded the stub projects).
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Notifications · Viberr" }];
}

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
  };
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { notifications, unread, truncated, limit } = loaderData;
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // Mark-all-read toast fires on the server RESULT, not on submit. This
  // fetcher also handles single-row reads, so a `wantAllRead` flag scopes the
  // toast; a failed POST reports the failure, not a false success (P11-40).
  const wantAllRead = useRef(false);
  useFetcherResult(fetcher, (data) => {
    if (!wantAllRead.current) return;
    wantAllRead.current = false;
    push(
      data.ok
        ? "All notifications marked read"
        : (data.error ?? "Marking notifications read failed — try again"),
    );
  });

  // New rows / packet-resolution auto-reads land live (the badge in the
  // shells is already SSE-wired; the overlay subscribes on its own since
  // it renders without the workspace shell underneath).
  useLiveUpdates([sseScopes.user()]);

  const items = notifications as NotificationPageItem[];

  const close = () => {
    const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
    navigate(returnTo ?? "/");
  };

  const markRead = (id: string) => {
    const item = items.find((n) => n.id === id);
    if (!item || !item.unread) return; // monotonic — nothing to do
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const markAllRead = () => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read-all");
    wantAllRead.current = true;
    fetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const openItem = (n: NotificationPageItem) => {
    if (n.projectSlug && n.taskKey) {
      navigate(`/projects/${n.projectSlug}/tasks/${n.taskKey}`);
    }
  };

  return (
    <PageOverlay label="Notifications" onClose={close}>
      <NotificationsPage
        items={items}
        unread={unread}
        truncated={truncated}
        limit={limit}
        onRead={markRead}
        onReadAll={markAllRead}
        onOpen={openItem}
      />
    </PageOverlay>
  );
}
