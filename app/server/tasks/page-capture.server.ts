import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { PageCaptures, TaskFileEvent, TaskFrontmatter } from "~/schemas/task-file.schema";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { getEnv } from "~/server/config/env.server";
import { AppError } from "~/server/errors/app-error.server";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keepDelivery, keptDeliveryDir } from "~/server/files/kept-deliveries.server";
import {
  IMAGE_READ_MAX_BYTES,
  imageHeader,
  readAttachmentBytes,
  resolveTaskAttachment,
  writeTaskAttachment,
} from "~/server/files/task-attachments.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  passThroughDirForAgents,
  shareDirWithAgentsOrWarn,
  shareFileForAgentsToRead,
  type AgentLaunch,
} from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import { runPersonCommand, taskOwnerLaunch } from "~/server/runtimes/person-command.server";
import { RUN_MARKER_ENV } from "~/server/runtimes/run-processes.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { errorMessage, toError } from "~/shared/errors";
import { newId } from "~/shared/ids/new-id.server";
import {
  PAGE_CAPTURE_MAX_NAME_CHARS,
  PAGE_CAPTURE_MAX_PAGES,
  PAGE_CAPTURE_NOTE_TITLE,
  PAGE_CAPTURE_SYSTEM_ID,
  PAGE_CAPTURE_VIEWS,
  PAGE_EXTENSIONS_TEXT,
  isPageCaptureName,
  pageCaptureName,
  pageCaptureView,
  pageKindOf,
  type PageCaptureView,
  type PageCaptureViewId,
  type PageKind,
} from "~/shared/page-capture";
import { noSuchAttachment } from "./board-read.server";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";
import { deliveredFileNames } from "./task-replies.server";
import { isRelayComment } from "./task-relay.server";

/**
 * Ruling 691: **Viberr renders a delivered page and keeps the picture.**
 *
 * A board that delivers a report, an email template or a status page delivers
 * HTML or markdown, and every reader of it read the source: a person opens the
 * file as text (ruling 363 never serves stored HTML on the app origin), and a
 * reviewer agent reads its bytes. A broken table, a missing picture or a
 * layout that falls apart on a phone cannot be seen there.
 *
 *  - **When.** Each stamped files delivery ({@link requestDeliveryCaptures},
 *    asked by `recordAgentCompletion` once the delivery is kept). An agent can
 *    ask for the same picture of any page on its task ({@link captureTaskPage},
 *    the `capture_page` tool) before it delivers or while it reviews.
 *  - **Off every request path, one at a time.** A serial queue for the whole
 *    instance, the gates' reasoning: a burst of deliveries must not start
 *    several browsers on a shared host. A newer delivery of a task replaces
 *    one still waiting, and an agent's ask goes ahead of waiting deliveries.
 *  - **As whom.** The renderer (`page-capture-child.server.ts`) and its
 *    browser run a page's scripts with no sandbox, so they run as the task
 *    owner's agent user through the ruling 460 launcher, with
 *    `filteredSpawnEnv()` and the person's own `$HOME`; with isolation on and
 *    no owner nothing is rendered and the task says so. The server only writes
 *    a job, reads back PNG bytes it checks by their own header, and stores
 *    them through its own writer.
 *  - **What is kept.** `<file>.capture-desktop.png` and
 *    `<file>.capture-phone.png` in the task's attachments (the next delivery's
 *    picture of the same file replaces them), a copy in the kept delivery they
 *    picture, the `pageCaptures` record bound to that delivery's stamp, one
 *    timeline note that claims the pictures, and audit `task.pages.captured`.
 *    A tool capture keeps nothing on the task.
 *  - **What it can break.** Nothing: a dead browser, a hang, a missing report
 *    or a picture that fails its header check is that page's `error`, one log
 *    line and one sentence in the note. The delivery, its kept copy, the
 *    verdict path and acceptance never read the record.
 */

/** How long a completion waits for its delivery's pictures before the
 *  operator reacts; the render then finishes in the background. Measured in
 *  the image (Debian Chromium 154): 1.6 s for a page at both widths. */
export const PAGE_CAPTURE_WAIT_MS = 45_000;
/** One page's limit for both widths in one browser, as the child is told. */
const PAGE_TIMEOUT_MS = 25_000;
/** The job's own limit: this, plus the page limit for each page. */
const JOB_BASE_MS = 10_000;
/** How long an agent's ask waits for the renderer before it is told `busy`. */
const TOOL_QUEUE_WAIT_MS = 15_000;
/** The tallest stretch an agent is handed: legible to a model, and inside the
 *  model API's 2000 px limit once a request holds more than 20 images. */
const TOOL_STRETCH_PX = 2_000;
/** The largest source set as a page, by kind. */
const SOURCE_MAX_BYTES = { html: 10 * 1024 * 1024, markdown: 2 * 1024 * 1024 } satisfies Record<PageKind, number>;
/** A delivery's files are copied where the renderer can read them: each up to
 *  this, and this much in all. */
const CARRIED_FILE_MAX_BYTES = 25 * 1024 * 1024;
const CARRIED_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
const REPORT_MAX_BYTES = 1024 * 1024;
/** How much of one sentence from the renderer's report is kept, and of one
 *  name (a host, or a file the page asked for). */
const REPORT_TEXT_MAX_CHARS = 200;
const REPORT_NAME_MAX_CHARS = 80;

const NO_OWNER = "the task has no owner to render it as";

/**
 * The renderer, tried in order: beside this module (source, vitest), then
 * where the image's `COPY app` puts it next to the bundled server. Node runs
 * it as TypeScript directly, as it runs the browser supervisor.
 */
const CHILD_CANDIDATES = [
  path.join(import.meta.dirname, "page-capture-child.server.ts"),
  path.resolve(process.cwd(), "app/server/tasks/page-capture-child.server.ts"),
];

export interface PageCaptureStatus {
  available: boolean;
  /** False when the deployment names no browser at all: nothing is pictured
   *  and nothing is said about it on any task. */
  configured: boolean;
  /** Why a configured deployment cannot render; free of deployment paths. */
  reason?: string;
}

interface Renderer {
  browser: string;
  child: string;
}

function renderer(): Renderer | PageCaptureStatus {
  const browser = getEnv().VIBERR_BROWSER_EXECUTABLE ?? null;
  if (!browser) return { available: false, configured: false };
  if (!existsSync(browser)) {
    return {
      available: false,
      configured: true,
      reason: "the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk",
    };
  }
  const child = CHILD_CANDIDATES.find((file) => existsSync(file));
  if (!child) {
    return {
      available: false,
      configured: true,
      reason: "the page renderer (ruling 691) is not installed in this deployment",
    };
  }
  return { browser, child };
}

/** Can this deployment picture a page? `VIBERR_BROWSER_EXECUTABLE` decides:
 *  the browser the image pins is the one the renderer drives. */
export function pageCaptureStatus(): PageCaptureStatus {
  const found = renderer();
  return "browser" in found ? { available: true, configured: true } : found;
}

// ------------------------------------------------------------ the queue

interface QueuedJob {
  kind: "delivery" | "tool";
  /** `<slug>/<KEY>`. */
  task: string;
  run: () => Promise<void>;
  /** Called instead of `run` when the job is taken out before it starts. */
  drop: () => void;
}

const waiting: QueuedJob[] = [];
let draining: Promise<void> | null = null;

function kick(): void {
  if (draining) return;
  draining = (async () => {
    try {
      while (waiting.length > 0) {
        const job = waiting.shift()!;
        try {
          await job.run();
        } catch (error) {
          logger.error("a page capture failed outside its own handling", {
            task: job.task,
            err: toError(error),
          });
        }
      }
    } finally {
      draining = null;
      // A job enqueued between the loop's last check and here starts now.
      if (waiting.length > 0) kick();
    }
  })();
}

function enqueue(job: QueuedJob): void {
  if (job.kind === "delivery") {
    // A newer delivery of the same task replaces one still waiting: the task
    // now names the newer stamp, so the older job would only find it moved.
    for (let i = waiting.length - 1; i >= 0; i -= 1) {
      const queued = waiting[i]!;
      if (queued.kind === "delivery" && queued.task === job.task) {
        waiting.splice(i, 1);
        queued.drop();
      }
    }
    waiting.push(job);
  } else {
    // An agent is waiting on its call: ahead of every delivery still queued.
    const firstDelivery = waiting.findIndex((queued) => queued.kind === "delivery");
    if (firstDelivery < 0) waiting.push(job);
    else waiting.splice(firstDelivery, 0, job);
  }
  kick();
}

// ------------------------------------------------------------ the render

/** One view as the renderer child is told it. */
interface ChildView {
  id: PageCaptureViewId;
  width: number;
  height: number;
  maxHeight: number;
  mobile: boolean;
  from: number;
}

interface PageInput {
  file: string;
  kind: PageKind;
}

/** One picture the renderer made, checked by its own header. */
interface RenderedShot {
  view: PageCaptureViewId;
  bytes: Buffer;
  /** Where the renderer left it, for an agent's own image viewer. */
  path: string;
  width: number;
  height: number;
  from: number;
  contentHeight: number;
  contentWidth: number;
  scale: number;
  cut: boolean;
}

interface RenderedPage {
  file: string;
  shots: RenderedShot[];
  /** Hosts the page asked the network for, and how many addresses in all. */
  asked: string[];
  askedCount: number;
  /** Names it asked for that the renderer did not have. */
  missing: string[];
  error: string | null;
}

interface Render {
  pages: RenderedPage[];
  /** The scratch folder, for the caller to remove (or leave for the run). */
  scratch: string | null;
  /** Names of the delivery left out of what the renderer could load. */
  notCarried: ReadonlySet<string>;
}

const reportShotSchema = z.looseObject({
  view: z.enum(["desktop", "phone"]),
  from: z.number().int().nonnegative(),
  contentHeight: z.number().int().nonnegative(),
  contentWidth: z.number().int().nonnegative(),
  scale: z.number().positive(),
  cut: z.boolean(),
});
const reportSchema = z.looseObject({
  pages: z.array(
    z.looseObject({
      file: z.string(),
      shots: z.array(reportShotSchema).catch([]),
      asked: z.array(z.string()).catch([]),
      askedCount: z.number().int().nonnegative().catch(0),
      missing: z.array(z.string()).catch([]),
      error: z.string().nullable().catch(null),
    }),
  ),
});

/** A sentence from the renderer's report, as one bounded line. The report is
 *  written by the person's process, so nothing in it is trusted as markup. */
function reportText(text: string, max = REPORT_TEXT_MAX_CHARS): string {
  const line = text.replace(/[\s`]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A name from the report: what a page asked for is the page's own text. */
const reportName = (name: string): string => reportText(name, REPORT_NAME_MAX_CHARS);

async function removeScratch(dir: string, launch: AgentLaunch | null): Promise<void> {
  try {
    await removeAgentTree(dir, launch);
  } catch (error) {
    logger.warn("a page capture's scratch folder could not be removed", { dir, err: toError(error) });
  }
}

interface RenderRequest {
  ctx: TaskMutationContext;
  projectSlug: string;
  taskKey: string;
  renderer: Renderer;
  launch: AgentLaunch | null;
  /** The folder the pages are served from: the attachments themselves, or a
   *  kept delivery, whose files are first copied where the person can read. */
  source: { kind: "attachments" } | { kind: "kept"; dir: string };
  pages: PageInput[];
  views: ChildView[];
}

/**
 * A kept delivery is the server's own (its files are not the agent group's to
 * read), so its files are copied into the scratch folder for the render: into
 * a folder the person passes through and cannot write, each file readable by
 * the agent group. The pages first, then the rest by name, within the limits.
 */
function carryDelivery(from: string, into: string, pages: readonly PageInput[]): Set<string> {
  // Best effort, like every share on this path: a folder or a file left
  // unshared makes the renderer's own read fail, which the page then says.
  try {
    passThroughDirForAgents(into);
  } catch (error) {
    logger.warn("a page capture's input folder could not be shared with the agent group", {
      dir: into,
      err: toError(error),
    });
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const first = new Set(pages.map((page) => page.file));
  const names = entries
    .filter((entry) => entry.isFile() && !isPageCaptureName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(first.has(b)) - Number(first.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const notCarried = new Set<string>();
  let total = 0;
  for (const name of names) {
    const source = path.join(from, name);
    let size: number;
    try {
      size = statSync(source).size;
    } catch {
      continue;
    }
    if (size > CARRIED_FILE_MAX_BYTES || total + size > CARRIED_TOTAL_MAX_BYTES) {
      notCarried.add(name);
      continue;
    }
    const copy = path.join(into, name);
    copyFileSync(source, copy);
    try {
      shareFileForAgentsToRead(copy);
    } catch (error) {
      logger.warn("a delivered file could not be shared with the agent group for its picture", {
        file: name,
        err: toError(error),
      });
    }
    total += size;
  }
  return notCarried;
}

/** Run the renderer child once over `pages` and read back what it made.
 *  Throws only before the child starts; after that every failure is a page's
 *  `error`. */
async function render(request: RenderRequest): Promise<Render> {
  const { ctx, projectSlug, taskKey, launch, pages, views } = request;
  const captureId = newId("cap");
  const workspaceRoot = path.join(taskDir(projectSlug, taskKey, ctx.dataRoot), "workspace");
  const capturesRoot = path.join(workspaceRoot, ".captures");
  const scratch = path.join(capturesRoot, captureId);
  // Ruling 460: the renderer runs as the person's uid, so the folders it
  // writes are the agents' to write.
  shareDirWithAgentsOrWarn(workspaceRoot);
  shareDirWithAgentsOrWarn(capturesRoot);
  // One render runs at a time, so anything else here is an agent's last
  // stretch or a render a restart cut short: removed before this one starts.
  for (const stale of readdirSync(capturesRoot)) {
    if (stale !== captureId) await removeScratch(path.join(capturesRoot, stale), launch);
  }
  shareDirWithAgentsOrWarn(scratch);
  const tmp = path.join(scratch, "tmp");
  shareDirWithAgentsOrWarn(tmp);
  const out = path.join(scratch, "out");
  let root = taskAttachmentsDir(projectSlug, taskKey, ctx.dataRoot);
  let notCarried = new Set<string>();
  if (request.source.kind === "kept") {
    root = path.join(scratch, "files");
    notCarried = carryDelivery(request.source.dir, root, pages);
  }
  const job = {
    root,
    out,
    profile: path.join(scratch, "profile"),
    browser: request.renderer.browser,
    pages,
    views,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: IMAGE_READ_MAX_BYTES,
  };
  const timeoutMs = JOB_BASE_MS + PAGE_TIMEOUT_MS * pages.length;
  const outcome = await runPersonCommand({
    file: process.execPath,
    args: [request.renderer.child, JSON.stringify(job)],
    cwd: scratch,
    launch,
    // The server's environment minus every credential and every Viberr
    // setting, the person's own `$HOME`, a temp folder of its own, and the
    // sweep marker. Nothing else.
    env: {
      ...filteredSpawnEnv(),
      NODE_ENV: "production",
      HOME: launch?.home ?? scratch,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      [RUN_MARKER_ENV]: captureId,
    },
    marker: captureId,
    timeoutMs,
    timeoutNote: `\n[viberr] the render ran past its ${Math.round(timeoutMs / 1000)} s limit and was stopped\n`,
  });
  const reported = new Map<string, z.infer<typeof reportSchema>["pages"][number]>();
  const report = readAttachmentBytes(path.join(out, "report.json"), REPORT_MAX_BYTES);
  if (report && "bytes" in report) {
    try {
      const parsed = reportSchema.safeParse(JSON.parse(report.bytes.toString("utf8")));
      if (parsed.success) for (const page of parsed.data.pages) reported.set(page.file, page);
    } catch {
      // Not a report: every page below says the renderer ended early.
    }
  }
  const unreported = outcome.timedOut
    ? `the render ran past ${Math.round(timeoutMs / 1000)} seconds`
    : outcome.spawnError !== null
      ? "the renderer could not be started"
      : "the renderer ended before this page was pictured";
  const rendered = pages.map((page, index): RenderedPage => {
    const said = reported.get(page.file);
    if (!said) return { file: page.file, shots: [], asked: [], askedCount: 0, missing: [], error: unreported };
    const shots: RenderedShot[] = [];
    let error = said.error === null ? null : reportText(said.error);
    for (const shot of said.shots) {
      const view = views.find((v) => v.id === shot.view);
      if (!view) continue;
      // By the server's own naming, never a path the report gives.
      const file = path.join(out, `${index + 1}-${view.id}.png`);
      const read = readAttachmentBytes(file, IMAGE_READ_MAX_BYTES);
      const header = read && "bytes" in read ? imageHeader(read.bytes) : null;
      if (
        !read ||
        !("bytes" in read) ||
        !header ||
        header.mimeType !== "image/png" ||
        header.width !== view.width ||
        header.height < 1 ||
        header.height > view.maxHeight
      ) {
        error ??= `its ${view.id} picture did not come back as a PNG of the size asked for`;
        continue;
      }
      shots.push({
        view: view.id,
        bytes: read.bytes,
        path: file,
        width: header.width,
        height: header.height,
        from: shot.from,
        contentHeight: shot.contentHeight,
        contentWidth: shot.contentWidth,
        scale: shot.scale,
        cut: shot.cut,
      });
    }
    return {
      file: page.file,
      shots,
      asked: said.asked.slice(0, 12).map(reportName),
      askedCount: said.askedCount,
      missing: said.missing.slice(0, 12).map(reportName),
      error: shots.length === 0 && error === null ? unreported : error,
    };
  });
  return { pages: rendered, scratch, notCarried };
}

// ------------------------------------------------------------ what it says

const code = (name: string): string => `\`${name}\``;
const px = (n: number): string => n.toLocaleString("en-US");
const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "It asked the network for 2 things (fonts.googleapis.com)", or null. */
function askedClause(page: RenderedPage): string | null {
  if (page.askedCount === 0) return null;
  const hosts = page.asked.length > 0 ? ` (${page.asked.join(", ")})` : "";
  return `the network for ${page.askedCount === 1 ? "1 thing" : `${px(page.askedCount)} things`}${hosts}`;
}

/** "`assets/chart.png`, which is not among this task's files (the folder is
 *  flat)", one clause per kind of miss. */
function missingClauses(page: RenderedPage, notCarried: ReadonlySet<string>): string[] {
  const tooLarge = page.missing.filter((name) => notCarried.has(name));
  const absent = page.missing.filter((name) => !notCarried.has(name));
  const clauses: string[] = [];
  if (absent.length > 0) {
    clauses.push(
      `${LIST_AND.format(absent.map(code))}, which ${absent.length === 1 ? "is" : "are"} not among this task's files (the folder is flat)`,
    );
  }
  if (tooLarge.length > 0) {
    clauses.push(
      `${LIST_AND.format(tooLarge.map(code))}, which a capture does not carry (a file over 25 MB, or past 200 MB in all)`,
    );
  }
  return clauses;
}

/** What one pictured page's pictures do not show by themselves. */
function pageRemarks(page: RenderedPage, notCarried: ReadonlySet<string>): string[] {
  const remarks: string[] = [];
  for (const shot of page.shots) {
    const view = pageCaptureView(shot.view);
    if (shot.cut) {
      remarks.push(
        `${code(page.file)} runs longer than its ${view.id} picture, which shows the first ${px(shot.height)} px of ${px(shot.contentHeight)}.`,
      );
    }
    if (shot.scale < 0.99) {
      remarks.push(
        `A ${view.id} lays ${code(page.file)} out ${px(Math.round(view.width / shot.scale))} px wide and shrinks it to fit its ${px(view.width)} px screen, so its text is small.`,
      );
    } else if (shot.contentWidth > view.width + 1) {
      remarks.push(
        `${code(page.file)} is ${px(shot.contentWidth)} px wide on a ${px(view.width)} px screen, so a reader scrolls sideways.`,
      );
    }
  }
  const asked = askedClause(page);
  if (asked) {
    remarks.push(
      `${code(page.file)} asked ${asked}; a capture loads none, so the picture shows the page without them.`,
    );
  }
  const missing = missingClauses(page, notCarried).map((clause) => `for ${clause}`);
  if (missing.length > 0) remarks.push(`${code(page.file)} asked ${missing.join(", and ")}.`);
  if (page.error) remarks.push(`Not every picture of ${code(page.file)} was made: ${page.error}.`);
  return remarks;
}

/** The timeline note a delivery's render writes. */
function captureNoteText(pages: readonly RenderedPage[], more: number, notCarried: ReadonlySet<string>): string {
  const pictured = pages.filter((page) => page.shots.length > 0);
  const failed = pages.filter((page) => page.shots.length === 0);
  const parts: string[] = [];
  if (pictured.length > 0) {
    const [desktop, phone] = PAGE_CAPTURE_VIEWS;
    parts.push(
      `Viberr rendered ${LIST_AND.format(pictured.map((page) => code(page.file)))} as a reader sees ` +
        `${pictured.length === 1 ? "it" : "them"}, at a desktop width (${px(desktop!.width)} px) and a phone width ` +
        `(${px(phone!.width)} px). The pictures are attached and show beside each file on the result.`,
    );
    for (const page of pictured) parts.push(...pageRemarks(page, notCarried));
  }
  for (const page of failed) parts.push(`Viberr could not picture ${code(page.file)}: ${page.error ?? "it was not rendered"}.`);
  if (failed.length > 0) {
    parts.push(
      `The delivery stands without ${failed.length === 1 ? "it" : "them"}, and an agent can look with \`capture_page\`.`,
    );
  }
  if (more > 0) {
    parts.push(
      `${more === 1 ? "1 more page was" : `${px(more)} more pages were`} not pictured: a delivery is pictured up to ${PAGE_CAPTURE_MAX_PAGES} pages.`,
    );
  }
  return parts.join(" ");
}

// ------------------------------------------------------------ a delivery

interface DeliveryPages {
  pages: PageInput[];
  /** Pages past the cap, counted and not pictured. */
  more: number;
}

/**
 * The pages of a kept delivery: its files that are pages, less Viberr's own
 * pictures and less what a person uploaded or a relay carried in (inputs, not
 * results). The deliverer's own first, then by code point; the first
 * {@link PAGE_CAPTURE_MAX_PAGES}.
 */
function deliveryPages(
  files: readonly string[],
  fm: TaskFrontmatter,
  timeline: readonly TaskFileEvent[],
): DeliveryPages {
  // Newest first: the newest entry that claims a name says whose it is.
  const inputs = new Set<string>();
  const claimed = new Set<string>();
  for (const event of timeline) {
    for (const name of event.attachments ?? []) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      if (event.actor.kind === "human" || isRelayComment(event)) inputs.add(name);
    }
  }
  const delivered = deliveredFileNames(fm, timeline);
  const pages = files
    .filter((name) => pageKindOf(name) !== null && !isPageCaptureName(name) && !inputs.has(name))
    .sort((a, b) => Number(delivered.has(b)) - Number(delivered.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    pages: pages.slice(0, PAGE_CAPTURE_MAX_PAGES).map((file) => ({ file, kind: pageKindOf(file)! })),
    more: Math.max(0, pages.length - PAGE_CAPTURE_MAX_PAGES),
  };
}

/** Why a file is not handed to the renderer at all, or null when it is. */
function sourceRefusal(file: string, kind: PageKind, bytes: number): string | null {
  if (file.length > PAGE_CAPTURE_MAX_NAME_CHARS) {
    return `its name is longer than ${PAGE_CAPTURE_MAX_NAME_CHARS} characters, and a picture is kept under the file's name`;
  }
  const cap = SOURCE_MAX_BYTES[kind];
  if (bytes > cap) {
    return `the file is ${(bytes / 1024 / 1024).toFixed(1)} MB; a page of up to ${cap / 1024 / 1024} MB is pictured`;
  }
  return null;
}

/** Remove the pictures a record named. By the record, never by pattern. */
function unlinkRecorded(ctx: TaskMutationContext, slug: string, key: string, names: Iterable<string>): void {
  for (const name of names) {
    if (!isPageCaptureName(name)) continue;
    try {
      unlinkSync(resolveTaskAttachment(slug, key, name, ctx.dataRoot));
    } catch {
      // Already gone, or never a name the store takes.
    }
  }
}

function recordedNames(record: PageCaptures | null | undefined): string[] {
  return (record?.pages ?? []).flatMap((page) => page.shots.map((shot) => shot.name));
}

const CAPTURE_ACTOR = { kind: "system", systemId: PAGE_CAPTURE_SYSTEM_ID } as const;

interface DeliveryCaptureInput {
  projectSlug: string;
  taskKey: string;
  /** The `deliveredAt` stamp of the delivery to picture. */
  stamp: string;
}

async function captureDelivery(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: DeliveryCaptureInput,
): Promise<void> {
  const { projectSlug, taskKey, stamp } = input;
  const ref = taskRef(ctx, projectSlug, taskKey);
  const file = readTaskFile(ref);
  // A newer delivery has its own job.
  if (!file || file.parsed.frontmatter.deliveredAt !== stamp) return;
  // A deployment without a browser is reported by health, not on every task.
  const found = renderer();
  if ("configured" in found && !found.configured) return;
  const started = Date.now();
  const fm = file.parsed.frontmatter;
  const kept = keptDeliveryDir(projectSlug, taskKey, stamp, ctx.dataRoot);
  let keptFiles: string[] = [];
  try {
    if (kept) keptFiles = readdirSync(kept);
  } catch {
    keptFiles = [];
  }
  const { pages, more } = deliveryPages(keptFiles, fm, file.parsed.timeline);
  unlinkRecorded(ctx, projectSlug, taskKey, recordedNames(fm.pageCaptures));
  if (!kept || pages.length === 0) {
    // No page in this delivery: nothing to say, and the last one's record goes.
    if (fm.pageCaptures) {
      await updateTaskFile(ref, (parsed) => {
        if (parsed.frontmatter.deliveredAt === stamp) delete parsed.frontmatter.pageCaptures;
      });
      reprojectTask(db, ctx, projectSlug, taskKey);
    }
    return;
  }
  const refused = new Map<string, string>();
  for (const page of pages) {
    let bytes = 0;
    try {
      bytes = statSync(path.join(kept, page.file)).size;
    } catch {
      bytes = 0;
    }
    const refusal = sourceRefusal(page.file, page.kind, bytes);
    if (refusal) refused.set(page.file, refusal);
  }
  const toRender = pages.filter((page) => !refused.has(page.file));
  let launch: AgentLaunch | null = null;
  let rendered: Render = { pages: [], scratch: null, notCarried: new Set() };
  try {
    if (!("browser" in found)) throw new Error(found.reason ?? "this server has no browser to render with");
    launch = taskOwnerLaunch(db, fm.ownerUserId, ctx.dataRoot, NO_OWNER);
    if (toRender.length > 0) {
      rendered = await render({
        ctx,
        projectSlug,
        taskKey,
        renderer: found,
        launch,
        source: { kind: "kept", dir: kept },
        pages: toRender,
        views: PAGE_CAPTURE_VIEWS.map((view) => ({ ...childView(view), from: 0 })),
      });
    }
  } catch (error) {
    // Whatever stopped the render is each page's reason; the delivery stands.
    const reason = reportText(error instanceof AppError ? error.userMessage : errorMessage(error));
    rendered = {
      pages: toRender.map((page) => ({ file: page.file, shots: [], asked: [], askedCount: 0, missing: [], error: reason })),
      scratch: null,
      notCarried: new Set(),
    };
  }
  const byFile = new Map(rendered.pages.map((page) => [page.file, page]));
  const results = pages.map(
    (page): RenderedPage =>
      byFile.get(page.file) ?? {
        file: page.file,
        shots: [],
        asked: [],
        askedCount: 0,
        missing: [],
        error: refused.get(page.file) ?? "it was not rendered",
      },
  );
  // The pictures land on the task, then in the kept delivery they picture.
  const record: PageCaptures = { deliveredAt: stamp, at: new Date().toISOString(), pages: [] };
  const written: string[] = [];
  for (const page of results) {
    const shots: PageCaptures["pages"][number]["shots"] = [];
    let error = page.error;
    for (const shot of page.shots) {
      try {
        const saved = writeTaskAttachment(
          projectSlug,
          taskKey,
          pageCaptureName(page.file, shot.view),
          shot.bytes,
          ctx.dataRoot,
        );
        written.push(saved.name);
        shots.push({ view: shot.view, name: saved.name, cut: shot.cut });
      } catch (caught) {
        error ??= `its ${shot.view} picture could not be saved (${reportText(errorMessage(caught))})`;
      }
    }
    record.pages.push({ file: page.file, shots, error });
    if (error) logger.warn("a page could not be captured", { taskKey, file: page.file, reason: error });
  }
  try {
    keepDelivery(projectSlug, taskKey, stamp, written, ctx.dataRoot);
  } catch (error) {
    logger.warn("a delivery's page pictures could not be kept with it", { taskKey, stamp, err: toError(error) });
  }
  // The note says what was saved, which is what the record says.
  const noted = results.map((page): RenderedPage => {
    const recorded = record.pages.find((p) => p.file === page.file);
    const saved = new Set(recorded?.shots.map((shot) => shot.view));
    return { ...page, shots: page.shots.filter((shot) => saved.has(shot.view)), error: recorded?.error ?? page.error };
  });
  const landed = { done: false };
  await updateTaskFile(ref, (parsed) => {
    // Re-checked under the lock: a delivery that landed while this rendered
    // has its own job, and these pictures are not of it.
    if (parsed.frontmatter.deliveredAt !== stamp) return;
    parsed.frontmatter.pageCaptures = record;
    const note: TaskFileEvent = {
      occurredAt: record.at,
      type: "note",
      actor: CAPTURE_ACTOR,
      title: PAGE_CAPTURE_NOTE_TITLE,
      text: captureNoteText(noted, more, rendered.notCarried),
      toAgent: false,
      evidence: null,
    };
    if (written.length > 0) note.attachments = [...written];
    parsed.timeline.unshift(note);
    landed.done = true;
  });
  if (rendered.scratch) await removeScratch(rendered.scratch, launch);
  if (!landed.done) {
    unlinkRecorded(ctx, projectSlug, taskKey, written);
    return;
  }
  reprojectTask(db, ctx, projectSlug, taskKey);
  const failed = record.pages.filter((page) => page.shots.length === 0).map((page) => page.file);
  const wallMs = Date.now() - started;
  recordAudit(db, {
    action: "task.pages.captured",
    actor: SYSTEM_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: {
      deliveredAt: stamp,
      pages: record.pages.length,
      captured: record.pages.length - failed.length,
      failed,
      more,
      wallMs,
      runsAs: launch ? launch.uid : "server",
    },
  });
  logger.info("page captures made", {
    projectSlug,
    taskKey,
    pages: record.pages.length,
    captured: record.pages.length - failed.length,
    wallMs,
  });
}

/** False only when the job would do nothing: no browser is named, or the
 *  delivery holds no file that is a page and the task has no record of an
 *  earlier delivery's pictures to take down. Anything unreadable is the job's
 *  to find out. */
function owesCapture(ctx: TaskMutationContext, input: DeliveryCaptureInput): boolean {
  try {
    const found = renderer();
    if ("configured" in found && !found.configured) return false;
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!file || file.parsed.frontmatter.pageCaptures) return true;
    const kept = keptDeliveryDir(input.projectSlug, input.taskKey, input.stamp, ctx.dataRoot);
    return !kept || readdirSync(kept).some((name) => pageKindOf(name) !== null && !isPageCaptureName(name));
  } catch {
    return true;
  }
}

function childView(view: PageCaptureView): Omit<ChildView, "from"> {
  return { id: view.id, width: view.width, height: view.height, maxHeight: view.maxHeight, mobile: view.mobile };
}

/**
 * Picture the pages of the files delivery `stamp` once the renderer is free.
 * Resolves when that is done, or at once when a newer delivery of the task
 * took its place in the queue. Never rejects: a capture is evidence beside a
 * delivery and never a reason for one to fail.
 */
export function requestDeliveryCaptures(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: DeliveryCaptureInput,
): Promise<void> {
  // Most deliveries hold no page, and a completion waits on this promise: one
  // with nothing to picture and nothing to take down never joins the queue
  // behind another task's render.
  if (!owesCapture(ctx, input)) return Promise.resolve();
  return new Promise((resolve) => {
    enqueue({
      kind: "delivery",
      task: `${input.projectSlug}/${input.taskKey}`,
      drop: resolve,
      run: async () => {
        try {
          await captureDelivery(db, ctx, input);
        } catch (error) {
          logger.warn("a delivery's pages could not be pictured", {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            err: toError(error),
          });
        } finally {
          resolve();
        }
      },
    });
  });
}

/** Wait for a delivery's pictures, at most {@link PAGE_CAPTURE_WAIT_MS}: the
 *  operator and the reviewers it dispatches then start with the pictures
 *  there, and a slow render never holds them longer. */
export function deliveryCapturesSettled(captures: Promise<void> | null): Promise<void> {
  if (!captures) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PAGE_CAPTURE_WAIT_MS);
    timer.unref?.();
    void captures.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ------------------------------------------------------------ an agent's ask

export interface PageCaptureImage {
  data: string;
  mimeType: string;
}

/** What `capture_page` answers: one text block and one image per view. */
export interface PageCaptureReply {
  text: string;
  images: PageCaptureImage[];
}

export interface PageCaptureAsk {
  projectSlug: string;
  taskKey: string;
  /** The page's name among the task's files. */
  name: string;
  /** One width; both when absent. */
  view?: PageCaptureViewId | undefined;
  /** Where the stretch starts, in px from the top. */
  from?: number | undefined;
}

const said = (text: string): PageCaptureReply => ({ text, images: [] });

/** One view's stretch, in the reply's words. */
function stretchSentence(shot: RenderedShot): string {
  const view = pageCaptureView(shot.view);
  const end = shot.from + shot.height;
  const whole = shot.from === 0 && !shot.cut;
  return (
    `${view.label}: ${px(shot.from)} to ${px(end)} px of ${px(Math.max(shot.contentHeight, end))}` +
    (whole ? ", the whole page" : shot.cut ? ` (\`nextFrom\`: ${end})` : ", the end of the page") +
    "."
  );
}

function captureReplyText(page: RenderedPage, scratchNote: string): string {
  const parts = [`[done] ${code(page.file)} as a reader sees it.`];
  for (const shot of page.shots) parts.push(stretchSentence(shot));
  for (const shot of page.shots) {
    const view = pageCaptureView(shot.view);
    if (shot.scale < 0.99) {
      parts.push(
        `A ${view.id} lays it out ${px(Math.round(view.width / shot.scale))} px wide and shrinks it to fit its ${px(view.width)} px screen, so its text is small.`,
      );
    } else if (shot.contentWidth > view.width + 1) {
      parts.push(`It is ${px(shot.contentWidth)} px wide on a ${px(view.width)} px screen, so a reader scrolls sideways.`);
    }
  }
  const asks: string[] = [];
  const asked = askedClause(page);
  if (asked) asks.push(`${asked}, which a capture never loads`);
  for (const clause of missingClauses(page, new Set())) asks.push(`for ${clause}`);
  if (asks.length > 0) parts.push(`It asked ${asks.join(", and ")}.`);
  if (page.error) parts.push(`Not every picture was made: ${page.error}.`);
  parts.push(scratchNote);
  return parts.join(" ");
}

async function capturePage(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  ask: PageCaptureAsk,
  found: Renderer,
): Promise<PageCaptureReply> {
  const { projectSlug, taskKey } = ask;
  const name = ask.name.trim();
  const kind = pageKindOf(name);
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file || !kind) return said(`[noop] ${code(name)} is not a page on ${taskKey}.`);
  let launch: AgentLaunch | null;
  try {
    launch = taskOwnerLaunch(db, file.parsed.frontmatter.ownerUserId, ctx.dataRoot, NO_OWNER);
  } catch {
    return said(
      `[error] ${code(name)} could not be captured: this task has no owner to render it as. ` +
        "A page renders as its person's agent user, never as the server.",
    );
  }
  const from = ask.from ?? 0;
  const views = PAGE_CAPTURE_VIEWS.filter((view) => !ask.view || view.id === ask.view).map(
    (view): ChildView => ({ ...childView(view), maxHeight: TOOL_STRETCH_PX, from }),
  );
  let rendered: Render;
  try {
    rendered = await render({
      ctx,
      projectSlug,
      taskKey,
      renderer: found,
      launch,
      source: { kind: "attachments" },
      pages: [{ file: name, kind }],
      views,
    });
  } catch (error) {
    logger.warn("a page could not be captured", { taskKey, file: name, reason: errorMessage(error) });
    return said(`[error] ${code(name)} could not be captured: the renderer could not be started.`);
  }
  const page = rendered.pages[0];
  if (!page || page.shots.length === 0) {
    const reason = page?.error ?? "it was not rendered";
    logger.warn("a page could not be captured", { taskKey, file: name, reason });
    return said(
      `[error] ${code(name)} could not be captured: ${reason}.` +
        (reason.startsWith("the render ran past")
          ? " A script that never finishes, or a page that never finishes loading, does that."
          : ""),
    );
  }
  logger.info("a page was captured for a run", { projectSlug, taskKey, file: name, views: page.shots.length });
  const paths = LIST_AND.format(page.shots.map((shot) => code(shot.path)));
  return {
    text: captureReplyText(
      page,
      `Saved for this run at ${paths}: scratch, nobody else sees it, and the next capture on this task replaces it.`,
    ),
    images: page.shots.map((shot) => ({ data: shot.bytes.toString("base64"), mimeType: "image/png" })),
  };
}

/**
 * `capture_page`: one page on the run's task as a reader sees it, in a stretch
 * a model can read. Saves nothing on the task, writes no audit row and no
 * timeline entry (it changes nothing, like `read_task_attachment`).
 */
export function captureTaskPage(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  ask: PageCaptureAsk,
): Promise<PageCaptureReply> {
  const found = renderer();
  if (!("browser" in found)) {
    return Promise.resolve(said("[error] This server has no browser to render a page with."));
  }
  const { projectSlug, taskKey } = ask;
  const name = ask.name.trim();
  let size: number | null = null;
  try {
    const stat = statSync(resolveTaskAttachment(projectSlug, taskKey, name, ctx.dataRoot));
    if (stat.isFile()) size = stat.size;
  } catch {
    size = null;
  }
  if (size === null) {
    // The reader's own sentence.
    return Promise.resolve(said(noSuchAttachment({ db, ctx, projectSlug }, taskKey, name)));
  }
  const kind = pageKindOf(name);
  if (!kind) {
    return Promise.resolve(
      said(
        `[noop] ${code(name)} is not a page. capture_page renders ${PAGE_EXTENSIONS_TEXT} files; ` +
          "read any other file with read_task_attachment.",
      ),
    );
  }
  const cap = SOURCE_MAX_BYTES[kind];
  if (size > cap) {
    return Promise.resolve(
      said(
        `[noop] ${code(name)} is ${(size / 1024 / 1024).toFixed(0)} MB; capture_page renders a page of up to ${cap / 1024 / 1024} MB.`,
      ),
    );
  }
  return new Promise((resolve) => {
    const job: QueuedJob = {
      kind: "tool",
      task: `${projectSlug}/${taskKey}`,
      drop: () => resolve(said("[busy] The renderer is working on other pages. Call again in a moment.")),
      run: async () => {
        clearTimeout(timer);
        try {
          resolve(await capturePage(db, ctx, ask, found));
        } catch (error) {
          logger.warn("a page could not be captured", { taskKey, file: name, reason: errorMessage(error) });
          resolve(said(`[error] ${code(name)} could not be captured: the renderer failed.`));
        }
      },
    };
    // Not started in time: taken out of the queue, so the call answers well
    // inside a Codex tool call's 60 seconds.
    const timer = setTimeout(() => {
      const at = waiting.indexOf(job);
      if (at < 0) return;
      waiting.splice(at, 1);
      job.drop();
    }, TOOL_QUEUE_WAIT_MS);
    timer.unref?.();
    enqueue(job);
  });
}
