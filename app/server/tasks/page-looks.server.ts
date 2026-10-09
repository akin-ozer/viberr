import { readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { deliveredAsFiles, type ParsedTaskFile } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keptDeliveryDir } from "~/server/files/kept-deliveries.server";
import {
  IMAGE_READ_MAX_BYTES,
  imageHeader,
  readAttachmentBytes,
  resolveTaskAttachment,
} from "~/server/files/task-attachments.server";
import { readTaskSources, type TaskSource } from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { getRun, patchRun } from "~/server/runtimes/run-store.server";
import { toError } from "~/shared/errors";
import {
  PAGE_CAPTURE_VIEWS,
  pageCaptureView,
  pageKindOf,
  pageOfCaptureName,
  viewOfCaptureName,
  type PageCaptureViewId,
} from "~/shared/page-capture";
import { measuredLine } from "~/shared/page-measure";
import { taskRef, type TaskMutationContext } from "./task-mutation.server";
import { deliverersOwnFileNames } from "./task-replies.server";

/**
 * Ruling 329: **an approval of a page binds only from a run that looked at it.**
 *
 * A files delivery that holds a page is judged from pictures (ruling 86), and
 * nothing held a reviewer to them: a run that read the page's source, or the
 * deliverer's report, could record `approve` and release the task. A reviewer
 * that looked at the page and never at the reference it was made to look
 * like could do the same.
 *
 * So every reader that hands a run a picture writes down what it showed
 * ({@link recordRunLooks}: a stretch of a task page from `capture_page`, one of
 * the pictures Viberr kept of a delivery, a kept source opened as an image),
 * and a run's `approve` is recorded only when that list covers what it judged
 * ({@link pageLooksOwed}):
 *
 *  - **each page of the delivery, whole, at both widths.** The pages are the
 *    HTML files the task's deliverer saved, as the kept delivery holds them. A
 *    page counts as seen at a width when the pictures the run was shown there
 *    run from its top to its end with no gap. A picture taller than a stretch
 *    (`PAGE_LOOK_MAX_PX`) is not a look: a model is handed it shrunk until its
 *    words cannot be read, which is how a kept picture of a long page looks.
 *  - **every stretch of every look the task keeps** (ruling 327: a page on the
 *    web as Viberr pictured it, which is what the result is judged against).
 *
 * A `request_changes` owes nothing: a fault found in the source is a fault.
 * Markdown is left out on purpose. Viberr sets a markdown file as an article
 * in its own type, so its picture shows the piece and not a look its writer
 * made, and a board that delivers prose reads its notes as text.
 */

/** The tallest picture that counts as a look, in px: `capture_page`'s stretch,
 *  the size a model reads. */
export const PAGE_LOOK_MAX_PX = 2_000;
/** How many looks one run's record holds; the oldest go first. */
const RUN_LOOKS_MAX = 600;

const viewSchema = z.enum(["desktop", "phone"]);
const runLookSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    task: z.string(),
    /** The page's name among the task's files. */
    file: z.string(),
    view: viewSchema,
    /** Where on the page the picture starts and ends, in px. */
    from: z.number().min(0),
    to: z.number().min(0),
    /** The page ends inside the picture. */
    end: z.boolean(),
    /** The delivery a kept picture is of; null for the task's files as they
     *  stood when `capture_page` rendered them. */
    delivery: z.string().nullable(),
  }),
  z.object({ kind: z.literal("source"), task: z.string(), id: z.string() }),
]);
export type RunLook = z.infer<typeof runLookSchema>;

function parseLooks(stored: string | null | undefined): RunLook[] {
  if (!stored) return [];
  try {
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(stored));
    if (!parsed.success) return [];
    return parsed.data.flatMap((entry) => {
      const look = runLookSchema.safeParse(entry);
      return look.success ? [look.data] : [];
    });
  } catch {
    return [];
  }
}

/** What run `runId` has been shown so far. */
export function runLooks(db: DatabaseSync, runId: string): RunLook[] {
  return parseLooks(getRun(db, runId)?.looked_json);
}

/**
 * Write down what a reader has just shown a run. Never throws: a look that
 * cannot be recorded must not fail the read that made it, and the run is told
 * what its approval still owes when it completes.
 */
export function recordRunLooks(db: DatabaseSync, runId: string | null | undefined, looks: readonly RunLook[]): void {
  if (!runId || looks.length === 0) return;
  try {
    const row = getRun(db, runId);
    if (!row) return;
    const next = [...parseLooks(row.looked_json), ...looks].slice(-RUN_LOOKS_MAX);
    patchRun(db, runId, { lookedJson: JSON.stringify(next) });
  } catch (error) {
    logger.warn("what a run looked at could not be recorded", { runId, err: toError(error) });
  }
}

/**
 * The runs whose looks an approval from `runId` rests on: itself, and the
 * earlier runs of the session it continued, while they judged the same
 * subject on the same task and no compaction came between. A resumed review
 * still holds the pictures its earlier turns were shown; one told what it had
 * not opened opens only that, and held to its own run's list it would never
 * be seen to have looked at the whole. A compaction replaces what a session
 * was shown with a summary of it, so nothing before one counts.
 */
export function looksRunIds(db: DatabaseSync, runId: string): string[] {
  const run = getRun(db, runId);
  if (!run?.session_id) return [runId];
  // SAFETY: the SELECT list is `id` (TEXT NOT NULL), `review_subject`
  // (nullable TEXT) and `compactions` (INTEGER NOT NULL) of `agent_runs`.
  const session = db
    .prepare(
      `SELECT id, review_subject, compactions FROM agent_runs
        WHERE session_id = ? AND project_slug = ? AND task_key = ? ORDER BY created_at, rowid`,
    )
    .all(run.session_id, run.project_slug, run.task_key) as { id: string; review_subject: string | null; compactions: number }[];
  let ids: string[] = [];
  for (const row of session) {
    // Another subject, or a compaction: what was seen before does not carry.
    if (row.review_subject !== run.review_subject || row.compactions > 0) ids = [];
    ids.push(row.id);
    if (row.id === runId) break;
  }
  return ids.includes(runId) ? ids : [runId];
}

/** One look a task keeps: the stretches of one page on the web. */
export interface KeptLook {
  url: string;
  at: string;
  stretches: { id: string; view: PageCaptureViewId }[];
}

/** The looks among a task's sources (ruling 327), oldest first. */
export function keptLooks(sources: readonly TaskSource[]): KeptLook[] {
  const looks = new Map<string, KeptLook>();
  for (const source of sources) {
    const look = source.look;
    if (!look) continue;
    const key = `${look.at}\n${look.url}`;
    const kept = looks.get(key) ?? { url: look.url, at: look.at, stretches: [] };
    if (look.part === "stretch" && look.view) kept.stretches.push({ id: source.id, view: look.view });
    looks.set(key, kept);
  }
  return [...looks.values()].filter((look) => look.stretches.length > 0);
}

/** What an approval of a task's delivery owes a look at. */
export interface PageLooksOwed {
  taskKey: string;
  /** The files delivery under review. */
  deliveredAt: string;
  /** Its pages: the HTML files the deliverer saved, as the kept delivery holds them. */
  pages: string[];
  looks: KeptLook[];
  /** Ruling 328: what Viberr measured of those pages as it pictured this
   *  delivery, one line a page; empty while the render has not finished. */
  measured: { file: string; line: string }[];
}

/** The names a folder holds; none when it cannot be listed. */
function listed(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * What an approval of this task's delivery owes a look at, or null when it
 * owes none: the delivery is a revision or nothing was delivered, and the
 * task keeps no look; or it is files with no page of the deliverer's among
 * them and no look.
 */
export function pageLooksOwed(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  parsed: ParsedTaskFile,
): PageLooksOwed | null {
  const fm = parsed.frontmatter;
  if (!fm.deliveredAt || !deliveredAsFiles(fm)) return null;
  const own = deliverersOwnFileNames(fm, parsed.timeline);
  const kept = listed(keptDeliveryDir(projectSlug, taskKey, fm.deliveredAt, ctx.dataRoot));
  // A delivery whose copy could not be kept (ruling 86) is still the files on
  // the task: the pages are read from there.
  const held = kept.length > 0 ? kept : listed(taskAttachmentsDir(projectSlug, taskKey, ctx.dataRoot));
  const pages = held.filter((name) => own.has(name) && pageKindOf(name) === "html").sort();
  const looks = keptLooks(readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources);
  if (pages.length === 0 && looks.length === 0) return null;
  const record = fm.pageCaptures?.deliveredAt === fm.deliveredAt ? fm.pageCaptures : null;
  const measured = (record?.pages ?? []).flatMap((page) =>
    page.measured && pages.includes(page.file) ? [{ file: page.file, line: measuredLine(page.measured) }] : [],
  );
  return { taskKey, deliveredAt: fm.deliveredAt, pages, looks, measured };
}

const same = (a: string, b: string): boolean => a.normalize("NFC") === b.normalize("NFC");
const px = (n: number): string => Math.round(n).toLocaleString("en-US");
const code = (name: string): string => `\`${name}\``;
const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * How far down a page a run's pictures of it run with no gap, from its top;
 * `whole` once they reach its end.
 */
function seenTo(looks: readonly Extract<RunLook, { kind: "page" }>[]) {
  const ordered = [...looks].sort((a, b) => a.from - b.from);
  let to = 0;
  let whole = false;
  for (const look of ordered) {
    // One px of slack: a stretch that starts where the last ended is no gap.
    if (look.from > to + 1) break;
    if (look.to >= to) {
      to = look.to;
      whole = look.end;
    }
    if (whole) break;
  }
  return { to, whole };
}

/**
 * What `owed` still lacks in `looks`, each as a clause a note and a prompt can
 * print; empty when the run looked at everything its approval rests on.
 */
export function unmetPageLooks(owed: PageLooksOwed, looks: readonly RunLook[]): string[] {
  const unmet: string[] = [];
  for (const page of owed.pages) {
    for (const view of PAGE_CAPTURE_VIEWS) {
      const mine = looks.filter(
        (look): look is Extract<RunLook, { kind: "page" }> =>
          look.kind === "page" &&
          look.task === owed.taskKey &&
          look.view === view.id &&
          same(look.file, page) &&
          // A kept picture is of one delivery; this one, or it shows another.
          (look.delivery === null || look.delivery === owed.deliveredAt) &&
          look.to - look.from <= PAGE_LOOK_MAX_PX,
      );
      const seen = seenTo(mine);
      if (seen.whole) continue;
      unmet.push(
        seen.to === 0
          ? `${code(page)} at the ${view.id} width (${view.width} px)`
          : `${code(page)} at the ${view.id} width (${view.width} px) below ${px(seen.to)} px, where the page runs on`,
      );
    }
  }
  for (const look of owed.looks) {
    const opened = new Set(
      looks.flatMap((entry) => (entry.kind === "source" && entry.task === owed.taskKey ? [entry.id] : [])),
    );
    const missing = look.stretches.filter((stretch) => !opened.has(stretch.id)).map((stretch) => stretch.id);
    if (missing.length > 0) {
      unmet.push(`${missing.length === 1 ? "picture" : "pictures"} ${LIST_AND.format(missing)} of ${look.url} as it was kept on ${look.at.slice(0, 10)}`);
    }
  }
  return unmet;
}

/** How a run looks at a page and at a kept look, in one sentence each: said
 *  to a reviewer before it starts and in the note when it did not. */
const HOW_TO_LOOK =
  "A page is looked at with `capture_page`: its name, one `view` at a time, reading on from each `nextFrom` until the reply says the page ends. " +
  "A look the task keeps is opened picture by picture with `read_task_source`.";

/** Source ids as a sentence names them: "S4 to S9" for three or more that
 *  run on, each id by itself otherwise, so "S1 to S3 and S5 to S7". */
export function idRange(ids: readonly string[]): string {
  const runs: string[][] = [];
  for (const id of ids) {
    const run = runs.at(-1);
    if (run && Number(id.slice(1)) === Number(run.at(-1)!.slice(1)) + 1) run.push(id);
    else runs.push([id]);
  }
  return LIST_AND.format(runs.flatMap((run) => (run.length > 2 ? [`${run[0]} to ${run.at(-1)}`] : run)));
}

/**
 * What a run that may approve is told before it starts (ruling 329), so the
 * rule is never learned from a verdict that did not bind.
 */
export function pageLooksNote(owed: PageLooksOwed): string {
  const parts: string[] = [];
  if (owed.pages.length > 0) {
    parts.push(
      `${LIST_AND.format(owed.pages.map(code))}, whole, at the desktop width (${pageCaptureView("desktop").width} px) and at the phone width (${pageCaptureView("phone").width} px)`,
    );
  }
  for (const look of owed.looks) {
    parts.push(
      `every picture of ${look.url} as this task kept it on ${look.at.slice(0, 10)} (${idRange(look.stretches.map((s) => s.id))})`,
    );
  }
  return (
    `- An approval here binds only from a run that looked. Before you approve, look at ${parts.join(", and at ")}. ` +
    HOW_TO_LOOK +
    (owed.looks.length > 0
      ? " Set the page beside those kept pictures section by section: they are what it is judged against, never the address as it reads today and never anyone's description of it."
      : "") +
    " An approval from a run that did not look is not recorded, and the review runs again. A `request_changes` owes no look." +
    (owed.measured.length > 0
      ? ` What Viberr measured as it pictured this delivery: ${owed.measured.map((page) => `${code(page.file)}: ${page.line}`).join(" ")} ` +
        "The delivery's \"Page captures\" note names each element (`read_timeline_entry`), and a fault it found is a finding until a delivery measures without it."
      : "")
  );
}

/** The title of that note: what the timeline and the operator read first. */
export const PAGE_LOOKS_NOTE_TITLE = "Approval not recorded";

/** The note written when an approval did not bind for want of a look. */
export function pageLooksRefusalNote(reviewer: string, unmet: readonly string[]): string {
  return (
    `${reviewer}'s approval was not recorded: the run did not look at ${unmet.join("; ")}. ` +
    "An approval of a page binds only from a run that looked at the whole page at both widths and at every picture of a look the task keeps. " +
    HOW_TO_LOOK +
    " Validation is unchanged and acceptance stays gated: run the review again."
  );
}

const readInputSchema = z.looseObject({ file_path: z.string() });
const toolUseSchema = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
const toolResultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  // A result is a string or a list of blocks; only a list can hold a picture.
  content: z.array(z.looseObject({ type: z.string() })).catch([]),
});
const envelopeSchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});

/**
 * The look a run takes when it opens one of the pictures Viberr kept of a
 * delivery (`<page>.capture-<view>.png`, ruling 86), or null when `name` is
 * not one the task's record names: how tall it is by its own header, whether
 * the page ends inside it by the record's `cut`, and which delivery it is of.
 */
export function keptPictureLook(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  name: string,
): RunLook | null {
  const view = viewOfCaptureName(name);
  if (!view) return null;
  const record = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter.pageCaptures;
  const shot = record?.pages.flatMap((page) => page.shots).find((entry) => same(entry.name, name));
  if (!record || !shot) return null;
  let height: number | null = null;
  try {
    const read = readAttachmentBytes(resolveTaskAttachment(projectSlug, taskKey, name, ctx.dataRoot), IMAGE_READ_MAX_BYTES);
    height = read && "bytes" in read ? (imageHeader(read.bytes)?.height ?? null) : null;
  } catch {
    height = null;
  }
  if (height === null) return null;
  return {
    kind: "page",
    task: taskKey,
    file: pageOfCaptureName(name),
    view,
    from: 0,
    to: height,
    end: !shot.cut,
    delivery: record.deliveredAt,
  };
}

/**
 * The looks a Claude run took with its own file reader: a picture Viberr kept
 * of a delivery, or a kept source, opened by its path. The run's log is its
 * record (ruling 165), and `Read` hands a model an image as `capture_page`
 * does, so a reviewer that opened the kept pictures that way has looked.
 */
export function looksFromRunLog(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; runId: string },
): RunLook[] {
  const attachments = taskAttachmentsDir(input.projectSlug, input.taskKey, ctx.dataRoot);
  const sources = path.join(taskDir(input.projectSlug, input.taskKey, ctx.dataRoot), "sources");
  const asked = new Map<string, string>();
  const looks: RunLook[] = [];
  // SAFETY: the SELECT list is the single column `raw_json`, which
  // `run_log_lines` declares TEXT NOT NULL in 0001_baseline.
  const rows = db
    .prepare(`SELECT raw_json FROM run_log_lines WHERE run_id = ? AND raw_json LIKE '%tool_%' ORDER BY seq`)
    .all(input.runId) as { raw_json: string }[];
  for (const row of rows) {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(row.raw_json));
      if (!parsed.success) continue;
      envelope = parsed.data;
    } catch {
      continue;
    }
    for (const block of envelope.message.content) {
      const use = toolUseSchema.safeParse(block);
      if (use.success && use.data.name === "Read") {
        const read = readInputSchema.safeParse(use.data.input);
        if (read.success) asked.set(use.data.id, read.data.file_path);
        continue;
      }
      const result = toolResultSchema.safeParse(block);
      // A picture the model was really handed: an image block in the result.
      const handed = result.success && result.data.is_error !== true && result.data.content.some((part) => part.type === "image");
      if (!result.success || !handed) continue;
      const file = asked.get(result.data.tool_use_id);
      if (!file) continue;
      const dir = path.dirname(file);
      const name = path.basename(file);
      if (dir === sources) {
        const id = /^(S[1-9]\d{0,5})(?:\.[a-z0-9]{1,10})?$/.exec(name)?.[1];
        if (id) looks.push({ kind: "source", task: input.taskKey, id });
      } else if (dir === attachments) {
        const look = keptPictureLook(ctx, input.projectSlug, input.taskKey, name);
        if (look) looks.push(look);
      }
    }
  }
  return looks;
}
