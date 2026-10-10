import { z } from "zod";
import type { PageCaptures } from "~/schemas/task-file.schema";

/**
 * Ruling 328: what Viberr measured of one pictured page, as a task's record
 * keeps it and as one line says it.
 *
 * The render that pictures a delivered page also measures it, and the record
 * keeps the figures a later reader compares: the page's weight and load time,
 * and at each width how many kinds of accessibility fault the checks found,
 * how many controls the keyboard did not reach or that showed nothing on
 * focus, and how many things still moved with reduced motion asked for. The
 * sentences that name each element are in the delivery's note.
 *
 * Server-only on purpose. The task file's own schema is loaded by the browser
 * too, and keeps `measured` as it is written without reading its shape; the
 * readers here are the note, the completion packet and the review's prompt.
 */

const pageMeasuredSchema = z
  .object({
    weightBytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    loadMs: z.number().nonnegative().nullable().default(null),
    line: z.string().default(""),
    views: z
      .array(
        z
          .object({
            view: z.enum(["desktop", "phone"]),
            faultKinds: z.number().int().nonnegative().nullable().default(null),
            faultElements: z.number().int().nonnegative().nullable().default(null),
            worstContrast: z.number().positive().nullable().default(null),
            // Null where that check did not run: not measured, not clean.
            controls: z.number().int().nonnegative().nullable().default(null),
            unreached: z.number().int().nonnegative().nullable().default(null),
            unmarked: z.number().int().nonnegative().nullable().default(null),
            stillMoving: z.number().int().nonnegative().nullable().default(null),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

export type PageMeasuredRecord = z.infer<typeof pageMeasuredSchema>;

type MeasuredViewRecord = PageMeasuredRecord["views"][number];

/** What a page's entry of `pageCaptures` holds as measured, or null when it
 *  holds none or one that does not read as a record. */
export function measuredOf(page: PageCaptures["pages"][number]): PageMeasuredRecord | null {
  const parsed = pageMeasuredSchema.safeParse(page.measured);
  return parsed.success ? parsed.data : null;
}

const revisionRecordSchema = z.looseObject({ revisionId: z.string().min(1) });

/** Ruling 86: the revision a record's pictures are of, when they are of the
 *  pages a revision builds; null for the pictures of a files delivery. Read
 *  here like `measured`: the browser's schema keeps the key and does not
 *  declare it. */
export function capturesRevision(record: PageCaptures | null | undefined): string | null {
  const read = revisionRecordSchema.safeParse(record);
  return read.success ? read.data.revisionId : null;
}

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
      `${view.faultKinds} ${view.faultKinds === 1 ? "kind" : "kinds"} of accessibility fault in ${view.faultElements} ${view.faultElements === 1 ? "place" : "places"}` +
        (view.worstContrast === null ? "" : ` (lowest contrast ${view.worstContrast.toFixed(1)} to 1)`),
    );
  }
  if (view.controls === null) parts.push("the keyboard's reach not measured");
  else {
    if (view.unreached === null) parts.push(`the keyboard's walk cut short of ${view.controls} controls`);
    else if (view.unreached > 0) parts.push(`${view.unreached} of ${view.controls} controls the keyboard does not reach`);
    if (view.unmarked !== null && view.unmarked > 0) parts.push(`${view.unmarked} that show nothing when they take focus`);
  }
  if (view.stillMoving === null) parts.push("reduced motion not measured");
  else if (view.stillMoving > 0) parts.push(`${view.stillMoving} still moving with reduced motion asked for`);
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
