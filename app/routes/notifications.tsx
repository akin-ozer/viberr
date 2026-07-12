import { useEffect, useRef } from "react";
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
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";
import { NotificationsPage } from "~/features/notifications/notifications-page";
import type { NotificationPageItem } from "~/features/notifications/notifications-page-helpers";
import {
  notificationReadAllFeedback,
  type NotificationReadResult,
} from "~/features/notifications/read-feedback";

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

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  return {
    notifications: listNotifications(db, user.id, { limit: 200 }),
    unread: countUnreadNotifications(db, user.id),
  };
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { notifications, unread } = loaderData;
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<NotificationReadResult>();
  const readAllFetcher = useFetcher<NotificationReadResult>();
  const csrf = useCsrfToken();
  const push = useToast();
  const handledReadAll = useRef<unknown>(null);

  useEffect(() => {
    if (readAllFetcher.state !== "idle" || !readAllFetcher.data) return;
    if (handledReadAll.current === readAllFetcher.data) return;
    handledReadAll.current = readAllFetcher.data;
    push(notificationReadAllFeedback(readAllFetcher.data));
  }, [push, readAllFetcher.data, readAllFetcher.state]);

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
    readAllFetcher.submit(fd, {
      method: "post",
      action: "/notifications/read",
    });
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
        readAllBusy={readAllFetcher.state !== "idle"}
        onRead={markRead}
        onReadAll={markAllRead}
        onOpen={openItem}
      />
    </PageOverlay>
  );
}
