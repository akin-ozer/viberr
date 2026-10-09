import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  deliveredAsFiles,
  type PageCaptures,
  type TaskFileEvent,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { getEnv } from "~/server/config/env.server";
import { AppError } from "~/server/errors/app-error.server";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keepDelivery, keptDeliveryDir } from "~/server/files/kept-deliveries.server";
import {
  IMAGE_READ_MAX_BYTES,
  checkAttachmentUpload,
  imageHeader,
  readAttachmentBytes,
  resolveTaskAttachment,
  writeTaskAttachment,
} from "~/server/files/task-attachments.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  TASK_CAPTURE_INPUT_DIR,
  TASK_CAPTURE_SCRATCH_DIR,
  isServersOwnDir,
  passThroughDirForAgents,
  passThroughDirForAgentsOrWarn,
  shareDirWithAgentsOrWarn,
  shareFileForAgentsToRead,
  type AgentLaunch,
} from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import { runPersonCommand, taskOwnerLaunch } from "~/server/runtimes/person-command.server";
import { RUN_MARKER_ENV } from "~/server/runtimes/run-processes.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { assertPathSafeRunId } from "~/server/runtimes/user-homes.server";
import { errorMessage, toError } from "~/shared/errors";
import { newId } from "~/shared/ids/new-id.server";
import {
  PAGE_CAPTURE_MAX_FROM,
  PAGE_CAPTURE_MAX_NAME_CHARS,
  PAGE_CAPTURE_MAX_PAGES,
  PAGE_CAPTURE_NOTE_TITLE,
  PAGE_CAPTURE_SYSTEM_ID,
  PAGE_CAPTURE_VIEWS,
  PAGE_EXTENSIONS_TEXT,
  isPageCaptureName,
  pageCaptureName,
  pageCaptureView,
  pageCapturesAmong,
  pageKindOf,
  recordedPageCaptures,
  type PageCaptureView,
  type PageCaptureViewId,
  type PageKind,
} from "~/shared/page-capture";
import { noSuchAttachment } from "./board-read.server";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";
import { deliverersOwnFileNames } from "./task-replies.server";
import { isRelayComment } from "./task-relay.server";

/**
 * Ruling 86: **Viberr renders a delivered page and keeps the picture.**
 *
 * A board that delivers a report, an email template or a status page delivers
 * HTML or markdown, and every reader of it read the source: a person opens the
 * file as text (ruling 317 never serves stored HTML on the app origin), and a
 * reviewer agent reads its bytes. A broken table, a missing picture or a
 * layout that falls apart on a phone cannot be seen there.
 *
 *  - **When.** Each stamped files delivery ({@link requestDeliveryCaptures},
 *    asked by `applyAgentCompletionEffects` once the delivery is kept and its
 *    delivery reconcile has run). A delivery that is a revision is not
 *    pictured: its pages live in the pull request. A first delivery on a
 *    board with a repository is stamped before the reconcile mints its
 *    revision, so the completion asks only after it, and the render writes
 *    nothing unless the delivery is still files under the task file's lock.
 *    An agent can ask for the same picture of any page on its task
 *    ({@link captureTaskPage}, the `capture_page` tool) before it delivers or
 *    while it reviews, and (ruling 194), given a size, for one picture of
 *    exactly that size of a page or an SVG drawing: how an agent that draws a
 *    diagram or a cover image gets its PNG.
 *  - **Off every request path, one at a time.** A serial queue for the whole
 *    instance, the gates' reasoning: a burst of deliveries must not start
 *    several browsers on a shared host. A newer delivery of a task replaces
 *    one still waiting, and an agent's ask goes ahead of waiting deliveries.
 *  - **As whom.** The renderer (`page-capture-child.server.ts`) and its
 *    browser run a page's scripts with no sandbox, so they run as the task
 *    owner's agent user through the ruling 139 launcher, with
 *    `filteredSpawnEnv()` and the person's own `$HOME`; with isolation on and
 *    no owner nothing is rendered and the task says so. The server only writes
 *    a job, reads back PNG bytes it checks by their own header, and stores
 *    them through its own writer.
 *  - **Where the server writes.** No file inside a folder an agent can write
 *    (ruling 140), and no folder either. The renderer's scratch is
 *    `.captures/<run>/<captureId>/` in the task's own directory, beside
 *    `deliveries/` and not under `workspace/`: `.captures/` and the run's
 *    folder are the server's own, passed through by the agent group and
 *    neither listed nor written by it, so no entry on the way can be a link
 *    an agent put there, and each is checked as the server's own directory
 *    before anything is made, listed or removed below it. Only the one
 *    render's folder, made new, is shared for the renderer to write, and from
 *    then on the server only reads what the renderer left and removes it as
 *    the person. A kept delivery's files are handed to the renderer in
 *    `.capture-input/` beside it, a folder whose parent only the server
 *    writes: the agent group passes through it and reads, and can neither
 *    list it nor put anything in it. A folder that cannot be made so is each
 *    page's reason for no picture, never a copy made anyway.
 *  - **What is kept.** `<file>.capture-desktop.png` and
 *    `<file>.capture-phone.png` in the task's attachments (the next delivery's
 *    picture of the same file replaces them), a copy in the kept delivery they
 *    picture, the `pageCaptures` record bound to that delivery's stamp, one
 *    timeline note that claims the pictures, and audit `task.pages.captured`.
 *    A tool capture keeps nothing on the task: its pictures stay in the
 *    scratch, in the folder of the run that asked, until that run ends.
 *  - **What it can break.** Nothing: a dead browser, a hang, a missing report
 *    or a picture that fails its header check is that page's `error`, one log
 *    line and one sentence in the note. The delivery, its kept copy, the
 *    verdict path and acceptance never read the record.
 */

/** How long a completion waits for its delivery's pictures before the
 *  operator reacts; the render then finishes in the background. Measured in
 *  the image (Debian Chromium 154): 1.6 s for a page at both widths. */
const PAGE_CAPTURE_WAIT_MS = 45_000;
/** One page's limit for both widths in one browser, as the child is told. */
const PAGE_TIMEOUT_MS = 25_000;
/** The job's own limit: this, plus the page limit for each page. */
const JOB_BASE_MS = 10_000;
/** How long an agent's ask waits for the renderer before it is told `busy`. */
const TOOL_QUEUE_WAIT_MS = 15_000;
/** The tallest stretch an agent is handed: legible to a model, and inside the
 *  model API's 2000 px limit once a request holds more than 20 images. */
const TOOL_STRETCH_PX = 2_000;
/** The most px a picture of an exact size holds: 4,000 by 4,000 at scale 1.
 *  Measured in the image (Debian Chromium 154): a flat picture of that many
 *  px is taken in 0.13 s. */
const BOX_MAX_PX = 16_000_000;

/** Ruling 194: a picture of an exact size, as an agent asks for it: a box in
 *  CSS px, and how many picture px draw one of them. */
interface PictureBox {
  width: number;
  height: number;
  scale: number;
}

/** The PNG a box is saved as, in its own px. The renderer and its browser
 *  come to the same two numbers (`pictureBox` in the child says how that was
 *  measured), and a picture of any other size is not kept. */
function boxPicture(box: PictureBox) {
  return { width: Math.round(box.width * box.scale), height: Math.round(box.height * box.scale) };
}

/**
 * What `capture_page` can picture: a page, or (given a size) a drawing. Apart
 * from {@link pageKindOf} on purpose: that one decides which delivered files
 * Viberr pictures by itself, at a desktop and a phone width, and a drawing has
 * neither. It is pictured at the size somebody asks for.
 */
type PictureKind = PageKind | "svg";

function pictureKindOf(name: string): PictureKind | null {
  return pageKindOf(name) ?? (path.extname(name).toLowerCase() === ".svg" ? "svg" : null);
}

/** The largest source set as a page, by kind. */
const SOURCE_MAX_BYTES = {
  html: 10 * 1024 * 1024,
  markdown: 2 * 1024 * 1024,
  svg: 10 * 1024 * 1024,
} satisfies Record<PictureKind, number>;
/** A delivery's files are copied where the renderer can read them: each up to
 *  this, and this much in all. */
const CARRIED_FILE_MAX_BYTES = 25 * 1024 * 1024;
const CARRIED_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
/** The buffer one delivered file is carried through. */
const CARRY_CHUNK_BYTES = 1024 * 1024;
const REPORT_MAX_BYTES = 1024 * 1024;
/** How much of one sentence from the renderer's report is kept, and of one
 *  name (a host, or a file the page asked for). */
const REPORT_TEXT_MAX_CHARS = 200;
const REPORT_NAME_MAX_CHARS = 80;

const NO_OWNER = "the task has no owner to render it as";
/** Why nothing was rendered when the scratch could not be made. */
const NO_SCRATCH = "the render's scratch folder could not be made";
/** The folder of `.captures/` for a render no run asked for: a delivery's
 *  own, or an ask whose caller could not name its run. A run's folder is its
 *  id, which never holds a dot (`assertPathSafeRunId`). */
const NO_RUN_HOME = "no.run";

/** A render that did not start, with a reason a task can show: free of
 *  deployment paths, which the log line beside the throw carries. */
class RenderRefused extends Error {}
/** Why a page past the cap has no picture, as the record keeps it. */
const PAST_PAGE_CAP = `a delivery is pictured up to ${PAGE_CAPTURE_MAX_PAGES} pages`;
/** How many pages one record names: the pictured ones and the next after the
 *  cap, each with why it has no picture. A larger delivery's rest is counted
 *  in the note; the record stays a few lines of a task file. */
const RECORDED_PAGES_MAX = 40;

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
      reason: "the page renderer (ruling 194) is not installed in this deployment",
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
  /** Set for a picture of an exact size: the viewport itself is the box, and
   *  `scale` is how many picture px draw one of its CSS px. */
  box?: { scale: number };
}

interface PageInput {
  file: string;
  kind: PictureKind;
}

/** The job the renderer child is handed. */
interface ChildJob {
  root: string;
  /** What `root` holds, when the renderer may pass through it and not list it. */
  names?: string[];
  out: string;
  profile: string;
  browser: string;
  pages: PageInput[];
  views: ChildView[];
  pageTimeoutMs: number;
  maxBytes: number;
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

/** A width at which the page was over before the stretch asked for began. */
interface EndedView {
  view: PageCaptureViewId;
  pageHeight: number;
}

interface RenderedPage {
  file: string;
  shots: RenderedShot[];
  /** The widths with nothing at `from`: no picture there, and no failure. */
  ended: EndedView[];
  /** How many script dialogs the page opened, each dismissed. */
  dialogs: number;
  /** Hosts the page asked the network for, and how many addresses in all. */
  asked: string[];
  askedCount: number;
  /** What it asked the renderer's page server for and was not served: a
   *  name, or (starting with `/`) a path outside its own folder. Whole, as
   *  the report gave them: only a sentence prints them, cut and cleaned. */
  missing: string[];
  error: string | null;
}

/** A page nothing was made of, and why. */
function unpictured(file: string, error: string): RenderedPage {
  return { file, shots: [], ended: [], dialogs: 0, asked: [], askedCount: 0, missing: [], error };
}

interface Render {
  pages: RenderedPage[];
  /** The scratch folder, for the caller to remove (or trim for the run). */
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
const reportEndedSchema = z.looseObject({
  view: z.enum(["desktop", "phone"]),
  pageHeight: z.number().int().nonnegative(),
});
const reportSchema = z.looseObject({
  pages: z.array(
    z.looseObject({
      file: z.string(),
      shots: z.array(reportShotSchema).catch([]),
      ended: z.array(reportEndedSchema).catch([]),
      dialogs: z.number().int().nonnegative().catch(0),
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

/** Remove one render's scratch, or a folder inside it: what the renderer
 *  wrote goes as the person who wrote it, and the emptied folder the server
 *  made goes with the server's `rmdir` (ruling 140(a)). */
async function removeScratch(dir: string, launch: AgentLaunch | null): Promise<void> {
  try {
    await removeAgentTree(dir, launch);
  } catch (error) {
    logger.warn("a page capture's scratch folder could not be removed", { dir, err: toError(error) });
  }
}

/**
 * Remove a run's folder of `.captures/` (or the one for renders no run asked
 * for): each render's scratch in it, then the folder. Nothing is listed or
 * removed unless the folder is the server's own directory, so never through a
 * link. The folder itself goes with the server's own `rmdir`, which walks
 * nothing and refuses a folder with anything in it: no agent can write in it
 * or beside it (ruling 140 is about the trees one can).
 */
async function removeCaptureHome(home: string, launch: AgentLaunch | null): Promise<void> {
  if (!isServersOwnDir(home)) return;
  try {
    for (const scratch of readdirSync(home)) await removeScratch(path.join(home, scratch), launch);
    if (readdirSync(home).length === 0) rmdirSync(home);
  } catch (error) {
    logger.warn("a run's page capture folder could not be removed", { dir: home, err: toError(error) });
  }
}

interface RenderRequest {
  db: DatabaseSync;
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
  /** The run that asked, whose scratch this is until it ends; null for a
   *  delivery's own render. */
  runId: string | null;
}


/** One file's carry: its size, that it is past what a capture carries, or
 *  null when the kept delivery holds no regular file of that name. */
type CarriedFile = { bytes: number } | { tooLarge: true } | null;

/**
 * Copy one kept file for the renderer, by descriptor at both ends: the source
 * opened without following a link, the copy made new (never over an entry and
 * never through one, ruling 19's rule for a write), readable by its group
 * and writable by the server alone.
 */
function carryFile(source: string, copy: string, room: number): CarriedFile {
  let from: number;
  try {
    from = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(from);
    if (!stat.isFile()) return null;
    if (stat.size > room) return { tooLarge: true };
    const to = openSync(
      copy,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o640,
    );
    try {
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CARRY_CHUNK_BYTES, stat.size)));
      for (;;) {
        const read = readSync(from, buffer, 0, buffer.length, null);
        if (read === 0) break;
        for (let written = 0; written < read; ) written += writeSync(to, buffer, written, read - written);
      }
    } finally {
      closeSync(to);
    }
    return { bytes: stat.size };
  } finally {
    closeSync(from);
  }
}

/** What of a kept delivery reached the renderer. */
interface Carried {
  /** The names carried: the renderer is told them, since it cannot list the
   *  folder they are in. */
  names: string[];
  /** The names left out: more than a capture carries. */
  notCarried: Set<string>;
}

/**
 * A kept delivery is the server's own (its files are not the agent group's to
 * read), so its files are copied for the render into `into`, a folder of the
 * task's `.capture-input/`: both the server's own, 0710 in the agent group,
 * under a parent no agent can write, each file 0640. The renderer passes
 * through and reads; it lists nothing and writes nothing there. The pages
 * first, then the rest by name, within the limits.
 *
 * Throws when a folder or a file cannot be made so. Nothing is copied into a
 * folder that is not the server's own (ruling 140), and a file the renderer
 * could not read would be pictured as missing from the delivery.
 */
function carryDelivery(from: string, into: string, pages: readonly PageInput[]): Carried {
  passThroughDirForAgents(path.dirname(into));
  passThroughDirForAgents(into);
  let entries: Dirent[];
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const own = pageCapturesAmong(entries.map((entry) => entry.name));
  const first = new Set(pages.map((page) => page.file));
  const wanted = entries
    .filter((entry) => entry.isFile() && !own.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(first.has(b)) - Number(first.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const carried: Carried = { names: [], notCarried: new Set() };
  let total = 0;
  for (const name of wanted) {
    const copy = path.join(into, name);
    const room = Math.min(CARRIED_FILE_MAX_BYTES, CARRIED_TOTAL_MAX_BYTES - total);
    const file = carryFile(path.join(from, name), copy, room);
    if (!file) continue;
    if ("tooLarge" in file) {
      carried.notCarried.add(name);
      continue;
    }
    shareFileForAgentsToRead(copy);
    carried.names.push(name);
    total += file.bytes;
  }
  return carried;
}

/** Remove the renderer's input folder. The server's own remove is the right
 *  one here and only here: no agent can write under it (ruling 140 is about
 *  the trees one can). */
function removeCaptureInput(inputRoot: string): void {
  try {
    rmSync(inputRoot, { recursive: true, force: true });
  } catch (error) {
    logger.warn("a page capture's input folder could not be removed", { dir: inputRoot, err: toError(error) });
  }
}

/** The folder name a run's stretches are kept under, or null for an id that
 *  cannot be one. */
function runFolder(runId: string | null): string | null {
  if (!runId) return null;
  try {
    return assertPathSafeRunId(runId);
  } catch {
    return null;
  }
}

function runIsLive(db: DatabaseSync, runId: string): boolean {
  const state = getRun(db, runId)?.state;
  return state === "running" || state === "queued";
}

/** Run the renderer child once over `pages` and read back what it made.
 *  Throws only before the child starts; after that every failure is a page's
 *  `error`. */
async function render(request: RenderRequest): Promise<Render> {
  const { db, ctx, projectSlug, taskKey, launch, pages, views } = request;
  const captureId = newId("cap");
  const task = taskDir(projectSlug, taskKey, ctx.dataRoot);
  const capturesRoot = path.join(task, TASK_CAPTURE_SCRATCH_DIR);
  const homeName = runFolder(request.runId) ?? NO_RUN_HOME;
  const home = path.join(capturesRoot, homeName);
  const scratch = path.join(home, captureId);
  const tmp = path.join(scratch, "tmp");
  try {
    // Level by level: each folder is the server's own directory, in a parent
    // only the server writes, before anything is listed, made or removed
    // below it. A link on the way (which no agent can put there) refuses the
    // render and nothing is touched through it.
    passThroughDirForAgentsOrWarn(capturesRoot);
    // One render runs at a time, so what else is here is a render a restart
    // cut short or the stretches of a run that has ended: removed before this
    // one starts. A run still going keeps its own, so two reviewers on one
    // task do not take each other's pictures away.
    for (const other of readdirSync(capturesRoot)) {
      if (other === homeName || runIsLive(db, other)) continue;
      await removeCaptureHome(path.join(capturesRoot, other), launch);
    }
    passThroughDirForAgentsOrWarn(home);
    // The last render kept here (the run's own last stretch) is replaced by
    // this one.
    for (const last of readdirSync(home)) await removeScratch(path.join(home, last), launch);
    // Ruling 15: the renderer runs as the person's uid, so this one folder
    // is the agents' to write. Made new, under a name nobody has been told
    // yet: `mkdir` refuses an entry that is already there, a link included.
    mkdirSync(scratch);
    shareDirWithAgentsOrWarn(scratch);
    mkdirSync(tmp);
    shareDirWithAgentsOrWarn(tmp);
  } catch (error) {
    logger.warn("a page render's scratch folder could not be made", { projectSlug, taskKey, err: toError(error) });
    throw new RenderRefused(NO_SCRATCH, { cause: error });
  }
  const out = path.join(scratch, "out");
  const job: ChildJob = {
    root: taskAttachmentsDir(projectSlug, taskKey, ctx.dataRoot),
    out,
    profile: path.join(scratch, "profile"),
    browser: request.renderer.browser,
    pages,
    views,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: IMAGE_READ_MAX_BYTES,
  };
  const inputRoot = path.join(task, TASK_CAPTURE_INPUT_DIR);
  let notCarried = new Set<string>();
  const timeoutMs = JOB_BASE_MS + PAGE_TIMEOUT_MS * pages.length;
  let outcome: Awaited<ReturnType<typeof runPersonCommand>>;
  try {
    if (request.source.kind === "kept") {
      // Whatever is here is an earlier render's that a restart cut short.
      removeCaptureInput(inputRoot);
      job.root = path.join(inputRoot, captureId);
      try {
        const carried = carryDelivery(request.source.dir, job.root, pages);
        job.names = carried.names;
        notCarried = carried.notCarried;
      } catch (error) {
        // The reason a task shows is free of deployment paths; the log has them.
        logger.warn("a delivery's files could not be handed to the page renderer", {
          projectSlug,
          taskKey,
          err: toError(error),
        });
        await removeScratch(scratch, launch);
        throw new RenderRefused("the delivered files could not be handed to the renderer", { cause: error });
      }
    }
    outcome = await runPersonCommand({
      file: process.execPath,
      args: [request.renderer.child],
      // On its standard input, never as an argument: the job names every file
      // of a kept delivery, and a delivery of thousands is past what the
      // kernel takes as one argument.
      stdin: JSON.stringify(job),
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
  } finally {
    if (request.source.kind === "kept") removeCaptureInput(inputRoot);
  }
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
    if (!said) return unpictured(page.file, unreported);
    const shots: RenderedShot[] = [];
    let error = said.error === null ? null : reportText(said.error);
    for (const shot of said.shots) {
      const view = views.find((v) => v.id === shot.view);
      if (!view) continue;
      // By the server's own naming, never a path the report gives.
      const file = path.join(out, `${index + 1}-${view.id}.png`);
      const read = readAttachmentBytes(file, IMAGE_READ_MAX_BYTES);
      const header = read && "bytes" in read ? imageHeader(read.bytes) : null;
      // A box has one size, to the px; a stretch has its width and a cap.
      const exact = view.box ? boxPicture({ width: view.width, height: view.height, scale: view.box.scale }) : null;
      const sized =
        header !== null &&
        (exact
          ? header.width === exact.width && header.height === exact.height
          : header.width === view.width && header.height >= 1 && header.height <= view.maxHeight);
      if (!read || !("bytes" in read) || !header || header.mimeType !== "image/png" || !sized) {
        error ??= `its ${exact ? "" : `${view.id} `}picture did not come back as a PNG of the size asked for`;
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
      ended: said.ended.filter((end) => views.some((view) => view.id === end.view)),
      dialogs: said.dialogs,
      asked: said.asked.slice(0, 12).map(reportName),
      askedCount: said.askedCount,
      // As the renderer wrote them: a name is matched against the names a
      // capture did not carry before it is cut for print (`missingClauses`).
      missing: said.missing.slice(0, 12),
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
  // A path the page server refuses whatever the folder holds: from the
  // site's root, or above the page's own folder. No file name starts so.
  const outside = page.missing.filter((name) => !notCarried.has(name) && name.startsWith("/"));
  const absent = page.missing.filter((name) => !notCarried.has(name) && !name.startsWith("/"));
  // Sorted into its kind by the name as it is, then printed cut and cleaned:
  // a long name cut first would no longer be the name that was not carried.
  const named = (names: readonly string[]): string => LIST_AND.format(names.map((name) => code(reportName(name))));
  const clauses: string[] = [];
  if (absent.length > 0) {
    clauses.push(
      `${named(absent)}, which ${absent.length === 1 ? "is" : "are"} not among this task's files (the folder is flat)`,
    );
  }
  if (outside.length > 0) {
    clauses.push(
      `${named(outside)}, ${outside.length === 1 ? "a path" : "paths"} from the site's root or above the page's folder, ` +
        "which a capture does not serve (it serves the task's own files by name)",
    );
  }
  if (tooLarge.length > 0) {
    clauses.push(`${named(tooLarge)}, which a capture does not carry (a file over 25 MB, or past 200 MB in all)`);
  }
  return clauses;
}

/** What a shrunk or overflowing layout means for a reader, or null. `subject`
 *  is how the sentence names the page: its name in a note, "it" in a reply. */
function widthRemark(shot: RenderedShot, subject: string): string | null {
  const view = pageCaptureView(shot.view);
  if (shot.scale < 0.99) {
    return `A ${view.id} lays ${subject} out ${px(Math.round(view.width / shot.scale))} px wide and shrinks it to fit its ${px(view.width)} px screen, so its text is small.`;
  }
  if (shot.contentWidth > view.width + 1) {
    const opening = subject.charAt(0).toUpperCase() + subject.slice(1);
    return `${opening} is ${px(shot.contentWidth)} px wide on a ${px(view.width)} px screen, so a reader scrolls sideways.`;
  }
  return null;
}

/** A page that stops on a dialog is pictured behind it, and a reader is not. */
const DIALOG_REMARK =
  "a dialog as it loads (an alert, a confirm or a prompt). A capture dismisses it, so the picture shows the page behind it.";

/** What one pictured page's pictures do not show by themselves. */
function pageRemarks(page: RenderedPage, notCarried: ReadonlySet<string>): string[] {
  const remarks: string[] = [];
  for (const shot of page.shots) {
    if (shot.cut) {
      remarks.push(
        `${code(page.file)} runs longer than its ${shot.view} picture, which shows the first ${px(shot.height)} px of ${px(shot.contentHeight)}.`,
      );
    }
    const width = widthRemark(shot, code(page.file));
    if (width) remarks.push(width);
  }
  if (page.dialogs > 0) remarks.push(`${code(page.file)} opens ${DIALOG_REMARK}`);
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

/** What a delivery's note is written from. */
interface CaptureNote {
  pages: readonly RenderedPage[];
  /** How many pages past the cap were not pictured. */
  more: number;
  notCarried: ReadonlySet<string>;
  /** The unpictured pages an agent's own `capture_page` can still show. */
  lookable: ReadonlySet<string>;
}

/** The timeline note a delivery's render writes. */
function captureNoteText({ pages, more, notCarried, lookable }: CaptureNote): string {
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
    // The tool is named only for a page it can show: it shares the renderer,
    // the owner it runs as and the source's size limit with this render.
    const open = failed.filter((page) => lookable.has(page.file));
    const look =
      open.length === 0
        ? ""
        : open.length === failed.length
          ? ", and an agent can look with `capture_page`"
          : `, and an agent can look at ${LIST_AND.format(open.map((page) => code(page.file)))} with \`capture_page\``;
    parts.push(`The delivery stands without ${failed.length === 1 ? "it" : "them"}${look}.`);
  }
  if (more > 0) {
    parts.push(`${more === 1 ? "1 more page was" : `${px(more)} more pages were`} not pictured: ${PAST_PAGE_CAP}.`);
  }
  return parts.join(" ");
}

// ------------------------------------------------------------ a delivery

interface DeliveryPages {
  pages: PageInput[];
  /** The pages past the cap, in the same order: not pictured. */
  extra: string[];
}

/**
 * The pages of a kept delivery: its files that are pages, less what a person
 * uploaded or a relay carried in (inputs, not results). The deliverer's own
 * first, then by code point; the first {@link PAGE_CAPTURE_MAX_PAGES}. One of
 * Viberr's own pictures is a PNG and never a page.
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
  // The deliverer's own, not every maker's (ruling 81): a picture's drawing
  // is a page too, and must not be pictured ahead of the piece or in its place.
  const delivered = deliverersOwnFileNames(fm, timeline);
  const pages = files
    .filter((name) => pageKindOf(name) !== null && !inputs.has(name))
    .sort((a, b) => Number(delivered.has(b)) - Number(delivered.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    pages: pages.slice(0, PAGE_CAPTURE_MAX_PAGES).map((file) => ({ file, kind: pageKindOf(file)! })),
    extra: pages.slice(PAGE_CAPTURE_MAX_PAGES),
  };
}

/** Why a file is not handed to the renderer at all. */
interface SourceRefusal {
  reason: string;
  /** An agent's own `capture_page` refuses the file for the same reason. */
  sharedByTool: boolean;
}

function sourceRefusal(file: string, kind: PictureKind, bytes: number): SourceRefusal | null {
  const cap = SOURCE_MAX_BYTES[kind];
  if (bytes > cap) {
    return {
      reason: `the file is ${(bytes / 1024 / 1024).toFixed(1)} MB; a page of up to ${cap / 1024 / 1024} MB is pictured`,
      sharedByTool: true,
    };
  }
  // The tool keeps nothing under the file's name, so it still shows this one.
  if (file.length > PAGE_CAPTURE_MAX_NAME_CHARS) {
    return {
      reason: `its name is longer than ${PAGE_CAPTURE_MAX_NAME_CHARS} characters, and a picture is kept under the file's name`,
      sharedByTool: false,
    };
  }
  return null;
}

/** The name the store keeps a page's picture under: trimmed and composed
 *  (`checkAttachmentUpload`, ruling 76), so two pages can come to one. Null
 *  for a name the store refuses, which the write itself then says. */
function keptPictureName(file: string): string | null {
  try {
    return checkAttachmentUpload(pageCaptureName(file, "desktop"), 0);
  } catch {
    return null;
  }
}

/**
 * Pages whose pictures another page's would be kept over, each with that
 * page: two names that differ only in what the store trims or composes
 * (` notes.md` and `notes.md`, or one name in both Unicode forms on a disk
 * that holds names byte for byte) share one pair of picture names. The page
 * spelled the way the store spells it keeps them.
 */
function pictureNameClashes(pages: readonly PageInput[]): Map<string, string> {
  const keeper = new Map<string, string>();
  const asStored = (page: PageInput): boolean => keptPictureName(page.file) === pageCaptureName(page.file, "desktop");
  const clashes = new Map<string, string>();
  for (const page of [...pages].sort((a, b) => Number(asStored(b)) - Number(asStored(a)))) {
    const kept = keptPictureName(page.file);
    if (kept === null) continue;
    const first = keeper.get(kept);
    if (first === undefined) keeper.set(kept, page.file);
    else clashes.set(page.file, first);
  }
  return clashes;
}

/** Remove the pictures a record named. By the record, never by pattern, and
 *  never a name that does not end like a picture, whatever a record holds. */
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
  // A delivery that is a revision is not pictured: its pages live in the pull
  // request, where the reviewers' browser and the operator's named
  // screenshots show them. The files its run saved are evidence beside it,
  // and the Result card of such a task shows no files to put a picture by.
  const { pages, extra } = deliveredAsFiles(fm)
    ? deliveryPages(keptFiles, fm, file.parsed.timeline)
    : { pages: [], extra: [] };
  unlinkRecorded(ctx, projectSlug, taskKey, recordedPageCaptures(fm.pageCaptures));
  if (!kept || pages.length === 0) {
    // No page to picture: nothing to say, and the last delivery's record goes.
    if (fm.pageCaptures) {
      await updateTaskFile(ref, (parsed) => {
        if (parsed.frontmatter.deliveredAt === stamp) delete parsed.frontmatter.pageCaptures;
      });
      reprojectTask(db, ctx, projectSlug, taskKey);
    }
    return;
  }
  const refused = new Map<string, SourceRefusal>();
  const clashes = pictureNameClashes(pages);
  for (const page of pages) {
    let bytes = 0;
    try {
      bytes = statSync(path.join(kept, page.file)).size;
    } catch {
      bytes = 0;
    }
    const other = clashes.get(page.file);
    const refusal =
      sourceRefusal(page.file, page.kind, bytes) ??
      (other === undefined
        ? null
        : {
            reason: `its pictures would be kept under the same names as the pictures of "${reportName(other)}"`,
            sharedByTool: true,
          });
    if (refusal) refused.set(page.file, refusal);
  }
  const toRender = pages.filter((page) => !refused.has(page.file));
  let launch: AgentLaunch | null = null;
  /** The renderer is there and has somebody to run as: what `capture_page`
   *  needs too, so the note offers it only then. */
  let toolCanRender = false;
  let rendered: Render = { pages: [], scratch: null, notCarried: new Set() };
  try {
    if (!("browser" in found)) throw new Error(found.reason ?? "this server has no browser to render with");
    launch = taskOwnerLaunch(db, fm.ownerUserId, ctx.dataRoot, NO_OWNER);
    toolCanRender = true;
    if (toRender.length > 0) {
      rendered = await render({
        db,
        ctx,
        projectSlug,
        taskKey,
        renderer: found,
        launch,
        source: { kind: "kept", dir: kept },
        pages: toRender,
        views: PAGE_CAPTURE_VIEWS.map((view) => ({ ...childView(view), from: 0 })),
        runId: null,
      });
    }
  } catch (error) {
    // Whatever stopped the render is each page's reason; the delivery stands.
    const reason = reportText(error instanceof AppError ? error.userMessage : errorMessage(error));
    rendered = {
      pages: toRender.map((page) => unpictured(page.file, reason)),
      scratch: null,
      notCarried: new Set(),
    };
  }
  const byFile = new Map(rendered.pages.map((page) => [page.file, page]));
  const results = pages.map(
    (page): RenderedPage =>
      byFile.get(page.file) ?? unpictured(page.file, refused.get(page.file)?.reason ?? "it was not rendered"),
  );
  const record: PageCaptures = { deliveredAt: stamp, at: new Date().toISOString(), pages: [] };
  const written: string[] = [];
  const failed: string[] = [];
  /** What the locked write below did: put the pictures down, or took an
   *  earlier delivery's record away because this one became a revision. */
  const wrote = { pictures: false, cleared: false };
  // Everything a render leaves on a task is put down inside the task
  // file's own lock, after the two checks that decide whether it may be:
  // the pictures, their copy in the kept delivery, the record and the note.
  // The render itself ran outside the lock and took seconds, and the task
  // can have moved on under it.
  await updateTaskFile(ref, (parsed) => {
    // A delivery that landed while this rendered has its own job, and these
    // pictures are not of it.
    if (parsed.frontmatter.deliveredAt !== stamp) return;
    // The task's work became a revision while this rendered (a caller that
    // asked before the delivery reconcile had minted one): a revision is
    // never pictured, recorded or noted. The record still here is of an
    // earlier files delivery, whose pictures went above.
    if (!deliveredAsFiles(parsed.frontmatter)) {
      if (parsed.frontmatter.pageCaptures) {
        delete parsed.frontmatter.pageCaptures;
        wrote.cleared = true;
      }
      return;
    }
    // The pictures land on the task, then in the kept delivery they picture.
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
      if (shots.length === 0) failed.push(page.file);
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
    const lookable = new Set(
      toolCanRender ? failed.filter((name) => refused.get(name)?.sharedByTool !== true) : [],
    );
    const note: TaskFileEvent = {
      occurredAt: record.at,
      type: "note",
      actor: CAPTURE_ACTOR,
      title: PAGE_CAPTURE_NOTE_TITLE,
      text: captureNoteText({ pages: noted, more: extra.length, notCarried: rendered.notCarried, lookable }),
      toAgent: false,
      evidence: null,
    };
    if (written.length > 0) note.attachments = [...written];
    // The record also says why a page past the cap has no picture, so the
    // operator's fact and the card can: the next ones, up to its own bound.
    for (const name of extra.slice(0, RECORDED_PAGES_MAX - results.length)) {
      record.pages.push({ file: name, shots: [], error: PAST_PAGE_CAP });
    }
    parsed.frontmatter.pageCaptures = record;
    parsed.timeline.unshift(note);
    wrote.pictures = true;
  });
  if (rendered.scratch) await removeScratch(rendered.scratch, launch);
  if (!wrote.pictures) {
    if (wrote.cleared) reprojectTask(db, ctx, projectSlug, taskKey);
    return;
  }
  reprojectTask(db, ctx, projectSlug, taskKey);
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
      pages: results.length,
      captured: results.length - failed.length,
      failed,
      more: extra.length,
      wallMs,
      runsAs: launch ? launch.uid : "server",
    },
  });
  logger.info("page captures made", {
    projectSlug,
    taskKey,
    pages: results.length,
    captured: results.length - failed.length,
    wallMs,
  });
}

/** False only when the job would do nothing: no browser is named, or the
 *  delivery is a revision or holds no file that is a page, and the task has
 *  no record of an earlier delivery's pictures to take down. Anything
 *  unreadable is the job's to find out. A saving, never the rule: a delivery
 *  that becomes a revision after this looked is refused by the job's own
 *  locked write. */
function owesCapture(ctx: TaskMutationContext, input: DeliveryCaptureInput): boolean {
  try {
    const found = renderer();
    if ("configured" in found && !found.configured) return false;
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!file || file.parsed.frontmatter.pageCaptures) return true;
    if (!deliveredAsFiles(file.parsed.frontmatter)) return false;
    const kept = keptDeliveryDir(input.projectSlug, input.taskKey, input.stamp, ctx.dataRoot);
    return !kept || readdirSync(kept).some((name) => pageKindOf(name) !== null);
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
 * delivery and never a reason for one to fail. Ask once it is known whether
 * the delivery is files or a revision (after the completion's delivery
 * reconcile); asked earlier, a render may run and its pictures are dropped.
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
  /** An exact size, in CSS px: with both, one picture of that box and no
   *  stretches. */
  width?: number | undefined;
  height?: number | undefined;
  /** How many picture px draw one CSS px of the box; 1 when absent. */
  scale?: number | undefined;
  /** False for a run that holds the verdict: it judges pictures and makes
   *  none, so a sized reply does not tell it how one is kept on the task.
   *  Told, a reviewer is one copy away from replacing the file it was asked
   *  to judge with its own render of it. */
  keeps?: boolean | undefined;
  /** The run that asks. Its pictures are kept for it under its own folder of
   *  the scratch and go when it ends; null when the caller cannot name it. */
  runId: string | null;
}

const said = (text: string): PageCaptureReply => ({ text, images: [] });

/** One view's stretch, in the reply's words. */
function stretchSentence(shot: RenderedShot): string {
  const view = pageCaptureView(shot.view);
  const end = shot.from + shot.height;
  let rest: string;
  if (!shot.cut) rest = shot.from === 0 ? ", the whole page" : ", the end of the page";
  else if (end <= PAGE_CAPTURE_MAX_FROM) rest = ` (\`nextFrom\`: ${end})`;
  // No `nextFrom` the tool would then refuse.
  else rest = `; the page runs on, and a stretch starts no further down than ${px(PAGE_CAPTURE_MAX_FROM)} px`;
  return `${view.label}: ${px(shot.from)} to ${px(end)} px of ${px(Math.max(shot.contentHeight, end))}${rest}.`;
}

/** "at 2,500 px at the desktop width (1280 px)". */
function endedClause(end: EndedView): string {
  const view = pageCaptureView(end.view);
  return `at ${px(end.pageHeight)} px at the ${view.id} width (${view.width} px)`;
}

/** What a page did as it loaded, in a reply's words: the dialog it opened,
 *  and what it asked for and did not get. */
function loadRemarks(page: RenderedPage): string[] {
  const parts: string[] = [];
  if (page.dialogs > 0) parts.push(`It opens ${DIALOG_REMARK}`);
  const asks: string[] = [];
  const asked = askedClause(page);
  if (asked) asks.push(`${asked}, which a capture never loads`);
  for (const clause of missingClauses(page, new Set())) asks.push(`for ${clause}`);
  if (asks.length > 0) parts.push(`It asked ${asks.join(", and ")}.`);
  if (page.error) parts.push(`Not every picture was made: ${page.error}.`);
  return parts;
}

function captureReplyText(name: string, page: RenderedPage, from: number, scratchNote: string): string {
  const parts = [`[done] ${code(name)} as a reader sees it.`];
  for (const view of PAGE_CAPTURE_VIEWS) {
    const shot = page.shots.find((s) => s.view === view.id);
    const end = page.ended.find((e) => e.view === view.id);
    if (shot) parts.push(stretchSentence(shot));
    // A phone lays a page out taller than a desktop does: past the shorter
    // layout's end, the other width still has the stretch.
    else if (end) parts.push(`${view.label}: the page ends at ${px(end.pageHeight)} px, so nothing starts at ${px(from)} px.`);
  }
  for (const shot of page.shots) {
    const width = widthRemark(shot, "it");
    if (width) parts.push(width);
  }
  parts.push(...loadRemarks(page), scratchNote);
  return parts.join(" ");
}

/** How a run keeps the picture it was just told the path of. The tool itself
 *  saves nothing on the task: the run's own copy is a file it saved, claimed
 *  and kept like any other. */
const KEEP_PICTURE =
  "Copying that file into the task's attachments folder under a name ending `.png` keeps it as a file of the task.";

/** Said in place of a picture too large to hand back. The file is saved all
 *  the same: only the look is at a lower scale. */
const NOT_SHOWN = `It is over ${px(TOOL_STRETCH_PX)} px on a side, so it is saved and not shown here: the same box at a lower scale is the same layout, and shows you it.`;

/** Whether a picture is handed back as an image block: a stretch always is
 *  (it is cut to fit), a box only while both its sides are within what a
 *  model is handed once a request holds more than 20 images. A run that draws
 *  looks at many pictures, and one refused image ends it. */
function shownToTheRun(shot: RenderedShot): boolean {
  return shot.width <= TOOL_STRETCH_PX && shot.height <= TOOL_STRETCH_PX;
}

/**
 * The reply to a picture of an exact size: what was asked and what was saved,
 * then what of the page the box left out. That is how the run that drew the
 * page learns its layout does not fit: the picture alone shows a cut edge and
 * not how much lies past it.
 */
function boxReplyText(
  name: string,
  page: RenderedPage,
  box: PictureBox,
  scratchNote: string,
  keeps: boolean,
  shown: boolean,
): string {
  const parts: string[] = [];
  for (const shot of page.shots) {
    parts.push(
      `[done] ${code(name)} as a picture of the size asked: ${px(box.width)} by ${px(box.height)} px at scale ${box.scale}, ` +
        `saved as a PNG of ${px(shot.width)} by ${px(shot.height)} px.`,
    );
    if (shot.contentHeight > box.height) {
      parts.push(
        `It is laid out ${px(shot.contentHeight)} px tall in a box ${px(box.height)} px tall, ` +
          "so the picture leaves out what is below the box.",
      );
    }
    if (shot.contentWidth > box.width) {
      parts.push(
        `It is laid out ${px(shot.contentWidth)} px wide in a box ${px(box.width)} px wide, ` +
          "so the picture leaves out what is to the right of the box.",
      );
    }
  }
  parts.push(...loadRemarks(page));
  if (!shown) parts.push(NOT_SHOWN);
  parts.push(scratchNote);
  if (keeps) parts.push(KEEP_PICTURE);
  return parts.join(" ");
}

/** A page the door has found on the task and may render. */
interface AskedPage {
  /** The name as the agent typed it, which the reply uses. */
  name: string;
  /** The name the folder holds it under (ruling 76): what the renderer opens. */
  stored: string;
  kind: PictureKind;
  /** The exact size asked for, or null for the page in stretches. */
  box: PictureBox | null;
}

async function capturePage(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  ask: PageCaptureAsk,
  asked: AskedPage,
  found: Renderer,
): Promise<PageCaptureReply> {
  const { projectSlug, taskKey } = ask;
  const { name, stored, kind, box } = asked;
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) return said(`[noop] ${code(name)} is not a page on ${taskKey}.`);
  const owner = file.parsed.frontmatter.ownerUserId;
  let launch: AgentLaunch | null;
  try {
    launch = taskOwnerLaunch(db, owner, ctx.dataRoot, NO_OWNER);
  } catch (error) {
    if (owner === null) {
      return said(
        `[error] ${code(name)} could not be captured: this task has no owner to render it as. ` +
          "A page renders as its person's agent user, never as the server.",
      );
    }
    // The owner is there and their launch could not be prepared: the
    // launch's own sentence, which says what failed.
    logger.warn("a page could not be captured", { taskKey, file: name, reason: errorMessage(error) });
    return said(
      `[error] ${code(name)} could not be captured. ` +
        (error instanceof AppError ? error.userMessage : "The renderer could not be started as the task owner's agent user."),
    );
  }
  const from = ask.from ?? 0;
  const views = box
    ? [boxView(box)]
    : PAGE_CAPTURE_VIEWS.filter((view) => !ask.view || view.id === ask.view).map(
        (view): ChildView => ({ ...childView(view), maxHeight: TOOL_STRETCH_PX, from }),
      );
  let rendered: Render;
  try {
    rendered = await render({
      db,
      ctx,
      projectSlug,
      taskKey,
      renderer: found,
      launch,
      source: { kind: "attachments" },
      pages: [{ file: stored, kind }],
      views,
      runId: ask.runId,
    });
  } catch (error) {
    logger.warn("a page could not be captured", { taskKey, file: name, reason: errorMessage(error) });
    const reason = error instanceof RenderRefused ? error.message : "the renderer could not be started";
    return said(`[error] ${code(name)} could not be captured: ${reason}.`);
  }
  if (rendered.scratch) {
    // Only the pictures are kept for the run: the browser's profile and the
    // render's temp files go now, as the person who wrote them.
    for (const spent of ["profile", "tmp"]) await removeScratch(path.join(rendered.scratch, spent), launch);
  }
  const page = rendered.pages[0];
  const ends = page && page.ended.length > 0 ? `ends ${LIST_AND.format(page.ended.map(endedClause))}` : null;
  if (page && page.shots.length === 0 && page.ended.length === views.length && ends) {
    // Asked for a stretch past the page's end at every width: nothing failed.
    return said(`[noop] ${code(name)} ${ends}, so nothing starts at ${px(from)} px.`);
  }
  if (!page || page.shots.length === 0) {
    // A width that failed is the answer, whatever another width ended at.
    const reason = page?.error ?? "it was not rendered";
    logger.warn("a page could not be captured", { taskKey, file: name, reason });
    return said(
      `[error] ${code(name)} could not be captured: ${reason}.` +
        (reason.startsWith("the render ran past")
          ? " A script that never finishes, or a page that never finishes loading, does that."
          : "") +
        (ends ? ` It ${ends}, so nothing starts at ${px(from)} px there.` : ""),
    );
  }
  logger.info("a page was captured for a run", { projectSlug, taskKey, file: name, views: page.shots.length });
  const paths = LIST_AND.format(page.shots.map((shot) => code(shot.path)));
  const kept =
    runFolder(ask.runId) !== null
      ? `Saved for this run at ${paths}: scratch, your next capture replaces it, and it goes when this run ends.`
      : `Saved at ${paths}: scratch, and the next capture on this task replaces it.`;
  // A stretch is cut to what a model reads well. A box is the size its
  // author asked for, up to 8,000 px a side: past 2,000 it is saved and not
  // handed back, and the reply says to look at a lower scale.
  const shown = !box || page.shots.every(shownToTheRun);
  return {
    text: box
      ? boxReplyText(name, page, box, kept, ask.keeps !== false, shown)
      : captureReplyText(name, page, from, kept),
    images: shown ? page.shots.map((shot) => ({ data: shot.bytes.toString("base64"), mimeType: "image/png" })) : [],
  };
}

/**
 * The view a box is pictured at: its own viewport, laid out as the desktop
 * view lays a page out (never as a phone), so the renderer is told it, and
 * reports it, under that view's id.
 */
function boxView(box: PictureBox): ChildView {
  return {
    ...childView(pageCaptureView("desktop")),
    width: box.width,
    height: box.height,
    maxHeight: box.height,
    from: 0,
    box: { scale: box.scale },
  };
}

/**
 * The box an ask names: null when it names none, or the refusal of a size
 * that cannot be pictured. Each side and the scale are held to their ranges
 * where the call is parsed (`CAPTURE_PAGE_BOX`), on both backends.
 */
function askedBox(ask: PageCaptureAsk, name: string): PictureBox | PageCaptureReply | null {
  const { width, height, scale } = ask;
  const refused = (why: string): PageCaptureReply => said(`[noop] ${code(name)} was not pictured: ${why}`);
  if (width === undefined && height === undefined) {
    return scale === undefined
      ? null
      : refused("`scale` goes with a size. Give `width` and `height` too, or leave `scale` out.");
  }
  if (width === undefined || height === undefined) {
    const [given, wanted] = width === undefined ? ["height", "width"] : ["width", "height"];
    return refused(`a size is \`width\` and \`height\` together, and this call gave only \`${given}\`. Give \`${wanted}\` too.`);
  }
  if (ask.view !== undefined || ask.from !== undefined) {
    return refused(
      "a size makes one picture of the box it names, so it goes with neither `view` nor `from`. " +
        "Give the size alone, or leave it out to look at the page in stretches.",
    );
  }
  const box: PictureBox = { width, height, scale: scale ?? 1 };
  const picture = boxPicture(box);
  if (picture.width * picture.height > BOX_MAX_PX) {
    return refused(
      `${px(width)} by ${px(height)} px at scale ${box.scale} is a picture of ${px(picture.width)} by ${px(picture.height)} px, ` +
        `${px(picture.width * picture.height)} px in all, and a capture makes one of up to ${px(BOX_MAX_PX)}. ` +
        "Lower the scale or the size.",
    );
  }
  return box;
}

/**
 * `capture_page`: one page on the run's task as a reader sees it, in a stretch
 * a model can read, or (given a size) a page or a drawing as one picture of
 * exactly that size. Saves nothing on the task, writes no audit row and no
 * timeline entry (it changes nothing, like `read_task_attachment`): a picture
 * a run wants kept is the run's to copy from the scratch the reply names.
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
  // What the call itself gets wrong is said before any file is looked for.
  const box = askedBox(ask, name);
  if (box && "text" in box) return Promise.resolve(box);
  let size: number | null = null;
  let stored = name;
  // A dot name is no file of the task to any reader, this one included: the
  // renderer's own page server answers none.
  if (!name.startsWith(".")) {
    try {
      const resolved = resolveTaskAttachment(projectSlug, taskKey, name, ctx.dataRoot);
      const stat = statSync(resolved);
      if (stat.isFile()) {
        size = stat.size;
        // Ruling 76: found in either Unicode form, and rendered under the
        // spelling the folder holds, which is the one the renderer can open.
        stored = path.basename(resolved);
      }
    } catch {
      size = null;
    }
  }
  if (size === null) {
    // The reader's own sentence.
    return Promise.resolve(said(noSuchAttachment({ db, ctx, projectSlug }, taskKey, name)));
  }
  const kind = pictureKindOf(name);
  if (!kind) {
    return Promise.resolve(
      said(
        `[noop] ${code(name)} is not a page. capture_page renders ${PAGE_EXTENSIONS_TEXT} files, ` +
          "and a .svg drawing given `width` and `height`; read any other file with read_task_attachment.",
      ),
    );
  }
  if (kind === "svg" && !box) {
    return Promise.resolve(
      said(`[noop] ${code(name)} is a drawing, and a drawing is pictured at a size: give \`width\` and \`height\`.`),
    );
  }
  const cap = SOURCE_MAX_BYTES[kind];
  if (size > cap) {
    return Promise.resolve(
      said(
        `[noop] ${code(name)} is ${(size / 1024 / 1024).toFixed(0)} MB; capture_page renders ` +
          `${kind === "svg" ? "a drawing" : "a page"} of up to ${cap / 1024 / 1024} MB.`,
      ),
    );
  }
  const asked: AskedPage = { name, stored, kind, box };
  return new Promise((resolve) => {
    const job: QueuedJob = {
      kind: "tool",
      task: `${projectSlug}/${taskKey}`,
      drop: () => resolve(said("[busy] The renderer is working on other pages. Call again in a moment.")),
      run: async () => {
        clearTimeout(timer);
        try {
          resolve(await capturePage(db, ctx, ask, asked, found));
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

/**
 * A run has ended: the pictures `capture_page` kept for it go, as the task's
 * person (ruling 140), whose agent user the renderer wrote them as. Called by
 * the completion pipeline for every run that ends; a run that asked for no
 * picture has no folder and costs one look. The folder is looked for through
 * no link: `.captures/` and the run's folder in it are each the server's own
 * directory, or nothing is done. Never throws: what cannot be removed now is
 * removed before the next render on the task.
 */
export async function removeRunPageCaptures(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; runId: string },
): Promise<void> {
  try {
    const runDir = runFolder(input.runId);
    if (!runDir) return;
    const root = path.join(taskDir(input.projectSlug, input.taskKey, ctx.dataRoot), TASK_CAPTURE_SCRATCH_DIR);
    const home = path.join(root, runDir);
    if (!isServersOwnDir(root) || !isServersOwnDir(home)) return;
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const launch = taskOwnerLaunch(db, file?.parsed.frontmatter.ownerUserId ?? null, ctx.dataRoot, NO_OWNER);
    await removeCaptureHome(home, launch);
  } catch (error) {
    logger.warn("a run's page captures could not be removed", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: input.runId,
      err: toError(error),
    });
  }
}
