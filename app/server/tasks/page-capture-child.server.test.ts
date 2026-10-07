import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { writeFakeBrowser, type FakeBrowser } from "../../../test-support/fake-browser";
import { createTempDirs } from "../../../test-support/temp-dirs";

/**
 * Ruling 691, through the real renderer child as a real process: the page
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
});
const reportSchema = z.object({
  pages: z.array(
    z.object({
      file: z.string(),
      shots: z.array(shotSchema),
      ended: z.array(z.object({ view: z.string(), pageHeight: z.number() })),
      dialogs: z.number(),
      asked: z.array(z.string()),
      askedCount: z.number(),
      missing: z.array(z.string()),
      error: z.string().nullable(),
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
}

const DESKTOP: View = { id: "desktop", width: 1280, height: 800, maxHeight: 4800, mobile: false, from: 0 };
const PHONE: View = { id: "phone", width: 390, height: 844, maxHeight: 5064, mobile: true, from: 0 };

const temp = createTempDirs();
afterAll(temp.cleanup);

interface Bench {
  /** The folder the pages are served from. */
  root: string;
  out: string;
  browser: FakeBrowser;
  run(input: {
    pages: string[];
    views?: View[];
    mode?: string;
    pageTimeoutMs?: number;
    maxBytes?: number;
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
        pages: input.pages.map((file) => ({ file, kind: file.endsWith(".md") ? "markdown" : "html" })),
        views: input.views ?? [DESKTOP, PHONE],
        pageTimeoutMs: input.pageTimeoutMs ?? 20_000,
        maxBytes: input.maxBytes ?? 3_750_000,
      };
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD, JSON.stringify(job)], {
          env: { ...process.env, ...browser.env(input.mode ?? "") },
          stdio: ["ignore", "ignore", "pipe"],
        });
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
          resolve(reportSchema.parse(JSON.parse(readFileSync(report, "utf8"))));
        });
      });
    },
  };
}

/** A PNG's own width and height, from its header. */
function pngSize(file: string) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the page capture's renderer child (ruling 691)", () => {
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
    // Each view loads the page at its own viewport.
    expect(b.browser.pages().slice(0, 2).map((page) => page.metrics)).toEqual([
      { width: 1280, height: 800, mobile: false },
      { width: 390, height: 844, mobile: true },
    ]);

    // A stretch for an agent: from 2,000 px down, at most 2,000 px tall.
    const stretch = bench({ "long.html": "<p>fake-height:5000</p>", "wide.html": "<p>fake-scale:0.5 fake-width:390</p>" });
    const second = await stretch.run({
      pages: ["long.html"],
      views: [{ ...DESKTOP, maxHeight: 2000, from: 2000 }],
    });
    expect(second.pages[0]!.shots).toEqual([
      { view: "desktop", width: 1280, height: 2000, from: 2000, contentHeight: 5000, contentWidth: 1280, scale: 1, cut: true },
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
    expect(b.browser.dialogs()).toEqual([{ accept: false }, { accept: false }]);
  });

  it("finds a page and the file beside it in whichever Unicode form they are stored", async () => {
    // Ruling 675's rule in the renderer's own process: a file uploaded from a
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
});
