/**
 * Ruling 521: the completion packet's rules, shared by the operator's writer
 * (`completion-packet.server.ts`) and the task page that shows it, so the two
 * never disagree about when a change is small enough to show whole.
 *
 * Client-safe: no server import.
 */

/**
 * A change of at most this many lines (added plus removed, as the pull
 * request counts them) is shown in full on the completion packet; a larger one
 * is shown as the operator's summary of it, with the full diff one press away.
 * The owner asked for "full if small, summary if not" and left the line to us.
 */
export const COMPLETION_SMALL_CHANGE_LINES = 200;

/** The operator's summary of the work, in characters. */
export const COMPLETION_SUMMARY_MAX = 4000;
/** The operator's summary of the code changes, in characters. */
export const COMPLETION_CHANGES_MAX = 4000;
/** How many screenshots one packet may show. */
export const COMPLETION_SCREENSHOTS_MAX = 6;
/** One screenshot's caption, in characters. */
export const COMPLETION_CAPTION_MAX = 200;

/** The change stats a task records (`github.changed`, the PR's own counts). */
export interface ChangeStats {
  files: number;
  add: number;
  del: number;
}

/** Lines the change adds and removes, or null when nobody has counted them. */
export function changedLines(changed: ChangeStats | null | undefined): number | null {
  if (!changed) return null;
  return Math.max(0, changed.add) + Math.max(0, changed.del);
}

/** True when the change is small enough to show whole, false when it is not,
 *  and null when its size is not known. */
export function isSmallChange(changed: ChangeStats | null | undefined): boolean | null {
  const lines = changedLines(changed);
  return lines === null ? null : lines <= COMPLETION_SMALL_CHANGE_LINES;
}
