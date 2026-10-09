import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { timelineEventTime } from "~/shared/page-anchors";
import type { TimelineFilterId } from "./timeline";

/**
 * What the timeline reads off its rows and its tab (ruling 13(b), the split
 * of `timeline.tsx` along the task page's recipe): which events a filter tab
 * shows, whether a hash names an event, and what the list says when it shows
 * none. Pure functions, no React; `Timeline` and its hooks in
 * `timeline-actions.ts` call them.
 */

/** Whether the filter tab `f` shows `ev`. */
export function shownBy(f: TimelineFilterId, ev: Pick<TimelineEventRender, "type">): boolean {
  return f === "all" ? true : f === "comment" ? ev.type === "comment" : ev.type !== "comment";
}

/** Ruling 75: a notification about an event links to it (`#event-<time>`). */
export function isEventAnchor(id: string): boolean {
  return timelineEventTime(id) !== null;
}

/** What the list says when the active tab shows none of the `eventCount`
 *  events loaded (UI-40: an empty tab is not an empty history). */
export function emptyTimelineText(
  eventCount: number,
  runLive: boolean | undefined,
  f: TimelineFilterId,
): string {
  return eventCount === 0
    ? runLive
      ? // U33-1: the loop HAS started — the Live-run strip on this
        //  same page is showing its progress. Saying "hasn't started"
        //  here contradicted it, and contradicted ruling 152's whole
        //  point (a healthy pre-run phase must be distinguishable from
        //  a wedged one). An empty timeline under a live run is the
        //  normal first seconds: the run has not reported yet.
        "The loop has started. Its first events land here as the live run above reports in."
      : "No activity yet. This task hasn't started its operator loop."
    : f === "comment"
      ? "No comments in the loaded history. Switch to All, or load older events."
      : // F18-14: "governance" is a banned UI word (copy-ban.test.ts);
        // this is the "Important" filter's empty state, so name that tab.
        "No important events in the loaded history. Switch to All, or load older events.";
}
