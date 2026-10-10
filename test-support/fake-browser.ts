import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * An executable stand-in for Chromium, for the page capture (ruling 194).
 *
 * The renderer child's whole job is to drive a REAL browser process over its
 * `--remote-debugging-pipe`: start it with flags that leave it no way out,
 * serve it a page, read the page's size, and take its picture. A stubbed module
 * would test none of that, so this is an actual executable (mode 0o755, a
 * shebang pointing at the node running the suite) that speaks the little of
 * the DevTools protocol the child speaks, on the same fd 3 and 4.
 *
 * What it does with a page it is told to open: it FETCHES the address from the
 * page server, as a browser would, and every `src="..."` in what came back, so
 * a test reads the page server's real answers (the article a markdown file was
 * set as, a sibling picture, a refused link). It lays nothing out, so a page
 * says how large it is in its own text: `fake-height:3000`, `fake-width:612`
 * and `fake-scale:0.398` anywhere in the document (markdown included) are the
 * page's content height, content width and phone scale; without them a page
 * is one screen. `fake-crash-at:390` ends the browser when the page is loaded
 * at that viewport width, so one width is pictured and the other is not. A
 * screenshot is a real PNG of the clip it was asked for, at the clip's own
 * scale times the device scale the viewport was set to, as a browser draws
 * it, in a grey that changes every 2,000 px down the page and comes round
 * again after ten, so two stretches of a page differ and a page of 20,000 px
 * and more repeats itself; `fake-short-by:1` makes it that many px shorter,
 * as a browser that rounded a side the other way would.
 *
 * A page also says, in its own text, what a browser would answer when the
 * child acts on it or reads it: `fake-<name>:<JSON>`, up to the next tag or
 * the end of the line. The child's in-page expressions each open with a marker
 * comment (`viberr:find` and what it is asked with, as JSON), and the stand-in
 * answers the marker from what the page declares, or "nothing" when it
 * declares none:
 *
 *  - `fake-find:{"Menu":[120,40,"button"]}`: the controls an act finds, each
 *    by the words it is asked for, at the centre given, of the kind given
 *    ("button" when left out); a fourth item is the address a press on it
 *    sends the browser to. `fake-names:["Docs","Sign in"]` is what the page's
 *    controls are called when the one asked for is not among them, and
 *    `fake-scrolled:340` where the window stands once the page was acted on.
 *  - `fake-controls:[["a","Docs"],["button","Menu"]]`: the controls a keyboard
 *    should reach, `fake-tab-order:[0,1]` the ones Tab stops on, in order (a
 *    key-down of Tab moves focus one stop along it, off the page after the
 *    last, and round again), `fake-unmarked:[1]` the stops whose look does
 *    not change when they take focus.
 *  - `fake-axe:[...]`: what the accessibility engine finds, answered only
 *    once the engine's script was run in the page (a script that holds the
 *    text `fake-engine`, or axe-core's own, by its banner, which is the one
 *    the server names); `fake-axe-throws:"why"` makes it throw.
 *  - `fake-animations:[...]` and `fake-videos:[...]`: what is running a
 *    moment after the load; `fake-animations-reduced:[...]` what still is
 *    when the page was told reduced motion. `fake-sticky:{...}`,
 *    `fake-on-scroll:3` and `fake-hover:[{"what":"a.nav","at":[100,20],
 *    "changes":["color"],"durationMs":150}]` are the rest of what moves; a
 *    control's look changes only while the pointer is on its centre.
 *  - `fake-load-ms:1234`: the load time it reports on a held line with the
 *    cache off (1 otherwise); `fake-slow-line:never` never finishes a load on
 *    a held line.
 *  - `fake-trickle:3`: so many requests after the load event, 200 ms apart;
 *    `fake-lands:"about:blank"`: the address the browser is at once loaded.
 *
 * A browser started without `--proxy-server` has the network open: an
 * absolute `src` is then fetched too, where one behind the proxy is only
 * reported. An address nothing answers at is a navigation that failed.
 *
 * It records itself in the evidence directory: `launches.jsonl` (argv, the
 * whole environment, the uid), `pages.jsonl` (one line per page load: the
 * address, the viewport, the HTML it was served, each sub-resource's status,
 * the motion it had been told to ask for), `shots.jsonl` (each screenshot's
 * clip, how many late requests were still to come, how long the network had
 * been quiet and how long ago the last pointer or key event arrived),
 * `dialogs.jsonl` (each dialog it opened: its type and how it
 * was answered), `inputs.jsonl` (each pointer and key event), `emulations.jsonl`
 * (each change of the emulated media, the cache and the line) and `asks.jsonl`
 * (each marked expression: its name, what it was asked with and how long
 * after the page's load event).
 *
 * A suite whose door refuses a loopback address stands a loopback server in
 * for a name on the web with a `host:look.example=127.0.0.1:4100` rule, as a
 * hosts file would: every fetch of that host goes to the server, under the
 * host's own name, and the page still reports the address it was asked for.
 *
 * Behaviour is switched by {@link FAKE_BROWSER_MODE_ENV} on the SUITE's
 * process (an undeclared name, so it survives `filteredSpawnEnv`): a
 * comma-separated list of `mode` or `mode:needle`, where a rule with a needle
 * applies only to a page whose address or HTML contains it. `hang` never
 * answers the load, `crash` ends the process at the load, `big` pads every
 * screenshot by 1,000 bytes per px of height, `dialog` opens an alert during
 * the load and finishes the load only once the dialog is answered (as a page
 * stopped on `alert()` does), `unload` is a page that asks before it lets the
 * browser leave it (a `beforeunload` dialog at every load after its first,
 * which starts only once the dialog is accepted and never when it is
 * dismissed), and `hold` finishes the load only once the suite calls
 * {@link FakeBrowser.release}, so a test can act while a render is in flight.
 */
const FAKE_BROWSER_MODE_ENV = "VIBERR_FAKE_BROWSER_MODE";
const FAKE_BROWSER_EVIDENCE_ENV = "VIBERR_FAKE_BROWSER_EVIDENCE_DIR";

const SCRIPT = `const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");

const evidenceDir = process.env.${FAKE_BROWSER_EVIDENCE_ENV} || "";
const rules = (process.env.${FAKE_BROWSER_MODE_ENV} || "")
  .split(",")
  .filter(Boolean)
  .map((rule) => {
    const at = rule.indexOf(":");
    return at < 0 ? { mode: rule, needle: "" } : { mode: rule.slice(0, at), needle: rule.slice(at + 1) };
  });
function evidence(name, record) {
  if (!evidenceDir) return;
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.appendFileSync(path.join(evidenceDir, name), JSON.stringify(record) + "\\n");
  } catch {
    // Evidence is best effort.
  }
}
evidence("launches.jsonl", { argv: process.argv.slice(2), env: process.env, uid: process.getuid() });

const send = (message) => fs.writeSync(4, JSON.stringify(message) + "\\0");
const metrics = { width: 0, height: 0, deviceScaleFactor: 1, mobile: false };
let page = { url: "about:blank", html: "" };
/** A browser started behind the proxy that leads nowhere reaches no address
 *  but the page server's. */
const networkOpen = !process.argv.some((arg) => arg.startsWith("--proxy-server="));
/** The motion the client last told the page to ask for; "" until it says. */
let reducedMotion = "";
/** The line as the client set it: the cache off, the throughput held. */
const line = { cacheDisabled: false, held: false };
/** Where the pointer was last moved to. */
let pointer = null;
/** How far along the page's tab order focus is; -1 while nothing holds it. */
let focus = -1;
/** True once the page's controls were noted, as a keyboard walk notes them. */
let noted = false;
/** True once the accessibility engine's script was run in this document. */
let engine = false;
/** Where the window is scrolled to. */
let scrollY = 0;
/** The address a press sent the browser to, when it left the page. */
let moved = null;
/** When the page last asked the network for something, and how many late
 *  requests it has still to make. */
let lastRequestAt = 0;
let lateLeft = 0;
/** When the last pointer or key event arrived. */
let lastInputAt = 0;
/** When the page's load event was sent. */
let loadedAt = 0;

/** The names a suite's loopback server stands in for, as a hosts file would
 *  name them: a \`host:look.example=127.0.0.1:4100\` rule each. */
const hosts = new Map(rules.filter((rule) => rule.mode === "host").map((rule) => rule.needle.split("=")));

/** Where an address is fetched from: itself, or the loopback server that
 *  stands in for its host, asked under the host's own name. */
function reach(url) {
  try {
    const asked = new URL(url);
    const stood = hosts.get(asked.host);
    if (stood) return { target: "http://" + stood + asked.pathname + asked.search, headers: { host: asked.host } };
  } catch {
    // Not an address: fetched as it is, and answered as one nothing is at.
  }
  return { target: url, headers: {} };
}

function get(url) {
  return new Promise((resolve) => {
    const { target, headers } = reach(url);
    const nothing = () => resolve({ status: 0, body: Buffer.alloc(0), headers: {} });
    try {
      http
        .get(target, { headers }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }));
        })
        .on("error", nothing);
    } catch {
      // An address this stand-in cannot fetch (https with no server stood in
      // for it) is one nothing answers at.
      nothing();
    }
  });
}

function modeFor(url, html) {
  const hit = rules.find((rule) => rule.needle === "" || url.includes(rule.needle) || html.includes(rule.needle));
  return hit ? hit.mode : "ok";
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
/** The dialog a page is stopped on, until the client answers it, and its
 *  type. */
let answerDialog = null;
let dialogType = "";

/** Open a dialog of \`type\` and resolve with how the client answered it. */
function openDialog(sessionId, url, type) {
  return new Promise((done) => {
    answerDialog = done;
    dialogType = type;
    send({
      method: "Page.javascriptDialogOpening",
      sessionId,
      params: { url, message: type === "alert" ? "Welcome" : "", type, hasBrowserHandler: false, defaultPrompt: "" },
    });
  });
}

function declared(name, fallback) {
  const found = new RegExp("fake-" + name + ":([0-9.]+)").exec(page.html);
  return found ? Number(found[1]) : fallback;
}

/** What the page says as \`fake-<name>:<JSON>\`, up to the next tag or the
 *  end of the line. */
function told(name, fallback) {
  const found = new RegExp("fake-" + name + ":([^<\\n]+)").exec(page.html);
  return found ? JSON.parse(found[1]) : fallback;
}

/** Tell the client the page asked the network for \`url\`. */
function requested(sessionId, url) {
  lastRequestAt = Date.now();
  send({ method: "Network.requestWillBeSent", sessionId, params: { request: { url } } });
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(width, height, padding, top) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; colour type 0 (grey) stays zero
  // One grey for each 2,000 px down the page, ten of them and round again:
  // two parts of a page look different, and a page long enough repeats.
  const rows = Buffer.alloc(height * (1 + width), 200 - (Math.floor(top / 2000) % 10) * 5);
  for (let y = 0; y < height; y += 1) rows[y * (1 + width)] = 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (padding > 0) parts.push(chunk("teXt", Buffer.alloc(padding, 120)));
  parts.push(chunk("IDAT", zlib.deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

async function navigate(message) {
  const url = message.params.url;
  const main = await get(url);
  if (main.status === 0) {
    // Nothing answers at that address: a browser says so and loads nothing.
    send({ id: message.id, sessionId: message.sessionId, result: { frameId: "F1", errorText: "net::ERR_CONNECTION_REFUSED" } });
    return;
  }
  const html = main.body.toString("utf8");
  const mode = modeFor(url, html);
  const crashAt = /fake-crash-at:([0-9]+)/.exec(html);
  if (mode === "crash" || (crashAt && Number(crashAt[1]) === metrics.width)) process.exit(7);
  if (mode === "hang") return;
  if (line.held && html.includes("fake-slow-line:never")) return;
  if (mode === "hold") {
    while (!fs.existsSync(path.join(evidenceDir, "release"))) await pause(20);
  }
  if (mode === "unload" && page.url !== "about:blank") {
    // The page loaded here asks before it lets the browser go: told to
    // stay, the browser never starts this load.
    const leave = await openDialog(message.sessionId, page.url, "beforeunload");
    if (!leave) return;
  }
  if (mode === "dialog") await openDialog(message.sessionId, url, "alert");
  const resources = [];
  for (const found of html.matchAll(/src="([^"]+)"/g)) {
    const src = found[1];
    if (/^https?:/.test(src)) {
      // A browser reports the request; behind the proxy it never leaves.
      requested(message.sessionId, src);
      if (!networkOpen) {
        resources.push({ src, status: null });
        continue;
      }
    }
    const answer = await get(new URL(src, url).href);
    resources.push({ src, status: answer.status, bytes: answer.body.length });
  }
  page = { url, html };
  // A new document: nothing holds focus, nothing was noted, run or scrolled.
  focus = -1;
  noted = false;
  engine = false;
  scrollY = 0;
  moved = null;
  lateLeft = declared("trickle", 0);
  evidence("pages.jsonl", { url, status: main.status, headers: main.headers, html, metrics: { ...metrics }, resources, reducedMotion });
  send({ id: message.id, sessionId: message.sessionId, result: { frameId: "F1" } });
  loadedAt = Date.now();
  send({ method: "Page.loadEventFired", sessionId: message.sessionId, params: { timestamp: 1 } });
  while (lateLeft > 0 && page.url === url) {
    await pause(200);
    lateLeft -= 1;
    requested(message.sessionId, url + "?late=" + lateLeft);
  }
}

/** Answer an expression the client runs in the page: a marked one from what
 *  the page declares, any other with where the browser is. */
function evaluate(message) {
  const reply = (result) => send({ id: message.id, sessionId: message.sessionId, result });
  const say = (value) => reply({ result: { type: "string", value: JSON.stringify(value) } });
  const thrown = (description) =>
    reply({
      result: { type: "object", subtype: "error", description },
      exceptionDetails: { text: "Uncaught (in promise)", exception: { type: "object", subtype: "error", description } },
    });
  const marked = /^\\/\\* viberr:([a-z-]+) (.*?) \\*\\//.exec(message.params.expression);
  if (!marked) return reply({ result: { type: "string", value: moved || page.url } });
  const ask = marked[1];
  const args = JSON.parse(marked[2]);
  evidence("asks.jsonl", { ask, args, sinceLoadMs: Date.now() - loadedAt });
  switch (ask) {
    case "walk":
      return reply({ result: { type: "string", value: told("lands", null) || moved || page.url } });
    case "fonts":
      return say({});
    case "scroll":
      scrollY = args.y;
      return say({ y: scrollY });
    case "screen":
      return say({ x: 0, y: scrollY, href: moved || page.url });
    case "find": {
      const hit = told("find", {})[args.what];
      if (!hit) return say({ found: null, names: told("names", []), more: false });
      return say({ found: { x: hit[0], y: hit[1], name: (hit[2] || "button") + ' "' + args.what + '"' } });
    }
    case "controls":
      noted = true;
      return say({ count: told("controls", []).length, names: told("controls", []).map(([tag, words]) => tag + ' "' + words + '"') });
    case "focus": {
      if (focus < 0) return say({ on: null });
      const order = told("tab-order", []);
      const index = order[focus];
      const [tag, words] = told("controls", [])[index];
      return say({
        on: {
          name: (tag === "a" ? "link" : tag) + ' "' + words + '"',
          tag: tag + ' "' + words + '"',
          control: noted ? index : -1,
          stop: order.indexOf(index),
          marked: noted ? !told("unmarked", []).includes(index) : null,
        },
      });
    }
    case "engine":
      engine = message.params.expression.includes("fake-engine") || message.params.expression.includes("/*! axe v");
      return reply({ result: { type: "boolean", value: true } });
    case "faults": {
      if (!engine) return thrown("TypeError: Cannot read properties of undefined (reading 'run')");
      const why = told("axe-throws", null);
      return why ? thrown("Error: " + why) : say({ violations: told("axe", []) });
    }
    case "animations": {
      const running = reducedMotion === "reduce" ? told("animations-reduced", []) : told("animations", []);
      return say({ count: running.length, running, videos: told("videos", []) });
    }
    case "sticky":
      return say({ sticky: told("sticky", null) });
    case "on-scroll":
      return say({ count: declared("on-scroll", 0) });
    case "hover-list":
      return say({ controls: told("hover", []).map((control) => control.what) });
    case "hover-rest": {
      const control = told("hover", [])[args.index];
      return say({ x: control.at[0], y: control.at[1] });
    }
    case "hover-read": {
      const control = told("hover", [])[args.index];
      const on = pointer !== null && pointer[0] === control.at[0] && pointer[1] === control.at[1];
      return say({ changes: on ? control.changes : [], durationMs: on && control.durationMs !== undefined ? control.durationMs : null });
    }
    case "load-time":
      return say({ ms: line.held && line.cacheDisabled ? declared("load-ms", 1) : 1 });
    default:
      return thrown("ReferenceError: the stand-in knows no " + ask);
  }
}

function handle(message) {
  const reply = (result) => send({ id: message.id, sessionId: message.sessionId, result });
  switch (message.method) {
    case "Target.createTarget":
      return reply({ targetId: "T1" });
    case "Target.attachToTarget":
      return reply({ sessionId: "S1" });
    case "Page.enable":
    case "Network.enable":
    case "Audits.enable":
      return reply({});
    case "Emulation.setDeviceMetricsOverride":
      Object.assign(metrics, {
        width: message.params.width,
        height: message.params.height,
        deviceScaleFactor: message.params.deviceScaleFactor,
        mobile: message.params.mobile,
      });
      return reply({});
    case "Emulation.setEmulatedMedia":
      evidence("emulations.jsonl", { method: message.method, ...message.params });
      for (const feature of message.params.features || []) {
        if (feature.name === "prefers-reduced-motion") reducedMotion = feature.value;
      }
      return reply({});
    case "Network.setCacheDisabled":
      evidence("emulations.jsonl", { method: message.method, ...message.params });
      line.cacheDisabled = message.params.cacheDisabled === true;
      return reply({});
    case "Network.emulateNetworkConditions":
      evidence("emulations.jsonl", { method: message.method, ...message.params });
      line.held = message.params.downloadThroughput > 0;
      return reply({});
    case "Input.dispatchMouseEvent": {
      evidence("inputs.jsonl", { method: message.method, ...message.params });
      lastInputAt = Date.now();
      const at = [message.params.x, message.params.y];
      if (message.params.type === "mouseMoved") pointer = at;
      if (message.params.type === "mousePressed") {
        // A press on a control that leads somewhere takes the browser there.
        const hit = Object.values(told("find", {})).find((control) => control[0] === at[0] && control[1] === at[1]);
        if (hit && hit[3]) moved = hit[3];
        scrollY = declared("scrolled", scrollY);
      }
      return reply({});
    }
    case "Input.dispatchKeyEvent":
      evidence("inputs.jsonl", { method: message.method, ...message.params });
      lastInputAt = Date.now();
      if ((message.params.type === "rawKeyDown" || message.params.type === "keyDown") && message.params.key === "Tab") {
        // One stop along the tab order; off the page after the last.
        focus = focus + 1 >= told("tab-order", []).length ? -1 : focus + 1;
        scrollY = declared("scrolled", scrollY);
      }
      return reply({});
    case "Page.navigate":
      return void navigate(message);
    case "Runtime.evaluate":
      return evaluate(message);
    case "Page.handleJavaScriptDialog": {
      evidence("dialogs.jsonl", { type: dialogType, accept: message.params.accept });
      reply({});
      const answer = answerDialog;
      answerDialog = null;
      if (answer) answer(message.params.accept);
      return;
    }
    case "Page.getLayoutMetrics": {
      const scale = metrics.mobile ? declared("scale", 1) : 1;
      return reply({
        cssContentSize: {
          x: 0,
          y: 0,
          width: declared("width", metrics.width) / scale,
          height: declared("height", metrics.height) / scale,
        },
        cssVisualViewport: { scale },
      });
    }
    case "Page.captureScreenshot": {
      const clip = message.params.clip;
      const width = Math.round(clip.width * clip.scale * metrics.deviceScaleFactor);
      const height = Math.round(clip.height * clip.scale * metrics.deviceScaleFactor) - declared("short-by", 0);
      const padding = modeFor(page.url, page.html) === "big" ? height * 1000 : 0;
      evidence("shots.jsonl", {
        url: page.url,
        clip,
        width,
        height,
        late: lateLeft,
        quietMs: Date.now() - lastRequestAt,
        sinceInputMs: Date.now() - lastInputAt,
      });
      return reply({ data: png(width, height, padding, clip.y).toString("base64") });
    }
    case "Browser.close":
      reply({});
      return process.exit(0);
    default:
      return send({ id: message.id, sessionId: message.sessionId, error: { code: -32601, message: "'" + message.method + "' wasn't found" } });
  }
}

let pending = Buffer.alloc(0);
// A socket, not a file stream: a file read waits in the thread pool and
// holds the process open past its own exit.
const input = new net.Socket({ fd: 3, readable: true, writable: false });
input.on("data", (data) => {
  pending = Buffer.concat([pending, data]);
  for (;;) {
    const end = pending.indexOf(0);
    if (end < 0) return;
    const text = pending.subarray(0, end).toString("utf8");
    pending = pending.subarray(end + 1);
    handle(JSON.parse(text));
  }
});
input.on("end", () => process.exit(0));
input.on("error", () => process.exit(0));
`;

export interface FakeBrowser {
  /** The executable: what `VIBERR_BROWSER_EXECUTABLE` (or a job) names. */
  executable: string;
  /** Where it records its launches and the pages it was served. */
  evidenceDir: string;
  /** The variables that point a suite's process at it, with `mode` set. */
  env(mode?: string): Record<string, string>;
  launches(): FakeBrowserLaunch[];
  pages(): FakeBrowserPage[];
  shots(): FakeBrowserShot[];
  /** Each dialog a `dialog` or an `unload` page opened: its type and how it
   *  was answered. */
  dialogs(): FakeBrowserDialog[];
  /** Each pointer and key event it was sent, in order. */
  inputs(): FakeBrowserInput[];
  /** Each change of the emulated media, the cache and the line, in order. */
  emulations(): FakeBrowserEmulation[];
  /** Each marked expression it was asked to run: its name and arguments. */
  asks(): FakeBrowserAsk[];
  /** Let every load a `hold` rule is holding finish, and every later one. */
  release(): void;
}

const launchSchema = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  uid: z.number(),
});
export type FakeBrowserLaunch = z.infer<typeof launchSchema>;

const pageSchema = z.object({
  url: z.string(),
  status: z.number(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  html: z.string(),
  metrics: z.object({ width: z.number(), height: z.number(), deviceScaleFactor: z.number(), mobile: z.boolean() }),
  resources: z.array(z.object({ src: z.string(), status: z.number().nullable(), bytes: z.number().optional() })),
  /** The `prefers-reduced-motion` the page was loaded under: "" when the
   *  client had set none. */
  reducedMotion: z.string(),
});
export type FakeBrowserPage = z.infer<typeof pageSchema>;

const shotSchema = z.object({
  url: z.string(),
  clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), scale: z.number() }),
  width: z.number(),
  height: z.number(),
  /** How many of a `fake-trickle` page's late requests were still to come. */
  late: z.number(),
  /** How long the page had asked the network for nothing. */
  quietMs: z.number(),
  /** How long ago the last pointer or key event arrived. */
  sinceInputMs: z.number(),
});
export type FakeBrowserShot = z.infer<typeof shotSchema>;

const dialogSchema = z.object({ type: z.string(), accept: z.boolean() });
export type FakeBrowserDialog = z.infer<typeof dialogSchema>;

const inputSchema = z.object({
  method: z.string(),
  type: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.string().optional(),
  clickCount: z.number().optional(),
  key: z.string().optional(),
  code: z.string().optional(),
  windowsVirtualKeyCode: z.number().optional(),
});
export type FakeBrowserInput = z.infer<typeof inputSchema>;

const emulationSchema = z.object({
  method: z.string(),
  /** `Emulation.setEmulatedMedia`: the media features it set. */
  features: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  /** `Network.setCacheDisabled`. */
  cacheDisabled: z.boolean().optional(),
  /** `Network.emulateNetworkConditions`. */
  offline: z.boolean().optional(),
  latency: z.number().optional(),
  downloadThroughput: z.number().optional(),
  uploadThroughput: z.number().optional(),
});
export type FakeBrowserEmulation = z.infer<typeof emulationSchema>;

const askSchema = z.object({
  ask: z.string(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** How long after the page's load event it was asked. */
  sinceLoadMs: z.number(),
});
export type FakeBrowserAsk = z.infer<typeof askSchema>;

function readLines<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}

/** Write the executable into `dir`, a directory the test owns and removes. */
export function writeFakeBrowser(dir: string): FakeBrowser {
  mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, "chromium");
  writeFileSync(executable, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(executable, 0o755);
  const evidenceDir = path.join(dir, "evidence");
  return {
    executable,
    evidenceDir,
    env: (mode = "") => ({ [FAKE_BROWSER_EVIDENCE_ENV]: evidenceDir, [FAKE_BROWSER_MODE_ENV]: mode }),
    launches: () => readLines(path.join(evidenceDir, "launches.jsonl"), launchSchema),
    pages: () => readLines(path.join(evidenceDir, "pages.jsonl"), pageSchema),
    shots: () => readLines(path.join(evidenceDir, "shots.jsonl"), shotSchema),
    dialogs: () => readLines(path.join(evidenceDir, "dialogs.jsonl"), dialogSchema),
    inputs: () => readLines(path.join(evidenceDir, "inputs.jsonl"), inputSchema),
    emulations: () => readLines(path.join(evidenceDir, "emulations.jsonl"), emulationSchema),
    asks: () => readLines(path.join(evidenceDir, "asks.jsonl"), askSchema),
    release: () => {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(path.join(evidenceDir, "release"), "");
    },
  };
}
