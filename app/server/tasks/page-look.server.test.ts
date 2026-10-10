import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { listAuditEvents } from "../../../test-support/audit-log";
import { withEnv } from "../../../test-support/env";
import { writeFakeBrowser, type FakeBrowser } from "../../../test-support/fake-browser";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { baseTaskFrontmatter, setupTestStore, writeTask, type TestStore } from "../../../test-support/test-store";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { readTaskSources, resolveTaskSource, writeTaskSource } from "~/server/files/task-sources.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetAgentIsolationForTests } from "~/server/runtimes/agent-isolation.server";
import { keepPageLook } from "./page-look.server";
import { keptLooks } from "./page-looks.server";

/**
 * Ruling 327 at the door both backends call (`keepPageLook`), on a
 * `setupTestStore` root, with the renderer child run for real against the
 * stand-in browser. The page on the web is a loopback server the stand-in is
 * told to reach under a name (`host:` rule), because the door refuses a
 * loopback address by itself.
 */

let ctx: TestDbContext;
let store: TestStore;
let fake: FakeBrowser;

const DEVELOPER: FileActorRef = { kind: "agent", backend: "claude", profileId: "developer", roleHint: "Developer" };

/** The loopback servers that stand in for the web, closed with the file. */
const sites: Server[] = [];
afterAll(() => {
  for (const server of sites) {
    server.closeAllConnections();
    server.close();
  }
});

/** A site on a loopback port of its own, serving `files` by path; resolves
 *  with `127.0.0.1:<port>`, what a `host:` rule maps a name to. */
function site(files: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = files[(req.url ?? "/").split("?")[0] ?? "/"];
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "not found");
    });
    sites.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`));
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
  for (const key of ["VIB-1", "VIB-2"]) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, { stage: "impl", ownerUserId: store.users.arda.id, title: "Build the page" }),
      goal: "A page made to the look of https://look.example/.",
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => {
  resetAgentIsolationForTests();
  ctx.cleanup();
});

const sourcesOf = (key: string) => readTaskSources(store.slug, key, store.dataRoot).sources;
const keep = (input: { taskKey?: string; url?: string; from?: string; actorRef?: FileActorRef }) =>
  keepPageLook(
    store.db,
    { dataRoot: store.dataRoot },
    { projectSlug: store.slug, taskKey: input.taskKey ?? "VIB-1", url: input.url, from: input.from, actorRef: input.actorRef ?? DEVELOPER, runId: null },
  );
const lookAudits = () => listAuditEvents(store.db, { action: "task.page_look.kept" });
const sha256Of = (key: string, id: string) =>
  createHash("sha256").update(readFileSync(resolveTaskSource(store.slug, key, id, store.dataRoot)!.abs)).digest("hex");

/** The reference: longer than two stretches at the desktop width, with
 *  something of each kind of motion the renderer reads. */
const REFERENCE =
  "<h1>The reference</h1><p>fake-height:4500</p>" +
  '<p>fake-animations:[{"name":"drift","target":"div.hero","loops":true,"durationMs":8000},{"name":"rise","target":"h1","loops":false,"durationMs":600}]</p>' +
  '<p>fake-videos:[{"autoplay":true,"loop":true,"playing":true,"width":960,"height":540}]</p>' +
  '<p>fake-sticky:{"what":"header.site","position":"sticky"}</p><p>fake-on-scroll:3</p>' +
  '<p>fake-hover:[{"what":"a.cta","at":[640,420],"changes":["background-color"],"durationMs":150}]</p>';

/** The limit of a case that keeps a look: a real child process and stand-in
 *  browser, four loads, and two screens watched for three seconds each, which
 *  is nine seconds on a quiet machine. */
const REAL_LOOK_MS = 90_000;

describe("ruling 327: a task keeps how a page on the web looked", () => {
  it("pictures the address once, whole at both widths with what moved, keeps it as the sources of one look, answers a second ask with the one kept, and hands the same look to another task", { timeout: REAL_LOOK_MS }, async () => {
    // The first board asked for a page made to the look of a site judged it
    // against the address as it read on the day of each review, and built it
    // from pictures a script of its own took at a width Viberr pictures
    // nothing at. Two reviews had looked at two pages.
    const reference = await site({ "/S3-series": REFERENCE });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(`host:look.example=${reference}`) }, async () => {
      const answer = await keep({ url: "https://look.example/S3-series#pricing" });
      const kept = sourcesOf("VIB-1");
      const at = kept[0]!.look!.at;
      const day = at.slice(0, 10);
      // The address without its fragment, one date for the whole look.
      expect(new Set(kept.map((source) => `${source.look?.url} ${source.look?.at}`))).toEqual(new Set([`https://look.example/S3-series ${at}`]));

      // The whole page at each width, in stretches a model reads, with no gap
      // between them. CANARY: ask the renderer for a stretch and not the
      // whole page and each width keeps its first 2,000 px.
      const stretches = (view: string) =>
        kept.flatMap((source) => (source.look?.part === "stretch" && source.look.view === view ? [[source.look.from, source.look.to, source.look.pageHeight]] : []));
      expect(stretches("desktop")).toEqual([
        [0, 2000, 4500],
        [2000, 4000, 4500],
        [4000, 4500, 4500],
      ]);
      expect(stretches("phone")).toEqual([
        [0, 2000, 4500],
        [2000, 4000, 4500],
        [4000, 4500, 4500],
      ]);
      // Its first screen while it moved: frames whose bytes differ are kept,
      // and the stand-in draws one screen the same at every moment, so each
      // width keeps one.
      const frames = kept.filter((source) => source.look?.part === "frame");
      expect(frames.map((source) => source.look!.view)).toEqual(["desktop", "phone"]);
      // And one note that says where each picture is and what moved, in the
      // renderer's own reading.
      const notes = kept.filter((source) => source.look?.part === "note");
      expect(notes).toHaveLength(1);
      const note = readFileSync(resolveTaskSource(store.slug, "VIB-1", notes[0]!.id, store.dataRoot)!.abs, "utf8");
      expect(note).toContain(`# How https://look.example/S3-series looked on ${day}`);
      expect(note).toContain(
        "- Desktop, 1280 px wide: S1 to S3, the whole page (4,500 px) in 3 pictures.\n" +
          "  - S1: 0 to 2,000 px.\n  - S2: 2,000 to 4,000 px.\n  - S3: 4,000 to 4,500 px.\n",
      );
      expect(note).toContain(
        "- 2 animations were running one second after the page loaded, 1 of them looping without end: `drift` on `div.hero` (loops), `rise` on `h1` (600 ms).",
      );
      expect(note).toContain("- A video 960 by 540 px plays by itself and loops.");
      expect(note).toContain("- A bar stays at the top of the screen while the page scrolls (`header.site`, sticky).");
      expect(note).toContain("- 3 elements began to animate as they were scrolled into view.");
      expect(note).toContain("- Under the pointer, `a.cta` changes its background-color over 150 ms.");

      // The answer names the ids and shows no picture.
      expect(answer).toContain(`[kept] How https://look.example/S3-series looked on ${day} is kept on VIB-1.`);
      expect(answer).toContain("Desktop, 1280 px wide: S1 to S3, the whole page (4,500 px) in 3 pictures.");
      expect(answer).toContain(`Where each picture is and what moved on the page, as measured: ${notes[0]!.id}.`);
      // What a reviewer's approval owes a look at (ruling 329) is this look.
      expect(keptLooks(kept)).toEqual([
        { url: "https://look.example/S3-series", at, stretches: expect.arrayContaining([{ id: "S1", view: "desktop" }]) },
      ]);
      expect(keptLooks(kept)[0]!.stretches).toHaveLength(6);

      // Opened with the network open, at its own address and at both widths.
      // CANARY: render it as a task page and the browser starts behind the
      // proxy that leads nowhere, reaching no site.
      expect(fake.launches().every((launch) => !launch.argv.some((arg) => arg.startsWith("--proxy-server=")))).toBe(true);
      expect(new Set(fake.pages().map((page) => `${page.url} ${page.metrics.width}`))).toEqual(
        new Set(["https://look.example/S3-series 1280", "https://look.example/S3-series 390"]),
      );

      // One look of an address per task: asked again, the one kept answers
      // and the address is not opened a second time. CANARY: picture it again
      // and a second review is held to a page that had changed since the first.
      const launches = fake.launches().length;
      expect(await keep({ url: "https://look.example/S3-series" })).toBe(
        `[noop] VIB-1 already keeps how https://look.example/S3-series looked on ${day} (S1 to S3 and S5 to S7). ` +
          "A result is judged against one look of an address: read that one. `read_task_source` lists every picture of it.",
      );
      expect(fake.launches()).toHaveLength(launches);
      expect(sourcesOf("VIB-1")).toHaveLength(kept.length);

      // Another task of the same work takes the look over: the same bytes
      // under the same date, and nothing is opened for it.
      // VIB-2 keeps a source of its own first, so the look's ids differ there.
      writeTaskSource(
        store.slug,
        "VIB-2",
        { name: "readme.md", data: Buffer.from("# The product"), title: "The product's readme", from: "the repository", by: { backend: "claude", profileId: "developer", roleHint: "Developer" }, runId: null },
        store.dataRoot,
      );
      const taken = await keep({ taskKey: "VIB-2", from: "VIB-1" });
      expect(taken).toContain(
        `[kept] VIB-2 now keeps https://look.example/S3-series as it was pictured on ${day}, taken over from VIB-1: the pictures byte for byte, as S2 to S${kept.length + 1}.`,
      );
      const theirs = sourcesOf("VIB-2").filter((source) => source.look);
      const pictures = (sources: typeof kept) => sources.filter((source) => source.look!.part !== "note").map((source) => [source.look, source.sha256]);
      expect(pictures(theirs)).toEqual(pictures(kept));
      expect(sha256Of("VIB-2", "S2")).toBe(kept[0]!.sha256);
      expect(theirs[0]!.from).toContain("(kept on VIB-1 as S1)");
      // The note says where each picture is by the ids it has on THIS task.
      // CANARY: copy the note byte for byte and VIB-2's note sends its reader
      // to S1 to S3, which on VIB-2 are the readme and two other pictures.
      const adoptedNote = theirs.find((source) => source.look!.part === "note")!;
      const text = readFileSync(resolveTaskSource(store.slug, "VIB-2", adoptedNote.id, store.dataRoot)!.abs, "utf8");
      expect(text).toContain("- Desktop, 1280 px wide: S2 to S4, the whole page (4,500 px) in 3 pictures.\n  - S2: 0 to 2,000 px.");
      expect(text).not.toContain("S1:");
      // Only where the note lists its pictures: the address in its heading
      // holds an `S3` that is no id. CANARY: rename every such token and the
      // heading sends its reader to .../S4-series.
      expect(text.split("\n")[0]).toBe(`# How https://look.example/S3-series looked on ${day}`);
      expect(fake.launches()).toHaveLength(launches);
      // Taken twice, it is already there.
      expect(await keep({ taskKey: "VIB-2", from: "VIB-1" })).toContain("[noop] VIB-2 already keeps what VIB-1 keeps of");

      // Each keep is on the audit record, newest first, with the address,
      // the date and the task it was taken over from. CANARY: drop
      // recordAudit from auditKept.
      expect(lookAudits().map((row) => [row.taskKey, row.details?.url, row.details?.at, row.details?.from])).toEqual([
        ["VIB-2", "https://look.example/S3-series", at, "VIB-1"],
        ["VIB-1", "https://look.example/S3-series", at, null],
      ]);
    });
  });

  it("keeps a long page to twelve stretches a width and says it runs on, and keeps a stretch that looks the same as another once and says where", { timeout: REAL_LOOK_MS }, async () => {
    // The stand-in draws a page in a grey that comes round again after
    // 20,000 px, so the eleventh and twelfth stretches of this one are, to
    // the byte, its first and second: a task keeps no bytes twice (ruling
    // 82), and a look that dropped them without a word claimed a whole page
    // from pictures with a hole in them.
    // CANARY: skip a stretch the task already keeps and say nothing, and the
    // note counts ten pictures as the first 24,000 px of the page.
    const reference = await site({ "/long": "<p>fake-height:25000</p>" });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(`host:look.example=${reference}`) }, async () => {
      const answer = await keep({ url: "https://look.example/long" });
      const kept = sourcesOf("VIB-1");
      const desktop = kept.filter((source) => source.look?.part === "stretch" && source.look.view === "desktop");
      expect(desktop.map((source) => source.look!.from)).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000]);
      const note = readFileSync(resolveTaskSource(store.slug, "VIB-1", kept.at(-1)!.id, store.dataRoot)!.abs, "utf8");
      expect(note).toContain(
        "- Desktop, 1280 px wide: S1 to S10, the first 24,000 px of a page 25,000 px long, in 10 pictures. The page runs on below them. " +
          "2 more stretches look the same as one of them and are kept once.",
      );
      expect(note).toContain("  - 20,000 to 22,000 px: the same as S1, to the byte.\n  - 22,000 to 24,000 px: the same as S2, to the byte.");
      expect(answer).toContain("Desktop, 1280 px wide: S1 to S10, the first 24,000 px of a page 25,000 px long, in 10 pictures.");
    });
  });

  it.each([
    ["a file on disk", { url: "file:///etc/passwd" }, "A look is of a page a browser opens over `http` or `https`."],
    ["this machine by name", { url: "http://localhost:5173/board" }, "A look is of a page on the web, and this address is this machine's or a private network's. A page among the task's files is looked at with `capture_page`."],
    ["this machine by its rooted name", { url: "http://localhost./" }, "A look is of a page on the web, and this address is this machine's or a private network's. A page among the task's files is looked at with `capture_page`."],
    ["a name only this network answers to", { url: "http://viberr:3000/" }, "A look is of a page on the web, and this address is this machine's or a private network's. A page among the task's files is looked at with `capture_page`."],
    ["a private network by address", { url: "http://192.168.1.10/" }, "A look is of a page on the web, and this address is this machine's or a private network's. A page among the task's files is looked at with `capture_page`."],
    ["a password in the address", { url: "https://arda:hunter2@look.example/" }, "`url` holds what reads as a user name, a token or a password. Give the address without it."],
    ["what is not an address", { url: "the retool site" }, "`url` is not an address a browser opens. Give it whole, with `https://`."],
    ["an address and a task at once", { url: "https://look.example/", from: "VIB-2" }, "Give `url` to picture a page, or `from` to take over the look another task keeps: not both."],
    ["neither", {}, "Give `url`, the address of the page to picture, or `from`, a task of this project that keeps one."],
    ["its own task", { from: "VIB-1" }, "VIB-1 is this task: `from` names another task of the project."],
    ["a task that keeps no look", { from: "VIB-2" }, "VIB-2 keeps no look of a page."],
    ["a task the project does not have", { from: "VIB-9" }, "There is no task VIB-9 in this project; `read_board` lists its tasks."],
  ])("refuses %s before anything is opened, and keeps nothing", async (_what, input, why) => {
    // CANARY: drop a check from webAddress or adoptLook and the renderer is
    // started for that ask, or a source is written for it.
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env() }, async () => {
      expect(await keep(input)).toBe(`[noop] ${why} Nothing was kept.`);
      expect(fake.launches()).toEqual([]);
      expect(sourcesOf("VIB-1")).toEqual([]);
      expect(lookAudits()).toEqual([]);
    });
  });

  it("takes over nothing of a look whose pictures are no longer all in the other task's store", async () => {
    // A person took one picture of VIB-1's look out of the store. Copied as
    // it stood, VIB-2 held a note that said "the whole page in 3 pictures"
    // and named ids that are other sources there.
    // CANARY: copy what is there and say nothing of what is not.
    const reference = await site({ "/": "<p>fake-height:4500</p>" });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(`host:look.example=${reference}`) }, async () => {
      await keep({ url: "https://look.example/" });
      unlinkSync(resolveTaskSource(store.slug, "VIB-1", "S2", store.dataRoot)!.abs);
      expect(await keep({ taskKey: "VIB-2", from: "VIB-1" })).toBe(
        "[noop] VIB-1 no longer holds S2 of its look (the picture was taken out of the store), so the look is not whole. Nothing was kept.",
      );
      expect(sourcesOf("VIB-2")).toEqual([]);
    });
  }, REAL_LOOK_MS);

  it("keeps nothing of a look that was pictured only in part", async () => {
    // The browser ends when the page is loaded at the phone's width: the
    // desktop pictures are in hand and the look is half a look. Kept, it
    // answered "the whole page" for one width, a second ask answered
    // "already keeps", and maker and reviewer were held to it for good.
    // CANARY: keep whatever stretches the render returned.
    const reference = await site({ "/": "<p>fake-height:4500</p><p>fake-crash-at:390</p>" });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env(`host:look.example=${reference}`) }, async () => {
      const answer = await keep({ url: "https://look.example/" });
      expect(answer).toBe(
        "[error] https://look.example/ could not be pictured: the browser ended before the page was pictured. Nothing was kept. " +
          "Say in your report that the page could not be opened, and state nothing about its look from memory.",
      );
      expect(sourcesOf("VIB-1")).toEqual([]);
      expect(lookAudits()).toEqual([]);
    });
  });

  it("keeps nothing of a page that could not be opened, and tells the run to say so and state nothing of its look from memory", async () => {
    // Port 9 answers nothing: the address is one nobody is at.
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("host:gone.example=127.0.0.1:9") }, async () => {
      const answer = await keep({ url: "https://gone.example/" });
      // CANARY: keep whatever the render returned and a task holds a look
      // with no picture in it, which a reviewer is then held to.
      expect(answer).toMatch(/^\[error\] https:\/\/gone\.example\/ could not be pictured: .+\. Nothing was kept\. /);
      expect(answer).toContain("Say in your report that the page could not be opened, and state nothing about its look from memory.");
      expect(sourcesOf("VIB-1")).toEqual([]);
      expect(lookAudits()).toEqual([]);
    });
  });
});
