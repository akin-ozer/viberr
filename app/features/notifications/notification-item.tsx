import { Icon } from "~/ui/icon";
import { formatDayTime } from "~/shared/dates/format";
import { useViewerTimeZone } from "~/shared/dates/use-viewer-time-zone";
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
}

export function NotificationItem({
  notification: n,
  onOpen,
}: {
  notification: NotificationView;
  onOpen: (n: NotificationView) => void;
}) {
  const m = ntfMeta(n);
  const timeZone = useViewerTimeZone();
  const metaLine = [
    n.projectName,
    n.taskKey,
    formatDayTime(n.occurredAt, new Date(), timeZone),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className={"ntf-item" + (n.unread ? "" : " read")}
      onClick={() => onOpen(n)}
    >
      <span className={"pev-ico " + m.cls}>
        <Icon name={m.icon} />
      </span>
      <span className="ntf-item-main">
        <span className="tt">{n.title || plainText(n.text)}</span>
        {n.title && <span className="tx">{plainText(n.text)}</span>}
        <span className="mt">{metaLine}</span>
      </span>
      {n.unread && <span className="unread-dot"></span>}
    </button>
  );
}
