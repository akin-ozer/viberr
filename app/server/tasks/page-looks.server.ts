import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { deliveredAsFiles, type ParsedTaskFile } from "~/schemas/task-file.schema";
import { resolveStoredSegment, taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keptDeliveryDir } from "~/server/files/kept-deliveries.server";
import {
  IMAGE_READ_MAX_BYTES,
  imageHeader,
  readAttachmentBytes,
  resolveTaskAttachment,
} from "~/server/files/task-attachments.server";
import {
  readTaskSources,
  resolveTaskSource,
  type LookPicture,
  type TaskSource,
} from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { getRun, patchRun } from "~/server/runtimes/run-store.server";
import { COMPACTION_LINE_TAG } from "~/server/runtimes/wire-format.server";
import { toError } from "~/shared/errors";
import {
  PAGE_CAPTURE_MAX_FROM,
  PAGE_CAPTURE_VIEWS,
  pageCaptureView,
  pageKindOf,
  pageOfCaptureName,
  viewOfCaptureName,
  type PageCaptureViewId,
} from "~/shared/page-capture";
import { measuredLine, measuredOf } from "./page-measured.server";
import { taskRef, type TaskMutationContext } from "./task-mutation.server";
import { filesClaimedBy } from "./task-replies.server";

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
 *    HTML files an agent saved while it was the task's deliverer, as the kept
 *    delivery holds them. A page counts as seen at a width when the pictures
 *    the run was shown there run from its top to its end with no gap. A
 *    picture taller than a stretch (`PAGE_LOOK_MAX_PX`) is not a look: a model
 *    is handed it shrunk until its words cannot be read, which is how a kept
 *    picture of a long page looks.
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
    /** The delivery the picture is of: a kept picture's own, and for a
     *  stretch `capture_page` rendered the task's delivery when its files
     *  were then as delivered. Null when they were not, or nothing was
     *  delivered: such a look is of other bytes than a review judges. */
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
    // Its own looks are the ones since its last compaction: a run's list is
    // emptied when its context is replaced by a summary (`run-sink`), and its
    // log is read from that line on. So a run that was compacted while it
    // worked carries nothing over from the runs before it either.
    if (row.id === runId) return row.compactions > 0 ? [runId] : [...ids, runId];
    // What an earlier run was shown is a summary once it was compacted, at
    // its end (ruling 174) or before. Another subject's looks are of other work.
    if (row.review_subject !== run.review_subject || row.compactions > 0) ids = [];
    else ids.push(row.id);
  }
  return [runId];
}

/** One look a task keeps: the pictures of one page on the web. */
export interface KeptLook {
  url: string;
  at: string;
  /** The source that is its note. */
  note: string;
  /** Its stretches, each source once: what a judge opens to have seen it. */
  stretches: { id: string; view: PageCaptureViewId }[];
  /** Every picture of it as its note lists them, a repeated stretch included. */
  pictures: LookPicture[];
}

/**
 * The looks among a task's sources (ruling 327), oldest first. A look is its
 * note, which is written last and lists the look's pictures: pictures a keep
 * left with no note (a write that failed part way) are sources of no look,
 * are owed by nobody and do not stand in the way of a new one. A task keeps
 * one look of an address, the first one kept.
 */
export function keptLooks(sources: readonly TaskSource[]): KeptLook[] {
  const kept = new Set(sources.map((source) => source.id));
  const looks = new Map<string, KeptLook>();
  for (const source of sources) {
    const look = source.look;
    if (look?.part !== "note" || !look.pictures || looks.has(look.url)) continue;
    const pictures = look.pictures.filter((picture) => kept.has(picture.id));
    const stretches = new Map<string, PageCaptureViewId>();
    for (const picture of pictures) {
      if (picture.part === "stretch" && !stretches.has(picture.id)) stretches.set(picture.id, picture.view);
    }
    if (stretches.size === 0) continue;
    looks.set(look.url, {
      url: look.url,
      at: look.at,
      note: source.id,
      stretches: [...stretches].map(([id, view]) => ({ id, view })),
      pictures,
    });
  }
  return [...looks.values()];
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

/** The largest HTML page `capture_page` renders, in bytes. */
export const PAGE_HTML_MAX_BYTES = 10 * 1024 * 1024;

/** Whether a file is there and within `bytes`. */
function within(file: string, bytes: number): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= bytes;
  } catch {
    return false;
  }
}

/**
 * The agents whose files are the task's pages: its deliverer, and every agent
 * a run of the task was dispatched to deliver as. Delivery handed to another
 * agent leaves a page what it was, and the new deliverer has saved nothing
 * yet: counted by today's deliverer alone, such a page would be owed by
 * nobody until it was saved again.
 */
function deliverersOf(db: DatabaseSync, projectSlug: string, taskKey: string, parsed: ParsedTaskFile): Set<string> {
  const profiles = new Set(parsed.frontmatter.engagements.filter((entry) => entry.delivers).map((entry) => entry.profileId));
  // SAFETY: the SELECT list is the single column `agent_profile_id`, nullable
  // TEXT on `agent_runs`, and the WHERE clause leaves the nulls out.
  const delivered = db
    .prepare(
      `SELECT DISTINCT agent_profile_id FROM agent_runs
        WHERE project_slug = ? AND task_key = ? AND kind = 'primary' AND agent_profile_id IS NOT NULL`,
    )
    .all(projectSlug, taskKey) as { agent_profile_id: string }[];
  for (const row of delivered) profiles.add(row.agent_profile_id);
  return profiles;
}

/**
 * What an approval of this task's delivery owes a look at, or null when it
 * owes none: the delivery is a revision or nothing was delivered, and the
 * task keeps no look; or it is files with no page of a deliverer's among
 * them and no look.
 *
 * The pages are read from the delivery's kept copy, which is what a judge is
 * shown ({@link judgedDelivery}): what a stopped rework, an upload or a
 * removal has since done to the task's folder changes neither what is owed
 * nor what can be shown. Nothing is owed that no tool can show, or the
 * approval could never bind: with no browser on the server (`canShowPages`
 * false) no page is pictured for anyone, a page past the size `capture_page`
 * renders is not rendered, and a kept picture whose bytes a person took out
 * of the store is not there to open.
 */
export function pageLooksOwed(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  parsed: ParsedTaskFile,
  canShowPages: boolean,
): PageLooksOwed | null {
  const fm = parsed.frontmatter;
  if (!fm.deliveredAt || !deliveredAsFiles(fm)) return null;
  const own = filesClaimedBy(parsed.timeline, deliverersOf(db, projectSlug, taskKey, parsed));
  const keptDir = keptDeliveryDir(projectSlug, taskKey, fm.deliveredAt, ctx.dataRoot);
  const kept = listed(keptDir);
  // A delivery whose copy could not be kept (ruling 86) is the files on the
  // task: the pages are read from there, as a judge is shown them from there.
  const dir = kept.length > 0 && keptDir ? keptDir : taskAttachmentsDir(projectSlug, taskKey, ctx.dataRoot);
  const held = kept.length > 0 ? kept : listed(dir);
  const pages = canShowPages
    ? held
        .filter((name) => own.has(name) && pageKindOf(name) === "html" && within(path.join(dir, name), PAGE_HTML_MAX_BYTES))
        .sort()
    : [];
  const looks = keptLooks(readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources)
    .map((look) => ({
      ...look,
      stretches: look.stretches.filter((stretch) => {
        const resolved = resolveTaskSource(projectSlug, taskKey, stretch.id, ctx.dataRoot);
        return resolved !== null && within(resolved.abs, Number.MAX_SAFE_INTEGER);
      }),
    }))
    .filter((look) => look.stretches.length > 0);
  if (pages.length === 0 && looks.length === 0) return null;
  const record = fm.pageCaptures?.deliveredAt === fm.deliveredAt ? fm.pageCaptures : null;
  const measured = (record?.pages ?? []).flatMap((page) => {
    const figures = pages.includes(page.file) ? measuredOf(page) : null;
    return figures ? [{ file: page.file, line: measuredLine(figures) }] : [];
  });
  return { taskKey, deliveredAt: fm.deliveredAt, pages, looks, measured };
}

/** The files delivery a run judges, as the run is shown it. */
export interface JudgedDelivery {
  deliveredAt: string;
  /** Its kept copy, or null when Viberr holds none (ruling 86: the copy
   *  failed): the task's files as they stand are then all anyone can be
   *  shown, and what a look is of. */
  dir: string | null;
  /** The names the kept copy holds. */
  names: string[];
}

/**
 * The delivery run `runId` judges on this task, or null when it judges none
 * and is shown the task's files as they stand.
 *
 * A run that judges looks at what was delivered: the delivery's own kept
 * copy, which no stopped rework, upload or other agent's save changes after
 * the stamp, so its look is of the delivery by construction. Everyone else,
 * the deliverer above all, looks at the files they are working on.
 *
 * A run judges by the completion's own rule for a verdict (`verdictAuthorized`,
 * ruling 87): dispatched to review and not to deliver, with no verdict
 * withheld, on an engagement that holds one. Where the engagement was taken
 * off the task under the run, the completion lets the agent's grant decide;
 * such a run is shown the delivery here, so its looks count wherever its
 * verdict does.
 */
export function judgedDelivery(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; runId: string | null },
  parsed: ParsedTaskFile,
): JudgedDelivery | null {
  const fm = parsed.frontmatter;
  if (!input.runId || !fm.deliveredAt || !deliveredAsFiles(fm)) return null;
  const run = getRun(db, input.runId);
  if (!run || run.kind !== "reviewer" || run.verdict_withheld === 1) return null;
  if (run.project_slug !== input.projectSlug || run.task_key !== input.taskKey) return null;
  const engagement = fm.engagements.find((entry) => entry.profileId === run.agent_profile_id);
  if (engagement && engagement.verdictCapable !== true) return null;
  const dir = keptDeliveryDir(input.projectSlug, input.taskKey, fm.deliveredAt, ctx.dataRoot);
  const names = listed(dir);
  return { deliveredAt: fm.deliveredAt, dir: dir && names.length > 0 ? dir : null, names };
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
  for (const look of ordered) {
    // One px of slack: a stretch that starts where the last ended is no gap.
    if (look.from > to + 1) break;
    to = Math.max(to, look.to);
    // The page ends inside a stretch that starts within what was seen: a
    // taller stretch of an earlier capture does not undo that.
    if (look.end) return { to, whole: true };
  }
  return { to, whole: false };
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
          // A look is of one delivery: this one, or it shows other bytes
          // (a kept picture of an earlier delivery, the task's files as a
          // rework or an upload has since left them).
          look.delivery === owed.deliveredAt &&
          look.to - look.from <= PAGE_LOOK_MAX_PX,
      );
      const seen = seenTo(mine);
      // A stretch starts no further down than `PAGE_CAPTURE_MAX_FROM`, so a
      // run that read a page to there has seen all of it that can be shown,
      // and is never owed a look nothing can give it.
      if (seen.whole || seen.to > PAGE_CAPTURE_MAX_FROM) continue;
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

/** How a run looks at what it owes a look at, a sentence for each kind owed:
 *  said to a reviewer before it starts and in the note when it did not. A
 *  tool is named only where there is something of its kind to open. */
function howToLook(owes: { pages: boolean; looks: boolean }): string {
  const parts: string[] = [];
  if (owes.pages) {
    parts.push(
      "A page is looked at with `capture_page`: its name, one `view` at a time, reading on from each `nextFrom` until the reply gives none.",
    );
  }
  if (owes.looks) parts.push("A look the task keeps is opened picture by picture with `read_task_source`.");
  return parts.join(" ");
}

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
    howToLook({ pages: owed.pages.length > 0, looks: owed.looks.length > 0 }) +
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
export function pageLooksRefusalNote(reviewer: string, unmet: readonly string[], owed: PageLooksOwed | null): string {
  return (
    `${reviewer}'s approval was not recorded: the run did not look at ${unmet.join("; ")}. ` +
    "An approval of a page binds only from a run that looked at the whole page at both widths and at every picture of a look the task keeps. " +
    howToLook({ pages: owed === null || owed.pages.length > 0, looks: owed === null || owed.looks.length > 0 }) +
    " Validation is unchanged and acceptance stays gated: run the review again."
  );
}

const readInputSchema = z.looseObject({ file_path: z.string() });
const toolUseSchema = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
const envelopeSchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});

/** How much of a tool result's line is read: its id, whether it failed and
 *  what kind of block it opens with all stand before the picture's bytes. */
const RESULT_HEAD_CHARS = 2_000;

/** A picture's bytes, or null when `file` holds none a reader takes. */
function pictureBytes(file: () => string): Buffer | null {
  try {
    const read = readAttachmentBytes(file(), IMAGE_READ_MAX_BYTES);
    return read && "bytes" in read ? read.bytes : null;
  } catch {
    return null;
  }
}

/**
 * The look a run takes when it opens one of the pictures Viberr kept of a
 * delivery (`<page>.capture-<view>.png`, ruling 86), or null when `name` is
 * not one the task's record names: how tall it is by its own header, whether
 * the page ends inside it by the record's `cut`, and which delivery it is of.
 *
 * The picture is the one in the delivery's kept copy. The task's folder holds
 * it under the same name, where any run that posts files can save over it:
 * one opened there counts only while the folder holds the kept bytes.
 */
export function keptPictureLook(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  name: string,
  /** The kept delivery the picture was read from; absent for the task's own
   *  folder, which holds the pictures of its latest delivery. */
  delivery?: string | undefined,
  /** When the picture was opened, where that is known after the fact (a
   *  run's log): one opened before the record's render finished was the
   *  picture of an earlier delivery under the same name. */
  openedAt?: string | undefined,
): RunLook | null {
  const view = viewOfCaptureName(name);
  if (!view) return null;
  const record = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter.pageCaptures;
  const shot = record?.pages.flatMap((page) => page.shots).find((entry) => same(entry.name, name));
  // The record is of one delivery: a picture read out of another's kept copy
  // is that delivery's, and no look at this one.
  if (!record || !shot || (delivery !== undefined && delivery !== record.deliveredAt)) return null;
  if (openedAt !== undefined && openedAt < record.at) return null;
  const keptDir = keptDeliveryDir(projectSlug, taskKey, record.deliveredAt, ctx.dataRoot);
  const kept = keptDir ? pictureBytes(() => resolveStoredSegment(keptDir, name)) : null;
  if (!kept) return null;
  if (delivery === undefined) {
    const onTask = pictureBytes(() => resolveTaskAttachment(projectSlug, taskKey, name, ctx.dataRoot));
    if (!onTask?.equals(kept)) return null;
  }
  const height = imageHeader(kept)?.height ?? null;
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
  // What the run asked its file reader for: the calls are short lines, read
  // whole.
  const asked = new Map<string, string>();
  // Only what the run was handed since its context was last replaced by a
  // summary: the lines after its last compaction's. That line is found by
  // the tag the run's sink gave it, the same parse that empties the run's
  // list, never by its text: a line that quotes the words is no compaction.
  // SAFETY: one aggregate of the INTEGER column `seq`; null when no line matches.
  const boundary = db
    .prepare(
      `SELECT MAX(seq) AS seq FROM run_log_lines
        WHERE run_id = ? AND CASE WHEN json_valid(display_json) THEN json_extract(display_json, '$.tag') END = ?`,
    )
    .get(input.runId, COMPACTION_LINE_TAG) as { seq: number | null } | undefined;
  const since = boundary?.seq ?? -1;
  // SAFETY: the SELECT list is the single column `raw_json`, which
  // `run_log_lines` declares TEXT NOT NULL in 0001_baseline.
  const calls = db
    .prepare(
      `SELECT raw_json FROM run_log_lines WHERE run_id = ? AND seq > ? AND raw_json LIKE '%"tool_use"%' AND raw_json LIKE '%"Read"%' ORDER BY seq`,
    )
    .all(input.runId, since) as { raw_json: string }[];
  for (const row of calls) {
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
      if (!use.success || use.data.name !== "Read") continue;
      const read = readInputSchema.safeParse(use.data.input);
      if (read.success) asked.set(use.data.id, read.data.file_path);
    }
  }
  if (asked.size === 0) return [];
  // What it was handed back: a result's line holds the picture itself, so
  // only its head is taken out of the store. A review that opened forty
  // pictures would otherwise load every one of them again at its completion.
  const looks: RunLook[] = [];
  // SAFETY: the SELECT list is `head`, a `substr` of `raw_json`, and
  // `occurred_at`, both TEXT NOT NULL on `run_log_lines` in 0001_baseline.
  const results = db
    .prepare(
      `SELECT substr(raw_json, 1, ${RESULT_HEAD_CHARS}) AS head, occurred_at FROM run_log_lines
        WHERE run_id = ? AND seq > ? AND raw_json LIKE '%"tool_result"%' ORDER BY seq`,
    )
    .all(input.runId, since) as { head: string; occurred_at: string }[];
  for (const { head, occurred_at: openedAt } of results) {
    const id = /"tool_use_id"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    const file = id ? asked.get(id) : undefined;
    // A picture the model was really handed: an image block in a result that
    // did not fail.
    if (!file || /"is_error"\s*:\s*true/.test(head) || !/"type"\s*:\s*"image"/.test(head)) continue;
    const dir = path.dirname(file);
    const name = path.basename(file);
    if (dir === sources) {
      const source = /^(S[1-9]\d{0,5})(?:\.[a-z0-9]{1,10})?$/.exec(name)?.[1];
      if (source) looks.push({ kind: "source", task: input.taskKey, id: source });
    } else if (dir === attachments) {
      const look = keptPictureLook(ctx, input.projectSlug, input.taskKey, name, undefined, openedAt);
      if (look) looks.push(look);
    }
  }
  return looks;
}
