/**
 * Timeline progressive disclosure (task-detail NFR: don't ship the full
 * history in the first payload). The loader serves a bounded newest-first
 * slice; "Show older" raises the `?events=` URL param by one step and the
 * loader re-slices. Pure and client-safe so the route and tests share it.
 */

const TIMELINE_INITIAL_SLICE = 30;
const TIMELINE_SLICE_STEP = 30;

/** Parses the `?events=` param; anything unusable → the initial slice. */
export function clampTimelineLimit(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return TIMELINE_INITIAL_SLICE;
  if (n < 1) return TIMELINE_INITIAL_SLICE;
  // Upper bound keeps a hostile ?events=1e9 from being meaningful; the
  // slice itself is naturally capped at the event count.
  return Math.min(n, 10_000);
}

export interface TimelineSlice<T> {
  events: T[];
  total: number;
  hasMore: boolean;
  /** How many older events are hidden (0 when !hasMore). */
  remaining: number;
  /** The `?events=` value the "Show older" affordance should request. */
  nextLimit: number;
}

/** How many events a slice for `limit` shows — the SQL `LIMIT` a reader that
 *  fetches only the shipped window uses (ruling 457). */
export function timelineWindowSize(limit: number): number {
  return Math.max(1, limit);
}

/**
 * Newest-first input (file order) → bounded newest-first slice, given the full
 * `total`. `events` may be a window already cut to at least
 * {@link timelineWindowSize} newest events: the slice is the same, without
 * reading the older events it would drop.
 */
export function timelineSlice<T>(events: T[], total: number, limit: number): TimelineSlice<T> {
  const shown = Math.min(total, timelineWindowSize(limit));
  const hasMore = total > shown;
  return {
    events: events.slice(0, shown),
    total,
    hasMore,
    remaining: total - shown,
    nextLimit: hasMore ? Math.min(total, shown + TIMELINE_SLICE_STEP) : shown,
  };
}
