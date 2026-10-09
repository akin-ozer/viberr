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
  readdirSync,
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
 * Ruling 194: the renderer behind every page picture.
 *
 * A delivered page (HTML or markdown) is judged from its source, and the
 * source does not show a broken table, a missing picture or a layout that
 * falls apart on a phone. So Viberr renders the page in a headless browser and
 * keeps the picture. This script is that render, and it is a process of its
 * own on purpose: the browser runs a page's scripts with no sandbox
 * (`specialist-browser-mcp.server.ts` says why the image's Chromium cannot
 * start one), so it must run as the task owner's agent user and never as the
 * server. `page-capture.server.ts` starts it through the ruling 139 launcher,
 * hands it one job, and reads back PNG files it checks by their own header.
 *
 * What it does, per page:
 *
 *  - **Serves the page to the browser itself.** A loopback server on a random
 *    port, every path under a random token, one file name deep (the task
 *    folder is flat), opened without following a link. Loaded over http and
 *    not `file://`, a page cannot pull a file off the disk into the picture.
 *  - **Sets a markdown file as an article first**, with the pipeline the app's
 *    own preview uses (react-markdown with remark-gfm and no raw HTML), and
 *    **an SVG drawing as a page that holds nothing else**, inline, so it loads
 *    the files saved beside it as an HTML page does.
 *  - **Starts one browser for the page** with no way out: every request but
 *    the page server's goes to a closed proxy port, and the page's own
 *    response carries a policy that allows only itself. The picture shows what
 *    the delivered files contain, in bounded time, and what the page asked the
 *    network for is reported, not hidden.
 *  - **Pictures it at each width**: loads it at that viewport, walks it once
 *    from top to bottom so lazy pictures and scroll-in sections are drawn as
 *    for a reader who scrolled, then takes the page from `from` down to the
 *    view's cap. A picture too large to hand to an agent is retaken shorter,
 *    and a width at which the page ends before `from` is reported as ended
 *    while the other width is still pictured.
 *  - **Or pictures it as one box of an exact size** (ruling 194, a view with
 *    `box`): laid out in a viewport of that size and cut to it from the top
 *    left, as a PNG of exactly the box times its scale. That one is never
 *    retaken shorter: a picture of another size is not the one asked for.
 *  - **Or shows it in a state** (ruling 194, a view with `act`): after the
 *    load and the walk it presses Tab, presses a control or puts the pointer
 *    on one, with the key and pointer events a reader's own hands send, and
 *    pictures the one screen the window then shows. An act that cannot be
 *    done is said in the report and costs the page nothing else.
 *  - **Dismisses a dialog the page opens.** `alert()`, `confirm()` and
 *    `prompt()` stop a page until somebody answers, and nobody is there: each
 *    is dismissed and counted, so the page loads on and the report says so.
 *
 * Run as `node page-capture-child.server.ts` with the job, as JSON, on its
 * standard input (never an argument: a job names every file of a delivery
 * and can be past what the kernel takes as one). It writes
 * `<out>/<n>-<view>.png` and `<out>/report.json` and prints nothing the server
 * parses. Node runs it as TypeScript; it imports only `node:` modules and
 * declared packages, and nothing in the app imports it.
 */

const pageSchema = z.object({
  /** A task file's name. For a page on the web, the label its report
   *  carries. */
  file: z.string().min(1),
  kind: z.enum(["html", "markdown", "svg", "web"]),
  /** With `web`: the http or https address to open. */
  url: z.string().optional(),
});
type JobPage = z.infer<typeof pageSchema>;

const actSchema = z.object({
  /** So many presses of Tab, from the top of the page. */
  tab: z.number().int().positive().optional(),
  /** A control to press: its visible words, or a CSS selector. */
  press: z.string().trim().min(1).optional(),
  /** A control to put the pointer on, named the same way. */
  hover: z.string().trim().min(1).optional(),
});

const viewSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The tallest picture this view takes. */
  maxHeight: z.number().int().positive(),
  mobile: z.boolean(),
  /** Where on the page the picture starts, in px from the top. */
  from: z.number().int().nonnegative(),
  /** Set for a picture of an exact size: the view is one box, `width` by
   *  `height` CSS px from the page's top left, and `scale` is how many
   *  picture px draw one CSS px. Absent for a stretch of the page. */
  box: z.object({ scale: z.number().positive() }).optional(),
  /** Picture the page from `from` down to its end, in stretches of up to
   *  `maxHeight`, at most `stretches` of them (one when it names none). */
  whole: z.boolean().optional(),
  stretches: z.number().int().positive().optional(),
  /** Ask the page for reduced motion before it loads. Goes with any kind. */
  reduce: z.boolean().optional(),
  /** Do this on the loaded page, then picture the screen as it stands. */
  act: actSchema.optional(),
  /** Picture the screen at `from` at three moments while it moves. */
  moving: z.boolean().optional(),
});
type JobView = z.infer<typeof viewSchema>;

/** When a moving view is pictured, in ms after its screen came into view. */
const MOVING_MOMENTS = [250, 1_000, 3_000];

/**
 * The pictures a view writes, as their names in `out` without the page's
 * number and the extension: `<view>` for a stretch or a box, `-s2`, `-s3` for
 * the further stretches of a whole page, `-m1` to `-m3` for the frames of a
 * moving screen, `-a` for an act.
 */
function pictureNames(view: JobView): string[] {
  if (view.act) return [`${view.id}-a`];
  if (view.moving === true) return MOVING_MOMENTS.map((_, at) => `${view.id}-m${at + 1}`);
  const further = view.whole === true ? (view.stretches ?? 1) - 1 : 0;
  return [view.id, ...Array.from({ length: further }, (_, at) => `${view.id}-s${at + 2}`)];
}

/** A page on the web's address, when it is one a browser is sent to. */
function webAddress(url: string | undefined): URL | null {
  if (url === undefined || !URL.canParse(url)) return null;
  const address = new URL(url);
  return address.protocol === "http:" || address.protocol === "https:" ? address : null;
}

/**
 * What is wrong with a job as a whole, which no one key shows. A view is one
 * kind of picture (a stretch, a box, a whole page, an act or a moving screen),
 * an act names something to do, and no two views write one picture: two of
 * one id and one kind would, and so would a stretch, a box and a whole page
 * of one id, whose first pictures share a name. A page on the web is opened
 * with the network open, so it shares no job, and so no browser, with a task
 * page, and it is never a box.
 */
function jobFaults(pages: readonly JobPage[], views: readonly JobView[]): string[] {
  const faults: string[] = [];
  const written = new Set<string>();
  for (const view of views) {
    const kinds = [view.box ? "a box" : "", view.whole === true ? "a whole page" : "", view.act ? "an act" : "", view.moving === true ? "moving" : ""].filter(
      (kind) => kind !== "",
    );
    if (kinds.length > 1) faults.push(`the view ${view.id} is ${kinds.join(" and ")} at once`);
    if (view.act && view.act.tab === undefined && view.act.press === undefined && view.act.hover === undefined) {
      faults.push(`the act of the view ${view.id} names no tab, press or hover`);
    }
    for (const name of pictureNames(view)) {
      if (written.has(name)) faults.push(`two views write the picture ${name}`);
      written.add(name);
    }
  }
  const web = pages.filter((page) => page.kind === "web");
  if (web.length > 0 && web.length < pages.length) faults.push("a page on the web shares a job with a task page");
  for (const page of web) {
    if (!webAddress(page.url)) faults.push(`the page ${page.file} has no http or https address`);
  }
  if (web.length > 0 && views.some((view) => view.box)) faults.push("a page on the web is asked for as a box");
  return faults;
}

const jobSchema = z
  .object({
    /** The folder the page and its sibling files are served from. */
    root: z.string().min(1),
    /** The names `root` holds, when it is a folder this process may pass
     *  through and not list; absent when it can read the listing itself. */
    names: z.array(z.string()).optional(),
    /** Where the pictures and the report go. */
    out: z.string().min(1),
    /** A scratch folder for the browser's profile, one below it per page. */
    profile: z.string().min(1),
    /** The browser executable. */
    browser: z.string().min(1),
    pages: z.array(pageSchema),
    views: z.array(viewSchema),
    /** How long one page gets for all its views, browser start included. */
    pageTimeoutMs: z.number().int().positive(),
    /** The largest PNG a view may be; over it a stretch is retaken shorter and
     *  a box, which has one size, is not kept. */
    maxBytes: z.number().int().positive(),
    /** Measure each page too (the report's `measured`). */
    measure: z.boolean().optional(),
    /** The accessibility engine's script (axe-core's `axe.min.js`), by its
     *  absolute path. Without it that one check is reported as not run. */
    axe: z.string().min(1).optional(),
  })
  .superRefine((job, issues) => {
    for (const message of jobFaults(job.pages, job.views)) issues.addIssue({ code: "custom", message });
  });
type Job = z.infer<typeof jobSchema>;

/** One picture as the report states it. */
interface Shot {
  view: string;
  width: number;
  /** The picture's own height in px. */
  height: number;
  /** Where on the page it starts. */
  from: number;
  /** The page's full height and width at this view, in the picture's px. For
   *  a box they are in CSS px, the unit the box itself is given in, whatever
   *  scale it was drawn at. */
  contentHeight: number;
  contentWidth: number;
  /** Under 1 when a phone shrank a page it lays out wider than its screen. */
  scale: number;
  /** The page runs on below the picture. */
  cut: boolean;
  /** The picture's name in `out`, exactly as written. */
  file: string;
  /** On a frame of a moving view: how many ms after its screen came into
   *  view it was taken. */
  moment?: number;
}

/** A width at which the page is over before the stretch asked for starts. */
interface Ended {
  view: string;
  /** The page's height at this view, in the picture's px. */
  pageHeight: number;
}

/** What a view's act came to: what it did, or why it could not. One of the
 *  two is set. */
interface Act {
  view: string;
  done: string | null;
  error: string | null;
}

/** One page as the report states it. */
interface PageReport {
  file: string;
  shots: Shot[];
  /** The views with nothing at `from`: no picture, and no failure either. */
  ended: Ended[];
  /** One entry per view that carried an act. */
  acts: Act[];
  /** How many script dialogs the page opened, each dismissed. */
  dialogs: number;
  /** Hosts the page asked the network for, and how many addresses in all. */
  asked: string[];
  askedCount: number;
  /** What it asked the page server for and was not served: a name that is not
   *  among the files, or (starting with `/`) a path outside its own folder. */
  missing: string[];
  error: string | null;
}

/** A markdown source past this is not set as a page. */
const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
/** Nor is an SVG source past this. */
const DRAWING_MAX_BYTES = 10 * 1024 * 1024;
/** How many hosts and missing names one page's report lists. */
const REPORT_LIST_MAX = 12;
/** The name the page a source is set as is served under (a markdown file's
 *  article, a drawing's page): a dot name, so it can never be a task file
 *  (the page server refuses every other dot name). */
const SET_PAGE_NAME = ".viberr-render.html";
/** After its window is asked to close, how long a browser has before its
 *  group is killed. */
const CLOSE_GRACE_MS = 2_000;
/** The longest name and the longest sentence a report carries. A page's own
 *  words reach the report only through these: they are its author's text. */
const NAME_MAX = 80;
const SENTENCE_MAX = 200;
/** How many controls an act that found none names, and how much of each
 *  one's words. */
const ACT_NAMES_MAX = 12;
const ACT_NAME_MAX = 40;
/** How long what an act started gets before the screen is pictured: a focus
 *  ring's or a hover's transition, and after a press a menu's or a panel's. */
const AFTER_POINTER_MS = 400;
const AFTER_PRESS_MS = 700;
/** The longest reason an act carries: the name asked for, and every control
 *  the page named in its place. */
const ACT_ERROR_MAX = SENTENCE_MAX + ACT_NAMES_MAX * (ACT_NAME_MAX + 4);

/**
 * The stylesheet a markdown file is set in. System colours only, so the page
 * reads as a plain article and no colour is chosen here.
 */
const ARTICLE_CSS = [
  ":root { color-scheme: light; }",
  "html { background: Canvas; color: CanvasText; }",
  // No `system-ui`: with only fonts-liberation installed, Debian Chromium 154
  // drew it in a monospace face (measured), and an article must not depend on
  // the image's font defaults.
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

/**
 * The stylesheet a drawing is set in: nothing but the page's own box.
 * Measured in the image (Debian Chromium 154, 2026-10-08), in a 1200 by 630
 * viewport: an inline `<svg>` sits on a text line, so a drawing 630 px tall
 * made a page 634 px tall, which would be said to overflow its box
 * (`display: block`); and one sized `height="100%"` was 150 px tall, the
 * default, where the same file opened by itself fills the window
 * (`height: 100%` on the page).
 */
const DRAWING_CSS = ["html, body { margin: 0; height: 100%; }", "body > svg { display: block; }"].join("\n");

/**
 * Ruling 194: an SVG source as a whole page, the drawing itself, inline, at
 * the page's top left. Inline and not as an `<img>` on purpose: a drawing shown as an
 * image loads nothing, and this one asks the page server for the files saved
 * beside it (a picture, a font) by name, as an HTML page does. Its markup is
 * the page's, so a script in it runs as one in an HTML page would.
 */
function drawingPage(file: string, source: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${escapeHtml(file)}</title>\n<style>\n${DRAWING_CSS}\n</style>\n</head>\n` +
    // A byte order mark would be text ahead of the drawing: a line of its
    // own, which moved the drawing 18 px down (measured as above).
    `<body>\n${source.replace(/^\uFEFF/, "")}\n</body>\n</html>\n`
  );
}

interface OpenFile {
  fd: number;
  size: number;
}

/** Open `name` in `root` as a regular file, never through a link (ruling
 *  19's rule, in the process that needs it); null when it is anything else. */
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

/** A name the page server answers at all: one file name deep (the task
 *  folder is flat), and never a dot name, which is never a task file. */
function servable(name: string): boolean {
  return name !== "" && !/[/\\\0]/.test(name) && !name.startsWith(".");
}

/**
 * Ruling 76's rule, restated here because this script imports nothing from
 * the app: among a folder's `entries`, a written name means the entry spelled
 * exactly so, else the single entry that composes to the same name. A Linux
 * directory holds names byte for byte, a file uploaded from a Mac may be
 * stored decomposed, and a page names its picture in the form its author
 * typed.
 */
function storedNameAmong(entries: readonly string[], name: string): string | null {
  if (entries.includes(name)) return name;
  const wanted = name.normalize("NFC");
  const same = entries.filter((entry) => entry.normalize("NFC") === wanted);
  return same.length === 1 ? same[0]! : null;
}

/** {@link openRegular} for a name somebody wrote: the file of exactly that
 *  name, else the one stored in the other Unicode form. `names` is the
 *  folder's listing when this process may not read it itself. */
function openStored(root: string, name: string, names: readonly string[] | undefined): OpenFile | null {
  const exact = openRegular(root, name);
  if (exact) return exact;
  let entries = names;
  if (!entries) {
    try {
      entries = readdirSync(root);
    } catch {
      return null;
    }
  }
  const stored = storedNameAmong(entries, name);
  // The entry of exactly that name was refused above (a link, a folder): its
  // twin in the other form is never served in its place.
  return stored === null || stored === name ? null : openRegular(root, stored);
}

/** A request path as its page wrote it, where it can be decoded. */
function pathAsWritten(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The loopback server a page is loaded from. */
interface PageServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** `<origin>/<token>/`. */
  base: string;
  port: number;
  /** Set the page a markdown file or a drawing is served as (null for an
   *  HTML page, which is served as it is) and start a fresh list of what was
   *  asked for and not served. */
  begin(setPage: string | null): void;
  missing(): string[];
  close(): Promise<void>;
}

const listenAddressSchema = z.looseObject({ port: z.number().int().positive() });

function startPageServer(root: string, names: readonly string[] | undefined): Promise<PageServer> {
  const token = randomBytes(8).toString("hex");
  const prefix = `/${token}/`;
  let setPage: string | null = null;
  let missing = new Set<string>();

  const refuse = (res: ServerResponse): void => {
    res.writeHead(404, { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  };

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const raw = (req.url ?? "").split("?")[0] ?? "";
    if (req.method !== "GET" && req.method !== "HEAD") {
      refuse(res);
      return;
    }
    if (!raw.startsWith(prefix)) {
      // A path from the site's root (`/css/site.css`) or above the page's
      // folder (`../up.png`): never served, and said, or the page is pictured
      // unstyled with no word of why. The path keeps its leading slash, which
      // no file name has. The browser asks for `/favicon.ico` by itself.
      if (raw !== "/favicon.ico") missing.add(pathAsWritten(raw));
      refuse(res);
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(raw.slice(prefix.length));
    } catch {
      // A name with a broken escape is no file's name: reported as written.
      missing.add(raw.slice(prefix.length));
      refuse(res);
      return;
    }
    if (name === SET_PAGE_NAME && setPage !== null) {
      res.writeHead(200, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : setPage);
      return;
    }
    const file = servable(name) ? openStored(root, name, names) : null;
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
          setPage = next;
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
type CdpParams = { [key: string]: string | number | boolean | CdpParams | CdpParams[] };

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

// -------------------------------------------------------- inside the page

/** What an in-page expression is asked with. */
type PageArgs = { [key: string]: string | number | boolean };

/**
 * What every expression below starts with, in the page's own JavaScript.
 *
 *  - `visible`: laid out with a box that is not empty, and not hidden.
 *  - `words`: what a control is called. Its `aria-label`, else its text, else
 *    its `value`, its `title` or the `alt` of a picture in it. A form field's
 *    text is what was typed into it, so a field is called by its label, its
 *    placeholder, its title or its name.
 *  - `kind`: what a control is, in a word: its `role`, else "link" for an
 *    `a`, "button" for a button-like `input`, "field" for any other, else its
 *    tag.
 */
const PAGE_HELPERS = `
const flat = (text) => String(text == null ? "" : text).replace(/\\s+/g, " ").trim();
const visible = (el) => {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
};
const tagOf = (el) => el.tagName.toLowerCase();
const words = (el) => {
  const label = flat(el.getAttribute("aria-label"));
  if (label) return label;
  if (el.matches("input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea")) {
    const named = el.labels && el.labels.length > 0 ? flat(el.labels[0].innerText) : "";
    return named || flat(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
  }
  const text = flat(el.innerText || el.textContent);
  if (text) return text;
  const picture = el.querySelector("img[alt]");
  return flat(el.value || el.getAttribute("title") || (picture ? picture.getAttribute("alt") : "") || el.getAttribute("alt"));
};
const kind = (el) => {
  const given = flat(el.getAttribute("role")).split(" ")[0].replace(/[^a-z]/gi, "").slice(0, 20);
  if (given) return given;
  const tag = tagOf(el);
  if (tag === "a") return "link";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
    return type === "checkbox" || type === "radio" ? type : "field";
  }
  return tag === "textarea" ? "field" : tag;
};
const centre = (el) => {
  const boxes = Array.from(el.getClientRects()).filter((box) => box.width > 0 && box.height > 0);
  const box = boxes[0] || el.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const KEPT = Symbol.for("viberr.kept");
`;

/**
 * An expression to run in the page: `body` is the body of an async function
 * that is handed `args` and the helpers above and returns JSON text. It opens
 * with a comment that names it and what it is asked with. A browser ignores
 * the comment, and the suite's stand-in browser, which runs no page, answers
 * by it (`test-support/fake-browser.ts`). The arguments are written with no
 * bare slash, so nothing in them can end the comment early.
 */
function inPage(name: string, args: PageArgs, body: string): string {
  const given = JSON.stringify(args).replaceAll("/", "\\/");
  return `/* viberr:${name} ${given} */ (async (args) => {${PAGE_HELPERS}${body}})(${given})`;
}

/** The controls an act looks among, and the ones a pointer is tried on. */
const CONTROLS =
  'a, button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
  'input[type="button"], input[type="submit"], label, [tabindex]';

/**
 * Find the control an act names, scroll it to the middle of the screen and
 * say where its centre is (the first line's, for a link that wraps). What it
 * is named by is read as a CSS selector first (the first visible match; text
 * that is no selector is no error), then as words: the visible control whose
 * own words are exactly these, whatever the case, else the one with the
 * fewest words that holds them.
 *
 * One bare word is read as words first. `Menu`, `Details` and `Search` are
 * each a selector too, of the `menu`, `details` and `search` elements, and a
 * page that has one would have its list pressed where its button was meant.
 * Nothing found answers with what the controls there are called.
 */
function findExpression(what: string): string {
  return inPage(
    "find",
    { what },
    `
  const controls = Array.from(document.querySelectorAll(${JSON.stringify(CONTROLS)})).filter(visible);
  const wanted = args.what.toLowerCase();
  const named = () => controls.find((el) => words(el).toLowerCase() === wanted) || null;
  const holding = () => {
    let best = null;
    let fewest = Infinity;
    for (const el of controls) {
      const said = words(el).toLowerCase();
      const count = said.split(" ").length;
      if (said.includes(wanted) && count < fewest) {
        best = el;
        fewest = count;
      }
    }
    return best;
  };
  const selected = () => {
    try {
      return Array.from(document.querySelectorAll(args.what)).find(visible) || null;
    } catch {
      return null;
    }
  };
  const el = /^[a-z][a-z0-9]*$/i.test(args.what) ? named() || holding() || selected() : selected() || named() || holding();
  if (!el) {
    const names = [];
    for (const control of controls) {
      const said = words(control).slice(0, ${ACT_NAME_MAX});
      if (said && !names.includes(said)) names.push(said);
    }
    return JSON.stringify({ found: null, names: names.slice(0, ${ACT_NAMES_MAX}), more: names.length > ${ACT_NAMES_MAX} });
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const at = centre(el);
  return JSON.stringify({ found: { x: at.x, y: at.y, name: kind(el) + ' "' + words(el).slice(0, ${ACT_NAME_MAX}) + '"' } });
`,
  );
}

/** What holds keyboard focus: nothing while it is on the page itself. */
const FOCUS_EXPRESSION = inPage(
  "focus",
  {},
  `
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return JSON.stringify({ on: null });
  return JSON.stringify({ on: { name: kind(el) + ' "' + words(el).slice(0, ${ACT_NAME_MAX}) + '"' } });
`,
);

/** Where the window is scrolled to, and the address it is at. */
const SCREEN_EXPRESSION = inPage("screen", {}, "return JSON.stringify({ x: window.scrollX, y: window.scrollY, href: location.href });");

const foundSchema = z.object({
  found: z.object({ x: z.number(), y: z.number(), name: z.string() }).nullable(),
  names: z.array(z.string()).optional(),
  more: z.boolean().optional(),
});
const focusSchema = z.object({ on: z.object({ name: z.string() }).nullable() });
const screenSchema = z.object({ x: z.number(), y: z.number(), href: z.string() });

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
/** What an in-page expression came to: the text it returned, or what the
 *  page threw under it. */
const evaluatedSchema = z.looseObject({
  result: z.looseObject({ value: z.string().optional().catch(undefined) }).optional(),
  exceptionDetails: z
    .looseObject({ exception: z.looseObject({ description: z.string().optional().catch(undefined) }).optional() })
    .optional(),
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

/** A script dialog the page opened: `alert`, `confirm`, `prompt`, or the
 *  question a page asks before it lets the browser leave it. */
const dialogEventSchema = z.looseObject({ type: z.string().optional() });

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

/** What picturing a page has come to so far. Filled as each picture is
 *  taken, so a page that fails part way still reports the ones before. */
interface Pictures {
  shots: Shot[];
  /** The views with nothing at `from`: no picture, and no failure either. */
  ended: Ended[];
  acts: Act[];
}

interface ViewContext {
  browser: Browser;
  sessionId: string;
  url: string;
  /** The page server's origin: where a page must still be when pictured. */
  origin: string;
  out: string;
  maxBytes: number;
  pictures: Pictures;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/** A number of px as a sentence prints it. */
const count = (n: number): string => n.toLocaleString("en-US");

/** Text as a report carries it: one line of at most `most` characters, with
 *  nothing in it that only a terminal would act on. */
function clip(text: string, most: number): string {
  return Array.from(text.replace(/[\p{Cc}\s]+/gu, " ").trim()).slice(0, most).join("");
}

/** Run an in-page expression and read the JSON text it answers with. A page
 *  that throws under it, or answers with anything else, is an error. */
async function askPage<T>(ctx: ViewContext, expression: string, schema: z.ZodType<T>): Promise<T> {
  const evaluated = evaluatedSchema.parse(
    await ctx.browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ctx.sessionId),
  );
  if (evaluated.exceptionDetails) {
    const [said = ""] = (evaluated.exceptionDetails.exception?.description ?? "").split("\n");
    throw new Error(clip(said, SENTENCE_MAX) || "the page threw while it was being read");
  }
  const text = evaluated.result?.value;
  if (text === undefined) throw new Error("the page gave no answer while it was being read");
  return schema.parse(JSON.parse(text));
}

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

/** Load the page at a view's viewport and device scale, walk it, and read
 *  how it was laid out. */
async function loadView(ctx: ViewContext, view: JobView, deviceScaleFactor: number): Promise<z.infer<typeof layoutSchema>> {
  const { browser, sessionId } = ctx;
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width: view.width, height: view.height, deviceScaleFactor, mobile: view.mobile },
    sessionId,
  );
  // A page reads what motion its reader asks for as it loads, so the browser
  // is told first, and told at every view: one that asks for none must not be
  // loaded under the last one's `reduce`.
  await browser.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: view.reduce === true ? "reduce" : "no-preference" }] },
    sessionId,
  );
  const loaded = nextLoad(browser, sessionId);
  const navigated = navigateResultSchema.parse(await browser.send("Page.navigate", { url: ctx.url }, sessionId));
  if (navigated.errorText) throw new Error(`the page did not load (${navigated.errorText})`);
  await loaded;
  await walkPage(ctx, view);
  return layoutSchema.parse(await browser.send("Page.getLayoutMetrics", {}, sessionId));
}

/**
 * Ruling 194: picture the page as one box of an exact size, `view.width` by
 * `view.height` CSS px from its top left, laid out in a viewport of that size,
 * as a PNG of that box times `scale`. Taken once: content past the box is
 * reported and left out, and a picture too large to keep is said, never
 * retaken smaller.
 *
 * How the scale is drawn, measured against Debian Chromium 154 (2026-10-08).
 * At 1 and over it is the device scale: the page itself is rendered at it
 * (its `devicePixelRatio`, a canvas sized by that, a `srcset`), so a 2x
 * picture is drawn at 2x and not enlarged. The screenshot's own scale also
 * re-draws lines and text at 2x, but leaves the page at 1x, so a canvas in it
 * is enlarged. Under 1 the device scale stays 1 and the screenshot is scaled
 * down, as a thumbnail of the page is: a device scale under 1 gave the same
 * pixels and told the page it is on a screen no reader has. The clip is the
 * box as given, in whole CSS px (the browser drops a fraction of one before
 * it scales), and the browser rounded each side times the scale as
 * `Math.round` does on every one of 266 boxes tried at 19 scales; the server
 * still reads the size from the PNG's own header.
 */
async function pictureBox(ctx: ViewContext, view: JobView, scale: number, file: string): Promise<Shot> {
  const deviceScaleFactor = Math.max(1, scale);
  const layout = await loadView(ctx, view, deviceScaleFactor);
  const shot = screenshotSchema.parse(
    await ctx.browser.send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: view.width, height: view.height, scale: scale / deviceScaleFactor },
      },
      ctx.sessionId,
    ),
  );
  const bytes = Buffer.from(shot.data, "base64");
  if (bytes.length > ctx.maxBytes) {
    throw new Error(
      `the picture is ${count(bytes.length)} bytes, over the ${count(ctx.maxBytes)} a capture hands back; ` +
        "lower the scale or simplify the picture",
    );
  }
  const size = pngSize(bytes);
  if (!size) throw new Error("the browser returned a picture that is not a PNG");
  writeFileSync(path.join(ctx.out, file), bytes);
  const contentHeight = Math.round(layout.cssContentSize.height);
  return {
    view: view.id,
    width: size.width,
    height: size.height,
    from: 0,
    contentHeight,
    contentWidth: Math.round(layout.cssContentSize.width),
    scale: 1,
    cut: contentHeight > view.height,
    file,
  };
}

/** How a page is laid out at a view, in the picture's own px: what the screen
 *  shows, after a phone has shrunk a page it lays out wider than itself. */
interface PageSize {
  /** Under 1 when a phone shrank the page. */
  scale: number;
  contentWidth: number;
  contentHeight: number;
  /** The content's height, and never less than one screen: a page shorter
   *  than the screen is still pictured as one screen. */
  pageHeight: number;
}

function pageSize(layout: z.infer<typeof layoutSchema>, view: JobView): PageSize {
  const scale = Math.min(Math.max(layout.cssVisualViewport.scale, 0.1), 5);
  const contentHeight = Math.round(layout.cssContentSize.height * scale);
  return {
    scale,
    contentWidth: Math.round(layout.cssContentSize.width * scale),
    contentHeight,
    pageHeight: Math.max(contentHeight, view.height),
  };
}

/** Picture the page at one view. The stretch starts at `view.from`, is never
 *  less than one screen and never more than the view's cap. Heights and
 *  widths are in the picture's own px: what the screen shows, after a phone
 *  has shrunk a page it lays out wider than itself. A page that is over
 *  before `view.from` at this width is this view's own outcome, not a
 *  failure: a phone lays a page out taller than a desktop does, so a stretch
 *  further down one may not exist on the other. */
async function pictureView(ctx: ViewContext, view: JobView, file: string): Promise<Shot | Ended> {
  if (view.box) return pictureBox(ctx, view, view.box.scale, file);
  const { browser, sessionId } = ctx;
  const { scale, contentWidth, contentHeight, pageHeight } = pageSize(await loadView(ctx, view, 1), view);
  if (view.from >= pageHeight) return { view: view.id, pageHeight };
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
        file,
      };
    }
    // Too large to hand to an agent: half as tall, down to one screen.
    const floor = Math.min(view.height, height);
    if (height <= floor) throw new Error("the picture of one screen of it is too large to keep");
    height = Math.max(Math.ceil(height / 2), floor);
  }
}

/**
 * Where the window stands and the address it is at. A press may have sent the
 * page to another document, which ends the reading under it, so it is taken
 * again on the document that loaded.
 */
async function screenNow(ctx: ViewContext): Promise<z.infer<typeof screenSchema>> {
  for (let attempt = 1; ; attempt += 1) {
    const moved = nextLoad(ctx.browser, ctx.sessionId);
    try {
      return await askPage(ctx, SCREEN_EXPRESSION, screenSchema);
    } catch (error) {
      if (!ctx.browser.alive || attempt >= WALK_ATTEMPTS) throw error;
      await Promise.race([moved, pause(MOVE_WAIT_MS)]);
    }
  }
}

/**
 * Picture the screen as it stands: one viewport, at the window's own scroll
 * position, with whatever holds focus, lies under the pointer or was opened
 * still so. Asked for inside the viewport on purpose: a capture beyond it
 * fires `resize` in the page twice (measured, Chrome 153), and a menu that
 * closes when its window is resized would be pictured shut.
 */
async function pictureScreen(ctx: ViewContext, view: JobView, file: string): Promise<Shot> {
  const { browser, sessionId } = ctx;
  const size = pageSize(layoutSchema.parse(await browser.send("Page.getLayoutMetrics", {}, sessionId)), view);
  const screen = await screenNow(ctx);
  const shot = screenshotSchema.parse(
    await browser.send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: screen.x, y: screen.y, width: view.width / size.scale, height: view.height / size.scale, scale: size.scale },
      },
      sessionId,
    ),
  );
  const bytes = Buffer.from(shot.data, "base64");
  if (bytes.length > ctx.maxBytes) throw new Error("the picture of one screen of it is too large to keep");
  const png = pngSize(bytes);
  if (!png) throw new Error("the browser returned a picture that is not a PNG");
  writeFileSync(path.join(ctx.out, file), bytes);
  const from = Math.round(screen.y * size.scale);
  return {
    view: view.id,
    width: png.width,
    height: png.height,
    from,
    contentHeight: size.contentHeight,
    contentWidth: size.contentWidth,
    scale: size.scale,
    cut: from + png.height < size.pageHeight,
    file,
  };
}

interface Point {
  x: number;
  y: number;
}

/** A real pointer event at a point of the screen, in the page's own CSS px
 *  (a phone's shrunk page takes them unscaled: measured, Chrome 153). */
async function pointer(ctx: ViewContext, type: "mouseMoved" | "mousePressed" | "mouseReleased", at: Point): Promise<void> {
  const params: CdpParams =
    type === "mouseMoved" ? { type, x: at.x, y: at.y } : { type, x: at.x, y: at.y, button: "left", clickCount: 1 };
  await ctx.browser.send("Input.dispatchMouseEvent", params, ctx.sessionId);
}

/** One press of Tab as a keyboard sends it, the key going down and coming up,
 *  so `:focus-visible` holds as it does for someone who tabs to a control. */
async function pressTab(ctx: ViewContext): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await ctx.browser.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, ctx.sessionId);
  }
}

/** The control an act names: where its centre is on the screen and what it
 *  is. Throws, with what the controls there are called, when there is none. */
async function findControl(ctx: ViewContext, what: string): Promise<Point & { name: string }> {
  const answer = await askPage(ctx, findExpression(what), foundSchema);
  if (answer.found) return { x: answer.found.x, y: answer.found.y, name: clip(answer.found.name, NAME_MAX) };
  const names = (answer.names ?? []).map((name) => clip(name, ACT_NAME_MAX)).filter((name) => name !== "");
  const called = `nothing at this width is called "${clip(what, NAME_MAX)}"`;
  if (names.length === 0) throw new Error(`${called}, and it shows no control`);
  const listed = names.slice(0, ACT_NAMES_MAX).map((name) => `"${name}"`);
  const more = answer.more === true || names.length > ACT_NAMES_MAX;
  throw new Error(`${called}. The controls on it: ${listed.join(", ")}${more ? ", ..." : ""}`);
}

type JobAct = NonNullable<JobView["act"]>;

/** Do what a view's act says, each step given its time, and say what was
 *  done: Tab first, then the press, then the hover. */
async function act(ctx: ViewContext, asked: JobAct): Promise<string> {
  const did: string[] = [];
  if (asked.tab !== undefined) {
    for (let press = 0; press < asked.tab; press += 1) await pressTab(ctx);
    await pause(AFTER_POINTER_MS);
    const focus = await askPage(ctx, FOCUS_EXPRESSION, focusSchema);
    const presses = asked.tab === 1 ? "1 press" : `${asked.tab} presses`;
    did.push(`${presses} of Tab: focus is on ${focus.on ? clip(focus.on.name, NAME_MAX) : "nothing"}`);
  }
  if (asked.press !== undefined) {
    const control = await findControl(ctx, asked.press);
    await pointer(ctx, "mouseMoved", control);
    await pointer(ctx, "mousePressed", control);
    await pointer(ctx, "mouseReleased", control);
    await pause(AFTER_PRESS_MS);
    // A link to another site leaves the page server, and what would be
    // pictured is the browser's own error page. One that moves within the
    // page, or to another file of the task, is pictured where it led.
    const screen = await screenNow(ctx);
    if (!screen.href.startsWith(`${ctx.origin}/`)) throw new Error("the press sent the browser to another address");
    did.push(`pressed ${control.name}`);
  }
  if (asked.hover !== undefined) {
    const control = await findControl(ctx, asked.hover);
    await pointer(ctx, "mouseMoved", control);
    await pause(AFTER_POINTER_MS);
    did.push(`the pointer is on ${control.name}`);
  }
  return clip(did.join("; "), SENTENCE_MAX);
}

/**
 * Ruling 194: show the page in a state. The page is loaded and walked as for
 * any picture, then the act is done on it, back at the top, and the screen is
 * pictured as it stands. An act that cannot be done (no such control, a press
 * that left the page) is that view's own outcome, never the page's failure:
 * it is said in the report, no picture is taken for the view, and the page's
 * other views are still pictured.
 */
async function pictureAct(ctx: ViewContext, view: JobView, asked: JobAct, file: string): Promise<void> {
  await loadView(ctx, view, 1);
  try {
    const done = await act(ctx, asked);
    ctx.pictures.shots.push(await pictureScreen(ctx, view, file));
    ctx.pictures.acts.push({ view: view.id, done, error: null });
  } catch (caught) {
    // A browser that ended is the page's failure, as at any other view.
    if (!ctx.browser.alive) throw caught;
    // The one sentence that runs past a sentence's length is the list of
    // what the controls are called, which has its own bounds.
    const why = caught instanceof Error ? caught.message : String(caught);
    ctx.pictures.acts.push({ view: view.id, done: null, error: clip(why, ACT_ERROR_MAX) });
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
  const pictures: Pictures = { shots: [], ended: [], acts: [] };
  const { shots, ended, acts } = pictures;
  const dialogs = { count: 0 };
  const report = (error: string | null): PageReport => ({
    file: page.file,
    shots,
    ended,
    acts,
    dialogs: dialogs.count,
    asked: [...asked.hosts].slice(0, REPORT_LIST_MAX),
    askedCount: asked.urls.size,
    missing: server.missing(),
    error,
  });

  let url = server.base + encodeURIComponent(page.file);
  let setPage: string | null = null;
  // Opened here first, by the page server's own rule: a name it would not
  // answer (a dot name, a path), one that is gone, or a link would otherwise
  // be pictured as the server's "not found".
  const source = servable(page.file) ? openStored(job.root, page.file, job.names) : null;
  if (!source) return report("the file is not there to render");
  try {
    if (page.kind === "markdown") {
      if (source.size > MARKDOWN_MAX_BYTES) {
        return report(`the markdown file is ${source.size} bytes; one of up to ${MARKDOWN_MAX_BYTES} is set as a page`);
      }
      setPage = articlePage(page.file, readFileSync(source.fd, "utf8"));
    } else if (page.kind === "svg") {
      if (source.size > DRAWING_MAX_BYTES) {
        return report(`the drawing is ${source.size} bytes; one of up to ${DRAWING_MAX_BYTES} is set as a page`);
      }
      setPage = drawingPage(page.file, readFileSync(source.fd, "utf8"));
    }
    // Served from the folder the source is in, so a name beside it still
    // resolves to the file of that name.
    if (setPage !== null) url = server.base + SET_PAGE_NAME;
  } finally {
    closeSync(source.fd);
  }
  server.begin(setPage);

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
      } else if (method === "Page.javascriptDialogOpening") {
        // With this client attached the page waits on its dialog until it is
        // answered, and nobody is there to answer: it is dismissed, so the
        // page loads on. Only the question asked before leaving a page is
        // accepted, or the next width's load would never start.
        const event = dialogEventSchema.safeParse(params);
        const leaving = event.success && event.data.type === "beforeunload";
        if (!leaving) dialogs.count += 1;
        browser.send("Page.handleJavaScriptDialog", { accept: leaving }, sessionId).catch(() => {});
      }
    });
    const ctx: ViewContext = { browser, sessionId, url, origin: server.origin, out: job.out, maxBytes: job.maxBytes, pictures };
    try {
      await browser.send("Page.enable", {}, sessionId);
      await browser.send("Network.enable", {}, sessionId);
      await browser.send("Audits.enable", {}, sessionId);
      for (const view of job.views) {
        const [name] = pictureNames(view);
        const file = `${index + 1}-${name}.png`;
        if (view.act) {
          await pictureAct(ctx, view, view.act, file);
          continue;
        }
        const pictured = await pictureView(ctx, view, file);
        if ("pageHeight" in pictured) ended.push(pictured);
        else shots.push(pictured);
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
  // Nothing at `from` at any width asked for: said with each width's own end.
  if (error === null && shots.length === 0 && ended.length > 0) {
    const viewOf = (end: Ended): JobView | undefined => job.views.find((view) => view.id === end.view);
    const ends = ended.map(
      (end) => `at ${count(end.pageHeight)} px at the ${end.view} width (${viewOf(end)?.width ?? 0} px)`,
    );
    error = `the page ends ${ends.join(" and ")}, so nothing starts at ${count(viewOf(ended[0]!)?.from ?? 0)} px`;
  }
  return report(error);
}

/** Everything on the standard input, as text. */
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  let job: Job;
  try {
    job = jobSchema.parse(JSON.parse(await readInput()));
  } catch (error) {
    process.stderr.write(
      `usage: page-capture-child.server.ts < job.json (${error instanceof Error ? error.message : String(error)})\n`,
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
  const server = await startPageServer(job.root, job.names);
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
