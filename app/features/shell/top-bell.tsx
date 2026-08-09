import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { useCsrfToken } from "~/ui/csrf-input";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useDismiss } from "~/ui/use-dismiss";
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

/**
 * UI-14: the popover list is loaded with `limit: 100` by both callers
 * (routes/project.tsx, routes/_index.tsx) while the head renders the FULL
 * unread count, so the header could claim more unread than the list can show.
 * At the cap the footer says so.
 */
export const BELL_LIST_CAP = 100;
export function TopBell({
  notifications,
  unread,
}: {
  notifications: NotificationView[];
  unread: number;
}) {
  // F19-25: `unread` comes from `countUnreadNotifications`, which EXCLUDES rows
  // whose project no longer exists (F18-1). Those orphan rows are still rendered
  // below, still wearing their unread dot — so the popover said "caught up" and
  // withdrew Mark all read while unread rows were on screen. The two sets are
  // disjoint by construction, so adding them cannot double-count.
  const shownUnread =
    unread + notifications.filter((n) => n.unread && n.targetMissing).length;

  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const popRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // P16-UI-12: one shared dismiss hook (`app/ui/use-dismiss.ts`) instead of a
  // hand-rolled listener. `outside: false` preserves today's behaviour — the
  // popover closes on Escape or an explicit action, not on any stray press.
  useDismiss(open, () => setOpen(false), { outside: false });

  // UI-45: the popover is rendered BEFORE its trigger in the DOM and nothing
  // moved focus into it, so a keyboard user who activated the bell then pressed
  // Tab landed on the account button — the panel they had just opened was
  // reachable only by Shift+Tab. Focus the panel on open and restore focus to
  // the bell on close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      popRef.current?.focus();
    } else if (wasOpen.current) {
      buttonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // The mark-all-read toast fires on the server RESULT, not on submit: the
  // bell's fetcher also handles single-row reads, so a `wantAllRead` flag
  // scopes the toast, and a failed POST (expired session/CSRF) reports the
  // failure instead of a false success (P11-40).
  const wantAllRead = useRef(false);
  useFetcherResult(fetcher, (data) => {
    if (!wantAllRead.current) return;
    wantAllRead.current = false;
    push(
      data.ok
        ? "All notifications marked read"
        : (data.error ?? "Marking notifications read failed — try again"),
      data.ok ? "success" : "error",
    );
  });

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
    // F18-1: an orphan's project is gone — navigating there 404s on a
    // shell-less error page. The click only clears it (mark-read above).
    if (!n.targetMissing && n.projectSlug && n.taskKey) {
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
            ref={popRef}
            tabIndex={-1}
            className="ntf-pop"
            aria-label="Notifications"
            data-screen-label="Notifications popover"
          >
            <div className="ntf-pop-head">
              <h3>Notifications</h3>
              <span className="ct mono">
                {shownUnread > 0 ? shownUnread + " unread" : "caught up"}
              </span>
              {shownUnread > 0 && (
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
              {/* UI-14: the head can claim "150 unread" while this list holds
                  the newest 100 (the loaders cap at `limit: 100`). Disclose the
                  cap instead of letting the count silently disagree with the
                  rows — the same truncation notice /notifications already got. */}
              {notifications.length >= BELL_LIST_CAP && (
                <span className="sub pull">
                  Showing the newest {notifications.length}
                </span>
              )}
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
        ref={buttonRef}
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
