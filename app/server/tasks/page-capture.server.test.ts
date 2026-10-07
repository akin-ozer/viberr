import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../../../test-support/audit-log";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { withEnv } from "../../../test-support/env";
import { writeFakeBrowser, type FakeBrowser } from "../../../test-support/fake-browser";
import { installFakeRuntime, queueFakeRun } from "../../../test-support/fake-runtime";
import { pollUntil } from "../../../test-support/polling";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { Engagement } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keepDelivery, listKeptDeliveries } from "~/server/files/kept-deliveries.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { attachmentNamesSince, imageHeader, writeTaskAttachment } from "~/server/files/task-attachments.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { AGENT_UID_FLOOR, resetAgentIsolationForTests } from "~/server/runtimes/agent-isolation.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { startRun } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { applyAgentCompletionEffects } from "./agent-completion.server";
import { readAgentTaskAttachment } from "./board-read.server";
import { PAGE_CAPTURE_WAIT_MS, requestDeliveryCaptures } from "./page-capture.server";
import { attachTaskFile } from "./task-edits.server";

/**
 * Ruling 691 at the boundary that owns it: a files delivery stamped by the
 * real completion pipeline (`applyAgentCompletionEffects`, so the hook in
 * `recordAgentCompletion` and the bounded wait before the react are both on
 * the path), on a `setupTestStore` root, with the renderer child run for real
 * against the stand-in browser (`test-support/fake-browser.ts`). The seam is
 * production configuration: `VIBERR_BROWSER_EXECUTABLE`, set the way a
 * deployment sets it.
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

/** A board that delivers files: no repository, one deliverer, and (when the
 *  case is about the react) an operator. */
function deployBoard(opts: { operator?: boolean } = {}): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
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
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
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

const attachments = () => taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
const frontmatter = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
const timeline = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline;
const onTask = () => readdirSync(attachments()).filter((name) => !name.startsWith(".")).sort();
const pngOf = (file: string) => imageHeader(readFileSync(file));

let runSeq = 0;
/** A finished run of the writer whose window holds `files`, as a real run's
 *  saves do: stamped with the run's own `finished_at` (a fake run finishes
 *  within the clock tick its start was read on). */
async function finishedRunSaving(files: Record<string, string>): Promise<string> {
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
  const savedAt = new Date(getRun(store.db, started.runId)!.finished_at!);
  mkdirSync(attachments(), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(attachments(), name), text);
    utimesSync(path.join(attachments(), name), savedAt, savedAt);
  }
  return started.runId;
}

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
async function deliver(files: Record<string, string>, mode = ""): Promise<void> {
  const runId = await finishedRunSaving(files);
  await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(mode) }, () => completeDelivery(runId));
}

const captureNote = () => timeline().find((event) => event.title === "Page captures");

describe("a delivered page is pictured (ruling 691)", () => {
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
    // CANARY: delete the requestDeliveryCaptures call after
    // keepStampedDelivery in recordAgentCompletion and no picture, record or
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
      },
    ]);
    // One note, from Viberr, that claims the pictures.
    const notes = timeline().filter((event) => event.title === "Page captures");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "note",
      actor: { kind: "system", systemId: "page-capture" },
      attachments: pictures,
      text:
        "Viberr rendered `notes.md` and `post.html` as a reader sees them, at a desktop width (1,280 px) and a " +
        "phone width (390 px). The pictures are attached and show beside each file on the result.",
    });
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
    expect(readdirSync(path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", ".captures"))).toEqual([]);
    expect(listAuditEvents(store.db, { action: "task.pages.captured" })[0]).toMatchObject({
      taskKey: "VIB-1",
      details: { deliveredAt: stamp, pages: 2, captured: 2, failed: [], more: 0, runsAs: "server" },
    });
  });

  it("the next delivery's pictures replace the last one's, a page it no longer holds loses its picture, and the earlier delivery keeps its own", async () => {
    await deliver({ "post.html": "<p>fake-height:3000</p>", "gone.html": "<p>dropped in the rework</p>" });
    const first = frontmatter().deliveredAt!;
    expect(onTask()).toContain("gone.html.capture-desktop.png");
    // The rework drops one page and shortens the other.
    unlinkSync(path.join(attachments(), "gone.html"));
    await deliver({ "post.html": "<p>fake-height:1500</p>" });
    const second = frontmatter().deliveredAt!;
    expect(second).not.toBe(first);

    // CANARY: drop the unlink of what the last record named and
    // gone.html.capture-desktop.png is still on the task.
    expect(onTask()).toEqual(["post.html", "post.html.capture-desktop.png", "post.html.capture-phone.png"]);
    expect(pngOf(path.join(attachments(), "post.html.capture-desktop.png"))).toMatchObject({ height: 1500 });
    expect(frontmatter().pageCaptures).toMatchObject({ deliveredAt: second, pages: [{ file: "post.html" }] });
    // CANARY: drop the isPageCaptureName filter in keepStampedDelivery and the
    // second kept delivery holds gone.html.capture-desktop.png.
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

  it("renders as the task owner's agent user through the launcher with no secret in its environment, and refuses a task with no owner rather than render as the server", async () => {
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

    await deliver({ "post.html": "<p>the page</p>" });
    // CANARY: pass null for the launch in the delivery job and no line is
    // launched for the child (with isolation on, that is the server
    // rendering a page an agent wrote).
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines.some((line) => line.startsWith("leaked "))).toBe(false);
    const child = lines.find((line) => line.includes("page-capture-child.server.ts"));
    expect(child).toMatch(
      new RegExp(
        `^uid=${AGENT_UID_FLOOR} exec=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ` +
          `script=\\S*app/server/tasks/page-capture-child\\.server\\.ts home=\\S*runtimes/users/${store.users.arda.id}/home$`,
      ),
    );
    // The browser the child started carries none of the server's own either.
    const [launch] = fake.launches();
    expect(Object.keys(launch!.env).filter((name) => /SECRET|ENCRYPTION|^VIBERR_DATA_ROOT$/.test(name))).toEqual([]);
    // It pictured both widths. (Saving them is the store's own writer, which
    // puts the folder in the agent group first; no test host has that group,
    // so the saved pictures are the other cases' to prove.)
    expect(fake.shots().map((shot) => shot.width)).toEqual([1280, 390]);
    expect(listAuditEvents(store.db, { action: "task.pages.captured" })[0]!.details).toMatchObject({
      runsAs: AGENT_UID_FLOOR,
    });

    // No owner: nobody to render it as, and never the server instead.
    writeFileSync(log, "");
    writeDeliveringTask({ ownerUserId: null });
    await deliver({ "orphan.html": "<p>nobody's page</p>" });
    // The delivery is every file on the task (ruling 610), so both pages say it.
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "orphan.html", shots: [], error: "the task has no owner to render it as" },
      { file: "post.html", shots: [], error: "the task has no owner to render it as" },
    ]);
    expect(readFileSync(log, "utf8")).not.toContain("page-capture-child");
    expect(captureNote()!.text).toBe(
      "Viberr could not picture `orphan.html`: the task has no owner to render it as. " +
        "Viberr could not picture `post.html`: the task has no owner to render it as. " +
        "The delivery stands without them, and an agent can look with `capture_page`.",
    );
  });

  it("a page that cannot be pictured is said on the task and leaves the delivery, its kept copy and the other pages as they were", async () => {
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
      },
    ]);
    expect(captureNote()!.text).toBe(
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
    expect(listAuditEvents(store.db, { action: "task.pages.captured" })[0]!.details).toMatchObject({
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
    // The earlier delivery's pictures left the task with its record.
    expect(onTask()).toEqual(["bad.html", "good.html"]);

    // And a server with no browser named at all says nothing on the task.
    const quiet = await finishedRunSaving({ "good.html": "<p>a third time</p>" });
    await completeDelivery(quiet);
    expect(timeline().filter((event) => event.title === "Page captures")).toHaveLength(2);
  });

  it("a render still running after 45 seconds no longer holds the operator, and one past its limit is stopped and said on the task", async () => {
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
    const effects = withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("hang") }, async () => {
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
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", ownerUserId: store.users.arda.id, deliveredAt: other }),
      });
      writeTaskAttachment(store.slug, "VIB-2", "figures.csv", new TextEncoder().encode("a,b\n"), store.dataRoot);
      keepDelivery(store.slug, "VIB-2", other, ["figures.csv"], store.dataRoot);
      await requestDeliveryCaptures(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-2", stamp: other });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(PAGE_CAPTURE_WAIT_MS - 5_000);
      expect(settled).toBe(false);
      // CANARY: await the capture promise without the bound in
      // applyAgentCompletionEffects and the operator's run never starts while
      // the browser hangs.
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(runOp).toHaveBeenCalledTimes(1);
      expect(frontmatter().pageCaptures).toBeUndefined();
      // The job's own limit, 10 s and 25 s a page: the render is stopped.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(frontmatter().pageCaptures).toBeDefined(), { timeout: 15_000 });
    });
    await effects;
    expect(frontmatter().pageCaptures!.pages).toEqual([
      { file: "one.html", shots: [], error: "the render ran past 60 seconds" },
      { file: "two.html", shots: [], error: "the render ran past 60 seconds" },
    ]);
    expect(captureNote()!.text).toContain("Viberr could not picture `one.html`: the render ran past 60 seconds.");
  });

  it("keeps a page capture out of the files a run in flight is credited with", async () => {
    await deliver({ "post.html": "<p>the page</p>" });
    expect(existsSync(path.join(attachments(), "post.html.capture-desktop.png"))).toBe(true);
    // A reviewer's run that started before the render: its window holds the
    // pictures by their time, and must not hold them by name. Claiming one
    // would name the run as its author and, since ruling 587, move
    // `deliveredAt` under the verdict it is about to give.
    // CANARY: drop the isPageCaptureName skip in attachmentNamesSince.
    expect(attachmentNamesSince(store.slug, "VIB-1", "2026-01-01T00:00:00.000Z", store.dataRoot)).toEqual(["post.html"]);
  });
});
