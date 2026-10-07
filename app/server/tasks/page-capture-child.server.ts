import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

/**
 * Ruling 691: the renderer behind every page picture.
 *
 * A delivered page (HTML or markdown) is judged from its source, and the
 * source does not show a broken table, a missing picture or a layout that
 * falls apart on a phone. So Viberr renders the page in a headless browser and
 * keeps the picture. This script is that render, and it is a process of its
 * own on purpose: the browser runs a page's scripts with no sandbox
 * (`specialist-browser-mcp.server.ts` says why the image's Chromium cannot
 * start one), so it must run as the task owner's agent user and never as the
 * server. `page-capture.server.ts` starts it through the ruling 460 launcher,
 * hands it one job, and reads back PNG files it checks by their own header.
 *
 * What it does, per page:
 *
 *  - **Serves the page to the browser itself.** A loopback server on a random
 *    port, every path under a random token, one file name deep (the task
 *    folder is flat), opened without following a link. Loaded over http and
 *    not `file://`, a page cannot pull a file off the disk into the picture.
 *  - **Sets a markdown file as an article first**, with the pipeline the app's
 *    own preview uses (react-markdown with remark-gfm and no raw HTML).
 *  - **Starts one browser for the page** with no way out: every request but
 *    the page server's goes to a closed proxy port, and the page's own
 *    response carries a policy that allows only itself. The picture shows what
 *    the delivered files contain, in bounded time, and what the page asked the
 *    network for is reported, not hidden.
 *  - **Pictures it at each width**: loads it at that viewport, walks it once
 *    from top to bottom so lazy pictures and scroll-in sections are drawn as
 *    for a reader who scrolled, then takes the page from `from` down to the
 *    view's cap. A picture too large to hand to an agent is retaken shorter.
 *
 * Run as `node page-capture-child.server.ts '<job json>'`. It writes
 * `<out>/<n>-<view>.png` and `<out>/report.json` and prints nothing the server
 * parses. Node runs it as TypeScript; it imports only `node:` modules and
 * declared packages, and nothing in the app imports it.
 */

const jobSchema = z.object({
  /** The folder the page and its sibling files are served from. */
  root: z.string().min(1),
  /** Where the pictures and the report go. */
  out: z.string().min(1),
  /** A scratch folder for the browser's profile, one below it per page. */
  profile: z.string().min(1),
  /** The browser executable. */
  browser: z.string().min(1),
  pages: z.array(z.object({ file: z.string().min(1), kind: z.enum(["html", "markdown"]) })),
  views: z.array(
    z.object({
      id: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** The tallest picture this view takes. */
      maxHeight: z.number().int().positive(),
      mobile: z.boolean(),
      /** Where on the page the picture starts, in px from the top. */
      from: z.number().int().nonnegative(),
    }),
  ),
  /** How long one page gets for all its views, browser start included. */
  pageTimeoutMs: z.number().int().positive(),
  /** The largest PNG a view may be; over it the picture is retaken shorter. */
  maxBytes: z.number().int().positive(),
});
type Job = z.infer<typeof jobSchema>;
type JobPage = Job["pages"][number];
type JobView = Job["views"][number];

/** One picture as the report states it. */
interface Shot {
  view: string;
  width: number;
  /** The picture's own height in px. */
  height: number;
  /** Where on the page it starts. */
  from: number;
  /** The page's full height and width at this view, in the picture's px. */
  contentHeight: number;
  contentWidth: number;
  /** Under 1 when a phone shrank a page it lays out wider than its screen. */
  scale: number;
  /** The page runs on below the picture. */
  cut: boolean;
}

/** One page as the report states it. */
interface PageReport {
  file: string;
  shots: Shot[];
  /** Hosts the page asked the network for, and how many addresses in all. */
  asked: string[];
  askedCount: number;
  /** Names it asked the page server for that are not among the files. */
  missing: string[];
  error: string | null;
}

/** A markdown source past this is not set as a page. */
const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
/** How many hosts and missing names one page's report lists. */
const REPORT_LIST_MAX = 12;
/** The name a markdown file's article is served under: a dot name, so it can
 *  never be a task file (the page server refuses every other dot name). */
const ARTICLE_NAME = ".viberr-render.html";
/** After its window is asked to close, how long a browser has before its
 *  group is killed. */
const CLOSE_GRACE_MS = 2_000;

/**
 * The stylesheet a markdown file is set in. System colours only, so the page
 * reads as a plain article and no colour is chosen here.
 */
const ARTICLE_CSS = [
  ":root { color-scheme: light; }",
  "html { background: Canvas; color: CanvasText; }",
  // No `system-ui`: the image's Chromium resolves it to a monospace face
  // (measured, Debian Chromium 154 with fonts-liberation only).
  'body { margin: 0; font: 17px/1.6 "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif; }',
  "main { max-width: 70ch; margin: 0 auto; padding: 40px 20px 72px; }",
  "h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }",
  "h1 { font-size: 1.9em; margin-top: 0; }",
  "img { max-width: 100%; height: auto; }",
  'pre, code { font-family: ui-monospace, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; }',
  "pre { border: 1px solid GrayText; padding: 12px 14px; overflow-x: auto; }",
  "table { border-collapse: collapse; margin: 1.2em 0; }",
  "th, td { border: 1px solid GrayText; padding: 6px 10px; text-align: left; vertical-align: top; }",
  "blockquote { margin: 1.2em 0; padding-left: 16px; border-left: 3px solid GrayText; }",
  "a { color: LinkText; }",
].join("\n");

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"],
  [".csv", "text/plain; charset=utf-8"],
]);

/** What every answer of the page server carries: the page may use itself and
 *  nothing else, and nothing is kept between loads. */
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "cache-control": "no-store",
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A markdown source as a whole article page. Raw HTML in it stays text. */
function articlePage(file: string, source: string): string {
  const body = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, source));
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(file)}</title>\n<style>\n${ARTICLE_CSS}\n</style>\n</head>\n` +
    `<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`
  );
}

interface OpenFile {
  fd: number;
  size: number;
}

/** Open `name` in `root` as a regular file, never through a link (ruling
 *  552's rule, in the process that needs it); null when it is anything else. */
function openRegular(root: string, name: string): OpenFile | null {
  let fd: number;
  try {
    fd = openSync(
      path.join(root, name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size };
  } catch {
    // Closed below.
  }
  closeSync(fd);
  return null;
}

/** The loopback server a page is loaded from. */
interface PageServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** `<origin>/<token>/`. */
  base: string;
  port: number;
  /** Set the article served for a markdown page (null for an HTML page) and
   *  start a fresh list of names asked for and not found. */
  begin(article: string | null): void;
  missing(): string[];
  close(): Promise<void>;
}

const listenAddressSchema = z.looseObject({ port: z.number().int().positive() });

function startPageServer(root: string): Promise<PageServer> {
  const token = randomBytes(8).toString("hex");
  const prefix = `/${token}/`;
  let article: string | null = null;
  let missing = new Set<string>();

  const refuse = (res: ServerResponse): void => {
    res.writeHead(404, { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  };

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const raw = (req.url ?? "").split("?")[0] ?? "";
    if ((req.method !== "GET" && req.method !== "HEAD") || !raw.startsWith(prefix)) {
      refuse(res);
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(raw.slice(prefix.length));
    } catch {
      refuse(res);
      return;
    }
    if (name === ARTICLE_NAME && article !== null) {
      res.writeHead(200, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : article);
      return;
    }
    // One file name deep: the task folder is flat, and a dot name is never a
    // task file.
    const flat = name !== "" && !/[/\\\0]/.test(name) && !name.startsWith(".");
    const file = flat ? openRegular(root, name) : null;
    if (!file) {
      if (name !== "") missing.add(name);
      refuse(res);
      return;
    }
    res.writeHead(200, {
      ...PAGE_HEADERS,
      "content-type": CONTENT_TYPES.get(path.extname(name).toLowerCase()) ?? "application/octet-stream",
      "content-length": String(file.size),
    });
    if (req.method === "HEAD") {
      closeSync(file.fd);
      res.end();
      return;
    }
    createReadStream("", { fd: file.fd, autoClose: true })
      .on("error", () => res.destroy())
      .pipe(res);
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer(answer);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = listenAddressSchema.parse(server.address());
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        base: `${origin}${prefix}`,
        port,
        begin(next) {
          article = next;
          missing = new Set();
        },
        missing: () => [...missing].slice(0, REPORT_LIST_MAX),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// ------------------------------------------------------------ the browser

const cdpMessageSchema = z.looseObject({
  id: z.number().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.looseObject({}).optional(),
  result: z.looseObject({}).optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});
type CdpMessage = z.infer<typeof cdpMessageSchema>;
type CdpFields = NonNullable<CdpMessage["result"]>;

/** What a command sends: plain JSON values. */
type CdpParams = { [key: string]: string | number | boolean | CdpParams };

interface Waiting {
  resolve(result: CdpFields): void;
  reject(error: Error): void;
}

/**
 * The little of the DevTools protocol this script speaks, over the browser's
 * `--remote-debugging-pipe`: the browser reads commands on its fd 3 and writes
 * answers and events on its fd 4, each a JSON message ended by a NUL.
 */
class Browser {
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private listeners = new Set<(message: CdpMessage) => void>();
  private pending: Buffer = Buffer.alloc(0);
  private gone: Error | null = null;
  private readonly toBrowser: Writable;
  private readonly child: ChildProcess;
  /** Resolves once the browser's process has ended. */
  readonly ended: Promise<void>;

  constructor(executable: string, args: readonly string[]) {
    // Its own process group, so a page that never finishes takes every
    // renderer down with it when the group is killed.
    this.child = spawn(executable, [...args], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      detached: true,
    });
    // SAFETY: stdio above declares fd 3 and 4 as pipes; 3 is the browser's
    // input (ours to write), 4 its output (ours to read).
    this.toBrowser = this.child.stdio[3] as Writable;
    // SAFETY: as above.
    const fromBrowser = this.child.stdio[4] as Readable;
    this.toBrowser.on("error", () => {});
    fromBrowser.on("error", () => {});
    fromBrowser.on("data", (chunk: Buffer) => this.read(chunk));
    this.ended = new Promise((done) => {
      this.child.once("error", (error) => {
        this.fail(new Error(`the browser could not be started (${error.message})`));
        done();
      });
      this.child.once("exit", () => {
        this.fail(new Error("the browser ended before the page was pictured"));
        done();
      });
    });
  }

  private read(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    for (;;) {
      const end = this.pending.indexOf(0);
      if (end < 0) return;
      const text = this.pending.subarray(0, end).toString("utf8");
      this.pending = this.pending.subarray(end + 1);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      const parsed = cdpMessageSchema.safeParse(value);
      if (parsed.success) this.dispatch(parsed.data);
    }
  }

  private dispatch(message: CdpMessage): void {
    if (message.id === undefined) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "the browser refused a command"));
    else waiter.resolve(message.result ?? {});
  }

  private fail(error: Error): void {
    if (this.gone) return;
    this.gone = error;
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  send(method: string, params: CdpParams, sessionId?: string): Promise<CdpFields> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
      this.toBrowser.write(`${JSON.stringify(message)}\0`);
    });
  }

  /** Every event of one session until the returned function is called. */
  listen(sessionId: string, on: (method: string, params: CdpFields) => void): () => void {
    const listener = (message: CdpMessage): void => {
      if (message.sessionId === sessionId && message.method !== undefined) on(message.method, message.params ?? {});
    };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** False once the browser's process has ended or could not start. */
  get alive(): boolean {
    return this.gone === null;
  }

  /** End the browser's whole group now. */
  kill(): void {
    const pid = this.child.pid;
    if (pid !== undefined && pid > 1) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // The group is gone; the process alone, below.
      }
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The flags one page's browser starts with. Only the page server is
 *  reachable: every other request, loopback included, goes to a closed proxy
 *  port. `--no-sandbox` for the reason the browser mount gives. */
function browserArgs(profile: string, port: number): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--proxy-server=http://127.0.0.1:9",
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`,
    // A peer connection would otherwise send UDP past the proxy.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    // No keyring: the cookie store asks the system's for a key before the
    // first request leaves, and a fresh home has none to answer. Measured on
    // macOS Chrome 155: one page load in three never started without these.
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ];
}

/**
 * Run in the page before it is pictured: wait for its fonts, walk it from the
 * top to the end of the stretch in viewport steps, come back, and let what
 * the walk started finish. Lazy pictures and scroll-in sections are then
 * drawn as for a reader who scrolled.
 */
function walkExpression(view: JobView): string {
  const end = view.from + view.maxHeight;
  return `(async () => {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  try { await Promise.race([document.fonts.ready, pause(3000)]); } catch {}
  const root = document.documentElement;
  const step = ${view.height};
  const end = Math.min(Math.max(root ? root.scrollHeight : 0, document.body ? document.body.scrollHeight : 0), ${end});
  for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await pause(80); }
  window.scrollTo(0, 0);
  const loading = Array.from(document.images).filter((img) => !img.complete).map((img) => new Promise((done) => {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  }));
  await Promise.race([Promise.all(loading), pause(2000)]);
  await pause(300);
  return location.href;
})()`;
}

const navigateResultSchema = z.looseObject({ errorText: z.string().optional() });
const walkResultSchema = z.looseObject({
  result: z.looseObject({ value: z.string().optional().catch(undefined) }).optional(),
});
const layoutSchema = z.looseObject({
  cssContentSize: z.looseObject({ width: z.number(), height: z.number() }),
  /** `scale` is how far a phone shrinks a page laid out wider than its
   *  screen (a page that sets no viewport is laid out 980 px wide). */
  cssVisualViewport: z.looseObject({ scale: z.number().positive() }),
});
const screenshotSchema = z.looseObject({ data: z.string() });
const requestEventSchema = z.looseObject({ request: z.looseObject({ url: z.string() }) });
/** A request the page's own policy stopped before it left: the browser
 *  reports it as an issue, and only some of them as a request. */
const blockedEventSchema = z.looseObject({
  issue: z.looseObject({
    details: z.looseObject({
      contentSecurityPolicyIssueDetails: z.looseObject({ blockedURL: z.string() }),
    }),
  }),
});

/** What one page asked for beyond its own server. */
interface Asked {
  hosts: Set<string>;
  urls: Set<string>;
}

function noteRequest(asked: Asked, url: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return;
  }
  if (parsed.origin === origin) return;
  asked.urls.add(parsed.href);
  asked.hosts.add(parsed.host);
}

interface ViewContext {
  browser: Browser;
  sessionId: string;
  url: string;
  /** The page server's origin: where a page must still be when pictured. */
  origin: string;
  out: string;
  maxBytes: number;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Resolves at the session's next load event. */
function nextLoad(browser: Browser, sessionId: string): Promise<void> {
  return new Promise((done) => {
    const stop = browser.listen(sessionId, (method) => {
      if (method !== "Page.loadEventFired") return;
      stop();
      done();
    });
  });
}

/** How often a page may move to another document under the walk before it is
 *  given up on, and how long each move gets to load. */
const WALK_ATTEMPTS = 3;
const MOVE_WAIT_MS = 2_000;

/**
 * Walk the page, and say where it ended up. A page that sends the browser on
 * (a redirect stub, a script that sets `location`) ends the walk under it, so
 * the walk is taken again on the document that loaded. One that left the page
 * server is not pictured: what would be drawn is the browser's own error page.
 */
async function walkPage(ctx: ViewContext, view: JobView): Promise<void> {
  const { browser, sessionId } = ctx;
  for (let attempt = 1; ; attempt += 1) {
    const moved = nextLoad(browser, sessionId);
    let walked: z.infer<typeof walkResultSchema>;
    try {
      walked = walkResultSchema.parse(
        await browser.send(
          "Runtime.evaluate",
          { expression: walkExpression(view), awaitPromise: true, returnByValue: true },
          sessionId,
        ),
      );
    } catch (error) {
      if (!browser.alive) throw error;
      if (attempt >= WALK_ATTEMPTS) {
        throw new Error("the page kept moving to another address while it was being pictured", { cause: error });
      }
      await Promise.race([moved, pause(MOVE_WAIT_MS)]);
      continue;
    }
    const address = walked.result?.value;
    if (address !== undefined && !address.startsWith(`${ctx.origin}/`)) {
      throw new Error("the page sent the browser to another address, and a capture loads only the task's own files");
    }
    return;
  }
}

interface PictureSize {
  width: number;
  height: number;
}

/** A PNG's own width and height, from its header; null when it has none. */
function pngSize(bytes: Buffer): PictureSize | null {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Picture the page at one view. The stretch starts at `view.from`, is never
 *  less than one screen and never more than the view's cap. Heights and
 *  widths are in the picture's own px: what the screen shows, after a phone
 *  has shrunk a page it lays out wider than itself. */
async function pictureView(ctx: ViewContext, view: JobView, file: string): Promise<Shot> {
  const { browser, sessionId } = ctx;
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile },
    sessionId,
  );
  const loaded = nextLoad(browser, sessionId);
  const navigated = navigateResultSchema.parse(await browser.send("Page.navigate", { url: ctx.url }, sessionId));
  if (navigated.errorText) throw new Error(`the page did not load (${navigated.errorText})`);
  await loaded;
  await walkPage(ctx, view);
  const layout = layoutSchema.parse(await browser.send("Page.getLayoutMetrics", {}, sessionId));
  const scale = Math.min(Math.max(layout.cssVisualViewport.scale, 0.1), 5);
  const contentWidth = Math.round(layout.cssContentSize.width * scale);
  const contentHeight = Math.round(layout.cssContentSize.height * scale);
  // A page shorter than the screen is still pictured as one screen.
  const pageHeight = Math.max(contentHeight, view.height);
  if (view.from >= pageHeight) {
    throw new Error(`the page is ${pageHeight} px tall at this width, so nothing starts at ${view.from} px`);
  }
  let height = Math.min(pageHeight - view.from, view.maxHeight);
  for (;;) {
    const shot = screenshotSchema.parse(
      await browser.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: view.from / scale, width: view.width / scale, height: height / scale, scale },
        },
        sessionId,
      ),
    );
    const bytes = Buffer.from(shot.data, "base64");
    if (bytes.length <= ctx.maxBytes) {
      const size = pngSize(bytes);
      if (!size) throw new Error("the browser returned a picture that is not a PNG");
      writeFileSync(path.join(ctx.out, file), bytes);
      return {
        view: view.id,
        width: size.width,
        height: size.height,
        from: view.from,
        contentHeight,
        contentWidth,
        scale,
        cut: view.from + height < pageHeight,
      };
    }
    // Too large to hand to an agent: half as tall, down to one screen.
    const floor = Math.min(view.height, height);
    if (height <= floor) throw new Error("the picture of one screen of it is too large to keep");
    height = Math.max(Math.ceil(height / 2), floor);
  }
}

/** The browser of the page being pictured, so a stop ends it too. */
let current: Browser | null = null;

const targetSchema = z.looseObject({ targetId: z.string() });
const sessionSchema = z.looseObject({ sessionId: z.string() });

/** Picture one page at every view in a browser of its own, inside the page's
 *  time limit. Never rejects. */
async function picturePage(job: Job, server: PageServer, page: JobPage, index: number): Promise<PageReport> {
  const asked: Asked = { hosts: new Set(), urls: new Set() };
  const shots: Shot[] = [];
  const report = (error: string | null): PageReport => ({
    file: page.file,
    shots,
    asked: [...asked.hosts].slice(0, REPORT_LIST_MAX),
    askedCount: asked.urls.size,
    missing: server.missing(),
    error,
  });

  let url = server.base + encodeURIComponent(page.file);
  let article: string | null = null;
  if (page.kind === "markdown") {
    const source = openRegular(job.root, page.file);
    if (!source) return report("the file is not there to render");
    try {
      if (source.size > MARKDOWN_MAX_BYTES) {
        return report(`the markdown file is ${source.size} bytes; one of up to ${MARKDOWN_MAX_BYTES} is set as a page`);
      }
      article = articlePage(page.file, readFileSync(source.fd, "utf8"));
    } finally {
      closeSync(source.fd);
    }
    url = server.base + ARTICLE_NAME;
  }
  server.begin(article);

  const profile = path.join(job.profile, String(index + 1));
  mkdirSync(profile, { recursive: true });
  const browser = new Browser(job.browser, browserArgs(profile, server.port));
  current = browser;
  let timer: NodeJS.Timeout | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the render ran past ${Math.round(job.pageTimeoutMs / 1000)} seconds`)),
      job.pageTimeoutMs,
    );
  });
  const work = (async (): Promise<void> => {
    const target = targetSchema.parse(await browser.send("Target.createTarget", { url: "about:blank" }));
    const session = sessionSchema.parse(
      await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
    );
    const sessionId = session.sessionId;
    const stop = browser.listen(sessionId, (method, params) => {
      if (method === "Network.requestWillBeSent") {
        const event = requestEventSchema.safeParse(params);
        if (event.success) noteRequest(asked, event.data.request.url, server.origin);
      } else if (method === "Audits.issueAdded") {
        const event = blockedEventSchema.safeParse(params);
        if (event.success) {
          const blocked = event.data.issue.details.contentSecurityPolicyIssueDetails.blockedURL;
          noteRequest(asked, blocked, server.origin);
        }
      }
    });
    const ctx: ViewContext = { browser, sessionId, url, origin: server.origin, out: job.out, maxBytes: job.maxBytes };
    try {
      await browser.send("Page.enable", {}, sessionId);
      await browser.send("Network.enable", {}, sessionId);
      await browser.send("Audits.enable", {}, sessionId);
      for (const view of job.views) {
        shots.push(await pictureView(ctx, view, `${index + 1}-${view.id}.png`));
      }
    } finally {
      stop();
    }
  })();
  let error: string | null = null;
  try {
    await Promise.race([work, expired]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  if (timer) clearTimeout(timer);
  // A page that failed part way leaves `work` to reject with the browser.
  work.catch(() => {});
  if (error === null) {
    browser.send("Browser.close", {}).catch(() => {});
    const grace = setTimeout(() => browser.kill(), CLOSE_GRACE_MS);
    await browser.ended;
    clearTimeout(grace);
  }
  // Whatever the browser left running goes with its group.
  browser.kill();
  await browser.ended;
  current = null;
  return report(error);
}

async function main(): Promise<number> {
  let job: Job;
  try {
    job = jobSchema.parse(JSON.parse(process.argv[2] ?? ""));
  } catch (error) {
    process.stderr.write(
      `usage: page-capture-child.server.ts '<job json>' (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return 2;
  }
  mkdirSync(job.out, { recursive: true });
  const pages: PageReport[] = [];
  const writeReport = (): void => {
    writeFileSync(path.join(job.out, "report.json"), `${JSON.stringify({ pages }, null, 2)}\n`);
  };
  // Stopped from outside (the job's own limit): the browser goes first, and
  // the pages already pictured are still reported.
  const stopped = (): void => {
    current?.kill();
    writeReport();
    process.exit(143);
  };
  process.on("SIGTERM", stopped);
  process.on("SIGINT", stopped);
  const server = await startPageServer(job.root);
  try {
    for (const [index, page] of job.pages.entries()) {
      pages.push(await picturePage(job, server, page, index));
      writeReport();
    }
  } finally {
    await server.close();
  }
  writeReport();
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
