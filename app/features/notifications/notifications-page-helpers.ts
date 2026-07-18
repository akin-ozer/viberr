import { formatClock, formatDayBucket } from "~/shared/dates/format";
import type { NotificationView } from "./notification-item";

/** Page rows additionally render the producing actor (stream lines). */
export interface NotificationPageItem extends NotificationView {
  from: { name: string } | null;
  /** The decision is still pending on the LIVE task record (loader-computed,
   * F7-NOTIF1) — resolved/applied/Done decisions leave "Waiting on you". */
  waitingOnYou: boolean;
}

export type NotificationFilter = "all" | "unread";

/** "Waiting on you" holds only LIVE pending decisions (F7-NOTIF1): a packet/
 * approval row whose decision was since resolved falls through to the
 * ordinary stream — never deleted, never auto-read. */
export function splitNotifications(
  items: NotificationPageItem[],
  f: NotificationFilter,
): { needs: NotificationPageItem[]; rest: NotificationPageItem[] } {
  const match = (n: NotificationPageItem) => (f === "unread" ? n.unread : true);
  const needsYou = (n: NotificationPageItem) =>
    (n.kind === "packet" || n.kind === "approval") && n.waitingOnYou;
  // R8-3: exactly one "Waiting on you" card per task — a task needs one human
  // action, so a superseded packet's leftover notification (or a stale approval
  // beside a newer packet) must NOT show as a second pending decision. Items are
  // newest-first, so the first waiting row per task wins; the rest fall to the
  // ordinary stream (never deleted, never auto-read).
  const seenTasks = new Set<string>();
  const needs: NotificationPageItem[] = [];
  const rest: NotificationPageItem[] = [];
  for (const n of items) {
    if (!match(n)) continue;
    const taskKey =
      n.projectSlug && n.taskKey ? `${n.projectSlug}::${n.taskKey}` : null;
    if (needsYou(n) && (!taskKey || !seenTasks.has(taskKey))) {
      if (taskKey) seenTasks.add(taskKey);
      needs.push(n);
    } else {
      rest.push(n);
    }
  }
  return { needs, rest };
}

/** Needs-you card time: today → "10:31", else lowercased day + time
 * ("yesterday 16:04", "mar 30 14:00" — the mock lowercases the day). */
export function needsYouTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  return bucket === "Today" ? clock : bucket.toLowerCase() + " " + clock;
}
