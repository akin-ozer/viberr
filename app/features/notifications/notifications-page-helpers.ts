import { formatClock, formatDayBucket } from "~/shared/dates/format";
import type { NotificationView } from "./notification-item";

/** Page rows additionally render the producing actor (stream lines). */
export interface NotificationPageItem extends NotificationView {
  from: { name: string } | null;
}

export type NotificationFilter = "all" | "unread";

export function splitNotifications(
  items: NotificationPageItem[],
  f: NotificationFilter,
): { needs: NotificationPageItem[]; rest: NotificationPageItem[] } {
  const match = (n: NotificationPageItem) => (f === "unread" ? n.unread : true);
  return {
    needs: items.filter(
      (n) => (n.kind === "packet" || n.kind === "approval") && match(n),
    ),
    rest: items.filter(
      (n) => n.kind !== "packet" && n.kind !== "approval" && match(n),
    ),
  };
}

/** Needs-you card time: today → "10:31", else lowercased day + time
 * ("yesterday 16:04", "mar 30 14:00" — the mock lowercases the day). */
export function needsYouTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  return bucket === "Today" ? clock : bucket.toLowerCase() + " " + clock;
}
