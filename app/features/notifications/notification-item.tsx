import { Icon } from "~/ui/icon";
import { formatDayTime } from "~/shared/dates/format";
import { ntfMeta, plainText } from "./notification-meta";

/**
 * One `.ntf-item` row — THE shared markup for the bell popover (both
 * shells) and the /notifications page list (ruling 14: bell popover ported
 * once, parameterized). Markup is verbatim from main.jsx/home.jsx.
 */

export interface NotificationView {
  id: string;
  kind: string;
  ptype: "input" | "blocked" | null;
  title: string | null;
  text: string;
  projectSlug: string | null;
  projectName: string | null;
  taskKey: string | null;
  occurredAt: string;
  unread: boolean;
  /** B-FD6: the destination `listNotifications` already resolved for this row —
   *  a task page, a project board, or null when the row concerns no live
   *  surface (org-wide rows, and F18-1 orphans whose project is gone). Every
   *  surface navigates to THIS; re-deriving it per surface as
   *  `projectSlug && taskKey` is what made project-scoped rows dead clicks. */
  href: string | null;
  /** F18-1: the project this row named no longer exists — render it as a
   *  non-navigable orphan (clicking it would 404) with a "no longer exists"
   *  note, instead of a live-looking link. */
  targetMissing?: boolean;
}

export function NotificationItem({
  notification: n,
  onOpen,
}: {
  notification: NotificationView;
  onOpen: (n: NotificationView) => void;
}) {
  const m = ntfMeta(n);
  const metaLine = [
    n.projectName,
    n.taskKey,
    formatDayTime(n.occurredAt),
    n.targetMissing ? "project no longer exists" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className={
        "ntf-item" + (n.unread ? "" : " read") + (n.targetMissing ? " orphaned" : "")
      }
      onClick={() => onOpen(n)}
      // F18-1: an orphan (its project was deleted) has nowhere to open — the
      // click only marks it read. `aria-disabled` (not `disabled`) keeps it
      // focusable so a keyboard user can still dismiss it.
      // A row with no destination is not a live control either: an org-wide
      // row has no page to open, and it used to render as a normal button that
      // navigated nowhere. `aria-disabled` (not `disabled`) keeps it focusable
      // so a keyboard user can still dismiss it.
      aria-disabled={n.href === null || undefined}
      title={
        n.targetMissing
          ? "The project this refers to no longer exists"
          : n.href === null
            ? "This one has no page to open"
            : undefined
      }
    >
      <span className={"pev-ico " + m.cls}>
        <Icon name={m.icon} />
      </span>
      <span className="ntf-item-main">
        {/* Unread is otherwise signalled only by the color dot (WCAG 1.4.1) —
            lead the accessible name with a visually-hidden "Unread:" marker.
            Sibling of `.tt` (not nested) so `.tt`'s exact textContent holds. */}
        {n.unread && <span className="mention-vh">Unread: </span>}
        <span className="tt">{n.title || plainText(n.text)}</span>
        {n.title && <span className="tx">{plainText(n.text)}</span>}
        <span className="mt">{metaLine}</span>
      </span>
      {n.unread && <span className="unread-dot"></span>}
    </button>
  );
}
