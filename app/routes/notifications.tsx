import { useLocation, useNavigate, useFetcher } from "react-router";
import type { Route } from "./+types/notifications";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";
import {
  NotificationItem,
  type NotificationView,
} from "~/features/notifications/notification-item";

/**
 * /notifications — URL-addressable PageOverlay route (bell "See all").
 * Phase 4 ships the full per-user list with mark-read / mark-all-read and
 * real navigation (cross-project included); Phase 9 ports the richer
 * notifications.jsx surface ("Waiting on you" cards, filters, RichText)
 * into this same route.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Notifications · Viberr" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = requireUser(request);
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
  const fetcher = useFetcher();
  const csrf = useCsrfToken();
  const push = useToast();

  const close = () => {
    const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
    navigate(returnTo ?? "/");
  };

  const markRead = (ids: string[]) => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read");
    for (const id of ids) fd.append("id", id);
    fetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const openItem = (n: NotificationView) => {
    if (n.unread) markRead([n.id]);
    if (n.projectSlug && n.taskKey) {
      navigate(`/projects/${n.projectSlug}/tasks/${n.taskKey}`);
    }
  };

  return (
    <PageOverlay label="Notifications" onClose={close}>
      <div className="ntf-page">
        <div className="ntf-pop-head">
          <h3>Notifications</h3>
          <span className="ct mono">
            {unread > 0 ? unread + " unread" : "caught up"}
          </span>
          {unread > 0 && (
            <button
              className="btn ghost sm"
              onClick={() => {
                const fd = new FormData();
                fd.set("_csrf", csrf);
                fd.set("intent", "read-all");
                fetcher.submit(fd, {
                  method: "post",
                  action: "/notifications/read",
                });
                push("All notifications marked read");
              }}
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="ntf-pop-list">
          {notifications.length === 0 && (
            <div className="empty">Nothing yet — you're caught up.</div>
          )}
          {notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} onOpen={openItem} />
          ))}
        </div>
      </div>
    </PageOverlay>
  );
}
