import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * An executable stand-in for Chromium, for the page capture (ruling 691).
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
 * screenshot is a real PNG of the clip it was asked for.
 *
 * It records itself in the evidence directory: `launches.jsonl` (argv, the
 * whole environment, the uid), `pages.jsonl` (one line per page load: the
 * address, the viewport, the HTML it was served, each sub-resource's status),
 * `shots.jsonl` (each screenshot's clip) and `dialogs.jsonl` (each dialog it
 * opened: its type and how it was answered).
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
export const FAKE_BROWSER_MODE_ENV = "VIBERR_FAKE_BROWSER_MODE";
export const FAKE_BROWSER_EVIDENCE_ENV = "VIBERR_FAKE_BROWSER_EVIDENCE_DIR";

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
const metrics = { width: 0, height: 0, mobile: false };
let page = { url: "about:blank", html: "" };

function get(url) {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }));
      })
      .on("error", () => resolve({ status: 0, body: Buffer.alloc(0), headers: {} }));
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

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(width, height, padding) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; colour type 0 (grey) stays zero
  const rows = Buffer.alloc(height * (1 + width), 200);
  for (let y = 0; y < height; y += 1) rows[y * (1 + width)] = 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (padding > 0) parts.push(chunk("teXt", Buffer.alloc(padding, 120)));
  parts.push(chunk("IDAT", zlib.deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

async function navigate(message) {
  const url = message.params.url;
  const main = await get(url);
  const html = main.body.toString("utf8");
  const mode = modeFor(url, html);
  const crashAt = /fake-crash-at:([0-9]+)/.exec(html);
  if (mode === "crash" || (crashAt && Number(crashAt[1]) === metrics.width)) process.exit(7);
  if (mode === "hang") return;
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
      // A browser reports the request; this one never leaves.
      send({ method: "Network.requestWillBeSent", sessionId: message.sessionId, params: { request: { url: src } } });
      resources.push({ src, status: null });
      continue;
    }
    const answer = await get(new URL(src, url).href);
    resources.push({ src, status: answer.status, bytes: answer.body.length });
  }
  page = { url, html };
  evidence("pages.jsonl", { url, status: main.status, headers: main.headers, html, metrics: { ...metrics }, resources });
  send({ id: message.id, sessionId: message.sessionId, result: { frameId: "F1" } });
  send({ method: "Page.loadEventFired", sessionId: message.sessionId, params: { timestamp: 1 } });
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
      Object.assign(metrics, { width: message.params.width, height: message.params.height, mobile: message.params.mobile });
      return reply({});
    case "Page.navigate":
      return void navigate(message);
    case "Runtime.evaluate":
      return reply({ result: { type: "string", value: page.url } });
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
      const width = Math.round(clip.width * clip.scale);
      const height = Math.round(clip.height * clip.scale);
      const padding = modeFor(page.url, page.html) === "big" ? height * 1000 : 0;
      evidence("shots.jsonl", { url: page.url, clip, width, height });
      return reply({ data: png(width, height, padding).toString("base64") });
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
  metrics: z.object({ width: z.number(), height: z.number(), mobile: z.boolean() }),
  resources: z.array(z.object({ src: z.string(), status: z.number().nullable(), bytes: z.number().optional() })),
});
export type FakeBrowserPage = z.infer<typeof pageSchema>;

const shotSchema = z.object({
  url: z.string(),
  clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), scale: z.number() }),
  width: z.number(),
  height: z.number(),
});
export type FakeBrowserShot = z.infer<typeof shotSchema>;

const dialogSchema = z.object({ type: z.string(), accept: z.boolean() });
export type FakeBrowserDialog = z.infer<typeof dialogSchema>;

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
    release: () => {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(path.join(evidenceDir, "release"), "");
    },
  };
}
