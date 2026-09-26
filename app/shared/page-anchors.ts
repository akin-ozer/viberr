/**
 * Ruling 497: the places inside a page that a notification opens, in one home.
 * The page that renders an element takes its id from here, and so does the
 * notifier that links to it, so the two can never disagree about a spelling.
 * (A goal chain's anchor is its id, and a goal link's is `goalLinkAnchor`.)
 */

const EVENT_PREFIX = "event-";

/**
 * A timeline event's element id on the task page. An event carries no id of
 * its own: its time is what the task file and the projection both keep (the
 * projection's row id is renumbered by a rebuild).
 */
export function timelineEventAnchor(occurredAt: string): string {
  return `${EVENT_PREFIX}${occurredAt}`;
}

/** The time a {@link timelineEventAnchor} names, or null for any other id. */
export function timelineEventTime(anchor: string): string | null {
  if (!anchor.startsWith(EVENT_PREFIX)) return null;
  return anchor.slice(EVENT_PREFIX.length) || null;
}

/** The task page's open decision packet (an operator's, or an agent's question). */
export const TASK_DECISION_ANCHOR = "decision";

/** The task page's pending recommendations, each a decision to apply. */
export const TASK_RECOMMENDATIONS_ANCHOR = "recommendations";

/** The project Controller page's Proposals panel (ruling 483). */
export const KB_PROPOSALS_ANCHOR = "kb-proposals";

/** One open proposal's entry in that panel. */
export function proposalAnchor(id: string): string {
  return `proposal-${id}`;
}

/** The element id a URL's hash names; a hash that is not valid percent-encoding
 *  names nothing (it is read while rendering, so it must not throw). */
export function hashTarget(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}
