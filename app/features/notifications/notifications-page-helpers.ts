import {
  formatClock,
  formatClockUTC,
  formatDayBucket,
  formatDayBucketUTC,
} from "~/shared/dates/format";
import type { NotificationView } from "./notification-item";

/** Page rows additionally render the producing actor (stream lines). */
export interface NotificationPageItem extends NotificationView {
  from: { name: string } | null;
  /** The decision is still pending on the LIVE task record (loader-computed,
   * F7-NOTIF1) — resolved/applied/Done decisions leave "Waiting on you". */
  waitingOnYou: boolean;
}

export type NotificationFilter = "all" | "unread";

/** The two streams the page renders, and the count its header states. */
export interface NotificationSplit {
  needs: NotificationPageItem[];
  rest: NotificationPageItem[];
  /** UI-54: pending decisions IGNORING the All/Unread filter — what the panel
   *  header must count. */
  needsTotal: number;
}

/** "Waiting on you" holds only LIVE pending decisions (F7-NOTIF1): a decision
 * row (packet, agent question, approval) whose decision was since resolved
 * falls through to the ordinary stream — never deleted, never auto-read. */
export function splitNotifications(
  items: NotificationPageItem[],
  f: NotificationFilter,
): NotificationSplit {
  const match = (n: NotificationPageItem) => (f === "unread" ? n.unread : true);
  // The server decides which kinds can wait on you (`listNotifications` sets
  // `waitingOnYou` only on `DECISION_NOTIFICATION_KINDS`, ruling 74); a
  // second copy of that set here missed the agent question.
  // R8-3: exactly one "Waiting on you" card per task — a task needs one human
  // action, so a superseded packet's leftover notification (or a stale approval
  // beside a newer packet) must NOT show as a second pending decision. Items are
  // newest-first, so the first waiting row per task wins; the rest fall to the
  // ordinary stream (never deleted, never auto-read).
  //
  // UI-54: the split now runs over EVERY item and the All/Unread filter is
  // applied afterwards. Filtering first meant three READ pending decisions under
  // the Unread filter rendered "0 decisions · Nothing is waiting on you" — the
  // filter is a view of the stream, not a statement about what still needs a
  // human. (It also made the per-task dedupe depend on the filter.)
  const seenTasks = new Set<string>();
  const needsAll: NotificationPageItem[] = [];
  const restAll: NotificationPageItem[] = [];
  for (const n of items) {
    const taskKey =
      n.projectSlug && n.taskKey ? `${n.projectSlug}::${n.taskKey}` : null;
    if (n.waitingOnYou && (!taskKey || !seenTasks.has(taskKey))) {
      if (taskKey) seenTasks.add(taskKey);
      needsAll.push(n);
    } else {
      restAll.push(n);
    }
  }
  return {
    needs: needsAll.filter(match),
    rest: restAll.filter(match),
    needsTotal: needsAll.length,
  };
}

/** Needs-you card time: today → "10:31", else lowercased day + time
 * ("yesterday 16:04", "mar 30 14:00" — the mock lowercases the day). */
export function needsYouTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  return bucket === "Today" ? clock : bucket.toLowerCase() + " " + clock;
}

/** The SSR/first-pass form of {@link needsYouTime}: absolute UTC, so the
 *  server and the client's first render agree whatever timezone the viewer is
 *  in. The stream panel beside this one has rendered *UTC first and swapped to
 *  local on `useHydrated` since UXA-5; the "Waiting on you" card was the last
 *  site in the file still printing viewer-local time straight from SSR, which
 *  mismatched on hydration for every viewer outside the server's zone. */
export function needsYouTimeUTC(iso: string): string {
  return formatDayBucketUTC(iso).toLowerCase() + " " + formatClockUTC(iso);
}

/** The "Waiting on you" header's tail after "N decisions" (ruling 13(b), the
 *  split of `NtfNeedsYou`): what the authoritative count holds that the card
 *  does not list, the rows the filter hides and the decisions with no row
 *  here. Empty when the card lists every one. */
export function needsYouCountTail(hiddenByFilter: number, onTaskPages: number): string {
  const subParts = [
    hiddenByFilter > 0 ? `${hiddenByFilter} hidden by the filter` : null,
    onTaskPages > 0 ? `${onTaskPages} on their task pages` : null,
  ].filter(Boolean);
  return subParts.length > 0 ? ` · ${subParts.join(" · ")}` : "";
}

/** What the "Waiting on you" card says when it lists nothing (ruling 13(b),
 *  the split of `NtfNeedsYou`): nothing waits; or decisions wait that the
 *  filter hides; or decisions wait that have no row here. */
export function needsYouEmptyText(decisionCount: number, hiddenByFilter: number): string {
  return decisionCount === 0
    ? "Nothing is waiting on you."
    : hiddenByFilter > 0
      ? `${decisionCount} decision${decisionCount === 1 ? " is" : "s are"} waiting on you. Switch to "All" to see ${decisionCount === 1 ? "it" : "them"}.`
      : `${decisionCount} decision${decisionCount === 1 ? " is" : "s are"} waiting on you. Open ${decisionCount === 1 ? "it" : "them"} from the board or the task page.`;
}
