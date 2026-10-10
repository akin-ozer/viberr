import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../../../test-support/audit-log";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { withEnv } from "../../../test-support/env";
import { writeFakeBrowser, type FakeBrowser } from "../../../test-support/fake-browser";
import { installFakeRuntime, queueFakeRun } from "../../../test-support/fake-runtime";
import { gitOutSync } from "../../../test-support/git-origin";
import { pollUntil } from "../../../test-support/polling";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { reconfigureProject } from "../../../test-support/projected-store";
import type { Engagement, WorkRevision } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keepDelivery, listKeptDeliveries } from "~/server/files/kept-deliveries.server";
import { attachmentNamesSince, imageHeader } from "~/server/files/task-attachments.server";
import { writeTaskSource } from "~/server/files/task-sources.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { AGENT_UID_FLOOR, resetAgentIsolationForTests } from "~/server/runtimes/agent-isolation.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { interruptRun, startRun } from "~/server/runtimes/run-service.server";
import { getRun, insertRunLine } from "~/server/runtimes/run-store.server";
import { applyAgentCompletionEffects } from "./agent-completion.server";
import { readAgentTaskAttachment, readAgentTaskSource } from "./board-read.server";
import { completionPacketFact } from "./completion-packet.server";
import { looksFromRunLog, pageLooksNote, pageLooksOwed, runLooks } from "./page-looks.server";
import {
  captureTaskPage,
  measureTaskPage,
  removeRunPageCaptures,
  requestDeliveryCaptures,
} from "./page-capture.server";
import { attachTaskFile } from "./task-edits.server";

/**
 * Ruling 86 at the boundary that owns it: a files delivery stamped by the
 * real completion pipeline (`applyAgentCompletionEffects`, so the stamp in
 * `recordAgentCompletion`, the delivery reconcile, the ask after it and the
 * bounded wait before the react are all on the path), on a `setupTestStore`
 * root, with the renderer child run for real
 * against the stand-in browser (`test-support/fake-browser.ts`). The seam is
 * production configuration: `VIBERR_BROWSER_EXECUTABLE`, set the way a
 * deployment sets it. The cases about the render's own rules (what it reads,
 * the queue, a delivery landing under it) start where the completion's ask
 * does, at `requestDeliveryCaptures` on a delivery the store really kept, and
 * an agent's ask is made at `captureTaskPage`, the door both backends call.
 */

let ctx: TestDbContext;
let store: TestStore;
let fake: FakeBrowser;

const WRITER: Engagement = {
  profileId: "writer",
  backend: "claude",
  role: "Writer",
  delivers: true,
  verdictCapable: false,
};

/** A board that delivers files: no repository (unless the case names one),
 *  one deliverer, and (when the case is about the react) an operator. */
function deployBoard(opts: { operator?: boolean; repo?: string } = {}): void {
  reconfigureProject(store, {
    repo: opts.repo ?? null,
    agents: [
      {
        profileId: "writer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "writer",
          role: "Writer",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      },
      ...(opts.operator
        ? [
            {
              profileId: "operator",
              capabilities: [
                { capabilityId: "generate-packets", mode: "direct" as const },
                { capabilityId: "append-typed-events", mode: "direct" as const },
              ],
              extras: [],
              definition: {
                kind: "operator" as const,
                backends: ["claude" as const],
                model: "sonnet",
                autonomy: "supervised" as const,
              },
            },
          ]
        : []),
    ],
  });
}

function writeDeliveringTask(patch: Parameters<typeof baseTaskFrontmatter>[1] = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Write the launch post",
      engagements: [WRITER],
      workRevision: null,
      validation: "none",
      ...patch,
    }),
    goal: "Deliver the post as a page.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
  deployBoard();
  writeDeliveringTask();
  installFakeRuntime();
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentIsolationForTests();
  ctx.cleanup();
});

const attachments = (key = "VIB-1") => taskAttachmentsDir(store.slug, key, store.dataRoot);
const frontmatter = (key = "VIB-1") =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed.frontmatter;
const timeline = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline;
const onTask = () => readdirSync(attachments()).filter((name) => !name.startsWith(".")).sort();
const pngOf = (file: string) => imageHeader(readFileSync(file));
/** Where a task's renders keep their scratch (a folder per run, and `no.run`
 *  for a delivery's own), and where a delivery's files are handed to the
 *  renderer: both in the task's own directory, which only the server writes. */
const scratchRoot = (key = "VIB-1") => path.join(taskDir(store.slug, key, store.dataRoot), ".captures");
/** Every render's scratch folder still on the task, as `<run>/<captureId>`. */
const scratches = (key = "VIB-1") =>
  existsSync(scratchRoot(key))
    ? readdirSync(scratchRoot(key)).flatMap((home) =>
        readdirSync(path.join(scratchRoot(key), home)).map((capture) => `${home}/${capture}`),
      )
    : [];
const inputRoot = (key = "VIB-1") => path.join(taskDir(store.slug, key, store.dataRoot), ".capture-input");
/** The files the stand-in browser was told to open, in order, once each. */
const opened = () => [...new Set(fake.pages().map((page) => decodeURIComponent(new URL(page.url).pathname.split("/").pop()!)))];
/** The limit of a case that waits on several real renders: each is a child
 *  process and a stand-in browser, and a measured page loads five more times
 *  with a second's settle on three of them, so a case with six pages runs
 *  past the suite's 20 s on a loaded machine. */
const REAL_RENDERS_MS = 90_000;
const captureAudits = () => listAuditEvents(store.db, { action: "task.pages.captured" });
/** What a delivery's note says of the pictures: all of it up to what was
 *  measured of each HTML page (ruling 328), which closes the note and has a
 *  case of its own. */
const ofThePictures = (text: string) => text.split(" Measured of ")[0]!;
/** The figures of a page that was measured as it was pictured, whatever they
 *  are: the measured case reads them. */
const MEASURED = { measured: expect.any(Object) };

/** The server's own browser setting, as a deployment sets it. */
function withBrowser<T>(mode: string, run: () => T | Promise<T>): Promise<T> {
  return withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(mode) }, run);
}

/** Files of a given size and no content: sparse, so a page past a size limit
 *  costs no disk. */
type Sized = Record<string, number>;

/** Put `files` on a task as text, and `sized` as that many bytes of nothing. */
function saveFiles(key: string, files: Record<string, string>, sized: Sized = {}, savedAt?: Date): void {
  mkdirSync(attachments(key), { recursive: true });
  const put = (name: string, text: string): string => {
    const file = path.join(attachments(key), name);
    writeFileSync(file, text);
    return file;
  };
  const saved = Object.entries(files).map(([name, text]) => put(name, text));
  for (const [name, bytes] of Object.entries(sized)) {
    const file = put(name, "");
    truncateSync(file, bytes);
    saved.push(file);
  }
  if (savedAt) for (const file of saved) utimesSync(file, savedAt, savedAt);
}

/**
 * A task whose files delivery `stamp` is kept, as the completion leaves it
 * when it asks for the pictures: the files on the task, and the store's own
 * copy of them. For the cases about the render itself, which start where the
 * completion's ask does.
 */
async function keptDelivery(key: string, stamp: string, files: Record<string, string>, sized: Sized = {}): Promise<void> {
  if (!existsSync(taskDir(store.slug, key, store.dataRoot))) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, { stage: "impl", ownerUserId: store.users.arda.id, engagements: [WRITER] }),
    });
  }
  saveFiles(key, files, sized);
  keepDelivery(store.slug, key, stamp, [...Object.keys(files), ...Object.keys(sized)], store.dataRoot);
  await updateTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot }, (parsed) => {
    parsed.frontmatter.deliveredAt = stamp;
  });
}

const picture = (key: string, stamp: string) =>
  requestDeliveryCaptures(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: key, stamp });

/** What an ask may name beside the page: a stretch, or an exact size. */
interface AskOver {
  runId?: string | null;
  view?: "desktop" | "phone";
  from?: number;
  width?: number;
  height?: number;
  scale?: number;
  keeps?: boolean;
  press?: string;
  hover?: string;
  tab?: number;
  motion?: "reduce";
  moving?: boolean;
}

/** An agent's `capture_page`, at the door both backends call. */
const ask = (name: string, over: AskOver = {}) =>
  captureTaskPage(
    store.db,
    { dataRoot: store.dataRoot },
    { projectSlug: store.slug, taskKey: "VIB-1", name, ...over, runId: over.runId ?? null },
  );
/** The pictures a reply hands back, by their own headers. */
const handedBack = (reply: { images: { data: string }[] }) =>
  reply.images.map((image) => imageHeader(Buffer.from(image.data, "base64")));

let runSeq = 0;
/** A finished run of the writer whose window holds `files`, as a real run's
 *  saves do: stamped with the run's own `finished_at` (a fake run finishes
 *  within the clock tick its start was read on). */
async function finishedRunSaving(files: Record<string, string>, sized: Sized = {}): Promise<string> {
  runSeq += 1;
  queueFakeRun({
    lines: [
      { t: "", ev: "init", tag: "system·init", text: "test session" },
      { t: "", ev: "text", tag: "assistant", text: `Delivered ${Object.keys(files).join(", ")}.` },
      { t: "", ev: "result", tag: "result", text: "done" },
    ],
    occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
    sessionId: `capture-${runSeq}`,
  });
  const started = await startRun(store.db, {
    projectSlug: store.slug,
    taskKey: "VIB-1",
    kind: "primary",
    role: "Writer",
    agentProfileId: "writer",
    credentialUserId: store.users.arda.id,
    backend: "claude",
    model: "sonnet",
    prompt: "write",
    workdir: store.dataRoot,
    autonomous: true,
    dataRoot: store.dataRoot,
    actor: actorOf(store.users.arda),
    threadId: `capture-thread-${runSeq}`,
  });
  expect(await pollUntil(() => getRun(store.db, started.runId)?.state === "finished")).toBe(true);
  saveFiles("VIB-1", files, sized, new Date(getRun(store.db, started.runId)!.finished_at!));
  return started.runId;
}

/** A reviewer's run that is still going. */
async function liveRun(profileId: string): Promise<string> {
  runSeq += 1;
  queueFakeRun({
    lines: [{ t: "", ev: "text", tag: "assistant", text: "looking" }],
    sessionId: `capture-live-${runSeq}`,
    keepRunning: true,
  });
  const started = await startRun(store.db, {
    projectSlug: store.slug,
    taskKey: "VIB-1",
    kind: "reviewer",
    role: "Reviewer",
    agentProfileId: profileId,
    credentialUserId: store.users.arda.id,
    backend: "claude",
    model: "sonnet",
    prompt: "review",
    workdir: store.dataRoot,
    autonomous: true,
    dataRoot: store.dataRoot,
    actor: actorOf(store.users.arda),
    threadId: `capture-live-thread-${runSeq}`,
  });
  expect(await pollUntil(() => getRun(store.db, started.runId)?.state === "running")).toBe(true);
  return started.runId;
}

/** End a live run the way a person's Stop does. */
const stopRun = (runId: string) =>
  interruptRun(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId },
    { userId: store.users.arda.id, label: store.users.arda.email },
  );

type EffectsContext = Parameters<typeof applyAgentCompletionEffects>[1];

/** The writer's completion, through the whole pipeline. */
function completeDelivery(runId: string, over: Partial<EffectsContext> = {}): Promise<void> {
  return applyAgentCompletionEffects(
    store.db,
    { dataRoot: store.dataRoot, ...over },
    {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude",
      profileId: "writer",
      role: "Writer",
      delivers: true,
      workdir: null,
      agentHandle: "writer",
    },
    { id: runId, state: "finished" },
  );
}

/** Deliver `files` on a server whose browser is the stand-in in `mode`. */
async function deliver(files: Record<string, string>, mode = "", sized: Sized = {}): Promise<void> {
  const runId = await finishedRunSaving(files, sized);
  await withBrowser(mode, () => completeDelivery(runId));
}

const captureNote = () => timeline().find((event) => event.title === "Page captures");

describe("a delivered page is pictured (ruling 86)", () => {
  it("a stamped files delivery pictures each page an agent delivered at a desktop and a phone width, keeps the pictures on the task and in the kept delivery, and writes one record and one note", async () => {
    // A person's own upload is an input, not a result.
    await attachTaskFile(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", name: "brief.md", data: new TextEncoder().encode("# The brief\n") },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await deliver({
      "post.html": '<h1>Launch</h1><img src="chart.png"><p>fake-height:3000</p>',
      "notes.md": "# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
      "chart.png": "a picture beside the page",
      "figures.csv": "a,b\n1,2\n",
    });
    const stamp = frontmatter().deliveredAt!;
    // CANARY: delete the requestDeliveryCaptures call after the delivery
    // reconcile in applyAgentCompletionEffects and no picture, record or
    // note appears.
    const pictures = [
      "notes.md.capture-desktop.png",
      "notes.md.capture-phone.png",
      "post.html.capture-desktop.png",
      "post.html.capture-phone.png",
    ];
    expect(onTask()).toEqual(["brief.md", "chart.png", "figures.csv", "notes.md", ...pictures, "post.html"].sort());
    expect(pngOf(path.join(attachments(), "post.html.capture-desktop.png"))).toEqual({
      mimeType: "image/png",
      width: 1280,
      height: 3000,
    });
    expect(pngOf(path.join(attachments(), "post.html.capture-phone.png"))).toMatchObject({ width: 390, height: 3000 });
    // The record is bound to the delivery it pictured.
    const record = frontmatter().pageCaptures!;
    expect(record.deliveredAt).toBe(stamp);
    expect(record.pages).toEqual([
      {
        file: "notes.md",
        shots: [
          { view: "desktop", name: "notes.md.capture-desktop.png", cut: false },
          { view: "phone", name: "notes.md.capture-phone.png", cut: false },
        ],
        error: null,
      },
      {
        file: "post.html",
        shots: [
          { view: "desktop", name: "post.html.capture-desktop.png", cut: false },
          { view: "phone", name: "post.html.capture-phone.png", cut: false },
        ],
        error: null,
        ...MEASURED,
      },
    ]);
    // One note, from Viberr, that claims the pictures.
    const notes = timeline().filter((event) => event.title === "Page captures");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "note",
      actor: { kind: "system", systemId: "page-capture" },
      attachments: pictures,
    });
    expect(ofThePictures(notes[0]!.text)).toBe(
      "Viberr rendered `notes.md` and `post.html` as a reader sees them, at a desktop width (1,280 px) and a " +
        "phone width (390 px). The pictures are attached and show beside each file on the result.",
    );
    // The page was served its sibling from the delivery itself.
    const served = fake.pages().find((page) => page.url.endsWith("/post.html"))!;
    expect(served.resources).toEqual([{ src: "chart.png", status: 200, bytes: 25 }]);
    // The kept delivery holds its own pictures, and a reviewer reads one as
    // the picture it is, from the task or from the delivery.
    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)).toEqual([
      {
        deliveredAt: stamp,
        files: ["brief.md", "chart.png", "figures.csv", "notes.md", ...pictures, "post.html"].sort(),
      },
    ]);
    const reader = { db: store.db, ctx: { dataRoot: store.dataRoot }, projectSlug: store.slug };
    for (const delivery of [undefined, stamp]) {
      const read = readAgentTaskAttachment(reader, "VIB-1", "post.html.capture-phone.png", 0, delivery);
      expect(read).toMatchObject({ image: { mimeType: "image/png" } });
    }
    // The render's scratch is gone with it.
    // CANARY: make the scratch under `workspace/` again, where an agent can
    // write, and no folder is here to be empty.
    expect(readdirSync(scratchRoot())).toEqual(["no.run"]);
    expect(scratches()).toEqual([]);
    expect(listAuditEvents(store.db, { action: "task.pages.captured" })[0]).toMatchObject({
      taskKey: "VIB-1",
      details: { deliveredAt: stamp, pages: 2, captured: 2, failed: [], more: 0, runsAs: "server" },
    });
  });

  it("ruling 328: a delivered page is measured as it is pictured: the figures are kept on its record, said in the note with what each fault is on, handed to the operator and the reviewer in one line, and set against the pages the board has accepted; an agent takes the same figures before it delivers", { timeout: REAL_RENDERS_MS }, async () => {
    // What a person accepted a page on was an agent's word that it "passes
    // accessibility" or "loads fast": nothing on the task was a figure.
    // An earlier page of this board, measured and accepted, and since
    // archived with its epic; and a lighter, faster page on a task nobody
    // has accepted, which sets no figure.
    const earlier = "2026-10-07T12:00:00.000Z";
    await keptDelivery("VIB-2", earlier, { "first.html": "<p>the first page, accepted</p><p>fake-load-ms:900</p>" });
    await keptDelivery("VIB-3", earlier, { "draft.html": "<p>fake-load-ms:300</p>" });
    await withBrowser("", async () => {
      await picture("VIB-2", earlier);
      await picture("VIB-3", earlier);
    });
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-2", dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.stage = "done";
      parsed.frontmatter.archived = true;
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const page =
      '<h1>Launch</h1><img src="hero.png">' +
      '<p>fake-axe:[{"id":"color-contrast","impact":"serious","help":"Elements must meet minimum color contrast ratio thresholds","count":2,' +
      '"nodes":[{"target":"p.lede","ratio":3.1,"text":"Governed delivery"},{"target":"a.more","ratio":2.4,"text":"Read more"}]}]</p>' +
      '<p>fake-controls:[["a","Docs"],["button","Menu"],["a","Start"]]</p><p>fake-tab-order:[0,2]</p><p>fake-unmarked:[2]</p>' +
      '<p>fake-animations-reduced:[{"name":"drift","target":"div.hero","durationMs":8000,"loops":true}]</p>' +
      "<p>fake-load-ms:1840</p>";
    await deliver({ "index.html": page, "hero.png": "x".repeat(4000), "notes.md": "# Notes\n" });

    const pages = frontmatter().pageCaptures!.pages;
    // A markdown file is set in Viberr's own type: nothing of its writer's
    // is there to measure. CANARY: measure every page of the delivery.
    expect(pages.find((entry) => entry.file === "notes.md")).not.toHaveProperty("measured");
    const view = { faultKinds: 1, faultElements: 2, worstContrast: 2.4, controls: 3, unreached: 1, unmarked: 1, stillMoving: 1 };
    // CANARY: drop `measure` from the delivery's render and the record holds
    // pictures and no figure.
    expect(pages.find((entry) => entry.file === "index.html")!.measured).toEqual({
      weightBytes: Buffer.byteLength(page) + 4000,
      files: 2,
      loadMs: 1840,
      line: "1.6 Mbit/s down, 150 ms",
      views: [
        { view: "desktop", ...view },
        { view: "phone", ...view },
      ],
    });

    // The note names what each fault is on, so the maker knows where to look
    // and the reviewer what to hold it to.
    const note = captureNote()!.text;
    expect(note).toContain(
      "Measured of `index.html`: It weighs 4 KB: the page and the 1 file it loads. " +
        "It finishes loading 1.8 s after it is asked for, on a slow phone line (1.6 Mbit/s down, 150 ms). " +
        "At 1280 px the accessibility checks (axe, WCAG 2.2 AA) found 1 kind of fault: " +
        "`color-contrast` on 2 (Elements must meet minimum color contrast ratio thresholds; first: `p.lede` and `a.more`). " +
        'The lowest contrast is 2.40 to 1, on "Read more". ',
    );
    expect(note).toContain("At 1280 px, with reduced motion asked for, 1 animation still runs: `drift` on `div.hero` (loops).");
    expect(note).toContain('At 1280 px Tab reaches 2 of 3 controls; never reached: `button "Menu"`; looking the same with focus as at rest: `a "Start"`.');
    // A board's pages only get lighter and faster: this one is set against
    // the lightest and the fastest it has had accepted, with both figures.
    // CANARY: read the figures of every task, accepted or not, and the page
    // is set against VIB-3's draft (0.3 s); leave archived tasks out and the
    // board forgets the page it accepted and says nothing at all.
    expect(note).toMatch(
      /That is heavier than the lightest page this board has accepted \(1 KB, VIB-2\) and slower than its fastest \(0\.9 s, VIB-2\)\. A board's pages only get lighter and faster\.$/,
    );

    // The operator is handed one line a page, and so is the reviewer, in the
    // note that says what its approval owes.
    const line =
      "4 KB in 2 files; loads in 1.8 s on a slow phone line (1.6 Mbit/s down, 150 ms); " +
      "at 1280 px 1 kind of accessibility fault on 2 elements (lowest contrast 2.4 to 1), 1 of 3 controls the keyboard does not reach, " +
      "1 that show nothing when they take focus, 1 still moving with reduced motion asked for; " +
      "at 390 px 1 kind of accessibility fault on 2 elements (lowest contrast 2.4 to 1), 1 of 3 controls the keyboard does not reach, " +
      "1 that show nothing when they take focus, 1 still moving with reduced motion asked for.";
    const fact = completionPacketFact(frontmatter(), { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot });
    expect(fact.pageCaptures.map((entry) => [entry.file, entry.measured])).toEqual([
      ["index.html", line],
      ["notes.md", null],
    ]);
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    expect(pageLooksNote(pageLooksOwed({ dataRoot: store.dataRoot }, store.slug, "VIB-1", parsed, true)!)).toContain(
      `What Viberr measured as it pictured this delivery: \`index.html\`: ${line} The delivery's "Page captures" note names each element`,
    );

    // `measure_page`: the same figures of a page as it stands, before it is
    // delivered, in words and with nothing saved.
    const before = JSON.stringify(frontmatter());
    const audits = captureAudits().length;
    const measure = (name: string) =>
      withBrowser("", () => measureTaskPage(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-1", name, runId: null }));
    const measured = await measure("index.html");
    expect(measured).toContain(
      "[done] `index.html` measured as Viberr measures a delivered page, at the desktop width (1280 px) and the phone width (390 px). It weighs 4 KB: the page and the 1 file it loads.",
    );
    expect(measured).toContain("`color-contrast` on 2");
    expect(measured).toContain("That is heavier than the lightest page this board has accepted (1 KB, VIB-2)");
    expect(measured.endsWith("Nothing was saved: these are the figures as the file stands now.")).toBe(true);
    expect(JSON.stringify(frontmatter())).toBe(before);
    expect(captureAudits()).toHaveLength(audits);
    expect(await measure("notes.md")).toBe(
      "[noop] `notes.md` is not a page somebody laid out. measure_page measures an .html or .htm file; " +
        "a markdown file is set as an article in Viberr's own type, so there is nothing of its writer's to measure.",
    );
  });

  it("ruling 328: a figure says no more than was measured: a list cut to its first few carries its count, a walk that never came round names nothing it did not try, and a check that did not finish is not a clean one", { timeout: REAL_RENDERS_MS }, async () => {
    // The first measurements said "0 unreached" of a walk that had stopped
    // at its press limit, kept the length of a list cut to six as the count,
    // and wrote a check that never ran as a page with nothing wrong.
    const links = Array.from({ length: 9 }, (_, at) => ["a", `Link ${at}`]);
    saveFiles("VIB-1", {
      "many.html": `<p>fake-controls:${JSON.stringify(links)}</p><p>fake-tab-order:[0,1,2,3,4,5,6,7,8]</p><p>fake-unmarked:[0,1,2,3,4,5,6,7,8]</p>`,
      "long.html": `<p>fake-controls:${JSON.stringify(Array.from({ length: 100 }, (_, at) => ["a", `Item ${at}`]))}</p><p>fake-tab-order:${JSON.stringify(Array.from({ length: 100 }, (_, at) => at))}</p>`,
      "throws.html": '<p>fake-controls:[["a","One"]]</p><p>fake-tab-order:[0]</p><p>fake-keyboard-throws:"the page went away"</p>',
    });
    const measure = (name: string) =>
      withBrowser("", () => measureTaskPage(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-1", name, runId: null }));
    // CANARY: print the list the renderer cut and its length, and nine
    // controls with no focus mark read as six.
    expect(await measure("many.html")).toContain(
      'At 1280 px Tab reaches 9 of 9 controls; looking the same with focus as at rest: 9, the first `a "Link 0"`, `a "Link 1"`, `a "Link 2"`, `a "Link 3"`, `a "Link 4"`, and `a "Link 5"`.',
    );
    // CANARY: say nothing of a walk that was cut and a page of a hundred
    // links reads "Tab reaches 80 of 100 controls, and each shows a change".
    expect(await measure("long.html")).toContain(
      "At 1280 px Tab reaches 80 of 100 controls; the walk stopped at its press limit, so the controls past it were not tried.",
    );
    // CANARY: read a walk that failed as its zeros and the page is said to
    // have "no control for a keyboard to reach".
    expect(await measure("throws.html")).toContain("At 1280 px the keyboard's reach was not measured: the walk did not finish.");
  });

  it("the next delivery's pictures replace the last one's, a page it no longer holds loses its picture, the rework is credited with none of them, and the earlier delivery keeps its own", async () => {
    await deliver({ "post.html": "<p>fake-height:3000</p>", "gone.html": "<p>dropped in the rework</p>" });
    const first = frontmatter().deliveredAt!;
    const firstPictures = onTask().filter((name) => name.endsWith(".png"));
    expect(firstPictures).toContain("gone.html.capture-desktop.png");
    // The rework drops one page and shortens the other.
    unlinkSync(path.join(attachments(), "gone.html"));
    const rework = await finishedRunSaving({ "post.html": "<p>fake-height:1500</p>" });
    // A render finishes in the background, so the first delivery's pictures
    // can land while the rework is already running: they are then in its
    // window by their time, as the files it saved itself are.
    const during = new Date(getRun(store.db, rework)!.finished_at!);
    for (const name of firstPictures) utimesSync(path.join(attachments(), name), during, during);
    await withBrowser("", () => completeDelivery(rework));
    const second = frontmatter().deliveredAt!;
    expect(second).not.toBe(first);
    // The deliverer claims its whole window, and Viberr's pictures are no
    // part of it: not the one of the page still there, and not the one whose
    // page the rework removed, which only the record still names.
    // CANARY: leave the record's names out of what is someone else's in
    // applyAgentCompletionEffects and the rework's reply claims
    // gone.html.capture-desktop.png as a file it delivered.
    expect(timeline().find((event) => event.actor.kind === "agent")!.attachments).toEqual(["post.html"]);

    // CANARY: drop the unlink of what the last record named and
    // gone.html.capture-desktop.png is still on the task.
    expect(onTask()).toEqual(["post.html", "post.html.capture-desktop.png", "post.html.capture-phone.png"]);
    expect(pngOf(path.join(attachments(), "post.html.capture-desktop.png"))).toMatchObject({ height: 1500 });
    expect(frontmatter().pageCaptures).toMatchObject({ deliveredAt: second, pages: [{ file: "post.html" }] });
    // CANARY: drop the picture filter in keepStampedDelivery, or take only
    // the pictures of pages still on the task for Viberr's own there, and
    // the second kept delivery holds gone.html.capture-desktop.png.
    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)).toEqual([
      { deliveredAt: second, files: ["post.html", "post.html.capture-desktop.png", "post.html.capture-phone.png"] },
      {
        deliveredAt: first,
        files: [
          "gone.html",
          "gone.html.capture-desktop.png",
          "gone.html.capture-phone.png",
          "post.html",
          "post.html.capture-desktop.png",
          "post.html.capture-phone.png",
        ],
      },
    ]);
    const reader = { db: store.db, ctx: { dataRoot: store.dataRoot }, projectSlug: store.slug };
    // The earlier delivery's picture is still the 3,000 px page it pictured.
    const earlier = readAgentTaskAttachment(reader, "VIB-1", "post.html.capture-desktop.png", 0, first);
    expect("image" in earlier ? imageHeader(Buffer.from(earlier.image.data, "base64"))?.height : null).toBe(3000);
  });

  it("renders as the task owner's agent user through the launcher with no secret in its environment, copies a delivery nowhere it cannot make its own, and refuses a task with no owner rather than render as the server", async () => {
    // A stand-in `viberr-launch`: logs the uid and the binary, scrubs the
    // `VIBERR_LAUNCH_*` names as the real one does, and execs.
    const dir = ctx.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--prepare-home" ]; then mkdir -p "$3"; exit 0; fi',
        'if [ "$1" = "--reap" ]; then exit 0; fi',
        `printf 'uid=%s exec=%s script=%s home=%s\\n' "$VIBERR_LAUNCH_UID" "$VIBERR_LAUNCH_EXEC" "$1" "$HOME" >> '${log}'`,
        `env | grep -E '^(VIBERR_SECRET_ENCRYPTION_KEY|VIBERR_SESSION_SECRET|VIBERR_DATA_ROOT)=' | sed 's/^/leaked /' >> '${log}'`,
        "target=$VIBERR_LAUNCH_EXEC",
        "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
        'exec "$target" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null }, { launcher });
    const childLines = () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes("page-capture-child.server.ts"));

    // A delivery's files are the server's own, so they are copied for the
    // renderer, and only into a folder the server can make its own and open
    // to the agent group. No test host has that group, so here the folder
    // cannot be made so, which is the case this owns: nothing is copied,
    // nothing is rendered, and the page says why. (In the image the folder
    // is made, and `scripts/check-page-capture.sh` renders through one.)
    // CANARY: catch the refusal in the render and carry on with a warning,
    // as the first version did: the renderer is launched on files the server
    // copied into a folder it never made its own.
    await deliver({ "post.html": "<p>the page</p>" });
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "post.html", shots: [], error: "the delivered files could not be handed to the renderer" },
    ]);
    expect(existsSync(log) ? childLines() : []).toEqual([]);
    expect(fake.launches()).toEqual([]);
    expect(existsSync(inputRoot())).toBe(false);
    expect(scratches()).toEqual([]);
    // The tool reads the task's own folder and copies nothing, so it can
    // still show the page, and the note says so.
    expect(captureNote()!.text).toBe(
      "Viberr could not picture `post.html`: the delivered files could not be handed to the renderer. " +
        "The delivery stands without it, and an agent can look with `capture_page`.",
    );
    expect(captureAudits()[0]!.details).toMatchObject({ captured: 0, failed: ["post.html"], runsAs: AGENT_UID_FLOOR });

    // An agent's ask renders as the task owner's agent user.
    // CANARY: pass null for the launch in the tool's render and no line is
    // launched for the child (with isolation on, that is the server running
    // a page an agent wrote).
    const reply = await withBrowser("", () => ask("post.html"));
    expect(reply.text).toMatch(/^\[done\] `post\.html` as a reader sees it\./);
    expect(reply.images).toHaveLength(2);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines.some((line) => line.startsWith("leaked "))).toBe(false);
    expect(childLines()).toHaveLength(1);
    expect(childLines()[0]).toMatch(
      new RegExp(
        `^uid=${AGENT_UID_FLOOR} exec=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ` +
          `script=\\S*app/server/tasks/page-capture-child\\.server\\.ts home=\\S*runtimes/users/${store.users.arda.id}/home$`,
      ),
    );
    // The browser the child started carries none of the server's own either.
    const [launch] = fake.launches();
    expect(Object.keys(launch!.env).filter((name) => /SECRET|ENCRYPTION|^VIBERR_DATA_ROOT$/.test(name))).toEqual([]);
    expect(fake.shots().map((shot) => shot.width)).toEqual([1280, 390]);

    // No owner: nobody to render it as, and never the server instead.
    writeFileSync(log, "");
    writeDeliveringTask({ ownerUserId: null });
    await deliver({ "orphan.html": "<p>nobody's page</p>" });
    // The delivery is every file on the task (ruling 81), so both pages say it.
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "orphan.html", shots: [], error: "the task has no owner to render it as" },
      { file: "post.html", shots: [], error: "the task has no owner to render it as" },
    ]);
    // The tool renders as the same person, so the note does not send an
    // agent to it. CANARY: name `capture_page` under every failure.
    expect(captureNote()!.text).toBe(
      "Viberr could not picture `orphan.html`: the task has no owner to render it as. " +
        "Viberr could not picture `post.html`: the task has no owner to render it as. " +
        "The delivery stands without them.",
    );
    expect((await withBrowser("", () => ask("orphan.html"))).text).toBe(
      "[error] `orphan.html` could not be captured: this task has no owner to render it as. " +
        "A page renders as its person's agent user, never as the server.",
    );
    expect(readFileSync(log, "utf8")).not.toContain("page-capture-child");

    // The owner is back and their launch cannot be prepared (the launcher
    // refuses to hand them their home): the tool gives the launch's own
    // sentence. CANARY: answer every failed launch with the no-owner
    // sentence, as before, and a task that has an owner is told it has none.
    writeDeliveringTask();
    writeFileSync(launcher, "#!/bin/sh\necho 'chown refused' >&2\nexit 1\n");
    const home = path.join(store.dataRoot, "runtimes", "users", store.users.arda.id);
    expect((await withBrowser("", () => ask("post.html"))).text).toBe(
      "[error] `post.html` could not be captured. " +
        "The agent could not be started as its person's own user (ruling 139): " +
        `the launcher could not prepare ${home} (chown refused). ` +
        "Nothing ran; nothing falls back to the server's own user.",
    );
  });

  it("a page that cannot be pictured is said on the task and leaves the delivery, its kept copy and the other pages as they were", { timeout: REAL_RENDERS_MS }, async () => {
    await deliver(
      { "good.html": '<img src="https://cdn.example.com/a.js"><img src="nested/b.png">', "bad.html": "<p>this one ends the browser</p>" },
      "crash:bad.html",
    );
    const stamp = frontmatter().deliveredAt!;
    // CANARY: remove the catch in the delivery job that turns a failed render
    // into each page's reason, and a server whose browser is gone (below)
    // writes no record at all.
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "bad.html", shots: [], error: "the browser ended before the page was pictured" },
      {
        file: "good.html",
        shots: [
          { view: "desktop", name: "good.html.capture-desktop.png", cut: false },
          { view: "phone", name: "good.html.capture-phone.png", cut: false },
        ],
        error: null,
        ...MEASURED,
      },
    ]);
    expect(ofThePictures(captureNote()!.text)).toBe(
      "Viberr rendered `good.html` as a reader sees it, at a desktop width (1,280 px) and a phone width (390 px). " +
        "The pictures are attached and show beside each file on the result. " +
        "`good.html` asked the network for 1 thing (cdn.example.com); a capture loads none, so the picture shows the page without them. " +
        "`good.html` asked for `nested/b.png`, which is not among this task's files (the folder is flat). " +
        "Viberr could not picture `bad.html`: the browser ended before the page was pictured. " +
        "The delivery stands without it, and an agent can look with `capture_page`.",
    );
    // The delivery itself is as the completion left it.
    expect(frontmatter().deliveredAt).toBe(stamp);
    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)[0]!.files).toEqual([
      "bad.html",
      "good.html",
      "good.html.capture-desktop.png",
      "good.html.capture-phone.png",
    ]);
    expect(captureAudits()[0]!.details).toMatchObject({
      pages: 2,
      captured: 1,
      failed: ["bad.html"],
    });

    // A pinned browser that is not on disk fails every page the same way.
    const runId = await finishedRunSaving({ "good.html": "<p>again</p>" });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: path.join(fake.evidenceDir, "no-such-browser") }, () =>
      completeDelivery(runId),
    );
    expect(frontmatter().deliveredAt).not.toBe(stamp);
    expect(frontmatter().pageCaptures!.pages.map((page) => [page.file, page.shots.length, page.error])).toEqual([
      ["bad.html", 0, "the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk"],
      ["good.html", 0, "the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk"],
    ]);
    // No run on such a server is given `capture_page`, so the note names no
    // tool: only that the delivery stands.
    expect(captureNote()!.text).toBe(
      "Viberr could not picture `bad.html`: the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk. " +
        "Viberr could not picture `good.html`: the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk. " +
        "The delivery stands without them.",
    );
    // The earlier delivery's pictures left the task with its record.
    expect(onTask()).toEqual(["bad.html", "good.html"]);

    // And a server with no browser named at all says nothing on the task.
    const quiet = await finishedRunSaving({ "good.html": "<p>a third time</p>" });
    await completeDelivery(quiet);
    expect(timeline().filter((event) => event.title === "Page captures")).toHaveLength(2);
  });

  it("a render still running after 120 seconds no longer holds the operator, an ask that cannot start within 15 seconds is told the renderer is busy, and a render past its limit is stopped and said on the task", async () => {
    deployBoard({ operator: true });
    const runOp = vi.fn<typeof runOperator>(async () => ({
      runId: null,
      queued: true,
      backend: "claude" as const,
      autonomy: "supervised" as const,
    }));
    const runId = await finishedRunSaving({ "one.html": "<p>never loads</p>", "two.html": "<p>never loads</p>" });
    // Only the server's clocks are faked; the hung child runs for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const effects = withBrowser("hang", async () => {
      const done = completeDelivery(runId, { deps: { runOperator: runOp } }).then(() => {
        settled = true;
      });
      // The stand-in browser is up and will never answer the load.
      await vi.waitFor(() => expect(fake.launches()).toHaveLength(1), { timeout: 15_000 });
      expect(frontmatter().deliveredAt).not.toBeNull();
      expect(runOp).not.toHaveBeenCalled();
      // Another task's delivery with no page in it has nothing to wait for:
      // it is done at once, while this render still holds the one renderer.
      // CANARY: queue every delivery and this never settles (the hung render
      // ends only when this test moves the clock).
      const other = "2026-10-07T12:00:00.000Z";
      await keptDelivery("VIB-2", other, { "figures.csv": "a,b\n" });
      await picture("VIB-2", other);
      // An agent asks to see a page while the renderer is held.
      const answer = { text: "" };
      void ask("one.html").then((reply) => {
        answer.text = reply.text;
      });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(answer.text).toBe("");
      // CANARY: never arm the ask's own timer and it is still waiting when
      // the render is stopped, past a Codex tool call's 60 seconds.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(answer.text).toBe("[busy] The renderer is working on other pages. Call again in a moment.");
      // 115 s in; the bound is 120 s (ruling 86): a page that is measured as
      // it is pictured (ruling 328) loads several times, once on a slow line.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(settled).toBe(false);
      // CANARY: await the capture promise without the bound in
      // applyAgentCompletionEffects and the operator's run never starts while
      // the browser hangs.
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(runOp).toHaveBeenCalledTimes(1);
      expect(frontmatter().pageCaptures).toBeUndefined();
      // The job's own limit, 10 s and 70 s for each page that is measured:
      // the render is stopped.
      await vi.advanceTimersByTimeAsync(30_000);
      // Waited to its last write, so nothing of the job outlives the test.
      await vi.waitFor(() => expect(captureAudits()).toHaveLength(1), { timeout: 15_000 });
    });
    await effects;
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "one.html", shots: [], error: "the render ran past 150 seconds" },
      { file: "two.html", shots: [], error: "the render ran past 150 seconds" },
    ]);
    expect(captureNote()!.text).toContain("Viberr could not picture `one.html`: the render ran past 150 seconds.");
    // The ask that was told `busy` never reached the renderer.
    expect(fake.launches()).toHaveLength(1);
  });

  it("keeps a page capture out of the files a run in flight is credited with, and leaves an agent's own file that is only named like one alone", async () => {
    await deliver({ "post.html": "<p>the page</p>" });
    expect(existsSync(path.join(attachments(), "post.html.capture-desktop.png"))).toBe(true);
    // An agent's own screenshots, named the way the tool says Viberr names
    // its pictures: one of nothing that is a page, one of a page this task
    // does not hold.
    saveFiles("VIB-1", { "landing.capture-desktop.png": "the agent's own", "other.html.capture-phone.png": "the agent's own" });
    // A reviewer's run that started before the render: its window holds the
    // pictures by their time, and must not hold them by name. Claiming one
    // would name the run as its author and so move `deliveredAt` (ruling 85)
    // under the verdict it is about to give.
    // CANARY: drop the picture skip in attachmentNamesSince and the run is
    // credited with post.html.capture-desktop.png. Recognise a picture by its
    // suffix alone and the agent's own two files are credited to nobody.
    expect(attachmentNamesSince(store.slug, "VIB-1", "2026-01-01T00:00:00.000Z", store.dataRoot).sort()).toEqual([
      "landing.capture-desktop.png",
      "other.html.capture-phone.png",
      "post.html",
    ]);
    // And the next delivery keeps them, as it keeps any file on the task,
    // while Viberr's own picture of the last one stays out of it.
    await deliver({ "post.html": "<p>the page again</p>" });
    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)[0]!.files).toEqual([
      "landing.capture-desktop.png",
      "other.html.capture-phone.png",
      "post.html",
      "post.html.capture-desktop.png",
      "post.html.capture-phone.png",
    ]);
  });

  it("pictures the delivery as it was kept and not the files as they are now, tells the renderer what a capture does not carry, and leaves no copy behind", async () => {
    const stamp = "2026-10-07T12:00:00.000Z";
    // A name longer than the 80 characters a sentence prints of one.
    const film = `${"film-".repeat(17)}reel.bin`;
    await keptDelivery(
      "VIB-1",
      stamp,
      {
        "post.html": `<h1>As delivered</h1><img src="chart.png"><img src="${film}">`,
        "chart.png": "the chart as delivered",
      },
      // Past the 25 MB a capture carries for one file.
      { [film]: 26 * 1024 * 1024 },
    );
    // After the delivery was stamped and kept, a run saves the page again and
    // removes the picture beside it. A verdict binds to the kept copy, so
    // that is what is pictured.
    // CANARY: render the attachments folder for a delivery (`source: { kind:
    // "attachments" }`) and the page served is the one saved afterwards.
    saveFiles("VIB-1", { "post.html": "<h1>Saved again afterwards</h1>" });
    unlinkSync(path.join(attachments(), "chart.png"));
    await withBrowser("", () => picture("VIB-1", stamp));

    const [served] = fake.pages();
    expect(served!.html).toContain("As delivered");
    expect(served!.resources).toEqual([
      { src: "chart.png", status: 200, bytes: 22 },
      { src: film, status: 404, bytes: 10 },
    ]);
    // The renderer was handed the copy by name, in a folder of the task's
    // own directory and not under the workspace agents write.
    const [launch] = fake.launches();
    expect(launch!.argv.join(" ")).not.toContain(inputRoot());
    expect(served!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16}\/post\.html$/);
    // The name is matched against what was not carried as it is, and only
    // printed cut. CANARY: cut the name where the report is read, before it
    // is compared, and a file that is among the task's files and was left out
    // for its size is said to be "not among this task's files".
    expect(ofThePictures(captureNote()!.text)).toBe(
      "Viberr rendered `post.html` as a reader sees it, at a desktop width (1,280 px) and a phone width (390 px). " +
        "The pictures are attached and show beside each file on the result. " +
        `\`post.html\` asked for \`${film.slice(0, 79)}\u2026\`, which a capture does not carry (a file over 25 MB, or past 200 MB in all).`,
    );
    // The copy is gone with the render, and so is the render's scratch.
    expect(existsSync(inputRoot())).toBe(false);
    expect(scratches()).toEqual([]);
  });

  it("pictures the first 8 pages of a delivery and says of each page past them, on the task and in the record, why it has no picture", async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`page-${String(i + 1).padStart(2, "0")}.md`, `# Page ${i + 1}\n`]),
    );
    await deliver(pages);
    const record = frontmatter().pageCaptures!;
    // CANARY: drop the cap in deliveryPages and all ten are pictured.
    expect(record.pages.map((page) => [page.file, page.shots.length, page.error])).toEqual([
      ...Array.from({ length: 8 }, (_, i) => [`page-0${i + 1}.md`, 2, null]),
      ["page-09.md", 0, "a delivery is pictured up to 8 pages"],
      ["page-10.md", 0, "a delivery is pictured up to 8 pages"],
    ]);
    expect(fake.launches()).toHaveLength(8);
    expect(captureNote()!.text).toMatch(/ 2 more pages were not pictured: a delivery is pictured up to 8 pages\.$/);
    expect(captureNote()!.attachments).toHaveLength(16);
    expect(captureAudits()[0]!.details).toMatchObject({ pages: 8, captured: 8, failed: [], more: 2 });
  });

  it("a delivery that lands while another is being pictured gets no record, note or picture from the older render", async () => {
    const first = "2026-10-07T12:00:00.000Z";
    const second = "2026-10-07T12:05:00.000Z";
    await keptDelivery("VIB-1", first, { "post.html": "<p>the first delivery</p>" });
    await withBrowser("hold", async () => {
      const rendering = picture("VIB-1", first);
      expect(await pollUntil(() => fake.launches().length === 1)).toBe(true);
      // The rework is delivered while the first render is still loading.
      await keptDelivery("VIB-1", second, { "post.html": "<p>the rework</p>" });
      fake.release();
      await rendering;
    });
    // CANARY: drop the re-check of deliveredAt under the lock and the older
    // render writes its record and note onto the newer delivery's task, and
    // its pictures of the first delivery show beside the rework.
    expect(frontmatter().deliveredAt).toBe(second);
    expect(frontmatter().pageCaptures).toBeUndefined();
    expect(captureNote()).toBeUndefined();
    expect(onTask()).toEqual(["post.html"]);
    expect(captureAudits()).toEqual([]);
    expect(scratches()).toEqual([]);
  });

  it("one render runs at a time: a newer delivery of a task replaces the one still waiting, and an agent's ask goes ahead of the deliveries that wait", async () => {
    const stampA = "2026-10-07T12:00:00.000Z";
    const stampB1 = "2026-10-07T12:01:00.000Z";
    const stampB2 = "2026-10-07T12:02:00.000Z";
    await keptDelivery("VIB-1", stampA, { "held.html": "<p>held</p>" });
    await keptDelivery("VIB-2", stampB1, { "waiting.html": "<p>the first try</p>" });
    saveFiles("VIB-1", { "asked.html": "<p>an agent wants to see this</p>" });
    // Only VIB-1's page is held; the rest load as soon as they are opened.
    await withBrowser("hold:held.html", async () => {
      const held = picture("VIB-1", stampA);
      expect(await pollUntil(() => fake.launches().length === 1)).toBe(true);
      const replaced = { done: false };
      void picture("VIB-2", stampB1).then(() => {
        replaced.done = true;
      });
      // VIB-2 is delivered again before its first delivery was pictured.
      await keptDelivery("VIB-2", stampB2, { "waiting.html": "<p>the rework</p>" });
      const latest = picture("VIB-2", stampB2);
      // CANARY: queue the newer delivery behind the older one and the older
      // job is still waiting here; it would later find the stamp moved and
      // have held a place in the queue for nothing.
      expect(await pollUntil(() => replaced.done, 1_000)).toBe(true);
      const asked = ask("asked.html");
      expect(fake.launches()).toHaveLength(1);
      fake.release();
      const reply = await asked;
      await Promise.all([held, latest]);
      expect(reply.text).toMatch(/^\[done\] `asked\.html` as a reader sees it\./);
    });
    // CANARY: put an agent's ask at the end of the queue and the order is
    // held, waiting, asked: the agent waits out every delivery ahead of it.
    expect(opened()).toEqual(["held.html", "asked.html", "waiting.html"]);
    expect(fake.pages().find((page) => page.url.endsWith("/waiting.html"))!.html).toBe("<p>the rework</p>");
    expect(frontmatter("VIB-2").pageCaptures).toMatchObject({ deliveredAt: stampB2, pages: [{ file: "waiting.html" }] });
  });

  it("does not render a page past the size a page is set at or with a name too long to keep a picture under, and offers the tool only for the one it can still show", async () => {
    const longName = `${"a".repeat(175)}.html`;
    await deliver(
      { "ok.html": "<p>fine</p>", [longName]: "<p>a page under a 180 character name</p>" },
      "",
      // Past 2 MB of markdown and 10 MB of HTML.
      { "big.md": 3 * 1024 * 1024, "huge.html": 14 * 1024 * 1024 },
    );
    // CANARY: hand every page to the renderer whatever `sourceRefusal` says
    // and the stand-in is served 14 MB of page.
    expect(opened()).toEqual(["ok.html"]);
    const reasons = Object.fromEntries(frontmatter().pageCaptures!.pages.map((page) => [page.file, page.error]));
    expect(reasons).toEqual({
      "ok.html": null,
      "big.md": "the file is 3.0 MB; a page of up to 2 MB is pictured",
      "huge.html": "the file is 14.0 MB; a page of up to 10 MB is pictured",
      [longName]: "its name is longer than 178 characters, and a picture is kept under the file's name",
    });
    // `capture_page` keeps nothing under a file's name, so it still shows the
    // long-named page; it refuses the two large ones for the same limit.
    expect(ofThePictures(captureNote()!.text).endsWith(
      `The delivery stands without them, and an agent can look at \`${longName}\` with \`capture_page\`.`,
    )).toBe(true);
    await withBrowser("", async () => {
      expect((await ask("big.md")).text).toBe("[noop] `big.md` is 3 MB; capture_page renders a page of up to 2 MB.");
      expect((await ask("huge.html")).text).toBe(
        "[noop] `huge.html` is 14 MB; capture_page renders a page of up to 10 MB.",
      );
      expect((await ask(longName)).images).toHaveLength(2);
    });
  });

  it("on a board with a repository a delivery is a revision and is never pictured: not the first, which the pipeline learns is one only after it stamped it, and not a later one", async () => {
    // The deliverer's run commits on its branch and saves a report beside
    // the commit. Its first completion stamps `deliveredAt` in the reply's
    // own write, and only the delivery reconcile, a step later, mints the
    // work revision that makes the delivery a revision.
    deployBoard({ repo: "akin-ozer/viberr" });
    const checkout = path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr");
    mkdirSync(checkout, { recursive: true });
    gitOutSync(checkout, ["init", "-q", "-b", "main"]);
    gitOutSync(checkout, ["config", "user.email", "t@viberr.local"]);
    gitOutSync(checkout, ["config", "user.name", "Test"]);
    gitOutSync(checkout, ["commit", "-q", "--allow-empty", "-m", "init"]);
    gitOutSync(checkout, ["checkout", "-q", "-b", "vib-1"]);
    gitOutSync(checkout, ["commit", "-q", "--allow-empty", "-m", "[VIB-1] the work"]);
    // The reconcile also asks `gh` for the branch's pull request: a stand-in
    // first on PATH answers that there is none, so no test reaches GitHub.
    const bin = ctx.makeTempDir("viberr-gh-");
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'no pull requests found' >&2\nexit 1\n");
    chmodSync(path.join(bin, "gh"), 0o755);
    const complete = (runId: string) =>
      withEnv(
        {
          VIBERR_BROWSER_EXECUTABLE: fake.executable,
          ...fake.env(""),
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        () => completeDelivery(runId),
      );
    // A render makes its scratch folder before it starts anything, so a task
    // with none never had a render started for it, whenever its browser
    // would have come up.
    const pictured = () => ({
      scratch: existsSync(scratchRoot()),
      launches: fake.launches().length,
      onTask: onTask(),
      record: frontmatter().pageCaptures,
      notes: timeline().filter((event) => event.title === "Page captures").length,
      audits: captureAudits().length,
    });
    const nothing = {
      scratch: false,
      launches: 0,
      onTask: ["playwright-report.html"],
      record: undefined,
      notes: 0,
      audits: 0,
    };

    await complete(await finishedRunSaving({ "playwright-report.html": "<p>the run's own evidence</p>" }));
    // The pipeline itself made it a revision, after it stamped the delivery.
    expect(frontmatter().deliveredAt).toBeTruthy();
    expect(frontmatter().workRevision).toMatchObject({ branch: "vib-1", sourceProfileId: "writer" });
    // CANARY: ask for the pictures where the delivery is stamped (in
    // recordAgentCompletion, before the reconcile) and a render is started
    // for a delivery whose result shows no files.
    expect(pictured()).toEqual(nothing);

    // A rework on the same branch stamps again, on a task that is already a
    // revision.
    const first = frontmatter().deliveredAt;
    gitOutSync(checkout, ["commit", "-q", "--allow-empty", "-m", "[VIB-1] the rework"]);
    await complete(await finishedRunSaving({ "playwright-report.html": "<p>the rework's evidence</p>" }));
    expect(frontmatter().deliveredAt).not.toBe(first);
    // CANARY: drop the revision check from owesCapture and from the head of
    // captureDelivery and a render is started here too.
    expect(pictured()).toEqual(nothing);
  });

  it("a delivery that becomes a revision after its pictures were asked for gets no picture, record or note, with the renderer idle or busy, and the pictures of the files delivery before it go", async () => {
    await deliver({ "notes.md": "# Notes\n" });
    expect(onTask()).toEqual(["notes.md", "notes.md.capture-desktop.png", "notes.md.capture-phone.png"]);
    const revision: WorkRevision = {
      id: "rev_1",
      headSha: "9".repeat(40),
      treeSha: null,
      branch: "vib-1-work",
      createdAt: "2026-10-07T12:00:00.000Z",
      sourceProfileId: "writer",
    };
    const mint = (key: string) =>
      updateTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot }, (parsed) => {
        parsed.frontmatter.workRevision = revision;
      });
    const stamp = "2026-10-07T12:00:00.000Z";
    await keptDelivery("VIB-1", stamp, { "playwright-report.html": "<p>the run's own evidence</p>" });
    await keptDelivery("VIB-3", stamp, { "report.html": "<p>another task's evidence</p>" });
    const launched = fake.launches().length;
    await withBrowser("hold:evidence", async () => {
      // The order a caller may ask in: the delivery is stamped and kept, its
      // pictures are asked for, and the task's work becomes a revision
      // afterwards. The renderer is idle, so VIB-1's render starts at once.
      const idle = picture("VIB-1", stamp);
      expect(await pollUntil(() => fake.launches().length === launched + 1)).toBe(true);
      // It is busy now, so VIB-3's render waits its turn.
      const busy = picture("VIB-3", stamp);
      await mint("VIB-1");
      await mint("VIB-3");
      fake.release();
      await Promise.all([idle, busy]);
    });
    // CANARY: drop the deliveredAsFiles check under the lock in
    // captureDelivery and the render that was already running writes two
    // pictures, a record and a note that says they "show beside each file on
    // the result", on a task whose result shows no files.
    expect(onTask()).toEqual(["notes.md", "playwright-report.html"]);
    expect(frontmatter().pageCaptures).toBeUndefined();
    expect(timeline().filter((event) => event.title === "Page captures")).toHaveLength(1);
    expect(captureAudits()).toHaveLength(1);
    const kept = listKeptDeliveries(store.slug, "VIB-1", store.dataRoot).find((held) => held.deliveredAt === stamp);
    expect(kept?.files).toEqual(["playwright-report.html"]);
    // The one that waited found a revision when its turn came: no browser.
    expect(opened()).not.toContain("report.html");
    expect(frontmatter("VIB-3").pageCaptures).toBeUndefined();
    expect(readdirSync(attachments("VIB-3"))).toEqual(["report.html"]);
  });

  it("the note says what a picture cannot show by itself: a page cut short, one a phone shrinks, one wider than its screen, one that opens a dialog, one that asks for a path it is never served, and one pictured at one width only", { timeout: REAL_RENDERS_MS }, async () => {
    await deliver(
      {
        "alert.html": '<script>alert("Welcome")</script><p>behind the dialog</p>',
        "half.html": "<p>fake-crash-at:390</p>",
        "long.html": "<p>fake-height:20000</p>",
        "rooted.html": '<script src="/css/site.js"></script><img src="../up.png"><p>styled from the site\'s root</p>',
        "shrunk.html": "<p>no viewport setting, so a phone lays it out 980 px wide: fake-scale:0.398</p>",
        "wide.html": "<p>fake-width:612</p>",
      },
      "dialog:alert.html",
    );
    // CANARY: delete any one branch of `pageRemarks` (the cut, the scale, the
    // width, the dialog, the error) and its sentence leaves the note. Take a
    // path for a file name in `missingClauses` and `rooted.html` is said to
    // have asked for files "not among this task's files (the folder is
    // flat)", which sends its author looking for a file to add.
    expect(ofThePictures(captureNote()!.text)).toBe(
      "Viberr rendered `alert.html`, `half.html`, `long.html`, `rooted.html`, `shrunk.html`, and `wide.html` as a reader sees them, " +
        "at a desktop width (1,280 px) and a phone width (390 px). " +
        "The pictures are attached and show beside each file on the result. " +
        "`alert.html` opens a dialog as it loads (an alert, a confirm or a prompt). A capture dismisses it, so the picture shows the page behind it. " +
        "Not every picture of `half.html` was made: the browser ended before the page was pictured. " +
        "`long.html` runs longer than its desktop picture, which shows the first 4,800 px of 20,000. " +
        "`long.html` runs longer than its phone picture, which shows the first 5,064 px of 20,000. " +
        "`rooted.html` asked for `/css/site.js` and `/up.png`, paths from the site's root or above the page's folder, " +
        "which a capture does not serve (it serves the task's own files by name). " +
        "A phone lays `shrunk.html` out 980 px wide and shrinks it to fit its 390 px screen, so its text is small. " +
        "`wide.html` is 612 px wide on a 390 px screen, so a reader scrolls sideways.",
    );
    // The page pictured at one width keeps that picture and its reason.
    expect(frontmatter().pageCaptures!.pages.find((page) => page.file === "half.html")).toEqual({
      file: "half.html",
      shots: [{ view: "desktop", name: "half.html.capture-desktop.png", cut: false }],
      error: "the browser ended before the page was pictured",
    });
    // An agent that looks is told the same about the paths.
    expect((await withBrowser("", () => ask("rooted.html"))).text).toContain(
      "It asked for `/css/site.js` and `/up.png`, paths from the site's root or above the page's folder, " +
        "which a capture does not serve (it serves the task's own files by name).",
    );
    // And when one width is over before the stretch asked for and the other
    // failed, the failure is the answer, with the width that ended named.
    // `half.html` is one screen tall, 800 px on a desktop, and ends the
    // browser at the phone's width. CANARY: answer [noop] whenever any width
    // reports its end, as before, and the agent is told the page is simply
    // over where a phone had content and the render failed.
    expect((await withBrowser("", () => ask("half.html", { from: 820 }))).text).toBe(
      "[error] `half.html` could not be captured: the browser ended before the page was pictured. " +
        "It ends at 800 px at the desktop width (1280 px), so nothing starts at 820 px there.",
    );
  });

  it("pictures one of two pages whose pictures would be kept under the same names, and says why the other has none", async () => {
    // The store keeps a name trimmed and composed, so the pictures of
    // ` notes.html` and of `notes.html` are one pair of names.
    const stamp = "2026-10-07T12:00:00.000Z";
    await keptDelivery("VIB-1", stamp, { "notes.html": "<p>the notes</p>", " notes.html": "<p>other notes</p>" });
    await withBrowser("", () => picture("VIB-1", stamp));
    // CANARY: hand both pages to the renderer, as before, and the second
    // page's pictures are written over the first's: the record names the
    // same two pictures under both pages and the task holds one pair.
    expect(frontmatter().pageCaptures!.pages).toEqual([
      {
        file: " notes.html",
        shots: [],
        error: 'its pictures would be kept under the same names as the pictures of "notes.html"',
      },
      {
        file: "notes.html",
        shots: [
          { view: "desktop", name: "notes.html.capture-desktop.png", cut: false },
          { view: "phone", name: "notes.html.capture-phone.png", cut: false },
        ],
        error: null,
        ...MEASURED,
      },
    ]);
    // The page spelled the way the store spells it is the one pictured.
    expect(opened()).toEqual(["notes.html"]);
    expect(fake.pages()[0]!.html).toBe("<p>the notes</p>");
    expect(ofThePictures(captureNote()!.text)).toBe(
      "Viberr rendered `notes.html` as a reader sees it, at a desktop width (1,280 px) and a phone width (390 px). " +
        "The pictures are attached and show beside each file on the result. " +
        'Viberr could not picture ` notes.html`: its pictures would be kept under the same names as the pictures of "notes.html". ' +
        "The delivery stands without it.",
    );
  });

  it("pictures a page of a delivery of thousands of files: the renderer is handed its job on standard input, not as one argument", async () => {
    // The job names every file of the kept delivery (ruling 81 keeps every
    // file on the task). 4,400 names of 240 characters are over a megabyte
    // of job: past the 131,072 bytes Linux takes as one argument, and past
    // the megabyte macOS takes for all of them.
    const stamp = "2026-10-07T12:00:00.000Z";
    const many = Object.fromEntries(
      Array.from({ length: 4_400 }, (_, i) => [`${String(i).padStart(5, "0")}-${"x".repeat(230)}.txt`, ""]),
    );
    await keptDelivery("VIB-1", stamp, { "post.html": "<p>the page</p>", ...many });
    await withBrowser("", () => picture("VIB-1", stamp));
    // CANARY: pass the job as an argument of the renderer again and it
    // cannot be spawned: the page records "the renderer could not be started".
    expect(frontmatter().pageCaptures!.pages).toEqual([
      {
        file: "post.html",
        shots: [
          { view: "desktop", name: "post.html.capture-desktop.png", cut: false },
          { view: "phone", name: "post.html.capture-phone.png", cut: false },
        ],
        error: null,
        ...MEASURED,
      },
    ]);
  });

  it("an agent's ask finds a page in either Unicode form and renders it under the name the folder holds", async () => {
    // Ruling 76's live case: a file uploaded from a Mac before that ruling,
    // stored decomposed, asked for by the composed name every listing shows.
    const stored = "Özet.html".normalize("NFD");
    const typed = "Özet.html".normalize("NFC");
    expect(stored).not.toBe(typed);
    saveFiles("VIB-1", { [stored]: "<p>summary</p>" });
    const reply = await withBrowser("", () => ask(typed));
    // The reply names the page as the agent did.
    expect(reply.text.startsWith(`[done] \`${typed}\` as a reader sees it.`)).toBe(true);
    // CANARY: hand the renderer the name as typed and, on a disk that holds
    // names byte for byte, it answers "the file is not there to render" for a
    // file the stat just found.
    expect(opened()).toEqual([stored]);
  });

  it("an agent's ask with a size is answered with one picture of exactly that size, told what of the layout the box left out and how the picture is kept, and saves nothing on the task", async () => {
    saveFiles("VIB-1", {
      "cover.html": '<img src="https://fonts.example.com/inter.css"><img src="logo.png"><p>a cover that fits its box</p>',
      "long.html": "<p>a layout that does not fit: fake-height:900 fake-width:1400</p>",
      "skew.html": "<p>comes back a px off the size asked: fake-short-by:1</p>",
    });
    // Ruling 194: an agent that draws a diagram or a cover asks for its
    // picture at the size the picture is for.
    const run = await liveRun("illustrator");
    const before = timeline();
    const kept = "Copying that file into the task's attachments folder under a name ending `\\.png` keeps it as a file of the task\\.$";
    await withBrowser("", async () => {
      // CANARY: leave the size out of the views `capturePage` hands the
      // renderer and this is the page in stretches, at both widths; drop
      // KEEP_PICTURE from the reply and the run is told of a file in a
      // scratch that goes with it, and not how the picture stays.
      const twice = await ask("cover.html", { runId: run, width: 1200, height: 630, scale: 2 });
      expect(twice.text).toMatch(
        new RegExp(
          "^\\[done\\] `cover\\.html` as a picture of the size asked: 1,200 by 630 px at scale 2, " +
            "saved as a PNG of 2,400 by 1,260 px\\. " +
            "It asked the network for 1 thing \\(fonts\\.example\\.com\\), which a capture never loads, " +
            "and for `logo\\.png`, which is not among this task's files \\(the folder is flat\\)\\. " +
            // Over 2,000 px on a side: saved, and not handed back. CANARY:
            // hand every box back as it is and a run that has looked at 20
            // pictures is sent one the model's API refuses.
            "It is over 2,000 px on a side, so it is saved and not shown here: " +
            "the same box at a lower scale is the same layout, and shows you it\\. " +
            `Saved for this run at \`\\S+/\\.captures/${run}/cap_\\S+/out/1-desktop\\.png\`: ` +
            "scratch, your next capture replaces it, and it goes when this run ends\\. " +
            kept,
        ),
      );
      expect(handedBack(twice)).toEqual([]);
      // The file the reply names is that picture, where the run's shell
      // reads it to copy it.
      const saved = /Saved for this run at `([^`]+)`/.exec(twice.text)![1]!;
      expect(pngOf(saved)).toEqual({ mimeType: "image/png", width: 2400, height: 1260 });
      // One picture of the one box: no second width, no stretch.
      expect(fake.pages()).toHaveLength(1);

      // A layout past the box, in each direction: said, with both sizes.
      // CANARY: delete either sentence from `boxReplyText` and the run sees
      // a picture cut at an edge with no word of how much lies past it.
      const long = await ask("long.html", { width: 1200, height: 630 });
      expect(long.text).toMatch(
        new RegExp(
          "^\\[done\\] `long\\.html` as a picture of the size asked: 1,200 by 630 px at scale 1, " +
            "saved as a PNG of 1,200 by 630 px\\. " +
            "It is laid out 900 px tall in a box 630 px tall, so the picture leaves out what is below the box\\. " +
            "It is laid out 1,400 px wide in a box 1,200 px wide, so the picture leaves out what is to the right of the box\\. " +
            "Saved at `\\S+/\\.captures/no\\.run/cap_\\S+/out/1-desktop\\.png`: " +
            "scratch, and the next capture on this task replaces it\\. " +
            kept,
        ),
      );
      expect(handedBack(long)).toEqual([{ mimeType: "image/png", width: 1200, height: 630 }]);

      // A run that holds the verdict is not told how a picture is kept: it
      // judges pictures and makes none. CANARY: ignore `keeps` in
      // `boxReplyText` and the sentence is there.
      const judged = await ask("long.html", { width: 1200, height: 630, keeps: false });
      expect(judged.text).toMatch(/scratch, and the next capture on this task replaces it\.$/);
      expect(judged.text).not.toContain("keeps it as a file of the task");

      // Under 1, and each side rounded by itself.
      const half = await ask("cover.html", { width: 1201, height: 631, scale: 0.5 });
      expect(half.text).toContain("as a picture of the size asked: 1,201 by 631 px at scale 0.5, saved as a PNG of 601 by 316 px.");
      expect(handedBack(half)).toEqual([{ mimeType: "image/png", width: 601, height: 316 }]);

      // A picture that comes back any other size is not the one asked for.
      // CANARY: hold a box to its width and a cap, as a stretch is held, and
      // this answers [done] with a PNG of 1,200 by 629 px.
      expect((await ask("skew.html", { width: 1200, height: 630 })).text).toBe(
        "[error] `skew.html` could not be captured: its picture did not come back as a PNG of the size asked for.",
      );
    });
    // One too large to hand back says so and what to change. The stand-in's
    // pictures weigh 1,000 bytes per px of height here: 4,000 px of them is
    // past the 3,750,000 bytes a capture hands back.
    const heavy = await withBrowser("big", () => ask("cover.html", { width: 1000, height: 2000, scale: 2 }));
    expect(heavy.text).toMatch(
      /^\[error\] `cover\.html` could not be captured: the picture is 4,0\d\d,\d{3} bytes, over the 3,750,000 a capture hands back; lower the scale or simplify the picture\.$/,
    );
    expect(heavy.images).toEqual([]);

    // It saved nothing on the task: no file, no entry, no record, no audit
    // row. A picture the run wants kept is the run's to copy.
    expect(onTask()).toEqual(["cover.html", "long.html", "skew.html"]);
    expect(timeline()).toEqual(before);
    expect(frontmatter().pageCaptures).toBeUndefined();
    expect(captureAudits()).toEqual([]);
    await stopRun(run);
  });

  it("refuses a size it cannot picture in a sentence that says what to change, and starts no browser for it", async () => {
    saveFiles("VIB-1", { "cover.html": "<p>a cover</p>" });
    const alone = (given: string, wanted: string) =>
      `[noop] \`cover.html\` was not pictured: a size is \`width\` and \`height\` together, and this call gave only \`${given}\`. Give \`${wanted}\` too.`;
    const noStretch =
      "[noop] `cover.html` was not pictured: a size makes one picture of the box it names, so it goes with neither `view` nor `from`. " +
      "Give the size alone, or leave it out to look at the page in stretches.";
    // CANARY: turn any one of `askedBox`'s four refusals off. A lone `width`
    // or a lone `scale` is then read as no size at all and answered with the
    // page in stretches; a `view` beside a size is dropped without a word;
    // and 64,000,000 px is asked of the browser.
    const refusals: [AskOver, string][] = [
      [{ width: 1200 }, alone("width", "height")],
      [{ height: 630, scale: 2 }, alone("height", "width")],
      [
        { scale: 2 },
        "[noop] `cover.html` was not pictured: `scale` goes with a size. Give `width` and `height` too, or leave `scale` out.",
      ],
      [{ width: 1200, height: 630, view: "phone" }, noStretch],
      [{ width: 1200, height: 630, from: 0 }, noStretch],
      [
        { width: 4000, height: 4000, scale: 2 },
        "[noop] `cover.html` was not pictured: 4,000 by 4,000 px at scale 2 is a picture of 8,000 by 8,000 px, " +
          "64,000,000 px in all, and a capture makes one of up to 16,000,000. Lower the scale or the size.",
      ],
    ];
    await withBrowser("", async () => {
      for (const [over, text] of refusals) expect((await ask("cover.html", over)).text).toBe(text);
      expect(fake.launches()).toEqual([]);
      // The limit is a bound and not a wall: 16,000,000 px is still made,
      // and saved where the reply says (it is too large to hand back).
      const largest = await ask("cover.html", { width: 4000, height: 4000 });
      expect(largest.text).toContain("saved as a PNG of 4,000 by 4,000 px.");
      expect(pngOf(/Saved at `([^`]+)`/.exec(largest.text)![1]!)).toEqual({ mimeType: "image/png", width: 4000, height: 4000 });
    });
  });

  it("pictures an SVG drawing at a size it is given and no other way: a delivered one is never pictured, and one asked for with no size is said to need one", async () => {
    const drawing = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400"/></svg>';
    // A delivered drawing is not a page: Viberr pictures none by itself, at
    // a desktop or a phone width it does not have. CANARY: answer a kind for
    // `.svg` from `pageKindOf` and this delivery gets two pictures, a record
    // and a note.
    await deliver({ "diagram.svg": drawing, "figures.csv": "a,b\n1,2\n" });
    expect(onTask()).toEqual(["diagram.svg", "figures.csv"]);
    expect(frontmatter().pageCaptures).toBeUndefined();
    expect(captureNote()).toBeUndefined();
    saveFiles("VIB-1", {}, { "huge.svg": 14 * 1024 * 1024 });
    await withBrowser("", async () => {
      // CANARY: drop the refusal and a drawing is pictured in stretches at
      // 1280 and 390 px, widths it was never drawn for.
      expect((await ask("diagram.svg")).text).toBe(
        "[noop] `diagram.svg` is a drawing, and a drawing is pictured at a size: give `width` and `height`.",
      );
      expect((await ask("huge.svg", { width: 800, height: 400 })).text).toBe(
        "[noop] `huge.svg` is 14 MB; capture_page renders a drawing of up to 10 MB.",
      );
      expect(fake.launches()).toEqual([]);
      const reply = await ask("diagram.svg", { width: 800, height: 400 });
      expect(reply.text).toMatch(
        /^\[done\] `diagram\.svg` as a picture of the size asked: 800 by 400 px at scale 1, saved as a PNG of 800 by 400 px\. Saved at /,
      );
      expect(handedBack(reply)).toEqual([{ mimeType: "image/png", width: 800, height: 400 }]);
      // The renderer was told it is a drawing: the browser was sent to the
      // page a drawing is set as, which holds it inline. CANARY: hand it over
      // as `html` and the browser is sent to `diagram.svg` itself.
      expect(opened()).toEqual([".viberr-render.html"]);
      expect(fake.pages()[0]!.html).toContain(`<body>\n${drawing}\n</body>`);
    });
  });

  it("ruling 194: an agent's ask puts a page in a state before the picture, says what the act found at each width, refuses a state it cannot show, and writes down no look", { timeout: REAL_RENDERS_MS }, async () => {
    // A still picture of a page at rest hides its menu, what a control looks
    // like under the pointer and where the keyboard goes. On the first board
    // asked for a page, its agents scripted a browser of their own to see
    // them, at a width Viberr pictures nothing at.
    const runId = await liveRun("writer");
    saveFiles("VIB-1", {
      "site.html":
        '<nav>fake-find:{"Menu":[340,28,"button"],"Docs":[120,28,"a"]}</nav>' +
        '<p>fake-names:["Docs","Menu","Sign in"]</p>' +
        '<p>fake-controls:[["a","Docs"],["button","Menu"],["a","Sign in"]]</p><p>fake-tab-order:[0,1,2]</p>' +
        "<p>fake-height:3000</p>",
    });
    await withBrowser("", async () => {
      // A press: one screen at each width, as it stood after it.
      const pressed = await ask("site.html", { press: "Menu", runId });
      expect(pressed.text).toContain("[done] `site.html` in the state asked for: each picture is one screen, as it stood after the act.");
      expect(pressed.text).toContain('At the desktop width (1280 px): pressed button "Menu".');
      expect(pressed.text).toContain('At the phone width (390 px): pressed button "Menu".');
      expect(handedBack(pressed)).toEqual([
        { mimeType: "image/png", width: 1280, height: 800 },
        { mimeType: "image/png", width: 390, height: 844 },
      ]);
      // The press reached the browser as a pointer's press and release on the
      // control, at each width.
      // CANARY: drop `act` from the view the door builds and the reply is a
      // stretch of the page at rest, with nothing pressed.
      expect(fake.inputs().filter((input) => input.type === "mousePressed")).toEqual([
        expect.objectContaining({ x: 340, y: 28 }),
        expect.objectContaining({ x: 340, y: 28 }),
      ]);

      // Tab, then the pointer on another control, in one call at one width.
      const before = fake.inputs().length;
      const focused = await ask("site.html", { tab: 2, hover: "Docs", view: "phone", runId });
      expect(focused.text).toContain('At the phone width (390 px): 2 presses of Tab: focus is on button "Menu"; the pointer is on a "Docs".');
      expect(handedBack(focused)).toEqual([{ mimeType: "image/png", width: 390, height: 844 }]);
      const sent = fake.inputs().slice(before);
      expect(sent.filter((input) => input.type === "rawKeyDown").map((input) => input.key)).toEqual(["Tab", "Tab"]);
      expect(sent.at(-1)).toEqual(expect.objectContaining({ type: "mouseMoved", x: 120, y: 28 }));

      // A name nothing answers to is said with the names that are there, and
      // no picture stands in for the state that was not reached.
      const missed = await ask("site.html", { press: "Pricing", view: "desktop", runId });
      expect(missed.text).toBe(
        "[noop] `site.html` was not pictured: the act found nothing to act on. " +
          'At the desktop width (1280 px): nothing at this width is called "Pricing". The controls on it: "Docs", "Menu", "Sign in".',
      );
      expect(missed.images).toEqual([]);

      // Reduced motion is the reader's setting, told to the browser before
      // the page loads.
      const reduced = await ask("site.html", { motion: "reduce", view: "desktop", runId });
      expect(reduced.text).toContain("with reduced motion asked for");
      expect(fake.pages().at(-1)!.reducedMotion).toBe("reduce");

      // The screen while it moves: three pictures a width, and when each was
      // taken, in place of a stretch.
      const moving = await ask("site.html", { moving: true, view: "desktop", runId });
      expect(moving.text).toContain(
        "[done] `site.html` while it moves: the screen at 0 px, pictured more than once as the page loaded. " +
          "What differs between two pictures of one width is what moved. Desktop, 1280 px wide: 3 pictures, about ",
      );
      // The moments are the renderer's own clock, so only their shape is read.
      expect(moving.text).toMatch(/about [\d,]+ ms, [\d,]+ ms, and [\d,]+ ms after it came into view\./);
      expect(handedBack(moving)).toEqual([
        { mimeType: "image/png", width: 1280, height: 800 },
        { mimeType: "image/png", width: 1280, height: 800 },
        { mimeType: "image/png", width: 1280, height: 800 },
      ]);

      // A state goes with no size and an act with no place on the page: each
      // is refused in a sentence that says what to leave out, and no browser
      // is started for it.
      const launched = fake.launches().length;
      for (const [over, why] of [
        [{ press: "Menu", width: 1200, height: 630 }, "a size makes one picture of the page at rest, so it goes with none of `press`, `hover`, `tab`, `moving` and `motion`."],
        [{ tab: 1, from: 2000 }, "`press`, `hover` and `tab` picture the screen where the act leaves it, so they go with no `from`. Leave `from` out."],
        [{ hover: "Docs", moving: true }, "`moving` pictures the screen while the page loads, before anything is pressed, so it goes with none of `press`, `hover` and `tab`."],
      ] as const) {
        const refused = await ask("site.html", { ...over, runId });
        expect(refused.text).toContain(`[noop] \`site.html\` was not pictured: ${why}`);
        expect(refused.images).toEqual([]);
      }
      expect(fake.launches()).toHaveLength(launched);
    });
    // Ruling 329: a look is a stretch of the page as it reads at rest. One
    // screen in a state, or the page with reduced motion asked for, is not
    // the page a reader scrolls, and counts for none of it.
    // CANARY: record every picture `capture_page` hands back and a reviewer
    // that opened the menu once has looked at the page's first 800 px.
    expect(runLooks(store.db, runId)).toEqual([]);
    await stopRun(runId);
  });

  it("keeps an agent's pictures for the run that asked: only the pictures, apart from another run's, until that run ends", async () => {
    saveFiles("VIB-1", { "post.html": "<p>fake-height:3000</p>" });
    const first = await liveRun("editor");
    const second = await liveRun("proofreader");
    const kept = (runId: string) => {
      const dir = path.join(scratchRoot(), runId);
      return existsSync(dir) ? readdirSync(dir).map((capture) => readdirSync(path.join(dir, capture)).sort()) : null;
    };
    await withBrowser("", async () => {
      const reply = await ask("post.html", { runId: first });
      // Beside the kept deliveries, in a folder of the run's own, and not
      // under the workspace agents write.
      expect(reply.text).toContain(`/VIB-1/.captures/${first}/cap_`);
      expect(reply.text).not.toContain("/workspace/");
      expect(reply.text.endsWith("scratch, your next capture replaces it, and it goes when this run ends.")).toBe(true);
      // CANARY: leave the browser's profile and the render's temp files
      // where they are and each capture keeps megabytes nobody reads.
      expect(kept(first)).toEqual([["out"]]);
      // Another reviewer on the same task looks too.
      // CANARY: remove every other folder before a render, as the first
      // version did, and the first run's saved pictures are gone here.
      await ask("post.html", { runId: second });
      expect(kept(first)).toEqual([["out"]]);
      expect(kept(second)).toEqual([["out"]]);
      // The run's own next stretch replaces its last.
      await ask("post.html", { runId: first, from: 2000 });
      expect(kept(first)).toEqual([["out"]]);
    });
    // The first run ends, and its pictures go with it.
    // CANARY: drop the removal from applyAgentCompletionEffects and they stay
    // for the life of the task.
    await stopRun(first);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "editor",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "editor",
      },
      { id: first, state: "interrupted" },
    );
    expect(await pollUntil(() => kept(first) === null)).toBe(true);
    expect(kept(second)).toEqual([["out"]]);
    // A run that ended with nobody to clean up after it (a restart) loses its
    // pictures to the next render on the task.
    await stopRun(second);
    const unnamed = await withBrowser("", () => ask("post.html"));
    expect(kept(second)).toBeNull();
    // An ask whose caller could not name its run is kept where the next
    // capture on the task replaces it, and says so.
    expect(unnamed.text).toMatch(
      /Saved at `\S+\/\.captures\/no\.run\/cap_\S+\/out\/1-desktop\.png` and `\S+\/out\/1-phone\.png`: scratch, and the next capture on this task replaces it\.$/,
    );
  });

  it("ruling 329: every reader that hands a run a picture writes down what it showed, and a picture of a size, a text read and a read by no run write nothing", async () => {
    // What an approval of a page rests on is this list. CANARY: drop
    // `recordRunLooks` from `capture_page`, from the attachment reader or from
    // the source reader and the matching entry below is missing.
    const STAMP = "2026-10-09T22:40:00.000Z";
    await keptDelivery("VIB-1", STAMP, { "post.html": "<p>fake-height:3000</p>", "notes.txt": "plain" });
    const deps = (runId: string | null) => ({ db: store.db, ctx: { dataRoot: store.dataRoot }, projectSlug: store.slug, runId });
    await withBrowser("", async () => {
      await picture("VIB-1", STAMP);
      const runId = await liveRun("editor");
      // A source that is a picture: the phone picture's own bytes.
      writeTaskSource(
        store.slug,
        "VIB-1",
        {
          name: "reference-phone.png",
          data: readFileSync(path.join(attachments(), "post.html.capture-phone.png")),
          title: "The reference at the phone width",
          from: "https://example.com/",
          by: { backend: "claude", profileId: "writer", roleHint: "Writer" },
          runId: null,
        },
        store.dataRoot,
      );
      // Two stretches of the page at the desktop width: its top, then its end.
      await ask("post.html", { runId, view: "desktop" });
      await ask("post.html", { runId, view: "desktop", from: 2000 });
      // The picture Viberr kept of the delivery at the phone width.
      expect("image" in readAgentTaskAttachment(deps(runId), "VIB-1", "post.html.capture-phone.png")).toBe(true);
      // The kept source, opened as an image.
      expect("image" in readAgentTaskSource(deps(runId), "VIB-1", "S1")).toBe(true);
      // None of these is a look: a picture of a size somebody chose, a file
      // read as text, the list of sources, and a picture handed to no run.
      await ask("post.html", { runId, width: 600, height: 400 });
      readAgentTaskAttachment(deps(runId), "VIB-1", "notes.txt");
      readAgentTaskSource(deps(runId), "VIB-1", undefined);
      readAgentTaskAttachment(deps(null), "VIB-1", "post.html.capture-desktop.png");
      // The task's files are as delivered, so a stretch of them is a look at
      // that delivery.
      expect(runLooks(store.db, runId)).toEqual([
        { kind: "page", task: "VIB-1", file: "post.html", view: "desktop", from: 0, to: 2000, end: false, delivery: STAMP },
        { kind: "page", task: "VIB-1", file: "post.html", view: "desktop", from: 2000, to: 3000, end: true, delivery: STAMP },
        { kind: "page", task: "VIB-1", file: "post.html", view: "phone", from: 0, to: 3000, end: true, delivery: STAMP },
        { kind: "source", task: "VIB-1", id: "S1" },
      ]);
      // The same kept picture read out of the delivery's own copy is the same
      // look. CANARY: record nothing for a read that names its delivery, the
      // one read that is provably of it.
      const second = await liveRun("proofreader");
      expect("image" in readAgentTaskAttachment(deps(second), "VIB-1", "post.html.capture-phone.png", 0, STAMP)).toBe(true);
      expect(runLooks(store.db, second)).toEqual([
        { kind: "page", task: "VIB-1", file: "post.html", view: "phone", from: 0, to: 3000, end: true, delivery: STAMP },
      ]);
      // A file changed on the task since the delivery (a rework that was
      // stopped, an upload): `capture_page` renders the files as they are,
      // and that look is of other bytes than the review judges.
      // CANARY: credit every stretch to the task's delivery and a reviewer
      // approves the delivery on a look at a page it does not hold.
      saveFiles("VIB-1", { "post.html": "<p>half a rework</p><p>fake-height:3000</p>" });
      await ask("post.html", { runId: second, view: "desktop" });
      expect(runLooks(store.db, second).at(-1)).toEqual({
        kind: "page",
        task: "VIB-1",
        file: "post.html",
        view: "desktop",
        from: 0,
        to: 2000,
        end: false,
        delivery: null,
      });
      await stopRun(second);

      // A Claude run that opens the kept pictures with its own file reader has
      // looked too: its log holds the read and the image it was handed.
      // CANARY: count a read whose result is an error, or text, as a look.
      const reader = await liveRun("proofreader");
      type Handed =
        | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
        | { type: "text"; text: string };
      type Block =
        | { type: "tool_use"; id: string; name: "Read"; input: { file_path: string } }
        | { type: "tool_result"; tool_use_id: string; is_error: boolean; content: Handed[] };
      interface Envelope {
        type: "assistant" | "user";
        message: { content: Block[] };
      }
      const line = (seq: number, envelope: Envelope) =>
        insertRunLine(store.db, {
          runId: reader,
          seq,
          occurredAt: new Date().toISOString(),
          raw: JSON.stringify(envelope),
          display: { t: "00:00:00", ev: "tool", tag: "tool_use", text: "" },
        });
      const read = (id: string, file: string): Envelope => ({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] },
      });
      const handed = (id: string, content: Handed[], isError = false): Envelope => ({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
      });
      const image: Handed[] = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }];
      const sources = path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "sources");
      line(100, read("t1", path.join(attachments(), "post.html.capture-desktop.png")));
      line(101, handed("t1", image));
      line(102, read("t2", path.join(sources, "S1.png")));
      line(103, handed("t2", image));
      line(104, read("t3", path.join(attachments(), "post.html.capture-phone.png")));
      line(105, handed("t3", [{ type: "text", text: "File does not exist." }], true));
      line(106, read("t4", path.join(attachments(), "notes.txt")));
      line(107, handed("t4", [{ type: "text", text: "plain" }]));
      expect(looksFromRunLog(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-1", runId: reader })).toEqual([
        { kind: "page", task: "VIB-1", file: "post.html", view: "desktop", from: 0, to: 3000, end: true, delivery: STAMP },
        { kind: "source", task: "VIB-1", id: "S1" },
      ]);
    });
  });

  it("makes, shares and removes nothing through a link where a render's scratch would go, and says the scratch could not be made", async () => {
    // The scratch is in the task's own directory, where no agent can put an
    // entry, and each folder on the way is still checked as the server's own
    // directory before anything is made, listed or removed below it. A test
    // host has no second user to refuse, so the suite plants the links itself.
    saveFiles("VIB-1", { "post.html": "<p>the page</p>" });
    const run = await liveRun("editor");
    // Somewhere else in the store: a folder named like the run's and one
    // named like an ended run's, each holding what a render would take for
    // an earlier scratch and remove.
    const elsewhere = ctx.makeTempDir("viberr-elsewhere-");
    for (const home of [run, "run_ended"]) {
      mkdirSync(path.join(elsewhere, home, "cap_earlier", "out"), { recursive: true });
      writeFileSync(path.join(elsewhere, home, "cap_earlier", "out", "kept.png"), "not a render's");
    }
    /** Every entry there with its mode and group: what a create, a share or
     *  a removal through a link would change. (The group itself moves only
     *  where the server launches agents, which no test host does.) */
    const seen = () =>
      readdirSync(elsewhere, { recursive: true })
        .map(String)
        .sort()
        .map((entry) => {
          const st = lstatSync(path.join(elsewhere, entry));
          return `${entry} ${(st.mode & 0o7777).toString(8)} ${st.gid}`;
        });
    const before = seen();
    const refused = "[error] `post.html` could not be captured: the render's scratch folder could not be made.";
    const runEnds = () =>
      removeRunPageCaptures(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-1", runId: run });
    const stamp = "2026-10-07T12:00:00.000Z";
    await keptDelivery("VIB-1", stamp, { "post.html": "<p>the page</p>" });

    // A link where `.captures/` itself goes.
    symlinkSync(elsewhere, scratchRoot());
    await withBrowser("", async () => {
      expect((await ask("post.html", { runId: run })).text).toBe(refused);
      expect((await ask("post.html")).text).toBe(refused);
      await picture("VIB-1", stamp);
    });
    await runEnds();
    // CANARY: make the folders with shareDirWithAgentsOrWarn alone, as the
    // first version did under `workspace/`, and drop the own-directory check
    // from removeCaptureHome and removeRunPageCaptures: `run_ended/` and the
    // run's `cap_earlier/` are removed from the link's target and a new
    // `cap_.../tmp` is made there for the renderer to write.
    expect(seen()).toEqual(before);
    expect(fake.launches()).toEqual([]);
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "post.html", shots: [], error: "the render's scratch folder could not be made" },
    ]);

    // A link one level down: where the run's own folder goes, and where an
    // ended run's folder would be cleared before a render.
    unlinkSync(scratchRoot());
    mkdirSync(scratchRoot());
    symlinkSync(path.join(elsewhere, run), path.join(scratchRoot(), run));
    symlinkSync(path.join(elsewhere, "run_ended"), path.join(scratchRoot(), "run_ended"));
    await withBrowser("", async () => {
      expect((await ask("post.html", { runId: run })).text).toBe(refused);
      // A render for another run goes ahead, past the ended run's link.
      expect((await ask("post.html")).text).toMatch(/^\[done\] `post\.html` as a reader sees it\./);
    });
    await runEnds();
    expect(seen()).toEqual(before);
    expect(readdirSync(path.join(scratchRoot(), "no.run"))).toEqual([expect.stringMatching(/^cap_/)]);
    await stopRun(run);
  });
});
