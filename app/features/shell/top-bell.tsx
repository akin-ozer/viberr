import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { useCsrfToken } from "~/ui/csrf-input";
import { useToast } from "~/ui/toast";
import {
  NotificationItem,
  type NotificationView,
} from "~/features/notifications/notification-item";

/**
 * Bell button + notifications popover — ONE implementation for both the
 * workspace topbar and the Home header (ruling 14). Fed from the per-user
 * notifications table; item clicks mark the row read and navigate for real,
 * including cross-project rows (the prototype "isn't built" toast is gone —
 * ruling 9 seeds the stub projects so navigation works).
 *
 * Additions over the mock (sanctioned): Escape closes the popover.
 */
export function TopBell({
  notifications,
  unread,
}: {
  notifications: NotificationView[];
  unread: number;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean }>();
  const csrf = useCsrfToken();
  const push = useToast();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The mark-all-read toast fires on the server RESULT, not on submit: the
  // bell's fetcher also handles single-row reads, so a `wantAllRead` flag
  // scopes the toast, and gating on `ok` avoids a false success when the POST
  // fails (expired session/CSRF) (P11-40).
  const wantAllRead = useRef(false);
  const seenReadAll = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (seenReadAll.current === fetcher.data) return;
    seenReadAll.current = fetcher.data;
    if (!wantAllRead.current) return;
    wantAllRead.current = false;
    if (fetcher.data.ok) push("All notifications marked read");
  }, [fetcher.state, fetcher.data, push]);

  const markRead = (ids: string[]) => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read");
    for (const id of ids) fd.append("id", id);
    fetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };
  const markAllRead = () => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read-all");
    wantAllRead.current = true;
    fetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const openItem = (n: NotificationView) => {
    if (n.unread) markRead([n.id]);
    setOpen(false);
    if (n.projectSlug && n.taskKey) {
      navigate(`/projects/${n.projectSlug}/tasks/${n.taskKey}`);
    }
  };

  return (
    <div className="home-user-wrap">
      {open && (
        <>
          <div
            className="menu-scrim"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          {/* Declarative non-modal <dialog open>: native dialog semantics
              without showModal()'s top-layer centering — the popover stays
              anchored to the bell via .ntf-pop's absolute positioning. */}
          <dialog
            open
            className="ntf-pop"
            aria-label="Notifications"
            data-screen-label="Notifications popover"
          >
            <div className="ntf-pop-head">
              <h3>Notifications</h3>
              <span className="ct mono">
                {unread > 0 ? unread + " unread" : "caught up"}
              </span>
              {unread > 0 && (
                <button type="button" className="btn ghost sm" onClick={markAllRead}>
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
            <div className="ntf-pop-foot">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setOpen(false);
                  navigate("/notifications", {
                    state: { returnTo: location.pathname + location.search },
                  });
                }}
              >
                See all
                <Icon name="arrow" />
              </button>
            </div>
          </dialog>
        </>
      )}
      <button
        type="button"
        className="icon-btn bell-btn"
        aria-label={
          "Notifications" + (unread > 0 ? " — " + unread + " unread" : "")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((b) => !b)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          // key re-mounts on count change so the pulse animation re-fires.
          <span className="bell-badge" key={unread}>
            {unread}
          </span>
        )}
      </button>
    </div>
  );
}
