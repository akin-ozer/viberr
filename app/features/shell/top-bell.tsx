import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFetcher, useLocation, useMatches, useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { useCsrfToken } from "~/ui/csrf-input";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useDismiss } from "~/ui/use-dismiss";
import { useToast } from "~/ui/toast";
import {
  NotificationItem,
  type NotificationView,
} from "~/features/notifications/notification-item";
import {
  REVALIDATION_RULES,
  type Fact,
} from "~/features/live-updates/revalidation-policy";
import type { clientLoader as bellListLoader } from "~/routes/resources.notifications";

/**
 * Bell button + notifications popover — ONE implementation for both the
 * workspace topbar and the Home header (ruling 14). Fed from the per-user
 * notifications table; item clicks mark the row read and navigate for real,
 * including cross-project rows (the prototype "isn't built" toast is gone;
 * navigation resolves against the projects the store actually holds — the
 * ruling-9 stub projects exist only in the demo seed).
 *
 * Additions over the mock (sanctioned): Escape closes the popover.
 *
 * Ruling 457 (owner decision 2026-09-24, FL-4 / SRV-6): pages carry only the
 * bell's counts. The list is this component's own fetch
 * (`/resources/notifications`): it starts when the pointer or the focus
 * reaches the bell, or on open, so a first open without either may show one
 * brief loading row. The list is stale once the page has re-read the counts
 * since it was fetched, whatever values they came back with: counts are not a
 * version (a packet resolved and another raised leaves them where they were,
 * with different rows). A notification created or read revalidates the page
 * (its `user` scope), so the route that reads the counts hands over a new
 * loader-data object; an intent or an open then reloads the list, and an open
 * popover reloads it at once. A failed load shows a failure row in the
 * popover, never the page's error boundary, and the next intent retries.
 */

/**
 * UI-14: the list holds the newest `BELL_LIST_CAP` rows while the head renders
 * the FULL unread count, so the header could claim more unread than the list
 * can show. At the cap the footer says so; the disclosure lives with the list.
 */
export const BELL_LIST_CAP = 100;

/** The list's resource route (`routes/resources.notifications.ts`). */
const BELL_LIST_URL = "/resources/notifications";

/** The routes whose loaders read the bell's counts (`REVALIDATION_RULES`):
 *  the workspace layout, Home, the standalone header and /notifications. */
const rules: [string, { reads: readonly Fact[] }][] = Object.entries(REVALIDATION_RULES);
const BELL_ROUTES = new Set(rules.filter(([, rule]) => rule.reads.includes("bell")).map(([id]) => id));

export function TopBell({
  unread,
  orphanUnread,
}: {
  /** The badge (`bellCounts`): unread rows that lead somewhere. */
  unread: number;
  /** F19-25: unread rows whose project is gone (`bellCounts`). */
  orphanUnread: number;
}) {
  // F19-25: `unread` EXCLUDES rows whose project no longer exists (F18-1).
  // Those orphan rows are still rendered in the list, still wearing their
  // unread dot — so the popover said "caught up" and withdrew Mark all read
  // while unread rows were on screen. The two sets are disjoint by
  // construction, so adding them cannot double-count. Ruling 457: the server
  // counts the orphans (the list is no longer here to count them from).
  const shownUnread = unread + orphanUnread;

  const list = useFetcher<typeof bellListLoader>();
  // Review finding bell-stale-list-count-key: the list's version is the READ
  // of the counts, not their values. The outermost route on screen that reads
  // the bell supplies the counts, and its loader data is a new object every
  // time its loader re-runs (single fetch decodes a fresh one), so this object
  // changes exactly when the page re-read them (or, where no such route is on
  // screen, when the counts themselves change).
  const countsRead = useMatches().find((match) => BELL_ROUTES.has(match.id))?.loaderData;
  const version = useMemo(
    () => ({ unread, orphanUnread, countsRead }),
    [unread, orphanUnread, countsRead],
  );
  // The version the list was last fetched for; null after a failed load, so
  // the next intent retries.
  const fetchedFor = useRef<typeof version | null>(null);
  const loadList = list.load;
  const load = useCallback(() => {
    fetchedFor.current = version;
    void loadList(BELL_LIST_URL);
  }, [version, loadList]);
  const want = () => {
    if (fetchedFor.current !== version) load();
  };
  const notifications: NotificationView[] = list.data?.notifications ?? [];
  const loading = list.data === undefined;
  // Ruling 457: the list route's `clientLoader` answers a failed load (an
  // outage, a 5xx, a signed-out 401) with `notifications: null`.
  const failed = list.data !== undefined && list.data.notifications === null;
  useEffect(() => {
    if (failed) fetchedFor.current = null;
  }, [failed, list.data]);

  const [open, setOpen] = useState(false);
  // On open, and while open whenever the page re-reads the counts.
  useEffect(() => {
    if (open && fetchedFor.current !== version) load();
  }, [open, version, load]);
  // Ruling 459: the badge pulses when the count RISES while this bell is on
  // screen. Not on first paint (SSR included), not when a layout change
  // remounts the bell (Home, the workspace and the standalone pages each mount
  // their own), and not when reading lowers it (R19-15). Derived during render
  // from the last count seen, so the pulse starts with the new digit.
  const [seenUnread, setSeenUnread] = useState(unread);
  const [arrivals, setArrivals] = useState(0);
  if (unread !== seenUnread) {
    setSeenUnread(unread);
    if (unread > seenUnread) setArrivals(arrivals + 1);
  }
  const navigate = useNavigate();
  const location = useLocation();
  const readFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // R14-3: mark-all-read owns its own fetcher. Sharing one with the row read
  // meant a row click ABORTED an in-flight mark-all, and React Router drops an
  // aborted submission's result — so the row's own success then spoke for the
  // mark-all, and the mark-all's failure branch was unreachable. Fixed for the
  // /notifications page in the same pass; this is that page's twin bell.
  const readAllFetcher = useFetcher<{ ok: boolean; error?: string }>();
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

  // Mark-all-read toast fires on the server RESULT, not on submit: a failed
  // POST (expired session/CSRF) reports the failure, not a false success
  // (P11-40). Its own fetcher means this result can only be a mark-all's, so no
  // submit-time flag has to scope it.
  useFetcherResult(readAllFetcher, (data) => {
    push(
      data.ok
        ? "All notifications marked read"
        : (data.error ?? "Marking notifications read failed. Try again"),
      data.ok ? "success" : "error",
    );
  });

  const markRead = (ids: string[]) => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read");
    for (const id of ids) fd.append("id", id);
    readFetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };
  const markAllRead = () => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "read-all");
    readAllFetcher.submit(fd, { method: "post", action: "/notifications/read" });
  };

  const openItem = (n: NotificationView) => {
    if (n.unread) markRead([n.id]);
    setOpen(false);
    // B-FD6: `href` is the destination `listNotifications` resolved (null for
    // an org-wide row, and for an F18-1 orphan whose project would 404) — the
    // rule lives there, not in each surface. The click still clears the row.
    if (n.href) navigate(n.href);
  };

  return (
    <div className="home-user-wrap">
      {open && (
        <BellPopover
          popRef={popRef}
          shownUnread={shownUnread}
          listBusy={list.state !== "idle"}
          loading={loading}
          failed={failed}
          notifications={notifications}
          onClose={() => setOpen(false)}
          onMarkAllRead={markAllRead}
          onRetry={load}
          onOpenItem={openItem}
          onSeeAll={() => {
            setOpen(false);
            navigate("/notifications", {
              state: { returnTo: location.pathname + location.search },
            });
          }}
        />
      )}
      <button
        type="button"
        ref={buttonRef}
        className="icon-btn bell-btn"
        aria-label={
          "Notifications" + (unread > 0 ? ", " + unread + " unread" : "")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={want}
        onFocus={want}
        onClick={() => setOpen((b) => !b)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          // Keyed on arrivals, not the count: each rise remounts it so the
          // pulse replays; a fall only changes the digit.
          <span
            className="bell-badge"
            key={arrivals}
            data-arrived={arrivals > 0 ? "" : undefined}
          >
            {unread}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * The open popover (ruling 700(e), split out of `TopBell` on the task page's
 * recipe; it calls no hook): its head and Mark all read, the list or what
 * stands for it, and the foot. The bell owns the list, the reads and focus,
 * and renders this only while it is open.
 */
function BellPopover({
  popRef,
  shownUnread,
  listBusy,
  loading,
  failed,
  notifications,
  onClose,
  onMarkAllRead,
  onRetry,
  onOpenItem,
  onSeeAll,
}: {
  popRef: RefObject<HTMLDialogElement | null>;
  /** The head's count: `unread` plus the orphan rows (F19-25). */
  shownUnread: number;
  listBusy: boolean;
  loading: boolean;
  failed: boolean;
  notifications: NotificationView[];
  onClose: () => void;
  onMarkAllRead: () => void;
  onRetry: () => void;
  onOpenItem: (n: NotificationView) => void;
  onSeeAll: () => void;
}) {
  return (
    <>
      <div
        className="menu-scrim"
        aria-hidden="true"
        onClick={onClose}
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
          <span className="ct">
            {shownUnread > 0 ? shownUnread + " unread" : "caught up"}
          </span>
          {shownUnread > 0 && (
            <button type="button" className="btn ghost sm" onClick={onMarkAllRead}>
              Mark all read
            </button>
          )}
        </div>
        <div className="ntf-pop-list" aria-busy={listBusy}>
          {loading ? (
            <div className="empty">Loading notifications…</div>
          ) : failed ? (
            <div className="empty">
              Couldn't load notifications.
              <button type="button" className="btn ghost sm empty-cta" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="empty">Nothing yet. You're caught up.</div>
          ) : null}
          {notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} onOpen={onOpenItem} />
          ))}
        </div>
        <div className="ntf-pop-foot">
          {/* UI-14: the head can claim "150 unread" while this list holds
              the newest 100 (the list route caps at `BELL_LIST_CAP`).
              Disclose the cap instead of letting the count silently
              disagree with the rows — the same truncation notice
              /notifications already got. */}
          {notifications.length >= BELL_LIST_CAP && (
            <span className="sub pull">
              Showing the newest {notifications.length}
            </span>
          )}
          <button
            type="button"
            className="btn ghost sm"
            onClick={onSeeAll}
          >
            See all
            <Icon name="arrow" className="ico-end" />
          </button>
        </div>
      </dialog>
    </>
  );
}
