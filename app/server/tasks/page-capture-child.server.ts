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
 *  - **Or pictures the whole of it** (a view with `whole`): walked to its
 *    end, then taken in stretches from `from` down, each where the one before
 *    ended, until the page ends or the job's count is reached.
 *  - **Or pictures it as one box of an exact size** (ruling 194, a view with
 *    `box`): laid out in a viewport of that size and cut to it from the top
 *    left, as a PNG of exactly the box times its scale. That one is never
 *    retaken shorter: a picture of another size is not the one asked for.
 *  - **Or pictures it while it moves** (a view with `moving`): loaded and
 *    not walked, the screen at `from` is taken at three moments after it came
 *    into view, so what plays as a page loads is seen playing.
 *  - **Or shows it in a state** (ruling 194, a view with `act`): after the
 *    load and the walk it presses Tab, presses a control or puts the pointer
 *    on one, with the key and pointer events a reader's own hands send, and
 *    pictures the one screen the window then shows. An act that cannot be
 *    done is said in the report and costs the page nothing else.
 *  - **Pictures a page on the web the same ways** (ruling 327, a page of
 *    kind `web`): opened at its own address in a browser with the network
 *    open, once it has asked for nothing for half a second. A job holds such
 *    pages or task pages, never both, so no task page meets the open network.
 *  - **Reads what moves on it** (a page on the web, and any page of a
 *    measured job): once every view is pictured, on a load of its own, what
 *    is running a second after the load, what animates in as the page is
 *    scrolled, a bar that stays, and what changes under the pointer.
 *  - **Measures it** (ruling 328, a job with `measure`, task pages only):
 *    at each view that is a stretch, what the accessibility engine the job
 *    names finds, how a keyboard gets round it, and what still moves with
 *    reduced motion asked for; and once for the page, what one load of it
 *    weighs and how long it takes on a slow line. All of it after the last
 *    picture, in what is left of the page's time: a page that cannot be
 *    measured is still a pictured page.
 *  - **Says when a page scrolls inside itself.** A page fixed to its screen
 *    with its content in a box that scrolls is pictured as the one screen it
 *    lays out as. The report names the largest such box and how much it
 *    holds, so a picture of one screen is not read as the whole page.
 *  - **Dismisses a dialog the page opens.** `alert()`, `confirm()` and
 *    `prompt()` stop a page until somebody answers, and nobody is there: each
 *    is dismissed and counted, so the page loads on and the report says so.
 *
 * Run as `node page-capture-child.server.ts` with the job, as JSON, on its
 * standard input (never an argument: a job names every file of a delivery
 * and can be past what the kernel takes as one). It writes each picture as
 * `<out>/<n>-<name>.png` (`pictureNames` has the names) and
 * `<out>/report.json`, and prints nothing the server parses. The report is
 * written by the person's own process and read by the server as untrusted
 * text, so it is plain data, and what a reading of a page puts in it in the
 * page's own words (an act's outcome, what moves, what is measured) is cut
 * to a length here (`clip`). Node runs it as TypeScript; it imports only
 * `node:` modules and declared packages, and nothing in the app imports it.
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
/** The most stretches a whole view is taken in, whatever number it names. */
const WHOLE_STRETCHES_MAX = 100;

/**
 * The pictures a view writes, as their names in `out` without the page's
 * number and the extension: `<view>` for a stretch or a box, `-s2`, `-s3` for
 * the further stretches of a whole page, `-m1` to `-m3` for the frames of a
 * moving screen, `-a` for an act.
 */
function pictureNames(view: JobView): string[] {
  if (view.act) return [`${view.id}-a`];
  if (view.moving === true) return MOVING_MOMENTS.map((_, at) => `${view.id}-m${at + 1}`);
  const further = view.whole === true ? Math.min(view.stretches ?? 1, WHOLE_STRETCHES_MAX) - 1 : 0;
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
    const kinds = [
      view.box ? "a box" : "",
      view.whole === true ? "a whole page" : "",
      view.act ? "an act" : "",
      view.moving === true ? "moving" : "",
    ].filter((kind) => kind !== "");
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

/**
 * A part of a page that scrolls inside it. A page whose own height is its
 * screen's, with its content in a box that scrolls, is pictured as the one
 * screen it lays out as, and a long page that keeps a log or a list in a box
 * of its own is pictured with that box as it stands. Either way what the box
 * holds past its own height is in no picture. The report says so, and
 * nothing here tries to picture it.
 */
interface ScrollsInside {
  /** The part, as `tag.firstClass` or `tag#id`. */
  what: string;
  /** How tall what it holds is, in the picture's px. */
  height: number;
}

/** One thing that was running on a page a second after it loaded. */
interface Running {
  /** A CSS animation's name, a transition's property, or "script
   *  animation". */
  name: string;
  /** The element it moves, as `tag.firstClass` or `tag#id`. */
  target: string;
  /** How long one run of it lasts, when that is a number of ms. */
  durationMs: number | null;
  /** It never ends by itself. */
  loops: boolean;
}

/** What moves on a page: on every page on the web (ruling 327) and on every
 *  page of a measured job (ruling 328). */
interface Motion {
  running: Running[];
  /** How many were running in all; `running` names the first of them. */
  runningCount: number;
  videos: Array<{ autoplay: boolean; loop: boolean; playing: boolean; width: number; height: number }>;
  /** A bar that stays at the top of the screen while the page scrolls. */
  sticky: { what: string; position: "fixed" | "sticky" } | null;
  /** How many elements began to animate as they were scrolled into view. */
  onScroll: number;
  /** The controls whose look changes under the pointer, and what changes. */
  hover: Array<{ what: string; changes: string[]; durationMs: number | null }>;
}

/** What the accessibility engine found in a page at one width. */
interface Faults {
  /** False when the job named no engine or it could not run; `why` says. */
  ran: boolean;
  why: string | null;
  /** One entry per kind of fault, the gravest first: how many places have
   *  it, and the first of them as the engine's own selector. */
  kinds: Array<{ id: string; impact: string | null; help: string; count: number; first: string[] }>;
  /** The lowest contrast it found failing, and the words it is on. */
  worstContrast: { ratio: number; text: string } | null;
}

/** How a keyboard gets round a page at one width. */
interface Keyboard {
  /** False when the walk could not be made or did not finish: the rest is
   *  then zero and empty, and says nothing of the page. */
  ran: boolean;
  /** True when the walk used its last press with a control still not come
   *  to and without having been round, so what Tab never reaches is not
   *  known: `unreached` is then empty and its count zero, and neither says
   *  the page has none. Never true of a walk that came to every control. */
  cut: boolean;
  /** The visible controls a keyboard should reach. */
  controls: number;
  /** How many of those controls Tab stopped on: never more than there are.
   *  What else took focus on the way is no control of the page's and is not
   *  counted. */
  stops: number;
  /** Controls Tab never reached, each as `tag "its words"`: the first of
   *  them, and how many there are in all. */
  unreached: string[];
  unreachedCount: number;
  /** Controls whose look did not change when they took focus: the first of
   *  them, and how many there are in all. */
  unmarked: string[];
  unmarkedCount: number;
}

/** What still moves at one width with reduced motion asked for: what loops
 *  or lasts, a second after the load. */
interface Reduced {
  /** False when the page could not be loaded and read that way, or not in
   *  time: the rest is then zero and empty, and says nothing of the page. */
  ran: boolean;
  runningCount: number;
  running: Array<{ name: string; target: string; loops: boolean }>;
  videosPlaying: number;
}

interface MeasuredView {
  view: string;
  faults: Faults;
  keyboard: Keyboard;
  reduced: Reduced;
}

/** How a page measures (ruling 328): on every page of a measured job, never
 *  on a page on the web. Whatever could not be measured says so and costs
 *  the page's pictures nothing: each check at each width carries `ran`, and
 *  a zero beside `ran: false` is no figure of the page's. */
interface Measured {
  /** One entry per view that is a stretch of the page. */
  views: MeasuredView[];
  /** What the page server served for one load of the page: the page and
   *  every file it asked for and got. */
  weight: Weight;
  /** The load event at a phone's width on `SLOW_LINE`, in ms; null when the
   *  load did not finish in what was left of the page's time. */
  loadMs: number | null;
  /** How that line reads. */
  line: string;
}

/** One page as the report states it. */
interface PageReport {
  file: string;
  shots: Shot[];
  /** The views with nothing at `from`: no picture, and no failure either. */
  ended: Ended[];
  /** One entry per view that carried an act. */
  acts: Act[];
  /** The largest part of the page that scrolls inside it with more than a
   *  screen of it out of sight, at the first view that is not a phone's;
   *  null when there is none, and when the page did not load to be read. */
  scrollsInside: ScrollsInside | null;
  /** How many script dialogs the page opened, each dismissed. */
  dialogs: number;
  /** Hosts the page asked the network for, and how many addresses in all. */
  asked: string[];
  askedCount: number;
  /** What it asked the page server for and was not served: a name that is not
   *  among the files, or (starting with `/`) a path outside its own folder. */
  missing: string[];
  error: string | null;
  motion?: Motion;
  measured?: Measured;
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
/** A page on the web is pictured once it has asked the network for nothing
 *  for the first of these, counted from its load event at the earliest, and
 *  is never waited on for longer than the second. */
const QUIET_MS = 500;
const QUIET_MAX_MS = 5_000;
/** What is still running this long after the load event is what moves on a
 *  page: an entrance is over by then. */
const SETTLE_MS = 1_000;
/** How much of what moves a report names: animations, videos, and the
 *  controls a pointer is tried on. */
const RUNNING_MAX = 12;
const VIDEOS_MAX = 6;
const HOVER_MAX = 8;
/** How long a control gets under the pointer before its look is read again. */
const HOVER_WAIT_MS = 350;
/** What of a control's look is read at rest and again under the pointer. */
const HOVER_LOOK = ["color", "background-color", "border-color", "box-shadow", "transform", "opacity", "text-decoration-line", "filter"];
/** The most screens a page is walked for what animates in, and how long each
 *  stop lasts. */
const ON_SCROLL_SCREENS = 40;
const ON_SCROLL_STOP_MS = 250;
/** How far down a page is sent to see what stays at the top of the screen. */
const STICKY_SCROLL_PX = 600;
/** How much of what a page measures a report names: kinds of fault and the
 *  places of each, the controls a keyboard missed or left unmarked, what
 *  still runs under reduced motion. */
const FAULT_KINDS_MAX = 20;
const FAULT_FIRST_MAX = 3;
const KEYBOARD_NAMES_MAX = 6;
const REDUCED_RUNNING_MAX = 6;
/** The standards a page is checked against: WCAG 2.2, levels A and AA. */
const FAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** The engine's words for how grave a fault is, the gravest first. */
const FAULT_IMPACTS = ["critical", "serious", "moderate", "minor"];
/** The most presses of Tab a keyboard walk makes, and an act. */
const TAB_PRESSES_MAX = 80;
/** Under reduced motion, an animation that lasts longer than this or never
 *  ends is still motion; a shorter one is a change of state. */
const LASTING_MS = 200;
/** The line a page's load is timed on, in the browser's own terms (ms, and
 *  bytes a second each way), and how a report says it. */
const SLOW_LINE = { latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 };
const SLOW_LINE_READS = "1.6 Mbit/s down, 150 ms";
/** What no one step of reading a page may run past, so that a slow one leaves
 *  time for the rest, and how much of a page's time is kept back for ending
 *  its browser and writing the report. */
const STEP_MAX_MS = 15_000;
const CLOSING_MS = 1_000;
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
  /** What it has served since `begin`: how many answers that carried a file
   *  or the set page, and their bytes. */
  served(): Weight;
  close(): Promise<void>;
}

interface Weight {
  bytes: number;
  files: number;
}

const listenAddressSchema = z.looseObject({ port: z.number().int().positive() });

function startPageServer(root: string, names: readonly string[] | undefined): Promise<PageServer> {
  const token = randomBytes(8).toString("hex");
  const prefix = `/${token}/`;
  let setPage: string | null = null;
  let missing = new Set<string>();
  let served: Weight = { bytes: 0, files: 0 };
  const serve = (bytes: number): void => {
    served = { bytes: served.bytes + bytes, files: served.files + 1 };
  };

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
      if (req.method !== "HEAD") serve(Buffer.byteLength(setPage));
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
    serve(file.size);
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
          served = { bytes: 0, files: 0 };
        },
        missing: () => [...missing].slice(0, REPORT_LIST_MAX),
        served: () => served,
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

/** The flags one page's browser starts with. For a task page only the page
 *  server is reachable: every other request, loopback included, goes to a
 *  closed proxy port. A page on the web (ruling 327) is opened with the
 *  network open, so its browser starts without those two flags and with
 *  every other one; a job never holds both kinds of page, so the open browser
 *  is never a task page's. `--no-sandbox` for the reason the browser mount
 *  gives. */
function browserArgs(profile: string, port: number, open: boolean): string[] {
  const closed = open ? [] : ["--proxy-server=http://127.0.0.1:9", `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`];
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
    ...closed,
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
 *  - `spot`: which element, as its author would point at it: its tag and
 *    first class, else its tag and id.
 *  - `jump`: send the window to a height in one step, whatever
 *    `scroll-behavior` the page sets.
 *  - `KEPT`: where a reading keeps what a later expression of it needs (the
 *    controls it noted), on the window, under a symbol no page script meets
 *    by accident.
 */
const PAGE_HELPERS = `
const flat = (text) => String(text == null ? "" : text).replace(/\\s+/g, " ").trim();
const visible = (el) => {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
};
const tagOf = (el) => el.tagName.toLowerCase();
const spot = (el) => tagOf(el) + (el.classList.length > 0 ? "." + el.classList[0] : el.id ? "#" + el.id : "");
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
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: "instant" });
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

/**
 * How a control looks to someone looking for where focus is: its outline, its
 * shadow, and the colours and underline a page changes instead of one. The
 * control's own, its two pseudo-elements' and its parent's, because a ring is
 * as often drawn by a `::after` or by the box around the control
 * (`:focus-within`) as by the control itself.
 */
const FOCUS_LOOK_SOURCE = `
  const FOCUS_LOOK = ["outline-style", "outline-width", "outline-color", "box-shadow", "border-color", "background-color", "color", "text-decoration-line"];
  const focusLook = (el) => {
    const read = (of, pseudo) => {
      const style = getComputedStyle(of, pseudo);
      return FOCUS_LOOK.map((name) => style.getPropertyValue(name)).join("|");
    };
    return [read(el), read(el, "::before"), read(el, "::after"), el.parentElement ? read(el.parentElement) : ""].join("||");
  };
`;

/**
 * Note every visible control a keyboard should reach, with its look at rest,
 * for the walk that follows (`FOCUS_EXPRESSION`). A control is a link with an
 * address, a button, a form field, a `summary`, or anything given a tab
 * index. Not one that is disabled or in a part of the page made `inert`, and
 * not one its page took out of the tab order on purpose (a negative tab
 * index, every radio of a group but the one Tab stops on): those are reached
 * another way or by nobody, and would be named as never reached. Disabled is
 * what the browser itself says is (`:disabled`): a field in a set of fields
 * that is switched off has no `disabled` of its own.
 *
 * What the page focused as it loaded is blurred first, so that the look
 * noted of it is its look at rest: a field with `autofocus` would otherwise
 * be noted with its focus ring on, and look the same when Tab came to it.
 */
const CONTROLS_EXPRESSION = inPage(
  "controls",
  {},
  `${FOCUS_LOOK_SOURCE}
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
  const reach = (el) => {
    if (el.matches(":disabled") || el.closest("[inert]") || !visible(el)) return false;
    const index = el.getAttribute("tabindex");
    if (index !== null && Number.parseInt(index, 10) < 0) return false;
    if (tagOf(el) === "input" && el.type === "radio" && el.name) {
      const group = Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => radio.name === el.name && radio.form === el.form);
      return (group.find((radio) => radio.checked) || group[0]) === el;
    }
    return true;
  };
  const all = Array.from(document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")).filter(reach);
  window[KEPT] = { controls: all, looks: all.map(focusLook), moving: all.map((el) => el.getAnimations().length), stops: [] };
  return JSON.stringify({ count: all.length, names: all.slice(0, 400).map((el) => tagOf(el) + ' "' + words(el).slice(0, 60) + '"') });
`,
);

/**
 * What holds keyboard focus: nothing while it is on the page itself. On a
 * page whose controls were noted it also says which of them this is (none,
 * for something else that takes focus), which stop of the walk (the first
 * time it is met), and whether its look differs from its look at rest. A
 * transition that focus started counts as a change: read this soon, its
 * values are still the ones at rest.
 */
const FOCUS_EXPRESSION = inPage(
  "focus",
  {},
  `${FOCUS_LOOK_SOURCE}
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return JSON.stringify({ on: null });
  const kept = window[KEPT];
  let control = -1;
  let stop = -1;
  let marked = null;
  if (kept && kept.controls) {
    control = kept.controls.indexOf(el);
    stop = kept.stops.indexOf(el);
    if (stop < 0) stop = kept.stops.push(el) - 1;
    if (control >= 0) marked = focusLook(el) !== kept.looks[control] || el.getAnimations().length > kept.moving[control];
  }
  return JSON.stringify({
    on: {
      name: kind(el) + ' "' + words(el).slice(0, ${ACT_NAME_MAX}) + '"',
      tag: tagOf(el) + ' "' + words(el).slice(0, 60) + '"',
      control,
      stop,
      marked,
    },
  });
`,
);

/**
 * Put the page back to where a keyboard walk starts: nothing focused, and Tab
 * starting at the top of the document.
 *
 * Blurring what holds focus is not enough: the browser goes on from where
 * focus last was, so Tab would still begin below a field with `autofocus`.
 * Neither is a caret set at the start of the document. What moves the place
 * Tab starts from is focus itself, so the body is made focusable for the
 * moment, focused, blurred, and left as it was: Tab then goes to the first
 * stop in the document, whatever its tab index. Measured on Chrome 153 and
 * Debian Chromium 154 on pages that open with focus on a field, on a
 * heading, in a frame and in a shadow tree, and on one whose script had
 * focused a field and blurred it again. A page that takes focus back, and
 * one under a modal dialog, stay as they are: `readKeyboard` does not count
 * on where a walk begins.
 */
const START_EXPRESSION = inPage(
  "start",
  {},
  `
  const held = document.activeElement;
  if (held && held !== document.body && held.blur) held.blur();
  const body = document.body;
  if (body) {
    const had = body.getAttribute("tabindex");
    body.setAttribute("tabindex", "-1");
    body.focus({ preventScroll: true });
    body.blur();
    if (had === null) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", had);
  }
  return JSON.stringify({});
`,
);

/** What marks the accessibility engine's own script when it is run in the
 *  page: the script defines `window.axe` and is the job's to name. */
const ENGINE_MARK = "/* viberr:engine {} */\n";

/**
 * Run the engine over the page as it rests, with nothing holding focus, and
 * answer with its findings cut down to what a report carries: each kind, how
 * many places have it, and the first of them. Every place of the contrast
 * finding is kept, with the ratio the engine measured and the words it is on.
 */
const FAULTS_EXPRESSION = inPage(
  "faults",
  {},
  `
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
  jump(0);
  const results = await window.axe.run(document, {
    runOnly: { type: "tag", values: ${JSON.stringify(FAULT_TAGS)} },
    resultTypes: ["violations"],
    elementRef: true,
  });
  const violations = results.violations.slice(0, 100).map((violation) => ({
    id: flat(violation.id),
    impact: violation.impact ? flat(violation.impact) : null,
    help: flat(violation.help),
    count: violation.nodes.length,
    nodes: violation.nodes.slice(0, violation.id === "color-contrast" ? 200 : ${FAULT_FIRST_MAX}).map((node) => {
      let ratio = null;
      for (const check of node.any || []) {
        if (check.id === "color-contrast" && check.data && Number.isFinite(check.data.contrastRatio)) ratio = check.data.contrastRatio;
      }
      return {
        target: flat((node.target || []).flat().join(" ")),
        ratio,
        text: node.element ? flat(node.element.innerText || node.element.textContent).slice(0, ${NAME_MAX}) : "",
      };
    }),
  }));
  return JSON.stringify({ violations });
`,
);

/** When the page's load event ended, in ms from the start of its navigation. */
const LOAD_TIME_EXPRESSION = inPage(
  "load-time",
  {},
  `
  for (let tries = 0; tries < 10; tries += 1) {
    const [entry] = performance.getEntriesByType("navigation");
    if (entry && entry.loadEventEnd > 0) return JSON.stringify({ ms: entry.loadEventEnd });
    await pause(50);
  }
  return JSON.stringify({ ms: null });
`,
);

/** Where the window is scrolled to, and the address it is at. */
const SCREEN_EXPRESSION = inPage("screen", {}, "return JSON.stringify({ x: window.scrollX, y: window.scrollY, href: location.href });");

/** Give the page's fonts a second to arrive. A moving screen is not held
 *  for the three a walk gives them. */
const FONTS_EXPRESSION = inPage(
  "fonts",
  {},
  `
  try { await Promise.race([document.fonts.ready, pause(1000)]); } catch {}
  return JSON.stringify({});
`,
);

/** Send the window down to `y`, in the page's CSS px, in one step. */
function scrollExpression(y: number): string {
  return inPage("scroll", { y }, "jump(args.y); return JSON.stringify({ y: window.scrollY });");
}

/**
 * What is running in the page now, and its videos. An animation's name is its
 * CSS name, a transition's the property it moves, and one a script started
 * has none. A scroll-driven one is listed too, with no duration: its length
 * is a share of the scroll, not a time.
 */
const ANIMATIONS_EXPRESSION = inPage(
  "animations",
  {},
  `
  const running = document.getAnimations().filter((animation) => animation.playState === "running");
  const told = running.slice(0, 200).map((animation) => {
    const effect = animation.effect;
    const timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : {};
    const el = effect ? effect.target : null;
    return {
      name: flat(animation.animationName || animation.transitionProperty || "script animation"),
      target: el ? spot(el) + (effect.pseudoElement || "") : "",
      durationMs: Number.isFinite(timing.duration) ? Math.round(timing.duration) : null,
      loops: timing.iterations === Infinity,
    };
  });
  const videos = Array.from(document.querySelectorAll("video")).slice(0, 50).map((video) => {
    const box = video.getBoundingClientRect();
    return { autoplay: video.autoplay, loop: video.loop, playing: !video.paused && !video.ended, width: Math.round(box.width), height: Math.round(box.height) };
  });
  return JSON.stringify({ count: running.length, running: told, videos });
`,
);

/** A screen in the page's own CSS px: the view's, over the scale a phone
 *  shrank the page by. The expressions that need it are handed it, as the
 *  walk is handed its step: this process set the viewport, and nothing reads
 *  it back from the page. */
interface ScreenSize {
  width: number;
  height: number;
}

/**
 * Walk the page one screen at a time and count the elements that begin to
 * animate on the way: the ones with a running animation or transition at a
 * stop that had none at any stop before it, the top of the page included. It
 * has to be the page's first walk. What animates in as a reader scrolls to it
 * plays once: measured on a page of three such sections (Chrome 153), the
 * first walk counted three and a second walk none, and Debian Chromium 154
 * counted none of two on a second walk.
 */
function onScrollExpression(screen: ScreenSize): string {
  return inPage(
    "on-scroll",
    { step: screen.height },
    `
  const moving = () => new Set(document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect && animation.effect.target).map((animation) => animation.effect.target));
  const before = moving();
  const began = new Set();
  const note = () => {
    for (const el of moving()) {
      if (before.has(el)) continue;
      before.add(el);
      began.add(el);
    }
  };
  const root = document.documentElement;
  const height = () => Math.max(root ? root.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  const step = args.step;
  for (let y = step, stops = 1; y < height() && stops < ${ON_SCROLL_SCREENS}; y += step, stops += 1) {
    jump(y);
    // Twice a stop: a short transition is over before the stop is.
    await pause(${Math.round(ON_SCROLL_STOP_MS * 0.4)});
    note();
    await pause(${Math.round(ON_SCROLL_STOP_MS * 0.6)});
    note();
  }
  jump(0);
  await pause(100);
  return JSON.stringify({ count: began.size });
`,
  );
}

/**
 * Send the page down and say what stays at the top of the screen: an element
 * that is `fixed` or `sticky`, at least half the screen wide, with its box
 * still at the top. A bar, so no taller than half the screen: a backdrop
 * fixed over the whole of it is not one. It is looked for at two heights and
 * has to be in the same place at both, or a sticky element that only happens
 * to be passing the top would be named. A page that does not scroll has
 * nothing to stay.
 */
function stickyExpression(screen: ScreenSize): string {
  return inPage(
    "sticky",
    { width: screen.width, height: screen.height },
    `
  const bars = () => {
    const found = new Map();
    for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 5000)) {
      const style = getComputedStyle(el);
      if ((style.position !== "fixed" && style.position !== "sticky") || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      const wide = box.width >= args.width / 2 && box.height > 0 && box.height <= args.height / 2;
      if (wide && box.top >= -1 && box.top <= 24) found.set(el, { top: box.top, position: style.position });
    }
    return found;
  };
  jump(${STICKY_SCROLL_PX});
  await pause(150);
  const at = window.scrollY;
  let bar = null;
  if (at >= 1) {
    const first = bars();
    jump(at + 200);
    await pause(150);
    const second = window.scrollY - at >= 1 ? bars() : first;
    for (const [el, was] of first) {
      const now = second.get(el);
      if (now && Math.abs(now.top - was.top) <= 1) {
        bar = { what: spot(el), position: was.position };
        break;
      }
    }
  }
  jump(0);
  await pause(50);
  return JSON.stringify({ sticky: bar });
`,
  );
}

/**
 * The largest part of the page that scrolls inside it with more than a screen
 * of what it holds out of sight. A part scrolls when its own `overflow-y` is
 * `auto` or `scroll`: one that only hides what does not fit (a folded panel,
 * a clamped paragraph) is nothing a reader can scroll. The window's own
 * scroller is not a part of the page, and neither is a `body` whose overflow
 * the browser hands to the window, which it does unless the root element has
 * an overflow of its own. Measured on Chrome 153 and Debian Chromium 154: a
 * `body` of one screen with `overflow: auto` under a plain root had a scroll
 * height of several screens and the window scrolled them all; under a root
 * with `overflow: hidden` the same `body` scrolled inside a window one screen
 * tall.
 */
function innerExpression(screen: ScreenSize): string {
  return inPage(
    "inner",
    { height: screen.height },
    `
  const own = document.scrollingElement;
  const bodyItself = getComputedStyle(document.documentElement).overflowY !== "visible";
  let most = null;
  for (const el of Array.from(document.querySelectorAll("body, body *")).slice(0, 5000)) {
    if (el === own || el.scrollHeight - el.clientHeight <= args.height) continue;
    if (most && el.scrollHeight <= most.scrollHeight) continue;
    const flow = getComputedStyle(el).overflowY;
    if ((flow !== "auto" && flow !== "scroll") || (el === document.body && !bodyItself) || !visible(el)) continue;
    most = el;
  }
  return JSON.stringify({ inside: most ? { what: spot(most), height: most.scrollHeight } : null });
`,
  );
}

/** The controls a pointer is tried on: the visible ones on the page's first
 *  two screens, one of each `tag.firstClass`, kept for the two expressions
 *  below. */
function hoverListExpression(screen: ScreenSize): string {
  return inPage(
    "hover-list",
    { height: screen.height },
    `
  const picked = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(${JSON.stringify(CONTROLS)})) {
    if (picked.length >= ${HOVER_MAX}) break;
    if (!visible(el) || el.getBoundingClientRect().top + window.scrollY >= 2 * args.height) continue;
    const what = spot(el);
    if (seen.has(what)) continue;
    seen.add(what);
    picked.push(el);
  }
  window[KEPT] = { hover: picked, rest: [] };
  return JSON.stringify({ controls: picked.map(spot) });
`,
  );
}

/**
 * A control's look, property by property. The colour of a border that is not
 * drawn is left out: with no colour of its own it is the text's, so a link
 * that only changed colour would be said to have changed its border too
 * (measured, Chrome 153).
 */
const HOVER_LOOK_SOURCE = `
  const lookOf = (el) => {
    const style = getComputedStyle(el);
    const bordered = ["top", "right", "bottom", "left"].some((side) => Number.parseFloat(style.getPropertyValue("border-" + side + "-width")) > 0);
    return ${JSON.stringify(HOVER_LOOK)}.map((name) => (name === "border-color" && !bordered ? "" : style.getPropertyValue(name)));
  };
`;

/** Bring one of those controls to the middle of the screen, keep its look at
 *  rest, and say where its centre is. */
function hoverRestExpression(index: number): string {
  return inPage(
    "hover-rest",
    { index },
    `${HOVER_LOOK_SOURCE}
  const kept = window[KEPT];
  const el = kept.hover[args.index];
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  kept.rest[args.index] = lookOf(el);
  return JSON.stringify(centre(el));
`,
  );
}

/** What of its look is no longer as it was at rest, and the longest of its
 *  transitions when it has one. */
function hoverReadExpression(index: number): string {
  return inPage(
    "hover-read",
    { index },
    `${HOVER_LOOK_SOURCE}
  const kept = window[KEPT];
  const el = kept.hover[args.index];
  const now = lookOf(el);
  const changes = ${JSON.stringify(HOVER_LOOK)}.filter((name, at) => now[at] !== kept.rest[args.index][at]);
  const style = getComputedStyle(el);
  const times = style.transitionDuration.split(",").map((time) => (time.trim().endsWith("ms") ? Number.parseFloat(time) : Number.parseFloat(time) * 1000));
  const longest = Math.max(0, ...times.filter(Number.isFinite));
  return JSON.stringify({ changes, durationMs: longest > 0 ? Math.round(longest) : null });
`,
  );
}

const runningSchema = z.object({ name: z.string(), target: z.string(), durationMs: z.number().nullable(), loops: z.boolean() });
const animationsSchema = z.object({
  count: z.number().int().nonnegative(),
  running: z.array(runningSchema),
  videos: z.array(
    z.object({ autoplay: z.boolean(), loop: z.boolean(), playing: z.boolean(), width: z.number(), height: z.number() }),
  ),
});
const stickySchema = z.object({ sticky: z.object({ what: z.string(), position: z.enum(["fixed", "sticky"]) }).nullable() });
const insideSchema = z.object({ inside: z.object({ what: z.string(), height: z.number().nonnegative() }).nullable() });
const countSchema = z.object({ count: z.number().int().nonnegative() });
const hoverListSchema = z.object({ controls: z.array(z.string()) });
const pointSchema = z.object({ x: z.number(), y: z.number() });
const hoverReadSchema = z.object({ changes: z.array(z.string()), durationMs: z.number().nullable() });

const foundSchema = z.object({
  found: z.object({ x: z.number(), y: z.number(), name: z.string() }).nullable(),
  names: z.array(z.string()).optional(),
  more: z.boolean().optional(),
});
const focusSchema = z.object({
  on: z
    .object({
      name: z.string(),
      tag: z.string(),
      /** Which of the noted controls it is; -1 when it is none of them. */
      control: z.number().int(),
      /** Which stop of the walk; -1 when no walk is under way. */
      stop: z.number().int(),
      marked: z.boolean().nullable(),
    })
    .nullable(),
});
const controlsSchema = z.object({ count: z.number().int().nonnegative(), names: z.array(z.string()) });
const faultsSchema = z.object({
  violations: z.array(
    z.object({
      id: z.string(),
      impact: z.string().nullable(),
      help: z.string(),
      count: z.number().int().nonnegative(),
      nodes: z.array(z.object({ target: z.string(), ratio: z.number().nullable().optional(), text: z.string().optional() })),
    }),
  ),
});
const screenSchema = z.object({ x: z.number(), y: z.number(), href: z.string() });

/** The most screens a whole page is walked. A page that grows as it is
 *  scrolled has no end to reach. */
const WHOLE_WALK_SCREENS = 40;

/**
 * Run in the page before it is pictured: wait for its fonts, walk it from the
 * top to the end of the stretch in viewport steps, come back, and let what
 * the walk started finish. Lazy pictures and scroll-in sections are then
 * drawn as for a reader who scrolled. A whole page is walked to its own end,
 * read again at every step, since what loads as it is scrolled makes it
 * longer. Not written with `inPage`: it answers with the page's address, as
 * text, and needs none of the helpers.
 */
function walkExpression(view: JobView): string {
  const asked = view.whole === true ? { screens: WHOLE_WALK_SCREENS } : { to: view.from + view.maxHeight };
  const steps =
    view.whole === true
      ? `for (let y = 0, stops = 0; y < height() && stops < ${WHOLE_WALK_SCREENS}; y += step, stops += 1) { window.scrollTo(0, y); await pause(80); }`
      : `const end = Math.min(height(), ${view.from + view.maxHeight});
  for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await pause(80); }`;
  return `/* viberr:walk ${JSON.stringify(asked)} */ (async () => {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  try { await Promise.race([document.fonts.ready, pause(3000)]); } catch {}
  const root = document.documentElement;
  const step = ${view.height};
  const height = () => Math.max(root ? root.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  ${steps}
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

const navigateResultSchema = z.looseObject({ frameId: z.string().optional(), errorText: z.string().optional() });
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
/** A response as the browser reports one: what kind of thing was answered,
 *  the frame it is for, and the status. */
const documentEventSchema = z.looseObject({
  type: z.string(),
  frameId: z.string(),
  response: z.looseObject({ status: z.number() }),
});
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
  /** What scrolls inside the page, once it was looked for. */
  scrollsInside: ScrollsInside | null;
}

interface ViewContext {
  browser: Browser;
  sessionId: string;
  url: string;
  /** The page server's origin: where a task page must still be when
   *  pictured. */
  origin: string;
  /** True for a page on the web (ruling 327): opened at its own address,
   *  with the network open, and held to no one address. */
  web: boolean;
  /** The origin the loaded page is on, which a press must not leave: the
   *  page server's for a task page, and for a page on the web wherever its
   *  address led. */
  site: string;
  /** When the page last asked the network for anything, and the status each
   *  frame's document was last answered with, by the frame's id. */
  traffic: { last: number; documents: Map<string, number> };
  out: string;
  maxBytes: number;
  pictures: Pictures;
  /** The view at whose load the page is looked at for a part that scrolls
   *  inside it: the first that is not a phone's, else the first. */
  insideAt: JobView | null;
}

/** Resolves once `ms` have passed by this process's clock, and not before: a
 *  timer alone fires up to a millisecond early by it (a frame due 3,000 ms
 *  after its screen came into view was stamped 2,999). */
async function pause(ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (let left = ms; left > 0; left = until - Date.now()) {
    await new Promise((done) => setTimeout(done, left));
  }
}
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
 * the walk is taken again on the document that loaded. A task page that left
 * the page server is not pictured: what would be drawn is the browser's own
 * error page.
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
    if (address === undefined) return;
    if (ctx.web) {
      // A site may send its visitor on, so a page on the web is held to no
      // one address, only to the web: anything else is the browser's own
      // page for a load that failed.
      const landed = webAddress(address);
      if (!landed) throw new Error("the page sent the browser to an address that is not on the web");
      ctx.site = landed.origin;
    } else if (!address.startsWith(`${ctx.origin}/`)) {
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

/** Wait until a page on the web has asked the network for nothing for
 *  `QUIET_MS`. A site goes on fetching after its load event (what it draws
 *  from a script, a font, a picture below the fold), and a picture taken at
 *  the event is of a page still arriving. */
async function networkQuiet(ctx: ViewContext, loadedAt: number): Promise<void> {
  for (;;) {
    const quietAt = Math.max(ctx.traffic.last, loadedAt) + QUIET_MS;
    const wait = Math.min(quietAt, loadedAt + QUIET_MAX_MS) - Date.now();
    if (wait <= 0) return;
    await pause(wait);
  }
}

/** Open the page at a view's viewport and device scale and wait for its load
 *  event, and for a page on the web to go quiet after it unless `settle` is
 *  false. Resolves with when the event fired, by this process's clock. */
async function openView(ctx: ViewContext, view: JobView, deviceScaleFactor: number, settle = true): Promise<number> {
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
  ctx.traffic.documents.clear();
  const navigated = navigateResultSchema.parse(await browser.send("Page.navigate", { url: ctx.url }, sessionId));
  if (navigated.errorText) throw new Error(`the page did not load (${navigated.errorText})`);
  await loaded;
  // Ruling 327: an address that answers with an error serves its error page,
  // and a picture of that is no look of the page that was asked for: a site
  // that turns a browser away with 403, a page that is gone. The status is
  // the one the frame this navigation loaded was answered with.
  const status = ctx.traffic.documents.get(navigated.frameId ?? "") ?? 0;
  if (ctx.web && status >= 400) throw new Error(`the address answered ${status}, so there is no page there to picture`);
  const loadedAt = Date.now();
  if (ctx.web && settle) await networkQuiet(ctx, loadedAt);
  return loadedAt;
}

type Layout = z.infer<typeof layoutSchema>;

async function layoutNow(ctx: ViewContext): Promise<Layout> {
  return layoutSchema.parse(await ctx.browser.send("Page.getLayoutMetrics", {}, ctx.sessionId));
}

/**
 * Look for a part of the page that scrolls inside it, at the one view it is
 * looked for at: on that view's own load, once the page is laid out and
 * before anything is done to it. A page that throws under the question is
 * one where nothing was found, and loses no picture for it.
 */
async function noteInside(ctx: ViewContext, view: JobView, layout: Layout): Promise<void> {
  if (view !== ctx.insideAt) return;
  const { scale } = pageSize(layout, view);
  try {
    const { inside } = await askPage(ctx, innerExpression({ width: view.width / scale, height: view.height / scale }), insideSchema);
    ctx.pictures.scrollsInside = inside ? { what: clip(inside.what, NAME_MAX), height: Math.round(inside.height * scale) } : null;
  } catch (caught) {
    if (!ctx.browser.alive) throw caught;
  }
}

/** Load the page at a view's viewport and device scale, walk it, and read
 *  how it was laid out. */
async function loadView(ctx: ViewContext, view: JobView, deviceScaleFactor: number): Promise<Layout> {
  await openView(ctx, view, deviceScaleFactor);
  await walkPage(ctx, view);
  const layout = await layoutNow(ctx);
  await noteInside(ctx, view, layout);
  return layout;
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

function pageSize(layout: Layout, view: JobView): PageSize {
  const scale = Math.min(Math.max(layout.cssVisualViewport.scale, 0.1), 5);
  const contentHeight = Math.round(layout.cssContentSize.height * scale);
  return {
    scale,
    contentWidth: Math.round(layout.cssContentSize.width * scale),
    contentHeight,
    pageHeight: Math.max(contentHeight, view.height),
  };
}

/**
 * One stretch of the page from `from` down, at most the view's cap tall and
 * never less than one screen. A picture too large to hand to an agent is
 * retaken half as tall, down to one screen. Resolves with the shot and the
 * height that was asked of the browser, which is where the next stretch
 * starts.
 */
async function pictureStretch(
  ctx: ViewContext,
  view: JobView,
  size: PageSize,
  from: number,
  file: string,
): Promise<{ shot: Shot; height: number }> {
  const { scale } = size;
  let height = Math.min(size.pageHeight - from, view.maxHeight);
  for (;;) {
    const shot = screenshotSchema.parse(
      await ctx.browser.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: from / scale, width: view.width / scale, height: height / scale, scale },
        },
        ctx.sessionId,
      ),
    );
    const bytes = Buffer.from(shot.data, "base64");
    if (bytes.length <= ctx.maxBytes) {
      const png = pngSize(bytes);
      if (!png) throw new Error("the browser returned a picture that is not a PNG");
      writeFileSync(path.join(ctx.out, file), bytes);
      return {
        height,
        shot: {
          view: view.id,
          width: png.width,
          height: png.height,
          from,
          contentHeight: size.contentHeight,
          contentWidth: size.contentWidth,
          scale,
          cut: false,
          file,
        },
      };
    }
    // Too large to hand to an agent: half as tall, down to one screen.
    const floor = Math.min(view.height, height);
    if (height <= floor) throw new Error("the picture of one screen of it is too large to keep");
    height = Math.max(Math.ceil(height / 2), floor);
  }
}

/** Picture the page at one view: a box, or stretches of it. A stretch starts
 *  at `view.from`, is never less than one screen and never more than the
 *  view's cap. Heights and widths are in the picture's own px: what the
 *  screen shows, after a phone has shrunk a page it lays out wider than
 *  itself. A page that is over before `view.from` at this width is this
 *  view's own outcome, not a failure: a phone lays a page out taller than a
 *  desktop does, so a stretch further down one may not exist on the other.
 *
 *  One stretch, into the first of `files`, unless the view is a whole page:
 *  then one per file, each starting where the one before ended, until the
 *  page does. Only the last says the page runs on below it: the ones before
 *  are carried on by the next. Each is kept as it is taken, so a page that
 *  fails at a later one still reports those it has. */
async function pictureView(ctx: ViewContext, view: JobView, files: readonly string[]): Promise<void> {
  const [first = ""] = files;
  if (view.box) {
    ctx.pictures.shots.push(await pictureBox(ctx, view, view.box.scale, first));
    return;
  }
  const size = pageSize(await loadView(ctx, view, 1), view);
  if (view.from >= size.pageHeight) {
    ctx.pictures.ended.push({ view: view.id, pageHeight: size.pageHeight });
    return;
  }
  let from = view.from;
  let last: Shot | null = null;
  for (const file of files) {
    if (from >= size.pageHeight) break;
    const stretch = await pictureStretch(ctx, view, size, from, file);
    ctx.pictures.shots.push(stretch.shot);
    last = stretch.shot;
    from += stretch.height;
  }
  if (last) last.cut = from < size.pageHeight;
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
 * shuts when its window is resized was pictured shut (Chrome 153 and Debian
 * Chromium 154).
 */
async function pictureScreen(ctx: ViewContext, view: JobView, file: string): Promise<Shot> {
  const { browser, sessionId } = ctx;
  const size = pageSize(await layoutNow(ctx), view);
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

/** A real pointer event at a point of the screen, in the page's own CSS px.
 *  A page a phone shrinks takes them unscaled: multiplied by the phone's
 *  scale, a press missed its control (Chrome 153 and Debian Chromium 154). */
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
    // Each press is paid for out of the page's time, and a number past any
    // page's stops would end the page at its limit for the sake of one act.
    if (asked.tab > TAB_PRESSES_MAX) throw new Error(`an act presses Tab at most ${TAB_PRESSES_MAX} times`);
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
    // page, or to another file of the task, is pictured where it led. A page
    // on the web is held to the site it is on the same way.
    const screen = await screenNow(ctx);
    if (!screen.href.startsWith(`${ctx.site}/`)) throw new Error("the press sent the browser to another address");
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

/**
 * Ruling 194: picture the page while it moves. It is loaded and not walked (a
 * walk plays what moves on a page before the first picture of it), its fonts
 * get a second, the window goes to `from` in one step, and the screen is
 * pictured at each of the moments after it came into view: after the load
 * event at the top of the page, after the step anywhere below. Each frame
 * says when it was really taken.
 */
async function pictureMoving(ctx: ViewContext, view: JobView, files: readonly string[]): Promise<void> {
  // At the top of a page the frames are due from the load event, so a page on
  // the web is not waited on there until it goes quiet.
  const loadedAt = await openView(ctx, view, 1, view.from > 0);
  await askPage(ctx, FONTS_EXPRESSION, z.object({}));
  const layout = await layoutNow(ctx);
  // Inside the wait for the first frame, which is due a quarter second on.
  await noteInside(ctx, view, layout);
  const size = pageSize(layout, view);
  if (view.from >= size.pageHeight) {
    ctx.pictures.ended.push({ view: view.id, pageHeight: size.pageHeight });
    return;
  }
  let shownAt = loadedAt;
  if (view.from > 0) {
    await askPage(ctx, scrollExpression(view.from / size.scale), z.object({ y: z.number() }));
    shownAt = Date.now();
  }
  for (const [frame, file] of files.entries()) {
    const wait = shownAt + (MOVING_MOMENTS[frame] ?? 0) - Date.now();
    if (wait > 0) await pause(wait);
    const moment = Date.now() - shownAt;
    ctx.pictures.shots.push({ ...(await pictureScreen(ctx, view, file)), moment });
  }
}

// ------------------------------------------------- reading a pictured page

/** A page's time ran out under a reading of it. */
class TimeUp extends Error {}

/** Why a check did not run when the page's time was up: the one sentence for
 *  it, whether the time went before the check's turn or under it. */
const OUT_OF_TIME = "the page's time ran out before it was measured";

/**
 * What is left of a page's time once its pictures are taken. The pictures are
 * what a capture is for, so what is read of a page beyond them (what moves on
 * it, how it measures) comes after every one of them, on loads of its own,
 * and may use this time and no more: a reading that ran into the page's limit
 * would turn a pictured page into a failed one. A step is cut off when the
 * time is up, and after `STEP_MAX_MS` whatever is left.
 */
class Budget {
  private readonly endsAt: number;

  constructor(endsAt: number) {
    this.endsAt = endsAt;
  }

  left(): number {
    return this.endsAt - Date.now();
  }

  /** What `start` resolves with, or a `TimeUp` once it has run for `most` ms
   *  or the page's time is up. Nothing is started with no time left. */
  async within<T>(start: () => Promise<T>, most: number = STEP_MAX_MS): Promise<T> {
    const left = this.left();
    if (left <= 0) throw new TimeUp(OUT_OF_TIME);
    let timer: NodeJS.Timeout | null = null;
    const up = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeUp(left <= most ? OUT_OF_TIME : `it was not measured in ${Math.round(most / 1000)} seconds`)),
        Math.min(left, most),
      );
    });
    try {
      return await Promise.race([start(), up]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A pictured page being read: its browser, and the time the reading has. */
interface Study {
  ctx: ViewContext;
  budget: Budget;
}

function askWithin<T>(study: Study, expression: string, schema: z.ZodType<T>): Promise<T> {
  return study.budget.within(() => askPage(study.ctx, expression, schema));
}

async function waitWithin(study: Study, ms: number): Promise<void> {
  if (ms > 0) await study.budget.within(() => pause(ms), ms + STEP_MAX_MS);
}

/**
 * One part of a reading, which may fail by itself: what it came to, or
 * `missed` when the page threw under it. A part that ran out of time is not
 * caught here. The page is then still busy with it, so it ends the whole
 * reading on that load.
 */
async function part<T>(work: Promise<T>, missed: T): Promise<T> {
  try {
    return await work;
  } catch (caught) {
    if (caught instanceof TimeUp) throw caught;
    return missed;
  }
}

/** A view's viewport with nothing else of it: how a page is loaded to be
 *  read at that width, from the top, with no motion preference of the
 *  view's. */
function atRest(view: JobView): JobView {
  return { id: view.id, width: view.width, height: view.height, maxHeight: view.maxHeight, mobile: view.mobile, from: 0 };
}

/** The controls whose look changes under the pointer, added to `hover` as
 *  each is found: brought to the middle of the screen, read at rest, given
 *  the real pointer and read again. One whose look does not change is left
 *  out. */
async function readHover(study: Study, screen: ScreenSize, hover: Motion["hover"]): Promise<void> {
  const listed = await askWithin(study, hoverListExpression(screen), hoverListSchema);
  for (const [index, what] of listed.controls.slice(0, HOVER_MAX).entries()) {
    const read = await part(
      (async () => {
        const at = await askWithin(study, hoverRestExpression(index), pointSchema);
        await study.budget.within(() => pointer(study.ctx, "mouseMoved", at));
        await waitWithin(study, HOVER_WAIT_MS);
        return askWithin(study, hoverReadExpression(index), hoverReadSchema);
      })(),
      null,
    );
    if (!read || read.changes.length === 0) continue;
    hover.push({
      what: clip(what, NAME_MAX),
      changes: read.changes.slice(0, HOVER_LOOK.length).map((name) => clip(name, NAME_MAX)),
      durationMs: read.durationMs === null ? null : Math.round(read.durationMs),
    });
  }
}

/**
 * What moves on a page (rulings 327 and 328), read once, at one width, on a
 * load of its own: what is still running a second after the load event, the
 * videos, how many elements animate in as the page is scrolled, a bar that
 * stays at the top, and the controls whose look changes under the pointer.
 *
 * On a load of its own and not on a view's, for two reasons. The count of
 * what animates in has to be taken on the page's first walk (see
 * `onScrollExpression`), and every pictured view but a moving one has
 * already walked its page. And a view's own load may be in no state to read:
 * an act has pressed something on it, a moving one is mid-flight. For the
 * same reason the count comes before the bar is looked for, which scrolls the
 * page. Null when the page did not load for it.
 */
async function readMotion(study: Study, view: JobView): Promise<Motion | null> {
  const rest = atRest(view);
  let loadedAt: number;
  try {
    loadedAt = await study.budget.within(() => openView(study.ctx, rest, 1));
  } catch {
    return null;
  }
  const motion: Motion = { running: [], runningCount: 0, videos: [], sticky: null, onScroll: 0, hover: [] };
  try {
    const { scale } = pageSize(await study.budget.within(() => layoutNow(study.ctx)), rest);
    const screen: ScreenSize = { width: rest.width / scale, height: rest.height / scale };
    await waitWithin(study, loadedAt + SETTLE_MS - Date.now());
    const moving = await part(askWithin(study, ANIMATIONS_EXPRESSION, animationsSchema), null);
    if (moving) {
      motion.running = moving.running.slice(0, RUNNING_MAX).map(asRunning);
      motion.runningCount = Math.max(moving.count, moving.running.length);
      motion.videos = moving.videos.slice(0, VIDEOS_MAX);
    }
    motion.onScroll = (await part(askWithin(study, onScrollExpression(screen), countSchema), { count: 0 })).count;
    const stays = (await part(askWithin(study, stickyExpression(screen), stickySchema), { sticky: null })).sticky;
    motion.sticky = stays ? { what: clip(stays.what, NAME_MAX), position: stays.position } : null;
    await part(readHover(study, screen, motion.hover), undefined);
  } catch {
    // Out of time part way: what was read stands.
  }
  return motion;
}

/** An animation as the page told it, in the report's own bounds. */
function asRunning(told: z.infer<typeof runningSchema>): Running {
  return {
    name: clip(told.name, NAME_MAX),
    target: clip(told.target, NAME_MAX),
    durationMs: told.durationMs === null ? null : Math.round(told.durationMs),
    loops: told.loops,
  };
}

/** The accessibility engine's script as the job named it: its source, or
 *  why there is none to run. */
interface Engine {
  source: string | null;
  why: string;
}

function readEngine(file: string | undefined): Engine {
  if (file === undefined) return { source: null, why: "no accessibility engine is installed" };
  try {
    return { source: readFileSync(file, "utf8"), why: "" };
  } catch {
    return { source: null, why: "the accessibility engine could not be read" };
  }
}

/** A check that did not run, and why. */
function notRun(why: string): Faults {
  return { ran: false, why: clip(why, SENTENCE_MAX), kinds: [], worstContrast: null };
}

/**
 * The engine's findings in the page as it stands. Its script is run in the
 * page first (it is the page's `window.axe` from then on), then asked for
 * what breaks the standards in `FAULT_TAGS`. The kinds come back the gravest
 * first, then the most widespread, so the cap never drops the worst of them.
 * Rejects with the reason when the engine cannot run, which `measureView`
 * reports and the page does not pay for.
 */
async function readFaults(study: Study, engine: Engine): Promise<Faults> {
  const { source } = engine;
  if (source === null) return notRun(engine.why);
  await study.budget.within(async () => {
    const run = evaluatedSchema.parse(
      await study.ctx.browser.send("Runtime.evaluate", { expression: `${ENGINE_MARK}${source}` }, study.ctx.sessionId),
    );
    if (run.exceptionDetails) throw new Error("the accessibility engine's script threw in the page");
  });
  const found = await askWithin(study, FAULTS_EXPRESSION, faultsSchema);
  const grave = (impact: string | null): number => {
    const at = impact === null ? -1 : FAULT_IMPACTS.indexOf(impact);
    return at < 0 ? FAULT_IMPACTS.length : at;
  };
  let worst: Faults["worstContrast"] = null;
  for (const node of found.violations.filter((violation) => violation.id === "color-contrast").flatMap((violation) => violation.nodes)) {
    const ratio = node.ratio ?? null;
    if (ratio !== null && (worst === null || ratio < worst.ratio)) worst = { ratio, text: clip(node.text ?? "", NAME_MAX) };
  }
  return {
    ran: true,
    why: null,
    kinds: found.violations
      .toSorted((a, b) => grave(a.impact) - grave(b.impact) || b.count - a.count)
      .slice(0, FAULT_KINDS_MAX)
      .map((violation) => ({
        id: clip(violation.id, NAME_MAX),
        impact: violation.impact === null ? null : clip(violation.impact, NAME_MAX),
        help: clip(violation.help, SENTENCE_MAX),
        count: violation.count,
        first: violation.nodes.slice(0, FAULT_FIRST_MAX).map((node) => clip(node.target, SENTENCE_MAX)),
      })),
    worstContrast: worst,
  };
}

/**
 * Walk the page with the keyboard: Tab, with real key events so that
 * `:focus-visible` holds, until it has come to every control, has been round,
 * or has made `TAB_PRESSES_MAX` presses.
 *
 * What a press can show, each measured on Chrome 153 and Debian Chromium 154:
 *
 *  - The same element as at the press before. That is one stop still being
 *    crossed, and the walk goes on. A date field is four stops and one
 *    element, a frame or a part with a shadow tree holds stops of its own
 *    while the document names only the frame or the part, and a field that
 *    keeps the key for itself looks the same, so nothing is concluded from
 *    it.
 *  - An element the walk was on earlier. That alone is not a walk gone
 *    round: a card whose own buttons stand before and after the link set
 *    into it holds focus, hands it to the link, and holds it again.
 *  - A step it has taken before, from one place to the same next one. From
 *    there Tab only goes where it has been, so the walk has been round all
 *    it can reach. That is the first step again on a page whose order comes
 *    round, and a step inside the trap on a page that traps the keyboard,
 *    where the controls past the trap are the ones to name.
 *  - Nothing: focus left the page. The next press shows where Tab comes back
 *    in. Back on the walk's first stop is its first step again. Nothing
 *    twice running is Tab going nowhere from the page itself, so there is no
 *    stop left to find. Leaving the page is by itself no proof that the walk
 *    has seen it all: the browser in the image sometimes sends focus from
 *    the last stop straight to the first and never off the page, and a walk
 *    does not always begin at the start of the order (a page can take focus
 *    back from `START_EXPRESSION`, and on a page with positive tab indexes
 *    the first stop in the document is not the first in the order).
 *
 * What is counted is the page's own controls, the ones `noted`: a stop that
 * is none of them (a box that scrolls, a frame, something editable) is where
 * focus was, not a control Tab reached, so the stops are never more than the
 * controls. A control is counted, and its look judged, the first time focus
 * comes to it. One that looks as it did at rest is unmarked. One that focus
 * never came to is unreached, and only a walk that has been round can say
 * so. A walk that came to every control has nothing left to find and ends
 * there, at whatever press. One that used its last press with a control
 * still not come to says it was cut, and names and counts none, since what
 * it did not get to may well be reachable. When that last press took focus
 * off the page, or back to where the walk had been, one more is made: it
 * shows whether the walk has just come round. Both lists are the first few;
 * the counts are of all.
 */
async function readKeyboard(study: Study, noted: z.infer<typeof controlsSchema>): Promise<Keyboard> {
  const reached = new Set<number>();
  const steps = new Set<string>();
  const unmarked: string[] = [];
  const been = new Set<number>();
  // The stop focus is on, null while it is on nothing of the page's, and
  // whether the last press took it there from somewhere else: off the page,
  // or back to a stop the walk had been on.
  let at: number | null = null;
  let back = false;
  let round = noted.count === 0;
  let presses = 0;
  if (!round) await askWithin(study, START_EXPRESSION, z.object({}));
  while (!round && (presses < TAB_PRESSES_MAX || (presses === TAB_PRESSES_MAX && back))) {
    presses += 1;
    await study.budget.within(() => pressTab(study.ctx));
    const focus = (await askWithin(study, FOCUS_EXPRESSION, focusSchema)).on;
    const place = focus ? focus.stop : null;
    if (place === at) {
      // The first press may start anywhere, so nothing then is no finding.
      round = place === null && presses > 1;
      back = false;
      continue;
    }
    const step = `${String(at)}>${String(place)}`;
    back = place === null || been.has(place);
    if (place !== null) been.add(place);
    at = place;
    if (steps.has(step)) {
      round = true;
      continue;
    }
    steps.add(step);
    if (!focus || focus.control < 0 || reached.has(focus.control)) continue;
    reached.add(focus.control);
    if (focus.marked === false) unmarked.push(clip(focus.tag, NAME_MAX));
    round = reached.size === noted.count;
  }
  const unreached = round ? noted.names.filter((_, control) => !reached.has(control)) : [];
  return {
    ran: true,
    cut: !round,
    controls: noted.count,
    stops: reached.size,
    unreached: unreached.slice(0, KEYBOARD_NAMES_MAX).map((name) => clip(name, NAME_MAX)),
    // Counted from how many were noted, not from the names: the page hands
    // over the first few hundred of those.
    unreachedCount: round ? noted.count - reached.size : 0,
    unmarked: unmarked.slice(0, KEYBOARD_NAMES_MAX),
    unmarkedCount: unmarked.length,
  };
}

/** What still runs at a view with reduced motion asked for, a second after a
 *  load of its own. A page that honours the preference has nothing here, and
 *  so has one that could not be read, which is why each says whether it
 *  ran. */
async function readReduced(study: Study, view: JobView): Promise<Reduced> {
  try {
    const loadedAt = await study.budget.within(() => openView(study.ctx, { ...view, reduce: true }, 1));
    await waitWithin(study, loadedAt + SETTLE_MS - Date.now());
    const moving = await askWithin(study, ANIMATIONS_EXPRESSION, animationsSchema);
    const lasting = moving.running.map(asRunning).filter((running) => running.loops || (running.durationMs ?? 0) > LASTING_MS);
    return {
      ran: true,
      runningCount: lasting.length,
      running: lasting.slice(0, REDUCED_RUNNING_MAX).map(({ name, target, loops }) => ({ name, target, loops })),
      videosPlaying: moving.videos.filter((video) => video.playing).length,
    };
  } catch {
    return { ran: false, runningCount: 0, running: [], videosPlaying: 0 };
  }
}

/** A view as the report states it before it is measured, and when it could
 *  not be: no check ran, so none of its zeros is a figure of the page's. */
function unmeasured(view: JobView): MeasuredView {
  return {
    view: view.id,
    faults: notRun(OUT_OF_TIME),
    keyboard: { ran: false, cut: false, controls: 0, stops: 0, unreached: [], unreachedCount: 0, unmarked: [], unmarkedCount: 0 },
    reduced: { ran: false, runningCount: 0, running: [], videosPlaying: 0 },
  };
}

/**
 * Ruling 328: measure the page at one view, on a load of its own that is
 * taken as the pictured one was: opened, its controls noted before anything
 * moves, then walked. The keyboard goes round it first and the engine runs
 * last, since nothing else is asked of that load after it: an engine that is
 * cut off for time is still at work in the page. What still moves under
 * reduced motion is read on one more load. Never rejects: whatever part
 * fails is reported as not measured, with the engine's reason when it was
 * the engine.
 */
async function measureView(study: Study, view: JobView, engine: Engine): Promise<MeasuredView> {
  const measured = unmeasured(view);
  try {
    await study.budget.within(() => openView(study.ctx, view, 1));
    const noted = await part(askWithin(study, CONTROLS_EXPRESSION, controlsSchema), null);
    await study.budget.within(() => walkPage(study.ctx, view));
    if (noted) measured.keyboard = await part(readKeyboard(study, noted), measured.keyboard);
    measured.faults = await readFaults(study, engine);
  } catch (caught) {
    // Measuring never fails a page: the reason is the report's to carry.
    measured.faults = notRun(caught instanceof Error ? caught.message : String(caught));
  }
  measured.reduced = await readReduced(study, view);
  return measured;
}

/**
 * How long the page takes to load on `SLOW_LINE`, with nothing cached: the
 * end of its load event, as the page's own navigation entry has it. The load
 * may use all that is left of the page's time, and one that does not finish
 * in it leaves null, so this is the last thing asked of a page's browser.
 * The line and the cache are put back whatever happened, and not waited on:
 * a browser still loading may not answer.
 */
async function readLoadMs(study: Study, view: JobView): Promise<number | null> {
  const { browser, sessionId } = study.ctx;
  try {
    await study.budget.within(async () => {
      await browser.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
      await browser.send("Network.emulateNetworkConditions", { offline: false, ...SLOW_LINE }, sessionId);
    });
    await study.budget.within(() => openView(study.ctx, atRest(view), 1), Infinity);
    const { ms } = await askWithin(study, LOAD_TIME_EXPRESSION, z.object({ ms: z.number().nullable() }));
    return ms === null ? null : Math.max(0, Math.round(ms));
  } catch {
    return null;
  } finally {
    browser
      .send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId)
      .catch(() => {});
    browser.send("Network.setCacheDisabled", { cacheDisabled: false }, sessionId).catch(() => {});
  }
}

/** A view that is a stretch of the page, one or several: the views a page is
 *  measured at. */
function isStretch(view: JobView): boolean {
  return !view.box && !view.act && view.moving !== true;
}

/** What is read of a page once it is pictured: null where it was not. */
interface Readings {
  motion: Motion | null;
  measured: Measured | null;
}

/** The view a page's motion is read at, and the one it is looked at for a
 *  part that scrolls inside it: the first that is not a phone's, where a
 *  pointer means something and a page is laid out at its widest, else the
 *  first. */
function motionView(views: readonly JobView[]): JobView | null {
  return views.find((view) => !view.mobile) ?? views[0] ?? null;
}

/** The browser of the page being pictured, so a stop ends it too. */
let current: Browser | null = null;

const targetSchema = z.looseObject({ targetId: z.string() });
const sessionSchema = z.looseObject({ sessionId: z.string() });

/** Picture one page at every view in a browser of its own, inside the page's
 *  time limit, then read of it what the job asks beyond its pictures, in what
 *  is left of that time. Never rejects. */
async function picturePage(job: Job, server: PageServer, engine: Engine, page: JobPage, index: number): Promise<PageReport> {
  const asked: Asked = { hosts: new Set(), urls: new Set() };
  const pictures: Pictures = { shots: [], ended: [], acts: [], scrollsInside: null };
  const { shots, ended, acts } = pictures;
  const dialogs = { count: 0 };
  // Ruling 327: a page on the web is opened at its own address, never through
  // the page server, so what a task page reports of the network and of the
  // page server (asked, missing) is not its to report.
  const web = page.kind === "web";
  const traffic = { last: 0, documents: new Map<string, number>() };
  const read: Readings = { motion: null, measured: null };
  /** What the page's pictures asked of the network and of the page server,
   *  and the dialogs they met. Fixed once the last picture is taken: the
   *  loads a reading makes after that are not the page's own. */
  const pictured = (): Pick<PageReport, "dialogs" | "asked" | "askedCount" | "missing"> => ({
    dialogs: dialogs.count,
    asked: web ? [] : [...asked.hosts].slice(0, REPORT_LIST_MAX),
    askedCount: web ? 0 : asked.urls.size,
    missing: web ? [] : server.missing(),
  });
  let settled: ReturnType<typeof pictured> | null = null;
  const report = (error: string | null): PageReport => {
    const said: PageReport = {
      file: page.file,
      shots,
      ended,
      acts,
      scrollsInside: pictures.scrollsInside,
      ...(settled ?? pictured()),
      error,
    };
    if (read.motion) said.motion = read.motion;
    if (read.measured) said.measured = read.measured;
    return said;
  };

  let url = server.base + encodeURIComponent(page.file);
  let setPage: string | null = null;
  if (web) {
    const address = webAddress(page.url);
    if (!address) return report("the page has no http or https address");
    url = address.href;
  } else {
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
  }
  server.begin(setPage);

  const profile = path.join(job.profile, String(index + 1));
  mkdirSync(profile, { recursive: true });
  const browser = new Browser(job.browser, browserArgs(profile, server.port, web));
  current = browser;
  const startedAt = Date.now();
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
        traffic.last = Date.now();
        const event = requestEventSchema.safeParse(params);
        if (event.success) noteRequest(asked, event.data.request.url, server.origin);
      } else if (method === "Network.responseReceived") {
        const event = documentEventSchema.safeParse(params);
        if (event.success && event.data.type === "Document") traffic.documents.set(event.data.frameId, event.data.response.status);
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
    const ctx: ViewContext = {
      browser,
      sessionId,
      url,
      origin: server.origin,
      web,
      site: web ? new URL(url).origin : server.origin,
      traffic,
      out: job.out,
      maxBytes: job.maxBytes,
      pictures,
      insideAt: motionView(job.views),
    };
    try {
      await browser.send("Page.enable", {}, sessionId);
      await browser.send("Network.enable", {}, sessionId);
      await browser.send("Audits.enable", {}, sessionId);
      // Ruling 328: a task page of a measured job is measured at each view
      // that is a stretch of it, and weighed on the first of those loads.
      const stretches = job.measure === true && !web ? job.views.filter(isStretch) : null;
      let weight: Weight = { bytes: 0, files: 0 };
      for (const view of job.views) {
        const files = pictureNames(view).map((name) => `${index + 1}-${name}.png`);
        const [first = ""] = files;
        const before = server.served();
        if (view.act) await pictureAct(ctx, view, view.act, first);
        else if (view.moving === true) await pictureMoving(ctx, view, files);
        else await pictureView(ctx, view, files);
        if (view === stretches?.[0]) {
          const after = server.served();
          weight = { bytes: after.bytes - before.bytes, files: after.files - before.files };
        }
      }
      settled = pictured();
      // Every picture is taken. What is read of the page beyond them has
      // what is left of its time, and costs it nothing when that runs out.
      const study: Study = { ctx, budget: new Budget(startedAt + job.pageTimeoutMs - CLOSING_MS) };
      if (stretches) {
        const measured: Measured = { views: stretches.map(unmeasured), weight, loadMs: null, line: SLOW_LINE_READS };
        read.measured = measured;
        for (const [at, view] of stretches.entries()) measured.views[at] = await measureView(study, view, engine);
      }
      const moves = web || job.measure === true ? motionView(job.views) : null;
      if (moves) read.motion = await readMotion(study, moves);
      // Last, since a load that does not finish leaves the browser at it.
      const slow = stretches?.find((view) => view.mobile) ?? stretches?.[0];
      if (read.measured && slow) read.measured.loadMs = await readLoadMs(study, slow);
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
  const engine = readEngine(job.measure === true ? job.axe : undefined);
  try {
    for (const [index, page] of job.pages.entries()) {
      pages.push(await picturePage(job, server, engine, page, index));
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
