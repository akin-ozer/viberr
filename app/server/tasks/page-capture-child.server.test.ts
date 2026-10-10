import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { writeFakeBrowser, type FakeBrowser } from "../../../test-support/fake-browser";
import { createTempDirs } from "../../../test-support/temp-dirs";

/**
 * Ruling 194, through the real renderer child as a real process: the page
 * server it starts, the article it sets a markdown file as, the flags it
 * starts a browser with and the picture it asks for. The browser is the
 * stand-in executable (`test-support/fake-browser.ts`), which fetches what it
 * is told to open from the child's own page server, so every assertion on a
 * page's bytes is on what a browser was really served. The real Chromium is
 * proved once, in the shipped image (`scripts/check-page-capture.sh`).
 */

const CHILD = path.join(import.meta.dirname, "page-capture-child.server.ts");

const shotSchema = z.object({
  view: z.string(),
  width: z.number(),
  height: z.number(),
  from: z.number(),
  contentHeight: z.number(),
  contentWidth: z.number(),
  scale: z.number(),
  cut: z.boolean(),
  /** The picture's name in the out folder. */
  file: z.string(),
  /** On a frame of a moving view: ms after the screen came into view. */
  moment: z.number().optional(),
});
/** What moves on a page: on every page on the web and every measured one. */
const motionSchema = z.strictObject({
  running: z.array(z.strictObject({ name: z.string(), target: z.string(), durationMs: z.number().nullable(), loops: z.boolean() })),
  runningCount: z.number(),
  videos: z.array(
    z.strictObject({ autoplay: z.boolean(), loop: z.boolean(), playing: z.boolean(), width: z.number(), height: z.number() }),
  ),
  sticky: z.strictObject({ what: z.string(), position: z.enum(["fixed", "sticky"]) }).nullable(),
  onScroll: z.number(),
  hover: z.array(z.strictObject({ what: z.string(), changes: z.array(z.string()), durationMs: z.number().nullable() })),
});
/** How a page measures: on every page of a measured job. */
const measuredSchema = z.strictObject({
  views: z.array(
    z.strictObject({
      view: z.string(),
      faults: z.strictObject({
        ran: z.boolean(),
        why: z.string().nullable(),
        kinds: z.array(
          z.strictObject({
            id: z.string(),
            impact: z.string().nullable(),
            help: z.string(),
            count: z.number(),
            first: z.array(z.string()),
          }),
        ),
        /** How many kinds the engine found: `kinds` is the first twenty. */
        kindsCount: z.number(),
        /** In how many places those kinds are, every kind's added up. */
        elementsCount: z.number(),
        worstContrast: z.strictObject({ ratio: z.number(), text: z.string() }).nullable(),
      }),
      keyboard: z.strictObject({
        /** False when the walk could not be made or did not finish. */
        ran: z.boolean(),
        /** The walk used its last press with a control still not come to. */
        cut: z.boolean(),
        controls: z.number(),
        /** How many of those controls Tab stopped on. */
        stops: z.number(),
        /** Six names at most, and how many there are in all. */
        unreached: z.array(z.string()),
        unreachedCount: z.number(),
        unmarked: z.array(z.string()),
        unmarkedCount: z.number(),
      }),
      reduced: z.strictObject({
        /** False when the page was not read with reduced motion asked for. */
        ran: z.boolean(),
        runningCount: z.number(),
        running: z.array(z.strictObject({ name: z.string(), target: z.string(), loops: z.boolean() })),
        videosPlaying: z.number(),
      }),
    }),
  ),
  weight: z.strictObject({ bytes: z.number(), files: z.number() }),
  loadMs: z.number().nullable(),
  line: z.string(),
});
const reportSchema = z.object({
  pages: z.array(
    z.object({
      file: z.string(),
      shots: z.array(shotSchema),
      ended: z.array(z.object({ view: z.string(), pageHeight: z.number() })),
      /** One per view that carried an act: what it did, or why it could not. */
      acts: z.array(z.object({ view: z.string(), done: z.string().nullable(), error: z.string().nullable() })),
      /** At each view where a part of the page scrolls inside it with more
       *  than a screen out of sight: the one that hides the most, how much
       *  it holds, how tall its own box is, and how many such parts there
       *  are; null when none does. */
      scrollsInside: z
        .array(z.strictObject({ view: z.string(), what: z.string(), height: z.number(), box: z.number(), count: z.number() }))
        .nullable(),
      dialogs: z.number(),
      asked: z.array(z.string()),
      askedCount: z.number(),
      missing: z.array(z.string()),
      error: z.string().nullable(),
      motion: motionSchema.optional(),
      measured: measuredSchema.optional(),
    }),
  ),
});
type Report = z.infer<typeof reportSchema>;

interface View {
  id: string;
  width: number;
  height: number;
  maxHeight: number;
  mobile: boolean;
  from: number;
  box?: { scale: number };
  whole?: boolean;
  stretches?: number;
  reduce?: boolean;
  act?: { tab?: number; press?: string; hover?: string };
  moving?: boolean;
}

/** A page on the web, as a job names one: the label its report carries and
 *  the address to open. */
interface WebPage {
  file: string;
  url?: string;
}

const DESKTOP: View = { id: "desktop", width: 1280, height: 800, maxHeight: 4800, mobile: false, from: 0 };
const PHONE: View = { id: "phone", width: 390, height: 844, maxHeight: 5064, mobile: true, from: 0 };
/** A picture of an exact size, as the server asks for one. */
const box = (width: number, height: number, scale: number): View => ({
  id: "desktop",
  width,
  height,
  maxHeight: height,
  mobile: false,
  from: 0,
  box: { scale },
});

const temp = createTempDirs();
afterAll(temp.cleanup);

interface Bench {
  /** The folder the pages are served from. */
  root: string;
  out: string;
  browser: FakeBrowser;
  run(input: {
    /** Task files, by name. */
    pages: string[];
    /** Pages on the web, after the task files. */
    web?: WebPage[];
    views?: View[];
    mode?: string;
    pageTimeoutMs?: number;
    maxBytes?: number;
    /** Measure each page too. */
    measure?: boolean;
    /** The accessibility engine's script, by its path. */
    axe?: string;
  }): Promise<Report>;
}

/** A fresh folder of task files and a fresh stand-in browser. */
function bench(files: Record<string, string>): Bench {
  const dir = temp.make("viberr-capture-child-");
  const root = path.join(dir, "files");
  const out = path.join(dir, "out");
  mkdirSync(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
  const browser = writeFakeBrowser(path.join(dir, "browser"));
  return {
    root,
    out,
    browser,
    run(input) {
      const job = {
        root,
        out,
        profile: path.join(dir, "profile"),
        browser: browser.executable,
        pages: [
          ...input.pages.map((file) => ({
            file,
            kind: file.endsWith(".md") ? "markdown" : file.endsWith(".svg") ? "svg" : "html",
          })),
          ...(input.web ?? []).map((page) => ({ ...page, kind: "web" })),
        ],
        views: input.views ?? [DESKTOP, PHONE],
        pageTimeoutMs: input.pageTimeoutMs ?? 20_000,
        maxBytes: input.maxBytes ?? 3_750_000,
        measure: input.measure,
        axe: input.axe,
      };
      return new Promise((resolve, reject) => {
        // The job goes in on the child's standard input, as the server
        // hands it over.
        const child = spawn(process.execPath, [CHILD], {
          env: { ...process.env, ...browser.env(input.mode ?? "") },
          stdio: ["pipe", "ignore", "pipe"],
        });
        child.stdin.end(JSON.stringify(job));
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
          const report = path.join(out, "report.json");
          if (code !== 0 || !existsSync(report)) {
            reject(new Error(`the child ended with ${code}: ${stderr}`));
            return;
          }
          // A report the suite cannot read fails the test at once: thrown
          // from this handler it would leave the promise open until the
          // test's own timeout.
          try {
            resolve(reportSchema.parse(JSON.parse(readFileSync(report, "utf8"))));
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  };
}

/** The loopback servers a test stands in for the web with, closed with the
 *  file. */
const sites: Server[] = [];
afterAll(() => {
  for (const server of sites) {
    server.closeAllConnections();
    server.close();
  }
});

/** A site on a loopback port of its own, serving `files` by path. `{origin}`
 *  in a file is the site's own origin, which a page cannot know until its
 *  server is up. `close` takes the site down, so nothing answers there. */
function site(files: Record<string, string>): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    let origin = "";
    const server = createServer((req, res) => {
      const body = files[(req.url ?? "/").split("?")[0] ?? "/"];
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
      res.end(body === undefined ? "not found" : body.replaceAll("{origin}", origin));
    });
    sites.push(server);
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
      resolve({ origin, close: () => new Promise((closed) => server.close(() => closed())) });
    });
  });
}

/** A PNG's own width and height, from its header. */
function pngSize(file: string) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the page capture's renderer child (ruling 194)", () => {
  it("sets a markdown file as an article page: a table, a code block and a sibling picture render, and raw HTML stays text", async () => {
    const b = bench({
      "notes.md":
        "# Estimate\n\n| Item | Cost |\n|---|---|\n| EC2 | $12 |\n\n```sh\necho hi\n```\n\n![chart](chart.png)\n\n<script>alert(1)</script>\n",
      "chart.png": "not really a picture, but served as one",
    });
    const report = await b.run({ pages: ["notes.md"], views: [DESKTOP] });
    expect(report.pages[0]).toMatchObject({ file: "notes.md", error: null, missing: [] });
    const [served] = b.browser.pages();
    // CANARY: render without remarkGfm and the table arrives as a paragraph
    // of pipes.
    expect(served!.html).toContain("<table>");
    expect(served!.html).toContain("<th>Item</th>");
    expect(served!.html).toContain('<pre><code class="language-sh">echo hi');
    // No raw HTML: a document's own markup is shown, never run.
    expect(served!.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(served!.html).not.toContain("<script>");
    // The article is a page of its own, set in the stylesheet, at a phone's
    // width too.
    expect(served!.html).toContain("<title>notes.md</title>");
    expect(served!.html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(served!.html).toContain("max-width: 70ch");
    // The picture beside it is answered by the page server, as a picture.
    expect(served!.html).toContain('<img src="chart.png" alt="chart"/>');
    expect(served!.resources).toEqual([{ src: "chart.png", status: 200, bytes: 39 }]);
  });

  it("serves a page only its own task files, refusing a symlink, a nested path and a dot name, and starts the browser with every flag that closes the network to it", async () => {
    const b = bench({
      "page.html":
        '<img src="chart.png"><img src="linked.png"><img src="sub/inner.png"><img src=".hidden.png"><img src="https://cdn.example.com/lib.js">',
      "chart.png": "picture",
      ".hidden.png": "a dot name is never a task file",
      ".draft.html": "<p>a dot name is never a page either</p>",
    });
    const outside = path.join(path.dirname(b.root), "outside.png");
    writeFileSync(outside, "a file outside the task");
    symlinkSync(outside, path.join(b.root, "linked.png"));
    mkdirSync(path.join(b.root, "sub"));
    writeFileSync(path.join(b.root, "sub", "inner.png"), "nested");

    // A page that is itself a link is not pictured at all. CANARY: drop the
    // open before the browser starts and the picture is of the page server's
    // "not found".
    symlinkSync(outside, path.join(b.root, "linked.html"));
    const report = await b.run({ pages: ["page.html", "linked.html", ".draft.html"], views: [DESKTOP] });
    expect(report.pages[1]).toMatchObject({ file: "linked.html", shots: [], error: "the file is not there to render" });
    // Nor is a page the page server would not answer: every reader hides a
    // dot name. CANARY: open the page without asking `servable` first and
    // `.draft.html` comes back pictured, error null, as the words "not found".
    expect(report.pages[2]).toMatchObject({ file: ".draft.html", shots: [], error: "the file is not there to render" });
    const [served] = b.browser.pages();
    // CANARY: open files without O_NOFOLLOW and the symlinked file is served.
    expect(served!.resources).toEqual([
      { src: "chart.png", status: 200, bytes: 7 },
      { src: "linked.png", status: 404, bytes: 10 },
      { src: "sub/inner.png", status: 404, bytes: 10 },
      { src: ".hidden.png", status: 404, bytes: 10 },
      { src: "https://cdn.example.com/lib.js", status: null },
    ]);
    // The page may use itself and nothing else, and what it asked for is said.
    expect(served!.headers["content-security-policy"]).toBe(
      "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
    );
    expect(report.pages[0]).toMatchObject({
      error: null,
      asked: ["cdn.example.com"],
      askedCount: 1,
      missing: ["linked.png", "sub/inner.png", ".hidden.png"],
    });
    // Every path is under a token nobody else on the host can guess.
    const address = new URL(served!.url);
    expect(address.hostname).toBe("127.0.0.1");
    expect(address.pathname).toMatch(/^\/[0-9a-f]{16}\/page\.html$/);

    // One browser, for the one page there was to picture.
    expect(b.browser.launches()).toHaveLength(1);
    const [launch] = b.browser.launches();
    // The flags a browser is started with, which is all a stand-in can show:
    // that a real one then loads nothing but the page server's answers is the
    // in-image check's to prove (`scripts/check-page-capture.sh`, run by the
    // e2e job). CANARY: drop any one of them from `browserArgs`.
    expect(launch!.argv).toEqual(
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-sandbox",
        "--proxy-server=http://127.0.0.1:9",
        // Loopback is proxied too, so the app's own port is as closed as any
        // other host; only the page server is let through.
        `--proxy-bypass-list=<-loopback>;127.0.0.1:${address.port}`,
        // A peer connection would send UDP past the proxy.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        // No system keyring to wait on before the first request.
        "--password-store=basic",
        "--use-mock-keychain",
        `--user-data-dir=${path.join(path.dirname(b.root), "profile", "1")}`,
      ]),
    );
  });

  it("reports what a page asked for by a path it is never served: from the site's root, above its own folder, or under a name with a broken escape", async () => {
    const b = bench({
      "post.html":
        '<script src="/css/site.js"></script><img src="/images/hero.png"><img src="../up.png">' +
        '<img src="%E0%A4%A.png"><img src="/favicon.ico"><img src="chart.png">',
      "chart.png": "picture",
    });
    const report = await b.run({ pages: ["post.html"], views: [DESKTOP] });
    // Each is answered "not found", like any other path outside the token.
    expect(b.browser.pages()[0]!.resources.map((resource) => [resource.src, resource.status])).toEqual([
      ["/css/site.js", 404],
      ["/images/hero.png", 404],
      ["../up.png", 404],
      ["%E0%A4%A.png", 404],
      ["/favicon.ico", 404],
      ["chart.png", 200],
    ]);
    // CANARY: refuse a path outside the token prefix, or a name that will
    // not decode, before it is recorded, as the first version did, and
    // `missing` is empty for a page pictured unstyled with broken pictures.
    // Record `/favicon.ico` too and every page a browser asks an icon for
    // is said to have asked for one.
    expect(report.pages[0]).toMatchObject({
      error: null,
      missing: ["/css/site.js", "/images/hero.png", "/up.png", "%E0%A4%A.png"],
    });
  });

  it("pictures the whole page up to the cap and never less than one screen, and marks a longer page as cut", async () => {
    const b = bench({
      "short.html": "<p>one line</p>",
      "long.html": "<p>fake-height:3000</p>",
      "endless.html": "<p>fake-height:20000</p>",
    });
    const report = await b.run({ pages: ["short.html", "long.html", "endless.html"] });
    const sizes = report.pages.map((page) => page.shots.map((s) => [s.view, s.width, s.height, s.contentHeight, s.cut]));
    // CANARY: clip to the viewport height and a 3,000 px page comes back
    // 800 px tall and not cut.
    expect(sizes).toEqual([
      [
        ["desktop", 1280, 800, 800, false],
        ["phone", 390, 844, 844, false],
      ],
      [
        ["desktop", 1280, 3000, 3000, false],
        ["phone", 390, 3000, 3000, false],
      ],
      [
        ["desktop", 1280, 4800, 20000, true],
        ["phone", 390, 5064, 20000, true],
      ],
    ]);
    expect(pngSize(path.join(b.out, "3-phone.png"))).toEqual({ width: 390, height: 5064 });
    // Each view loads the page at its own viewport, at one picture px to a
    // CSS px: a stretch is what a reader's screen shows.
    expect(b.browser.pages().slice(0, 2).map((page) => page.metrics)).toEqual([
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    ]);

    // A stretch for an agent: from 2,000 px down, at most 2,000 px tall.
    const stretch = bench({ "long.html": "<p>fake-height:5000</p>", "wide.html": "<p>fake-scale:0.5 fake-width:390</p>" });
    const second = await stretch.run({
      pages: ["long.html"],
      views: [{ ...DESKTOP, maxHeight: 2000, from: 2000 }],
    });
    expect(second.pages[0]!.shots).toEqual([
      {
        view: "desktop",
        width: 1280,
        height: 2000,
        from: 2000,
        contentHeight: 5000,
        contentWidth: 1280,
        scale: 1,
        cut: true,
        file: "1-desktop.png",
      },
    ]);
    expect(stretch.browser.shots()[0]!.clip).toEqual({ x: 0, y: 2000, width: 1280, height: 2000, scale: 1 });
    const last = await stretch.run({ pages: ["long.html"], views: [{ ...DESKTOP, maxHeight: 2000, from: 4000 }] });
    expect(last.pages[0]!.shots[0]).toMatchObject({ height: 1000, from: 4000, cut: false });

    // A phone lays a page out taller than a desktop does, so a stretch may
    // start past one layout's end and inside the other's. That width is said
    // to have ended and the other is still pictured. CANARY: fail the page
    // at the first width with nothing at `from` and the phone is never loaded.
    const uneven = bench({ "short.html": "<p>one screen: 800 px on a desktop, 844 on a phone</p>" });
    const tool = (from: number) => [
      { ...DESKTOP, maxHeight: 2000, from },
      { ...PHONE, maxHeight: 2000, from },
    ];
    const between = await uneven.run({ pages: ["short.html"], views: tool(820) });
    expect(between.pages[0]).toMatchObject({
      error: null,
      ended: [{ view: "desktop", pageHeight: 800 }],
      shots: [{ view: "phone", from: 820, height: 24, cut: false }],
    });
    expect(uneven.browser.pages().map((page) => page.metrics.width)).toEqual([1280, 390]);
    // Past the end at every width is the only case that is the page's own
    // failure, and it names each width with where the page ends there.
    const past = await uneven.run({ pages: ["short.html"], views: tool(5000) });
    expect(past.pages[0]).toMatchObject({
      shots: [],
      ended: [
        { view: "desktop", pageHeight: 800 },
        { view: "phone", pageHeight: 844 },
      ],
      error:
        "the page ends at 800 px at the desktop width (1280 px) and at 844 px at the phone width (390 px), " +
        "so nothing starts at 5,000 px",
    });

    // A phone shrinks a page it lays out wider than its screen: the picture
    // is what the screen shows, the whole width at the phone's own 390 px.
    const shrunk = await stretch.run({ pages: ["wide.html"], views: [PHONE] });
    expect(shrunk.pages[0]!.shots[0]).toMatchObject({ width: 390, height: 844, contentWidth: 390, scale: 0.5, cut: false });
    expect(stretch.browser.shots().at(-1)!.clip).toEqual({ x: 0, y: 0, width: 780, height: 1688, scale: 0.5 });
  });

  it("takes a shorter picture when the full one is too large for an agent to be handed", async () => {
    const b = bench({ "heavy.html": "<p>fake-height:4800</p>" });
    // The stand-in's pictures weigh 1,000 bytes per px of height here.
    const report = await b.run({ pages: ["heavy.html"], views: [DESKTOP], mode: "big", maxBytes: 2_000_000 });
    // CANARY: remove the retry loop and the report carries an error where a
    // shorter picture was possible.
    expect(report.pages[0]).toMatchObject({ error: null });
    expect(report.pages[0]!.shots[0]).toMatchObject({ height: 1200, contentHeight: 4800, cut: true });
    expect(b.browser.shots().map((shot) => shot.height)).toEqual([4800, 2400, 1200]);
    expect(pngSize(path.join(b.out, "1-desktop.png")).height).toBe(1200);

    // One screen is the floor: a picture still too large there is not kept.
    const floor = await b.run({ pages: ["heavy.html"], views: [DESKTOP], mode: "big", maxBytes: 500_000 });
    expect(floor.pages[0]).toMatchObject({
      shots: [],
      error: "the picture of one screen of it is too large to keep",
    });
  });

  it("pictures a box of an exact size once: laid out in a viewport that is the box, drawn at the device scale asked for, cut to the box and never retaken smaller", async () => {
    const b = bench({
      "cover.html": "<p>a cover that fits its box</p>",
      "long.html": "<p>a layout that does not fit: fake-height:900 fake-width:1400</p>",
    });
    // Ruling 194.
    const twice = await b.run({ pages: ["cover.html"], views: [box(1200, 630, 2)] });
    expect(twice.pages[0]).toMatchObject({
      error: null,
      // The page's size is in the box's own CSS px, whatever it was drawn at.
      shots: [
        {
          view: "desktop",
          width: 2400,
          height: 1260,
          from: 0,
          contentHeight: 630,
          contentWidth: 1200,
          scale: 1,
          cut: false,
          file: "1-desktop.png",
        },
      ],
    });
    expect(pngSize(path.join(b.out, "1-desktop.png"))).toEqual({ width: 2400, height: 1260 });
    // The page itself is loaded at device scale 2, so what it draws by its
    // own `devicePixelRatio` (a canvas, a `srcset`) is drawn at 2x. CANARY:
    // leave the device scale at 1 and scale the screenshot instead
    // (`deviceScaleFactor: 1`, `clip.scale: 2`): the PNG is the same size and
    // the page was told it is on a 1x screen.
    expect(b.browser.pages()[0]!.metrics).toEqual({ width: 1200, height: 630, deviceScaleFactor: 2, mobile: false });
    expect(b.browser.shots()[0]!.clip).toEqual({ x: 0, y: 0, width: 1200, height: 630, scale: 1 });

    // Under 1 the page is still drawn for a 1x screen and the picture of it
    // is scaled down, as a thumbnail is. Each side is rounded by itself.
    // CANARY: hand the browser the scale as the device scale whatever it is
    // and this page is told it is on a 0.5x screen.
    const half = await b.run({ pages: ["cover.html"], views: [box(1201, 631, 0.5)] });
    expect(half.pages[0]!.shots).toEqual([
      {
        view: "desktop",
        width: 601,
        height: 316,
        from: 0,
        contentHeight: 631,
        contentWidth: 1201,
        scale: 1,
        cut: false,
        file: "1-desktop.png",
      },
    ]);
    expect(b.browser.pages().at(-1)!.metrics).toEqual({ width: 1201, height: 631, deviceScaleFactor: 1, mobile: false });
    expect(b.browser.shots().at(-1)!.clip).toEqual({ x: 0, y: 0, width: 1201, height: 631, scale: 0.5 });

    // A layout taller and wider than the box is cut to the box, and the
    // report says how large it is: that is how its author learns it does not
    // fit. CANARY: picture a box as a stretch is pictured (drop the `box` arm
    // of `pictureView`) and this comes back 900 px tall.
    const long = await b.run({ pages: ["long.html"], views: [box(1200, 630, 1)] });
    expect(long.pages[0]!.shots).toEqual([
      {
        view: "desktop",
        width: 1200,
        height: 630,
        from: 0,
        contentHeight: 900,
        contentWidth: 1400,
        scale: 1,
        cut: true,
        file: "1-desktop.png",
      },
    ]);
    expect(b.browser.shots().at(-1)!.clip).toEqual({ x: 0, y: 0, width: 1200, height: 630, scale: 1 });

    // A box has one size, so a picture too large to hand back is said and
    // not retaken shorter: one screenshot, and a reason that names the way
    // out. The stand-in's pictures weigh 1,000 bytes per px of height here.
    // CANARY: send a box through the stretch's retry loop and the reason is
    // "the picture of one screen of it is too large to keep", which tells
    // the run nothing it can change.
    const taken = b.browser.shots().length;
    const heavy = await b.run({ pages: ["cover.html"], views: [box(400, 300, 1)], mode: "big", maxBytes: 200_000 });
    expect(heavy.pages[0]!.shots).toEqual([]);
    expect(heavy.pages[0]!.error).toMatch(
      /^the picture is 30\d,\d{3} bytes, over the 200,000 a capture hands back; lower the scale or simplify the picture$/,
    );
    expect(b.browser.shots()).toHaveLength(taken + 1);
  });

  it("sets an SVG drawing as a page that holds nothing but the drawing, inline, so a file saved beside it is still served by name", async () => {
    const drawing =
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">' +
      '<foreignObject width="200" height="100"><img src="logo.png"/></foreignObject><text y="40">Q3 &amp; Q4</text></svg>\n';
    // Saved with a byte order mark, as some editors save one.
    const b = bench({ "diagram.svg": `\uFEFF${drawing}`, "logo.png": "the logo" });
    const report = await b.run({ pages: ["diagram.svg"], views: [box(1200, 630, 1)] });
    expect(report.pages[0]).toMatchObject({ file: "diagram.svg", error: null, missing: [] });
    expect(report.pages[0]!.shots).toHaveLength(1);
    const [served] = b.browser.pages();
    // CANARY: open the drawing at its own address, or leave `svg` out of the
    // kinds that are set as a page, and the browser is sent to `diagram.svg`:
    // a drawing opened by itself is laid out by the window, not by a page
    // whose margins and box are known.
    expect(new URL(served!.url).pathname).toMatch(/^\/[0-9a-f]{16}\/\.viberr-render\.html$/);
    // The drawing's own markup, whole and inline, in a page named for it.
    expect(served!.html).toContain(`<body>\n${drawing}\n</body>`);
    expect(served!.html).toContain("<title>diagram.svg</title>");
    // CANARY: set the source as it was read and the mark is text ahead of
    // the drawing, a line of its own that moves it down.
    expect(served!.html).not.toContain("\uFEFF");
    // Served from the folder the drawing is in, so the name beside it is the
    // file beside it. What the page's own few rules do to a drawing (no
    // margin, no text line under it, a percent height) only a real browser
    // shows: `scripts/check-page-capture.sh` pictures one in the image.
    expect(served!.resources).toEqual([{ src: "logo.png", status: 200, bytes: 8 }]);
  });

  it("dismisses a dialog a page opens while it loads, pictures the page behind it, and says the page opened one", async () => {
    const b = bench({ "alert.html": "<script>alert(\"Welcome\")</script><p>the page behind it</p>" });
    // The stand-in finishes this load only once its dialog is answered, as a
    // page stopped on `alert()` does. CANARY: drop the
    // `Page.javascriptDialogOpening` arm of the session listener and the page
    // waits on its dialog until "the render ran past 3 seconds".
    const report = await b.run({ pages: ["alert.html"], mode: "dialog:alert.html", pageTimeoutMs: 3_000 });
    expect(report.pages[0]).toMatchObject({ file: "alert.html", error: null, dialogs: 2 });
    expect(report.pages[0]!.shots.map((shot) => shot.view)).toEqual(["desktop", "phone"]);
    // Dismissed, once per load: nobody is there to press OK.
    expect(b.browser.dialogs()).toEqual([
      { type: "alert", accept: false },
      { type: "alert", accept: false },
    ]);
  });

  it("accepts the question a page asks before the browser leaves it, so the next width still loads, and counts it as no dialog of the page's", async () => {
    // A page with a `beforeunload` handler holds the browser on itself until
    // somebody answers, and the second width is a second load of the page.
    // The stand-in starts that load only once the question is accepted.
    // CANARY: dismiss it like any other dialog (`accept: false`) and the
    // phone's load never starts: one picture, and "the render ran past 2
    // seconds".
    const b = bench({ "form.html": "<p>a form that asks before you leave it</p>" });
    const report = await b.run({ pages: ["form.html"], mode: "unload:form.html", pageTimeoutMs: 1_500 });
    expect(report.pages[0]).toMatchObject({ file: "form.html", error: null, dialogs: 0 });
    expect(report.pages[0]!.shots.map((shot) => shot.view)).toEqual(["desktop", "phone"]);
    // Asked once, on the way to the second width, and accepted.
    expect(b.browser.dialogs()).toEqual([{ type: "beforeunload", accept: true }]);
  });

  it("finds a page and the file beside it in whichever Unicode form they are stored", async () => {
    // Ruling 76's rule in the renderer's own process: a file uploaded from a
    // Mac may be stored decomposed, and a page names its picture the way its
    // author typed it. CANARY: open every name with `openRegular` alone and,
    // on a file system that holds names byte for byte (the image's), the
    // page is "not there to render" and its picture is reported missing. A
    // file system that folds the two forms together (APFS, on a developer's
    // Mac) finds both files either way, so this case cannot go red there.
    const decomposed = (name: string) => name.normalize("NFD");
    const b = bench({
      [decomposed("Özet.html")]: `<img src="${"Şema.png".normalize("NFC")}"><p>summary</p>`,
      [decomposed("Şema.png")]: "the diagram",
    });
    const report = await b.run({ pages: ["Özet.html".normalize("NFC")], views: [DESKTOP] });
    expect(report.pages[0]).toMatchObject({ error: null, missing: [] });
    expect(report.pages[0]!.shots).toHaveLength(1);
    expect(b.browser.pages()[0]!.resources).toEqual([{ src: "Şema.png".normalize("NFC"), status: 200, bytes: 11 }]);
  });

  it("stops a page at its timeout and still pictures the next one", async () => {
    const b = bench({ "slow.html": "<p>never finishes loading</p>", "next.html": "<p>fine</p>", "dead.html": "<p>x</p>" });
    // CANARY: never arm the page timer and this test runs into its own
    // timeout (the stand-in never answers the load of slow.html).
    const report = await b.run({
      pages: ["slow.html", "dead.html", "next.html"],
      views: [DESKTOP],
      mode: "hang:slow.html,crash:dead.html",
      pageTimeoutMs: 1_500,
    });
    expect(report.pages.map((page) => [page.file, page.error, page.shots.length])).toEqual([
      ["slow.html", "the render ran past 2 seconds", 0],
      ["dead.html", "the browser ended before the page was pictured", 0],
      ["next.html", null, 1],
    ]);
    // A browser of its own per page: the one that hung was not reused.
    expect(b.browser.launches()).toHaveLength(3);
    expect(new Set(b.browser.launches().map((launch) => launch.argv.find((arg) => arg.startsWith("--user-data-dir=")))).size).toBe(3);
  });

  it("asks a page for reduced motion before it loads at a view that carries `reduce`, and for no preference at one that does not, so one view's setting never reaches the next", async () => {
    const b = bench({ "page.html": "<p>a page that moves</p>" });
    const report = await b.run({ pages: ["page.html"], views: [{ ...DESKTOP, reduce: true }, PHONE] });
    expect(report.pages[0]).toMatchObject({ error: null });
    expect(report.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-desktop.png", "1-phone.png"]);
    // What each load had been told when it started. CANARY: tell the browser
    // after `Page.navigate` and the desktop's load is under "" (a page reads
    // the preference as it loads). Leave a view without `reduce` alone and
    // the phone is loaded under the desktop's "reduce".
    expect(b.browser.pages().map((page) => [page.metrics.width, page.reducedMotion])).toEqual([
      [1280, "reduce"],
      [390, "no-preference"],
    ]);
  });

  it("does what a view's act says with real key and pointer events, gives what that started its time, and pictures the screen where the window then stands", async () => {
    const b = bench({
      "page.html": [
        "<p>fake-height:3000</p>",
        '<p>fake-find:{"Menu":[120,40,"button"],"Docs":[300,60,"link"]}</p>',
        '<p>fake-controls:[["a","Docs"],["a","Blog"],["a","Pricing"]]</p>',
        "<p>fake-tab-order:[0,1,2]</p>",
        // A pressed or focused control may be further down: the window
        // follows it.
        "<p>fake-scrolled:340</p>",
      ].join("\n"),
    });
    const report = await b.run({
      pages: ["page.html"],
      views: [
        DESKTOP,
        // One id, another kind: the act's picture has a name of its own.
        { ...DESKTOP, act: { press: "Menu" } },
        { ...DESKTOP, id: "keys", act: { tab: 3 } },
        { ...PHONE, act: { hover: "Docs" } },
      ],
    });
    expect(report.pages[0]).toMatchObject({
      error: null,
      acts: [
        { view: "desktop", done: 'pressed button "Menu"', error: null },
        { view: "keys", done: '3 presses of Tab: focus is on link "Pricing"', error: null },
        { view: "phone", done: 'the pointer is on link "Docs"', error: null },
      ],
    });
    // One screen each, starting where the window was left, in a file named
    // for the act. CANARY: picture an act as a stretch from the view's `from`
    // and each comes back 3,000 px tall from the top, the menu out of sight.
    expect(report.pages[0]!.shots.map((shot) => [shot.file, shot.from, shot.height, shot.cut])).toEqual([
      ["1-desktop.png", 0, 3000, false],
      ["1-desktop-a.png", 340, 800, true],
      ["1-keys-a.png", 340, 800, true],
      ["1-phone-a.png", 0, 844, true],
    ]);
    expect(pngSize(path.join(b.out, "1-desktop-a.png"))).toEqual({ width: 1280, height: 800 });
    expect(b.browser.shots().slice(1).map((shot) => shot.clip)).toEqual([
      { x: 0, y: 340, width: 1280, height: 800, scale: 1 },
      { x: 0, y: 340, width: 1280, height: 800, scale: 1 },
      { x: 0, y: 0, width: 390, height: 844, scale: 1 },
    ]);
    // Real events, at the centre the page gave for the control. CANARY: leave
    // `mousePressed` out and a real page's menu never opens; send Tab as a
    // lone `keyUp` and focus never moves (the stand-in moves it on the key
    // going down, as Chromium does).
    const tab = { method: "Input.dispatchKeyEvent", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
    expect(b.browser.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 120, y: 40 },
      { method: "Input.dispatchMouseEvent", type: "mousePressed", x: 120, y: 40, button: "left", clickCount: 1 },
      { method: "Input.dispatchMouseEvent", type: "mouseReleased", x: 120, y: 40, button: "left", clickCount: 1 },
      { ...tab, type: "rawKeyDown" },
      { ...tab, type: "keyUp" },
      { ...tab, type: "rawKeyDown" },
      { ...tab, type: "keyUp" },
      { ...tab, type: "rawKeyDown" },
      { ...tab, type: "keyUp" },
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 300, y: 60 },
    ]);
    // What the act started gets its time before the picture: a menu's
    // transition, a focus ring's. CANARY: picture at once and each of these
    // is a few ms.
    const [pressed, tabbed, hovered] = b.browser.shots().slice(1).map((shot) => shot.sinceInputMs);
    expect(pressed).toBeGreaterThanOrEqual(700);
    expect(tabbed).toBeGreaterThanOrEqual(400);
    expect(hovered).toBeGreaterThanOrEqual(400);
  });

  it("keeps an act that cannot be done as that view's own outcome: no picture, the reason with what the controls there are called, and the page's other views still pictured", async () => {
    const names = ["Docs", "Sign in", "A control whose name runs past the forty characters a list keeps", ...Array.from({ length: 11 }, (_, at) => `Link ${at + 4}`)];
    const b = bench({
      "page.html": [
        `<p>fake-names:${JSON.stringify(names)}</p>`,
        // A link to another site: pressed, it takes the browser off the page.
        '<p>fake-find:{"Away":[300,200,"link","chrome-error://chromewebdata/"]}</p>',
      ].join("\n"),
    });
    const report = await b.run({
      pages: ["page.html"],
      views: [
        { ...DESKTOP, id: "menu", act: { press: "Menu" } },
        { ...DESKTOP, id: "away", act: { press: "Away" } },
        { ...DESKTOP, id: "far", act: { tab: 500 } },
        PHONE,
      ],
    });
    // CANARY: let an act's failure reject the page's work, as a failed load
    // does, and the page carries the reason as its own `error` with the
    // phone never pictured.
    expect(report.pages[0]).toMatchObject({
      error: null,
      acts: [
        {
          view: "menu",
          done: null,
          // Twelve names at most, each cut at forty characters, and a mark
          // that there are more.
          error:
            'nothing at this width is called "Menu". The controls on it: "Docs", "Sign in", ' +
            '"A control whose name runs past the forty", "Link 4", "Link 5", "Link 6", "Link 7", "Link 8", "Link 9", ' +
            '"Link 10", "Link 11", "Link 12", ...',
        },
        // CANARY: picture the screen without asking where the press left the
        // browser and this is a picture of the browser's own error page.
        { view: "away", done: null, error: "the press sent the browser to another address" },
        // CANARY: press Tab as often as asked, whatever the number, and five
        // hundred presses are made out of the page's own time.
        { view: "far", done: null, error: "an act presses Tab at most 80 times" },
      ],
    });
    expect(b.browser.inputs().filter((input) => input.method === "Input.dispatchKeyEvent")).toEqual([]);
    expect(report.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-phone.png"]);
    expect(existsSync(path.join(b.out, "1-menu-a.png"))).toBe(false);
  });

  it("pictures a whole page in stretches from `from` to its end: each starts where the one before ended and is retaken shorter by itself, at most as many as asked, and only the last says the page runs on", async () => {
    const b = bench({ "long.html": "<p>fake-height:9000</p>" });
    const stretches = (report: Report) => report.pages[0]!.shots.map((shot) => [shot.file, shot.from, shot.height, shot.cut]);

    // To the page's end, which here comes before the third stretch asked for.
    const whole = await b.run({ pages: ["long.html"], views: [{ ...DESKTOP, whole: true, stretches: 3 }, PHONE] });
    expect(whole.pages[0]).toMatchObject({ error: null, ended: [] });
    // CANARY: say `cut` on every stretch with more page below it and the
    // first of these says so, though the second carries the page on.
    expect(stretches(whole)).toEqual([
      ["1-desktop.png", 0, 4800, false],
      ["1-desktop-s2.png", 4800, 4200, false],
      // A view without `whole` beside it is one stretch, as ever.
      ["1-phone.png", 0, 5064, true],
    ]);
    expect(pngSize(path.join(b.out, "1-desktop-s2.png"))).toEqual({ width: 1280, height: 4200 });
    expect(b.browser.shots().slice(0, 2).map((shot) => shot.clip)).toEqual([
      { x: 0, y: 0, width: 1280, height: 4800, scale: 1 },
      { x: 0, y: 4800, width: 1280, height: 4200, scale: 1 },
    ]);
    // A whole page is walked to its end, at most forty screens, where a
    // stretch is walked to its own end. CANARY: walk a whole page as a
    // stretch is walked and what loads only when scrolled to is missing from
    // every stretch after the first.
    expect(b.browser.asks().filter((asked) => asked.ask === "walk").map((asked) => asked.args)).toEqual([
      { screens: 40 },
      { to: 5064 },
    ]);

    // No more stretches than asked: the last one then says the page runs on.
    // And one alone when the view names no number.
    const capped = await b.run({ pages: ["long.html"], views: [{ ...DESKTOP, maxHeight: 2000, from: 1000, whole: true, stretches: 3 }] });
    expect(stretches(capped)).toEqual([
      ["1-desktop.png", 1000, 2000, false],
      ["1-desktop-s2.png", 3000, 2000, false],
      ["1-desktop-s3.png", 5000, 2000, true],
    ]);
    const one = await b.run({ pages: ["long.html"], views: [{ ...DESKTOP, whole: true }] });
    expect(stretches(one)).toEqual([["1-desktop.png", 0, 4800, true]]);

    // Each stretch is retaken shorter by itself when its picture is too
    // large (the stand-in's weigh 1,000 bytes per px of height here), and the
    // next starts where it ended. CANARY: start the nth stretch at `from`
    // plus n times the cap and the page between 1,200 and 4,800 px is in no
    // picture.
    const taken = b.browser.shots().length;
    const heavy = await b.run({
      pages: ["long.html"],
      views: [{ ...DESKTOP, whole: true, stretches: 3 }],
      mode: "big",
      maxBytes: 2_000_000,
    });
    expect(stretches(heavy)).toEqual([
      ["1-desktop.png", 0, 1200, false],
      ["1-desktop-s2.png", 1200, 1200, false],
      ["1-desktop-s3.png", 2400, 1200, true],
    ]);
    expect(b.browser.shots().slice(taken).map((shot) => [shot.clip.y, shot.height])).toEqual([
      [0, 4800],
      [0, 2400],
      [0, 1200],
      [1200, 4800],
      [1200, 2400],
      [1200, 1200],
      [2400, 4800],
      [2400, 2400],
      [2400, 1200],
    ]);

    // Nothing at `from` at this width is still the view's own outcome.
    const past = await b.run({ pages: ["long.html"], views: [{ ...DESKTOP, from: 9500, whole: true, stretches: 2 }, PHONE] });
    expect(past.pages[0]).toMatchObject({ error: null, ended: [{ view: "desktop", pageHeight: 9000 }] });
    expect(stretches(past)).toEqual([["1-phone.png", 0, 5064, true]]);
  });

  it("pictures a moving view's screen at three moments after it came into view, without walking the page first", async () => {
    const b = bench({ "page.html": "<p>fake-height:3000 an entrance that plays as the page loads</p>" });
    // The top of the page comes into view when it loads, a screen further
    // down when the window is sent there.
    const report = await b.run({
      pages: ["page.html"],
      views: [
        { ...DESKTOP, moving: true },
        { ...PHONE, from: 1200, moving: true },
      ],
    });
    expect(report.pages[0]).toMatchObject({ error: null, ended: [] });
    const frames = report.pages[0]!.shots;
    // One screen each, at `from`, in a file named for the frame.
    expect(frames.map((shot) => [shot.file, shot.from, shot.height, shot.cut])).toEqual([
      ["1-desktop-m1.png", 0, 800, true],
      ["1-desktop-m2.png", 0, 800, true],
      ["1-desktop-m3.png", 0, 800, true],
      ["1-phone-m1.png", 1200, 844, true],
      ["1-phone-m2.png", 1200, 844, true],
      ["1-phone-m3.png", 1200, 844, true],
    ]);
    expect(b.browser.shots().map((shot) => shot.clip.y)).toEqual([0, 0, 0, 1200, 1200, 1200]);
    // About 250, 1,000 and 3,000 ms on, each frame saying when it was taken.
    // CANARY: take the three one after another and the last is a few ms
    // after the first, of a page that has not moved between them.
    for (const [first, second, third] of [frames.slice(0, 3), frames.slice(3)].map((view) => view.map((shot) => shot.moment ?? -1))) {
      expect(first).toBeGreaterThanOrEqual(250);
      expect(first).toBeLessThan(1000);
      expect(second).toBeGreaterThanOrEqual(1000);
      expect(second).toBeLessThan(3000);
      expect(third).toBeGreaterThanOrEqual(3000);
    }
    // The page is not walked: a walk plays what moves on it before the first
    // frame. Its fonts are waited for, and the window goes down in one step.
    // CANARY: load a moving view as any other (`loadView`) and a walk comes
    // first in each of these.
    expect(b.browser.asks().map((asked) => asked.ask)).toEqual([
      "fonts",
      "screen",
      "screen",
      "screen",
      "fonts",
      "scroll",
      "screen",
      "screen",
      "screen",
    ]);
    expect(b.browser.asks().find((asked) => asked.ask === "scroll")!.args).toEqual({ y: 1200 });

    // Nothing at `from` at this width is the view's own outcome here too.
    const past = await b.run({ pages: ["page.html"], views: [{ ...DESKTOP, from: 5000, moving: true }, PHONE] });
    expect(past.pages[0]).toMatchObject({ error: null, ended: [{ view: "desktop", pageHeight: 3000 }] });
    expect(past.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-phone.png"]);
  });

  it("asks a page at every width for the part that scrolls inside it, and says of each width where there is one how much it holds, in a box how tall, and how many such parts there are", async () => {
    const shell = `main.${"app-shell-".repeat(10)}`;
    const part = `<p>fake-inner:${JSON.stringify({ what: shell, height: 5200.4, box: 640.4 })}</p>`;
    const b = bench({
      // A page whose content scrolls in a part of it, as the page's own
      // layout says: the stand-in answers what the page declares.
      "app.html": part,
      // A long page with three such parts in it, of which this is the one
      // that hides the most.
      "long.html": `<p>fake-height:3000</p><p>fake-inner:${JSON.stringify({ what: shell, height: 5200.4, box: 640.4, count: 3 })}</p>`,
      // One at a phone's width alone.
      "narrow.html": `<p>fake-height:3000 fake-inner-under:600</p>${part}`,
      // A page with no such part.
      "plain.html": "<p>fake-height:3000</p>",
    });
    const report = await b.run({ pages: ["app.html", "long.html", "narrow.html", "plain.html"], views: [DESKTOP, PHONE] });
    const found = (view: string, count = 1) => ({ view, what: shell.slice(0, 80), height: 5200, box: 640, count });
    // CANARY: say nothing of it and a picture of a page whose content
    // scrolls in a part of it reads as showing all the page holds. The
    // part's name is the page author's, so it is cut at eighty characters
    // like any other, and its two heights are whole numbers of px. Stop at
    // the first width that finds one and a page that has it at both is said
    // to have it at the desktop alone. Ask only a page no taller than its
    // screen and the long page says nothing of the part its pictures show
    // 640 px of. Name the one part and not how many there are and a page
    // with three reads as one whose other two hide nothing.
    expect(report.pages.map((page) => [page.file, page.error, page.scrollsInside])).toEqual([
      ["app.html", null, [found("desktop"), found("phone")]],
      ["long.html", null, [found("desktop", 3), found("phone", 3)]],
      ["narrow.html", null, [found("phone")]],
      ["plain.html", null, null],
    ]);
    // Asked on each view's own load, after its walk and before its picture,
    // with that screen's height: which part it is, if any, is the page's
    // own layout to say.
    expect(b.browser.asks().map((asked) => asked.ask)).toEqual(Array.from({ length: 8 }, () => ["walk", "inner"]).flat());
    expect(b.browser.asks().filter((asked) => asked.ask === "inner").map((asked) => asked.args)).toEqual(
      Array.from({ length: 4 }, () => [{ height: 800 }, { height: 844 }]).flat(),
    );
  });

  it.each<{ what: string; pages?: string[]; web?: WebPage[]; views: View[] }>([
    // A view is one kind of picture: a box, a whole page, an act or a moving
    // screen.
    { what: "a view that is a box and a whole page at once", views: [{ ...box(1200, 630, 1), whole: true }] },
    { what: "a view that carries an act and is moving", views: [{ ...DESKTOP, act: { tab: 1 }, moving: true }] },
    { what: "an act that names nothing to do", views: [{ ...DESKTOP, act: {} }] },
    // A picture's name is the view's id and its kind, so two of one id and
    // one kind would write one file.
    { what: "two views of one id and one kind", views: [DESKTOP, { ...DESKTOP, from: 800 }] },
    {
      what: "a stretch and a whole page of one id, whose first pictures have one name",
      views: [DESKTOP, { ...DESKTOP, whole: true }],
    },
    // A page on the web is opened with the network open, so its browser is
    // never a task page's.
    { what: "a page on the web among task pages", web: [{ file: "site", url: "http://127.0.0.1:9/" }], views: [DESKTOP] },
    { what: "a page on the web with no address", pages: [], web: [{ file: "site" }], views: [DESKTOP] },
    {
      what: "a page on the web at an address that is not http or https",
      pages: [],
      web: [{ file: "site", url: "file:///etc/hosts" }],
      views: [DESKTOP],
    },
    {
      what: "a page on the web as a box",
      pages: [],
      web: [{ file: "site", url: "http://127.0.0.1:9/" }],
      views: [box(1200, 630, 1)],
    },
  ])("refuses a job that asks for $what", async ({ pages, web, views }) => {
    const b = bench({ "page.html": "<p>one line</p>" });
    // CANARY: drop the job schema's check of what its views and pages are
    // together (`jobFaults`) and each of these jobs is pictured or opened:
    // the first as a plain stretch, the fourth twice into `1-desktop.png`.
    await expect(b.run({ pages: pages ?? ["page.html"], web, views })).rejects.toThrow(
      "the child ended with 2: usage: page-capture-child.server.ts < job.json",
    );
    // Refused whole, before any browser is started.
    expect(b.browser.launches()).toEqual([]);
  });
});

describe("a page on the web, pictured by the renderer child (ruling 327)", () => {
  it("opens a page on the web at its own address in a browser with the network open, pictures it once it has gone quiet, and reports nothing as asked of the network or missing", async () => {
    const other = await site({ "/logo.png": "the logo" });
    const reference = await site({
      // Three requests after the load event, 200 ms apart: a page that goes
      // on fetching once it has loaded.
      "/": `<p>fake-height:9000 fake-trickle:3</p><img src="${other.origin}/logo.png"><img src="/hero.png"><img src="/gone.png">`,
      "/hero.png": "the hero",
    });
    const b = bench({});
    const report = await b.run({
      pages: [],
      web: [{ file: "the reference", url: `${reference.origin}/` }],
      views: [{ ...DESKTOP, whole: true, stretches: 2 }, PHONE, { ...DESKTOP, id: "top", moving: true }],
    });
    // The label it was given, and nothing of what a task page reports: what
    // a site asks the network for is its own business.
    expect(report.pages[0]).toMatchObject({ file: "the reference", error: null, asked: [], askedCount: 0, missing: [] });
    expect(report.pages[0]!.shots.map((shot) => [shot.file, shot.from, shot.height, shot.cut])).toEqual([
      ["1-desktop.png", 0, 4800, false],
      ["1-desktop-s2.png", 4800, 4200, false],
      ["1-phone.png", 0, 5064, true],
      ["1-top-m1.png", 0, 800, true],
      ["1-top-m2.png", 0, 800, true],
      ["1-top-m3.png", 0, 800, true],
    ]);
    // At its own address, never through the page server, and what it draws
    // from another host is fetched: the network is open to it. CANARY: start
    // a web page's browser with the task pages' flags and the stand-in, like
    // Chromium behind the dead proxy, fetches nothing from the other host
    // (`status: null`).
    const [first] = b.browser.pages();
    // One load a view, and the one on which what moves on it is read.
    expect(b.browser.pages().map((page) => page.url)).toEqual(Array.from({ length: 4 }, () => `${reference.origin}/`));
    expect(first!.resources).toEqual([
      { src: `${other.origin}/logo.png`, status: 200, bytes: 8 },
      { src: "/hero.png", status: 200, bytes: 8 },
      { src: "/gone.png", status: 404, bytes: 9 },
    ]);
    const [launch] = b.browser.launches();
    expect(launch!.argv.filter((arg) => arg.startsWith("--proxy"))).toEqual([]);
    // Every other flag stays.
    expect(launch!.argv).toEqual(
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-sandbox",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--password-store=basic",
        "--use-mock-keychain",
      ]),
    );
    // Pictured only once the page had asked for nothing for half a second.
    // CANARY: walk a web page straight after its load event, as a task page
    // is, and its first picture is taken with all three late requests still
    // to come.
    for (const shot of b.browser.shots().slice(0, 3)) {
      expect(shot.late).toBe(0);
      expect(shot.quietMs).toBeGreaterThanOrEqual(500);
    }
    // But a moving view's frames are due from the load event, so nothing is
    // waited for ahead of them. CANARY: wait for quiet there too and the
    // first frame comes over a second after the load.
    expect(report.pages[0]!.shots[3]!.moment).toBeLessThan(1000);
  });

  it("reads what moves on a page on the web once, on a load of its own at the first width that is not a phone's: what runs a second after the load, what animates in as it is scrolled to, a bar that stays, and the controls whose look changes under the real pointer", async () => {
    const running = Array.from({ length: 14 }, (_, at) => ({ name: `pulse-${at}`, target: "div.dot", durationMs: 1200, loops: true }));
    const videos = Array.from({ length: 7 }, (_, at) => ({ autoplay: true, loop: at === 0, playing: true, width: 640, height: 360 }));
    const hover = [
      { what: "a.nav-link", at: [100, 20], changes: ["color", "text-decoration-line"], durationMs: 150 },
      { what: "button.cta", at: [300, 400], changes: ["background-color", "transform"] },
      // A control whose look does not change is tried and left out.
      { what: "label.quiet", at: [50, 600], changes: [] },
    ];
    const reference = await site({
      "/": [
        `<p>fake-animations:${JSON.stringify(running)}</p>`,
        `<p>fake-videos:${JSON.stringify(videos)}</p>`,
        '<p>fake-sticky:{"what":"header.site","position":"sticky"}</p>',
        "<p>fake-on-scroll:5</p>",
        `<p>fake-hover:${JSON.stringify(hover)}</p>`,
      ].join("\n"),
    });
    const b = bench({ "page.html": "<p>a task page nobody asked to measure</p>" });
    const report = await b.run({ pages: [], web: [{ file: "the reference", url: `${reference.origin}/` }], views: [PHONE, DESKTOP] });
    expect(report.pages[0]).toMatchObject({ error: null });
    // CANARY: hand on every animation and video the page names and these are
    // 14 and 7 long.
    expect(report.pages[0]!.motion).toEqual({
      running: running.slice(0, 12),
      runningCount: 14,
      videos: videos.slice(0, 6),
      sticky: { what: "header.site", position: "sticky" },
      onScroll: 5,
      hover: [
        { what: "a.nav-link", changes: ["color", "text-decoration-line"], durationMs: 150 },
        { what: "button.cta", changes: ["background-color", "transform"], durationMs: null },
      ],
    });
    // Its own load, after both pictures, at the desktop's width: a pointer
    // means nothing at a phone's. CANARY: read it at the first view whatever
    // it is and the third load is 390 px wide.
    expect(b.browser.pages().map((page) => page.metrics.width)).toEqual([390, 1280, 1280]);
    // That load is not walked first: what animates in as a reader scrolls to
    // it plays once, and is counted on the page's first walk. Measured on a
    // real page: a second walk counted none of three. CANARY: read motion on
    // a view's own load, after its walk, and a `walk` comes first here. (The
    // four before these are the two pictures': each view's walk, and its
    // look for a part of the page that scrolls inside it.)
    const reading = b.browser.asks().slice(4);
    expect(reading.map((asked) => asked.ask)).toEqual([
      "animations",
      "on-scroll",
      "sticky",
      "hover-list",
      "hover-rest",
      "hover-read",
      "hover-rest",
      "hover-read",
      "hover-rest",
      "hover-read",
    ]);
    // What still runs a second after the load is what moves on a page: an
    // entrance is over by then. CANARY: read without that wait and this is
    // the half second a page on the web is given to go quiet.
    expect(reading[0]!.sinceLoadMs).toBeGreaterThanOrEqual(1000);
    // The real pointer, onto each control in turn. CANARY: read each look
    // twice with the pointer left where it was and no control's changes (the
    // stand-in's change only under the pointer, as a page's `:hover` does).
    expect(b.browser.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 100, y: 20 },
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 300, y: 400 },
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 50, y: 600 },
    ]);

    // A task page nobody asked to measure is pictured and nothing more.
    const plain = await b.run({ pages: ["page.html"], views: [DESKTOP] });
    expect(plain.pages[0]).not.toHaveProperty("motion");
    expect(b.browser.pages()).toHaveLength(4);
  });

  it("does not picture a page on the web whose address answers with an error: its error page is no look of the page that was asked for", async () => {
    // A site that turns a headless browser away answers 403 with a page of
    // its own, and a page that is gone answers 404 with another. Pictured,
    // either would be kept as the look a result is made to.
    // CANARY: picture whatever the address serves and the report holds two
    // pictures of "not found" and no error.
    const reference = await site({ "/": "<p>the page</p>" });
    const b = bench({});
    const report = await b.run({ pages: [], web: [{ file: "gone", url: `${reference.origin}/no-such-page` }], views: [DESKTOP, PHONE] });
    expect(report.pages[0]).toMatchObject({ file: "gone", shots: [], error: "the address answered 404, so there is no page there to picture" });
    expect(b.browser.shots()).toEqual([]);
    // A task page is served by Viberr's own page server and is not a page on
    // the web: what it is answered with is the page server's business.
    const page = await b.run({ pages: [], web: [{ file: "there", url: `${reference.origin}/` }], views: [DESKTOP] });
    expect(page.pages[0]).toMatchObject({ error: null });
  });

  it("says in the browser's own words when a page on the web does not load, refuses one that ends up off the web, and holds a press to the site the page is on", async () => {
    const reference = await site({
      // A site may send its visitor on to another address of the web.
      "/moved": `<p>fake-lands:"https://www.example.com/landing"</p>`,
      // Or to something that is no web page at all.
      "/broken": `<p>fake-lands:"chrome-error://chromewebdata/"</p>`,
    });
    const gone = await site({});
    await gone.close();
    const b = bench({});
    const web = (file: string, url: string): WebPage => ({ file, url });
    const pages = await b.run({
      pages: [],
      web: [web("gone", `${gone.origin}/`), web("moved", `${reference.origin}/moved`), web("broken", `${reference.origin}/broken`)],
      views: [DESKTOP],
    });
    // CANARY: hold a web page to the page server's origin, as a task page is
    // held, and "moved" is refused for going where its own site sent it.
    expect(pages.pages.map((page) => [page.file, page.shots.length, page.error])).toEqual([
      ["gone", 0, "the page did not load (net::ERR_CONNECTION_REFUSED)"],
      ["moved", 1, null],
      ["broken", 0, "the page sent the browser to an address that is not on the web"],
    ]);

    // A press may move within the site the page is on, and one that leaves
    // it is the act's own failure, as a press off the page server is on a
    // task page. CANARY: hold a press on a web page to the page server's
    // origin and "Docs", which stays on its site, is refused too.
    const linked = await site({
      "/": '<p>fake-find:{"Docs":[40,20,"link","{origin}/docs"],"Partner":[90,20,"link","https://partner.example.com/"]}</p>',
    });
    const acted = await b.run({
      pages: [],
      web: [web("linked", `${linked.origin}/`)],
      views: [
        { ...DESKTOP, id: "docs", act: { press: "Docs" } },
        { ...DESKTOP, id: "partner", act: { press: "Partner" } },
      ],
    });
    expect(acted.pages[0]).toMatchObject({
      error: null,
      acts: [
        { view: "docs", done: 'pressed link "Docs"', error: null },
        { view: "partner", done: null, error: "the press sent the browser to another address" },
      ],
    });
    expect(acted.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-docs-a.png"]);
  });
});

describe("a measured page, read by the renderer child (ruling 328)", () => {
  /** A stand-in for axe-core's script. The stand-in browser answers the
   *  engine's findings only once a script holding these words was run in the
   *  page, as a real page has no `axe` until the real script was. */
  function engineIn(b: Bench): string {
    const file = path.join(path.dirname(b.root), "axe.min.js");
    writeFileSync(file, "/* fake-engine */ window.axe = {};");
    return file;
  }
  const measuredOf = (report: Report) => report.pages[0]!.measured!;

  it("runs the accessibility engine the job names in a page and reports its findings by kind, the gravest first, with the lowest contrast it found failing", async () => {
    const faint = "A line so faint it is hard to read, and long enough that a report must cut it at eighty characters";
    const findings = [
      ...Array.from({ length: 19 }, (_, at) => ({ id: `rule-${at}`, impact: "minor", help: `Rule ${at}`, count: 1, nodes: [{ target: `#n${at}` }] })),
      {
        id: "color-contrast",
        impact: "serious",
        help: "Elements must meet minimum color contrast ratio thresholds",
        count: 3,
        nodes: [
          { target: ".soft", ratio: 2.32, text: "Soft" },
          { target: ".faint", ratio: 1.6, text: faint },
          { target: ".near", ratio: 4.1, text: "Nearly there" },
        ],
      },
      {
        id: "image-alt",
        impact: "critical",
        help: "Images must have alternative text",
        count: 5,
        nodes: ["a", "b", "c", "d"].map((name) => ({ target: `img[src$="${name}.png"]` })),
      },
    ];
    const b = bench({ "page.html": `<p>fake-axe:${JSON.stringify(findings)}</p>`, "throws.html": '<p>fake-axe-throws:"axe gave up"</p>' });
    const report = await b.run({ pages: ["page.html", "throws.html"], views: [DESKTOP], measure: true, axe: engineIn(b) });
    expect(report.pages[0]).toMatchObject({ error: null });
    const { faults } = measuredOf(report).views[0]!;
    expect(faults).toMatchObject({ ran: true, why: null });
    // Twenty kinds at most, the gravest first, so the cap never drops the
    // worst of them; three places each. CANARY: hand on the engine's own
    // order and its first twenty and the two that matter most, which the
    // engine lists last here, are the two that are cut.
    expect(faults.kinds).toHaveLength(20);
    // And how many there are in all. CANARY: count the kinds the report
    // lists and a page with twenty-one kinds of fault reads as one with
    // twenty.
    expect(faults.kindsCount).toBe(21);
    // And in how many places, over every kind: nineteen of one each, the
    // contrast's three and the picture's five. CANARY: add up the kinds the
    // report lists and the twenty-first kind's place is left out of a
    // number that stands beside "21 kinds".
    expect(faults.elementsCount).toBe(27);
    expect(faults.kinds.slice(0, 3)).toEqual([
      {
        id: "image-alt",
        impact: "critical",
        help: "Images must have alternative text",
        count: 5,
        first: ['img[src$="a.png"]', 'img[src$="b.png"]', 'img[src$="c.png"]'],
      },
      {
        id: "color-contrast",
        impact: "serious",
        help: "Elements must meet minimum color contrast ratio thresholds",
        count: 3,
        first: [".soft", ".faint", ".near"],
      },
      { id: "rule-0", impact: "minor", help: "Rule 0", count: 1, first: ["#n0"] },
    ]);
    // The lowest ratio among the contrast finding's own places, and the
    // words it is on. CANARY: take the first place's and this is 2.32.
    expect(faults.worstContrast).toEqual({ ratio: 1.6, text: faint.slice(0, 80) });

    // An engine that throws in a page is said not to have run there, and
    // costs the page nothing. CANARY: let its failure reject the page's work
    // (`measureView`) and the page carries "axe gave up" as its own error.
    const [, thrown] = report.pages;
    expect(thrown).toMatchObject({ file: "throws.html", error: null });
    expect(thrown!.shots).toHaveLength(1);
    expect(thrown!.measured!.views[0]!.faults).toEqual({ ran: false, why: "Error: axe gave up", kinds: [], kindsCount: 0, elementsCount: 0, worstContrast: null });

    // The engine is the job's to name: with none named, or one that is not
    // there to read, the check is said not to have run. CANARY: ask for the
    // findings without running the engine's script in the page first and the
    // run above says the same of an engine that was named and is there.
    const none = await b.run({ pages: ["page.html"], views: [DESKTOP], measure: true });
    expect(none.pages[0]).toMatchObject({ error: null });
    expect(measuredOf(none).views[0]!.faults).toEqual({
      ran: false,
      why: "no accessibility engine is installed",
      kinds: [],
      kindsCount: 0,
      elementsCount: 0,
      worstContrast: null,
    });
    const unread = await b.run({ pages: ["page.html"], views: [DESKTOP], measure: true, axe: path.join(b.root, "no-such-engine.js") });
    expect(measuredOf(unread).views[0]!.faults).toEqual({
      ran: false,
      why: "the accessibility engine could not be read",
      kinds: [],
      kindsCount: 0,
      elementsCount: 0,
      worstContrast: null,
    });
    // Its own limit: four pages are measured above, one after another, each
    // in a real process that waits two seconds of the clock by itself.
  }, 60_000);

  /** So many links, and their places among a page's controls. */
  const links = (count: number) => Array.from({ length: count }, (_, at) => ["a", `Link ${at}`]);
  const places = (count: number) => Array.from({ length: count }, (_, at) => at);
  /** A page as the stand-in reads it: one declaration a line. */
  const declares = (...lines: string[]) => lines.map((line) => `<p>${line}</p>`).join("\n");

  /**
   * The keyboard walk of each page, at the desktop's width: every page in a
   * renderer and a browser of its own, all at the same time. A measured page
   * waits two seconds of the clock by itself, so six of them one after the
   * other are a test of thirteen. Resolves, in the order given, with each
   * page's walk, how many times Tab went down on it, and its bench.
   */
  function walked(pages: Record<string, string>) {
    return Promise.all(
      Object.entries(pages).map(async ([file, text]) => {
        const b = bench({ [file]: text });
        const report = await b.run({ pages: [file], views: [DESKTOP], measure: true });
        expect(report.pages[0]).toMatchObject({ file, error: null });
        const presses = b.browser.inputs().filter((input) => input.type === "rawKeyDown").length;
        return { walk: measuredOf(report).views[0]!.keyboard, presses, b };
      }),
    );
  }
  /** A walk that ran, came round and found nothing to say. */
  const clean = { ran: true, cut: false, unreached: [], unreachedCount: 0, unmarked: [], unmarkedCount: 0 };

  it("walks a page with real presses of Tab and says which of the controls a keyboard should reach it never reached, and which took focus with no change of look", async () => {
    const [page, wide, trap, none, many] = await walked({
      // Tab stops on four of the five, two of which do not show it, and on
      // two things that are no control of the page's: a skip link that is
      // only there with focus, a list that scrolls.
      "page.html": declares(
        'fake-controls:[["a","Docs"],["button","Menu"],["a","Pricing"],["input","Email"],["a","Legal"]]',
        'fake-tab-order:[["a","Skip to content"],0,1,["div","A list that scrolls"],2,3]',
        "fake-unmarked:[1,3]",
      ),
      // Twenty controls: Tab goes round the first twelve, seven of which do
      // not show it.
      "wide.html": declares(
        `fake-controls:${JSON.stringify(links(20))}`,
        `fake-tab-order:${JSON.stringify(places(12))}`,
        `fake-unmarked:${JSON.stringify(places(7))}`,
      ),
      // A keyboard trap: from "Close" focus goes back to "Open", for ever.
      // "Open" does not show focus.
      "trap.html": declares(
        'fake-controls:[["a","Start"],["button","Open"],["button","Close"],["a","After"],["a","Further on"]]',
        "fake-tab-order:[0,1,2]",
        "fake-tab-trap:1",
        "fake-unmarked:[1]",
      ),
      // A control and no stop anywhere for Tab.
      "none.html": declares('fake-controls:[["a","Out of reach"]]'),
      "many.html": declares(`fake-controls:${JSON.stringify(links(100))}`, `fake-tab-order:${JSON.stringify(places(100))}`),
    });
    // CANARY: count a stop that is no control of the page's and Tab is said
    // to have stopped on all five, "Legal" among them, which it never did.
    expect(page!.walk).toEqual({
      ran: true,
      cut: false,
      controls: 5,
      stops: 4,
      unreached: ['a "Legal"'],
      unreachedCount: 1,
      unmarked: ['button "Menu"', 'input "Email"'],
      unmarkedCount: 2,
    });
    // Real key events: six stops, the press that takes focus off the page,
    // and one more, which finds Tab back on its first stop. Only then has the
    // walk been round and can say that it never came to "Legal". CANARY: move
    // focus from a script and `:focus-visible` never holds, so every control
    // would look unmarked; here the stand-in's focus would not move at all.
    expect(page!.presses).toBe(8);
    expect(page!.b.browser.inputs()[0]).toEqual({ method: "Input.dispatchKeyEvent", type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    // The controls are noted, with their look at rest, before the page is
    // walked: the walk is what a reader does next. CANARY: note them after
    // the walk and these two change places. Focus is put back at the top of
    // the page last, with the first press next. (The two before these are
    // the picture's.)
    const measuring = page!.b.browser.asks().slice(2);
    expect(measuring.slice(0, 4).map((asked) => asked.ask)).toEqual(["controls", "walk", "start", "focus"]);

    // Six names at most of each, and how many there are in all. CANARY:
    // count what the lists hold and eight controls nobody can tab to are
    // said to be six.
    expect(wide!.walk).toEqual({
      ran: true,
      cut: false,
      controls: 20,
      stops: 12,
      unreached: places(6).map((at) => `a "Link ${at + 12}"`),
      unreachedCount: 8,
      unmarked: places(6).map((at) => `a "Link ${at}"`),
      unmarkedCount: 7,
    });
    // Twelve stops, off the page, and back on the first.
    expect(wide!.presses).toBe(14);
    // A step Tab has taken before, from one stop to the same next one, is a
    // walk that has been round all it can reach: what lies past a trap is
    // named, and the walk does not go on to its last press. CANARY: take no
    // such step for the end of a walk and the trap is pressed through eighty
    // times and reported as cut, with nothing said of the two links past it.
    // A control is judged the first time focus comes to it. CANARY: judge it
    // each time and "Open", which the trap comes back to, is listed twice.
    expect(trap!.walk).toEqual({
      ...clean,
      controls: 5,
      stops: 3,
      unreached: ['a "After"', 'a "Further on"'],
      unreachedCount: 2,
      unmarked: ['button "Open"'],
      unmarkedCount: 1,
    });
    expect(trap!.presses).toBe(5);
    // Tab from the page itself that leaves focus on the page itself has no
    // stop to find. CANARY: press on while focus stays off the page and this
    // is eighty presses and a walk said to be cut.
    expect(none!.walk).toEqual({ ...clean, controls: 1, stops: 0, unreached: ['a "Out of reach"'], unreachedCount: 1 });
    expect(none!.presses).toBe(2);
    // Eighty presses at most. A walk that was cut there has not been round
    // the page, and says so: twenty of these links were never reached and
    // every one of them can be, so it names none and counts none. CANARY:
    // say `cut` of no walk and this one reads as a walk all the way round a
    // page of a hundred controls that reached eighty. List what the cut walk
    // did not get to and `unreached` names six links a keyboard reaches.
    expect(many!.walk).toEqual({ ...clean, cut: true, controls: 100, stops: 80 });
    expect(many!.presses).toBe(80);
  });

  it("goes on through a part that may hold stops of its own for as long as it keeps focus, and says a walk was cut only when a control is left that it never came to", async () => {
    const [held, full, edge, wrap] = await walked({
      // A date field is four stops and one element (the page says it holds
      // stops of its own: a plain field with focus at four presses running
      // would be where the walk stops), a frame holds stops of its own, and
      // a card's own buttons stand before and after the button set into it:
      // focus is on the card, on the button, on the card again.
      "held.html": declares(
        'fake-controls:[["a","Home"],["input","Date of birth"],["a","Terms"],["button","Send"],["a","Privacy"]]',
        'fake-tab-order:[0,1,1,1,1,["iframe","A map"],["iframe","A map"],2,["x-card","Card"],3,["x-card","Card"],4]',
        "fake-tab-holds:[1]",
        "fake-unmarked:[1]",
      ),
      // Exactly as many controls as there are presses, every one a stop.
      "full.html": declares(`fake-controls:${JSON.stringify(links(80))}`, `fake-tab-order:${JSON.stringify(places(80))}`),
      // One fewer stop: the last press takes focus off the page with a
      // control still not come to. Or straight back to the first stop, on a
      // browser that never sends focus off the page: the one in the image
      // does that, now and then.
      "edge.html": declares(`fake-controls:${JSON.stringify(links(80))}`, `fake-tab-order:${JSON.stringify(places(79))}`),
      "wrap.html": declares(`fake-controls:${JSON.stringify(links(80))}`, `fake-tab-order:${JSON.stringify(places(79))}`, "fake-tab-trap:0"),
    });
    // The same element at the next press is one stop still being crossed:
    // the walk goes on, and counts it once. CANARY: take a stop met again
    // for a walk that has come round and the three controls after the date
    // field are named as never reached, which Tab reaches every one of. Take
    // only a stop met again after another for it and "Privacy" is, since
    // focus comes back to the card. Count a control at each press it holds
    // focus and the date field is listed four times over.
    expect(held!.walk).toEqual({ ...clean, controls: 5, stops: 5, unmarked: ['input "Date of birth"'], unmarkedCount: 1 });
    // To the last control, and no further.
    expect(held!.presses).toBe(12);
    // A walk that has come to every control has nothing left to find, at
    // whatever press. CANARY: say `cut` of every walk that used its last
    // press and a page whose eighty controls Tab reaches every one of is
    // said to hold some that are not known.
    expect(full!.walk).toEqual({ ...clean, controls: 80, stops: 80 });
    expect(full!.presses).toBe(80);
    // The last press took focus off the page, or back to a stop the walk had
    // been on: one more is made, only to see whether Tab then takes a step
    // it took before, and it does, so the walk has been round. CANARY: stop
    // at the eightieth whatever it did and both walks are cut, with nothing
    // said of the one link Tab never reaches. Make the one more only when
    // the eightieth left the page and the second walk still is.
    const round = { ...clean, controls: 80, stops: 79, unreached: ['a "Link 79"'], unreachedCount: 1 };
    expect(edge!.walk).toEqual(round);
    expect(wrap!.walk).toEqual(round);
    expect([edge!.presses, wrap!.presses]).toEqual([81, 81]);
  });

  it("takes an element that can hold no stop of its own and has focus at four presses running for where the walk comes round, and names what lies past it", async () => {
    const dialog = ['fake-controls:[["button","Accept"],["a","Home"],["a","About"]]', "fake-tab-order:[0]", "fake-tab-from:0", "fake-tab-held:true"];
    const [editor, keeps, off, wraps, once] = await walked({
      // An editor in a part of its own keeps focus for as long as Tab is
      // pressed: stops of its own, or a key it keeps, and no telling which.
      "editor.html": declares('fake-controls:[["a","Docs"],["a","After"]]', 'fake-tab-order:[0,["x-editor","Editor"]]', "fake-tab-trap:1"),
      // A text field whose own script keeps Tab for itself, then a button.
      "keeps.html": declares('fake-controls:[["a","Docs"],["textarea","Notes"],["button","Save"]]', "fake-tab-order:[0,1]", "fake-tab-trap:1"),
      // A dialog over the page with one button a keyboard can reach, which
      // holds focus as the page loads. One browser sends focus off the page
      // after it, the other straight back to it.
      "dialog-off.html": declares(...dialog),
      "dialog-wraps.html": declares(...dialog, "fake-tab-trap:0"),
      // A field that takes one Tab for itself and lets the next through, as
      // a list that opens on focus does to pick its option.
      // The button after it keeps two.
      "once.html": declares('fake-controls:[["a","Docs"],["input","City"],["button","Go"],["a","Help"]]', "fake-tab-order:[0,1,1,2,2,2,3]"),
    });
    // A link, a button or a text field holds no stop but itself, so one
    // that has focus at four presses running keeps the key. CANARY: press on
    // through it as through a date field and the walk uses its eighty
    // presses and is said to be cut, with nothing said of "Save", which a
    // keyboard never reaches.
    expect(keeps!.walk).toEqual({ ...clean, controls: 3, stops: 2, unreached: ['button "Save"'], unreachedCount: 1 });
    // Twice running is one stop still being crossed: the third press goes
    // on. CANARY: take two presses running for a field that keeps the key
    // and the button and the link after this one are named as never
    // reached, which the next presses reach. The count starts again at each
    // element: go on counting from the field into the button and the link
    // after the button is named.
    expect(once!.walk).toEqual({ ...clean, controls: 4, stops: 4 });
    expect([keeps!.presses, once!.presses]).toEqual([5, 7]);
    // One page, one report, however the browser ends its order.
    const behind = { ...clean, controls: 3, stops: 1, unreached: ['a "Home"', 'a "About"'], unreachedCount: 2 };
    expect(off!.walk).toEqual(behind);
    expect(wraps!.walk).toEqual(behind);
    // What may hold stops of its own is pressed on through to the last
    // press, and the walk then says it was cut: whether "After" can be
    // reached is not known. CANARY: take any element that still has focus
    // at the next press for where the walk comes round and "After" is named
    // as never reached on the strength of one press.
    expect(editor!.walk).toEqual({ ...clean, cut: true, controls: 2, stops: 1 });
    expect(editor!.presses).toBe(80);
  });

  it("starts a walk at the top of the page with nothing focused, wherever the page put focus as it loaded, and goes round one that takes focus back", async () => {
    const [far, kept, last] = await walked({
      // A hundred links, the ninety-first of which holds focus when the page
      // is loaded, as a field with `autofocus` does. Three near the end do
      // not show focus.
      "far.html": declares(
        `fake-controls:${JSON.stringify(links(100))}`,
        `fake-tab-order:${JSON.stringify(places(100))}`,
        "fake-tab-from:90",
        "fake-unmarked:[94,95,96]",
      ),
      // A page that keeps focus where it put it, as one under a dialog does:
      // the walk begins below its third control.
      "kept.html": declares(`fake-controls:${JSON.stringify(links(5))}`, "fake-tab-order:[0,1,2,3,4]", "fake-tab-from:2", "fake-tab-held:true"),
      // The same with focus kept on the last of two controls: the first
      // press takes it off the page.
      "last.html": declares(`fake-controls:${JSON.stringify(links(2))}`, "fake-tab-order:[0,1]", "fake-tab-from:1", "fake-tab-held:true"),
    });
    // Eighty presses from the top are the first eighty links. CANARY: leave
    // focus where the page put it and the walk begins at the ninety-second:
    // it meets the three that do not show focus, and its eighty presses stop
    // on seventy-nine controls.
    expect(far!.walk).toEqual({ ...clean, cut: true, controls: 100, stops: 80 });
    // Focus leaving the page is no proof that a walk has seen it all: this
    // one began part way down, so it goes on, comes back in at the top and
    // reaches the three above where it began. CANARY: take the first time
    // focus leaves the page for the end of a walk and those three are named
    // as never reached.
    expect(kept!.walk).toEqual({ ...clean, controls: 5, stops: 5 });
    // Two below, off the page, three above.
    expect(kept!.presses).toBe(6);
    // Nothing focused after the first press says where the walk began, not
    // that the page has no stop. CANARY: take it for a page with none and
    // both links are named as never reached, which the next two presses
    // reach.
    expect(last!.walk).toEqual({ ...clean, controls: 2, stops: 2 });
  });

  it("measures a page only once every view of it is pictured, on loads of its own: what still runs with reduced motion asked for, what one load of it weighs, and how long it takes to load on a slow line", async () => {
    const reduced = [
      { name: "spin", target: "div.loader", durationMs: 1200, loops: true },
      // Over in under a fifth of a second: not what reduced motion is for.
      { name: "opacity", target: "a.link", durationMs: 150, loops: false },
      { name: "slide", target: "div.hero", durationMs: 600, loops: false },
      // Driven by the scroll: it has no length in time.
      { name: "grow", target: "div.bar", durationMs: null, loops: false },
    ];
    const page = [
      '<img src="chart.png"><img src="gone.png">',
      `<p>fake-animations:${JSON.stringify([...reduced, { name: "pulse", target: "i.dot", durationMs: 900, loops: true }])}</p>`,
      `<p>fake-animations-reduced:${JSON.stringify(reduced)}</p>`,
      '<p>fake-videos:[{"autoplay":true,"loop":true,"playing":true,"width":640,"height":360},{"autoplay":false,"loop":false,"playing":false,"width":320,"height":180}]</p>',
      "<p>fake-load-ms:2345</p>",
    ].join("\n");
    const b = bench({ "page.html": page, "chart.png": "a picture" });
    // The page opens an alert at every load: two while it is pictured.
    const report = await b.run({ pages: ["page.html"], measure: true, mode: "dialog:page.html" });
    expect(report.pages[0]).toMatchObject({ error: null, dialogs: 2, missing: ["gone.png"] });
    expect(report.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-desktop.png", "1-phone.png"]);
    const measured = measuredOf(report);
    // With reduced motion asked for, a second after the load: what loops or
    // lasts. CANARY: hand on everything that runs and the count is 4.
    expect(measured.views.map((view) => view.reduced)).toEqual(
      Array.from({ length: 2 }, () => ({
        ran: true,
        runningCount: 2,
        running: [
          { name: "spin", target: "div.loader", loops: true },
          { name: "slide", target: "div.hero", loops: false },
        ],
        videosPlaying: 1,
      })),
    );
    // One load of the page: the page and the one file it was served.
    // CANARY: read the page server's count once the views are measured, and
    // not around the one load, and this is six loads' worth.
    expect(measured.weight).toEqual({ bytes: Buffer.byteLength(page) + 9, files: 2 });
    // The stand-in reports this time only on a held line with the cache off.
    // CANARY: load it again as it is and `loadMs` is 1.
    expect(measured).toMatchObject({ loadMs: 2345, line: "1.6 Mbit/s down, 150 ms" });
    // A measured page says what moves on it too.
    expect(report.pages[0]!.motion).toMatchObject({ runningCount: 5 });

    // Every picture first, then the loads a reading makes: each view again
    // to be measured and once more with reduced motion, one for what moves
    // (at the desktop's width), and last the slow one, at the phone's.
    // CANARY: measure a view on the load that pictured it and the phone's
    // picture waits on the desktop's measuring.
    expect(b.browser.pages().map((loaded) => [loaded.metrics.width, loaded.reducedMotion])).toEqual([
      [1280, "no-preference"],
      [390, "no-preference"],
      [1280, "no-preference"],
      [1280, "reduce"],
      [390, "no-preference"],
      [390, "reduce"],
      [1280, "no-preference"],
      [390, "no-preference"],
    ]);
    // The line is held for that last load only, and let go after it.
    expect(b.browser.emulations().filter((set) => set.method.startsWith("Network."))).toEqual([
      { method: "Network.setCacheDisabled", cacheDisabled: true },
      { method: "Network.emulateNetworkConditions", offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 },
      { method: "Network.emulateNetworkConditions", offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      { method: "Network.setCacheDisabled", cacheDisabled: false },
    ]);
  });

  it("says of each check at each width whether it ran, so a width that was not measured does not read as a clean one", async () => {
    const b = bench({
      // Its load with reduced motion asked for never finishes (the stand-in's
      // word for it), so the page's time runs out there, on the first width.
      "stuck.html": ['<p>fake-controls:[["a","Docs"]]</p>', "<p>fake-tab-order:[0]</p>", "<p>fake-reduced-load:never</p>"].join("\n"),
      // A page that breaks under the keyboard walk alone.
      "breaks.html": [
        '<p>fake-controls:[["a","Docs"],["button","Menu"]]</p>',
        "<p>fake-tab-order:[0,1]</p>",
        '<p>fake-keyboard-throws:"the page went away"</p>',
        "<p>fake-axe:[]</p>",
      ].join("\n"),
    });
    const notWalked = { ran: false, cut: false, controls: 0, stops: 0, unreached: [], unreachedCount: 0, unmarked: [], unmarkedCount: 0 };
    const outOfTime = "the page's time ran out before it was measured";
    // The page's time has to run out by the clock: ten seconds, of which a
    // browser to start and two pictures of a page of three lines are all
    // that has to fit. How much of the measuring fits before the load that
    // never finishes is the machine's to say, and nothing below needs any of
    // it to have.
    const stuck = await b.run({ pages: ["stuck.html"], measure: true, pageTimeoutMs: 10_000 });
    // The pictures stand.
    expect(stuck.pages[0]).toMatchObject({ error: null });
    expect(stuck.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-desktop.png", "1-phone.png"]);
    const [desktop, phone] = measuredOf(stuck).views;
    // What came before the time went stands, and what did not says so: the
    // walk is the whole of a walk or none, and the engine is either the one
    // nobody named or one whose turn never came.
    expect([{ ...notWalked, ran: true, controls: 1, stops: 1 }, notWalked]).toContainEqual(desktop!.keyboard);
    expect(desktop!.faults).toMatchObject({ ran: false, kinds: [], kindsCount: 0 });
    expect(["no accessibility engine is installed", outOfTime]).toContain(desktop!.faults.why);
    // The read with reduced motion asked for never ran, whether the time
    // went under it or before it. CANARY: answer a reduced-motion read that
    // failed with its zeros alone (`ran: true`) and this reads as a page on
    // which nothing still moves.
    expect(desktop!.reduced).toEqual({ ran: false, runningCount: 0, running: [], videosPlaying: 0 });
    // The phone's turn never came. CANARY: report a width that was never
    // measured as measured (`ran: true` in `unmeasured`) and it reads as a
    // page with no control, nothing still moving and nothing to say why.
    expect(phone).toEqual({
      view: "phone",
      faults: { ran: false, why: outOfTime, kinds: [], kindsCount: 0, elementsCount: 0, worstContrast: null },
      keyboard: notWalked,
      reduced: { ran: false, runningCount: 0, running: [], videosPlaying: 0 },
    });

    // One check that fails is said of that check, and the others still run.
    const breaks = await b.run({ pages: ["breaks.html"], views: [DESKTOP], measure: true, axe: engineIn(b) });
    expect(breaks.pages[0]).toMatchObject({ error: null });
    expect(measuredOf(breaks).views[0]).toEqual({
      view: "desktop",
      faults: { ran: true, why: null, kinds: [], kindsCount: 0, elementsCount: 0, worstContrast: null },
      keyboard: notWalked,
      reduced: { ran: true, runningCount: 0, running: [], videosPlaying: 0 },
    });
    // Its own limit: the first run above waits ten seconds of the clock out
    // in a real process before the second starts.
  }, 60_000);

  it("leaves `loadMs` out when the slow load does not finish in what is left of the page's time, and the page's pictures stand", async () => {
    // The stand-in never finishes this page's load once the line is held.
    const b = bench({ "page.html": "<p>fake-slow-line:never</p>" });
    // CANARY: wait for that load as for any other and the page's own limit
    // ends it: "the render ran past 6 seconds", for a page that was pictured.
    const report = await b.run({ pages: ["page.html"], views: [DESKTOP], measure: true, pageTimeoutMs: 6_000 });
    expect(report.pages[0]).toMatchObject({ error: null });
    expect(report.pages[0]!.shots.map((shot) => shot.file)).toEqual(["1-desktop.png"]);
    expect(measuredOf(report)).toMatchObject({ loadMs: null, line: "1.6 Mbit/s down, 150 ms" });
    // What was measured before it stands too, and the engine nobody named
    // is said not to have run. (On a machine so loaded that the page's time
    // went before the engine's turn, that is the reason it gives.)
    const { faults } = measuredOf(report).views[0]!;
    expect(faults.ran).toBe(false);
    expect(["no accessibility engine is installed", "the page's time ran out before it was measured"]).toContain(faults.why);
  });
});

