import type { PageMeasuredRecord } from "~/schemas/task-file.schema";

/**
 * Ruling 328: what Viberr measured of one pictured page, as a task's record
 * keeps it and as one line says it.
 *
 * The render that pictures a delivered page also measures it, and the record
 * keeps the figures a later reader compares: the page's weight and load time,
 * and at each width how many kinds of accessibility fault the checks found,
 * how many controls the keyboard did not reach or that showed nothing on
 * focus, and how many things still moved with reduced motion asked for. The
 * sentences that name each element are in the delivery's note. Client-safe:
 * the result card may print the line.
 */

type MeasuredViewRecord = PageMeasuredRecord["views"][number];

const WIDTH = { desktop: 1280, phone: 390 } as const;

/** "412 KB", "1.2 MB". */
export function weightText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "1.8 s". */
export function loadText(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** What one width's figures say, or null when they hold nothing to say. */
function viewClause(view: MeasuredViewRecord): string | null {
  const parts: string[] = [];
  if (view.faultKinds === null) parts.push("accessibility checks not run");
  else if (view.faultKinds > 0) {
    parts.push(
      `${view.faultKinds} ${view.faultKinds === 1 ? "kind" : "kinds"} of accessibility fault on ${view.faultElements} ${view.faultElements === 1 ? "element" : "elements"}` +
        (view.worstContrast === null ? "" : ` (lowest contrast ${view.worstContrast.toFixed(1)} to 1)`),
    );
  }
  if (view.unreached > 0) parts.push(`${view.unreached} of ${view.controls} controls the keyboard does not reach`);
  if (view.unmarked > 0) parts.push(`${view.unmarked} that show nothing when they take focus`);
  if (view.stillMoving > 0) parts.push(`${view.stillMoving} still moving with reduced motion asked for`);
  return parts.length > 0 ? `at ${WIDTH[view.view]} px ${parts.join(", ")}` : null;
}

/** One line for a page's figures: its weight and load, then what was found
 *  at each width, or that nothing was. */
export function measuredLine(measured: PageMeasuredRecord): string {
  const size = `${weightText(measured.weightBytes)} in ${measured.files} ${measured.files === 1 ? "file" : "files"}`;
  const load =
    measured.loadMs === null ? "load time not measured" : `loads in ${loadText(measured.loadMs)} on a slow phone line (${measured.line})`;
  const found = measured.views.flatMap((view) => viewClause(view) ?? []);
  return `${size}; ${load}; ${found.length > 0 ? found.join("; ") : "the checks at both widths found nothing"}.`;
}
