#!/bin/sh
# Ruling 42's in-image check: the page capture's renderer against the REAL
# browser the image ships, as an agent uid, through the launcher.
#
# The unit suites drive the renderer with a stand-in browser
# (test-support/fake-browser.ts), so everything that only Chromium itself can
# show is proved here, once, in the image:
#
#   - the proxy rule lets ONLY the page server through: a page's requests to
#     another loopback port (the app's own included) and to a remote host load
#     nothing, by a subresource, a fetch or a navigation;
#   - a full-page picture leaves the layout alone: a `100vh` section is one
#     screen tall in a picture three screens tall;
#   - the pictures come back at the two widths, with a sibling file drawn;
#   - a markdown file is set as a page;
#   - a page that stops on `alert()` is pictured behind its dialog, and the
#     report says it opened one;
#   - ruling 194: a picture of an exact size (`capture_page` with `width` and
#     `height`) is
#     a PNG of exactly the box times its scale: twice the box at scale 2, drawn
#     at device scale 2 and not enlarged (the page reads `devicePixelRatio` 2,
#     and a line half a CSS px wide is one whole picture px), half the box at
#     0.5, drawn for a 1x screen and scaled down, and each side rounded as the
#     server rounds it at a scale that leaves half a px over; a layout larger
#     than the box is cut to it and reported at its own size;
#   - an SVG drawing is pictured as the page it is set as: at the top left
#     with no margin, filling a box it is sized to in percent, not said to
#     overflow a box it fits (a byte order mark and a text line under the
#     drawing each made it so), with a picture saved beside it drawn;
#   - any agent uid reads the picture the renderer saved, so a run of another
#     person than the task's owner can copy it onto the task;
#   - the renderer reads its pages from a folder it can only pass through, the
#     way the server hands it a kept delivery: it cannot list the folder or put
#     a file in it, and it still finds a page and the picture beside it stored
#     in the other Unicode form (ruling 76), on a disk that holds names byte
#     for byte;
#   - the renderer writes in a scratch folder made new under a parent it can
#     only pass through, the way the server makes one in a task's `.captures/`:
#     an agent uid cannot list that parent or put a link beside the scratch;
#   - the image's fonts give `system-ui` a proportional face and draw an emoji,
#     the four generic families still mean the Liberation faces, and a page
#     that names Inter (by that name or as `Inter Variable`), EB Garamond or
#     JetBrains Mono is drawn in it (the Dockerfile's chromium layer);
#   - nothing of the browser is left running.
#
# Run INSIDE the production image, as the server user (`node`). The e2e job
# runs it in the e2e stack's app container (`docker compose exec -T app sh
# scripts/check-page-capture.sh`); by hand:
#
#   docker run --rm --init viberr-app sh scripts/check-page-capture.sh
#
# It uses one throwaway agent uid at the top of the range (never a real
# person's) and removes everything it creates. Exit 0 when every check holds;
# 1 with the failures listed.
set -u

LAUNCH=/usr/local/libexec/viberr-launch
DATA=${VIBERR_DATA_ROOT:-/data}
BROWSER=${VIBERR_BROWSER_EXECUTABLE:-/usr/bin/chromium}
APP=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CHILD="$APP/app/server/tasks/page-capture-child.server.ts"
NODE=$(command -v node)
UID_C=59992
# A second agent uid: a run of another person on the same task.
UID_R=59993
TAG="capture-check-$$"
# The stand-in for a run's folder of a task's `.captures/`: the server's own,
# passed through by the agent group and neither listed nor written by it
# (0710). Outside projects/, which the server's file watcher follows.
WORK="$DATA/runtimes/$TAG"
# One render's scratch in it, made new and shared for the renderer to write
# (2770), as page-capture.server.ts makes it.
SCRATCH="$WORK/scratch"
failures=0
listener=""

pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

cleanup() {
  [ -n "$listener" ] && kill "$listener" 2>/dev/null
  if [ -d "$WORK" ]; then
    # What the agent wrote is the agent's to remove (ruling 140).
    VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "rm -rf '$SCRATCH/out' '$SCRATCH/profile' '$SCRATCH/sized' '$SCRATCH/tmp' '$SCRATCH'/.[!.]*" >/dev/null 2>&1
    rm -rf "$WORK" 2>/dev/null
  fi
}
trap cleanup EXIT

echo "page capture check (ruling 42) as $(id -un) with $BROWSER"

if [ ! -x "$BROWSER" ]; then
  fail "the browser $BROWSER is not on disk"
  echo "page capture: $failures check(s) FAILED"
  exit 1
fi
if [ ! -f "$CHILD" ]; then
  fail "the renderer $CHILD is not in the image"
  echo "page capture: $failures check(s) FAILED"
  exit 1
fi

# A volume no server has booted on yet: the directory the check needs, made the
# way the server's boot makes it (enforceStoreLayout).
if [ ! -d "$DATA/runtimes" ]; then
  mkdir -p "$DATA/runtimes" && chgrp viberr-agents "$DATA/runtimes" && chmod 0750 "$DATA/runtimes"
  echo "note  no server has booted on $DATA: created runtimes/ as the boot would"
fi
mkdir -p "$WORK" && chgrp viberr-agents "$WORK" && chmod 0710 "$WORK"
mkdir -p "$WORK/files"
# The server makes the scratch and the temp folder in it; the renderer makes
# `out/` and `profile/` itself.
mkdir "$SCRATCH" && chgrp viberr-agents "$SCRATCH" && chmod 2770 "$SCRATCH"
mkdir "$SCRATCH/tmp" && chmod 2770 "$SCRATCH/tmp"

# The fixtures, the stand-in for "another port on this host", and the reading
# of what came back, in one helper: Node is what the image has.
cat >"$WORK/check.mjs" <<'EOF'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const [command, ...args] = process.argv.slice(2);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A solid picture, as a PNG. */
function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG's size and a reader of its pixels. */
function decodePng(bytes) {
  let at = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const data = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colour = body[9];
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - corner);
        const pb = Math.abs(left - corner);
        const pc = Math.abs(left + up - 2 * corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + x] = (value + predicted) & 255;
    }
  }
  return {
    width,
    height,
    at: (x, y) => [...pixels.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)].join(","),
  };
}

if (command === "listen") {
  // Another server on this host's loopback, as the app's own port is.
  const [hitsFile, portFile] = args;
  const server = createServer((req, res) => {
    appendFileSync(hitsFile, `${req.method} ${req.url}\n`);
    res.setHeader("access-control-allow-origin", "*");
    res.end("reached");
  });
  server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
}

if (command === "fixtures") {
  const [dir, port] = args;
  writeFileSync(path.join(dir, "chart.png"), solidPng(100, 100, [255, 0, 0]));
  writeFileSync(
    path.join(dir, "page.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}.screen{height:100vh;background:rgb(0,0,255)}.after{height:1200px;background:rgb(0,128,0)}img{display:block}</style></head><body>
<div class="screen"><img src="chart.png" width="100" height="100">
<img id="loopback" src="http://127.0.0.1:${port}/hit-img" width="40" height="40">
<img id="remote" src="https://example.com/remote.png" width="40" height="40"></div>
<div class="after"></div>
<script>
const mark = (name) => { new Image().src = name; };
const probe = (id) => {
  const img = document.getElementById(id);
  const done = (loaded) => mark("check-" + id + (loaded ? "-LOADED" : "-refused"));
  if (img.complete) done(img.naturalWidth > 0);
  else { img.onload = () => done(true); img.onerror = () => done(false); }
};
probe("loopback");
probe("remote");
fetch("http://127.0.0.1:${port}/hit-fetch").then(() => mark("check-fetch-LOADED"), () => mark("check-fetch-refused"));
fetch("http://localhost:${port}/hit-fetch-localhost").then(() => mark("check-localhost-LOADED"), () => mark("check-localhost-refused"));
</script></body></html>`,
  );
  writeFileSync(
    path.join(dir, "leave.html"),
    `<!doctype html><html><body><p>leaving</p><script>setTimeout(() => { location.href = "http://127.0.0.1:${port}/hit-navigate"; }, 50);</script></body></html>`,
  );
  writeFileSync(
    path.join(dir, "notes.md"),
    "# Estimate\n\n| Item | Cost |\n|---|---|\n| EC2 | $12 |\n\n![chart](chart.png)\n",
  );
  // A page that stops on a dialog while it loads.
  writeFileSync(
    path.join(dir, "alert.html"),
    `<!doctype html><html><head><meta charset="utf-8"><script>alert("Welcome")</script></head><body><p>behind the dialog</p></body></html>`,
  );
  // A page and its picture stored decomposed, as a file uploaded from a Mac
  // was, and named in the composed form everybody types.
  writeFileSync(
    path.join(dir, "\u00d6zet.html".normalize("NFD")),
    `<!doctype html><html><head><meta charset="utf-8"></head><body><img src="${"\u015eema.png".normalize("NFC")}" width="100" height="100"></body></html>`,
  );
  writeFileSync(path.join(dir, "\u015eema.png".normalize("NFD")), solidPng(100, 100, [255, 0, 0]));
  // A page drawn to be a picture of an exact size, in a layout larger than
  // the box it is asked at. Its background says what screen the page was told
  // it is drawn for, and it marks each font it names as drawn or missing: a
  // family that is not there is drawn in the fallback, at the fallback's
  // width.
  writeFileSync(
    path.join(dir, "sized.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0}.sheet{width:1400px;height:900px}.corner{position:absolute;left:0;top:0;width:100px;height:100px;background:rgb(255,0,0)}</style></head><body>
<div class="sheet"></div><div class="corner"></div>
<script>
const mark = (name) => { new Image().src = name; };
document.body.style.background = devicePixelRatio === 2 ? "rgb(0,128,0)" : devicePixelRatio === 1 ? "rgb(0,0,255)" : "rgb(128,128,128)";
const wide = (family) => {
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;white-space:nowrap;font:40px " + family;
  span.textContent = "Sphinx of black quartz, judge my vow 0123456789";
  document.body.append(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
};
for (const [family, fallback] of [["Inter Variable", "monospace"], ["Inter", "monospace"], ["EB Garamond", "monospace"], ["JetBrains Mono", "serif"]]) {
  mark("font-" + family.replace(/ /g, "-") + (wide('"' + family + '", ' + fallback) === wide(fallback) ? "-MISSING" : "-drawn"));
}
</script></body></html>`,
  );
  // A drawing, saved with a byte order mark and an XML declaration, sized to
  // its box in percent: a line half a CSS px wide, and a picture beside it.
  writeFileSync(
    path.join(dir, "drawing.svg"),
    `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
<rect width="100%" height="100%" fill="rgb(0,0,255)"/>
<rect x="300.5" y="0" width="0.5" height="100" fill="rgb(0,0,0)"/>
<image href="chart.png" x="100" y="100" width="100" height="100"/>
</svg>
`,
  );
}

if (command === "job") {
  const [work, browser] = args;
  process.stdout.write(
    JSON.stringify({
      root: path.join(work, "files"),
      // The renderer may pass through this folder and not list it, so it is
      // told what the folder holds, as the server tells it.
      names: readdirSync(path.join(work, "files")),
      out: path.join(work, "scratch", "out"),
      profile: path.join(work, "scratch", "profile"),
      browser,
      pages: [
        { file: "page.html", kind: "html" },
        { file: "notes.md", kind: "markdown" },
        { file: "leave.html", kind: "html" },
        { file: "alert.html", kind: "html" },
        { file: "\u00d6zet.html".normalize("NFC"), kind: "html" },
      ],
      views: [
        { id: "desktop", width: 1280, height: 800, maxHeight: 4800, mobile: false, from: 0 },
        { id: "phone", width: 390, height: 844, maxHeight: 5064, mobile: true, from: 0 },
      ],
      pageTimeoutMs: 25000,
      maxBytes: 3750000,
    }),
  );
}

if (command === "job-sized") {
  const [work, browser] = args;
  // One box per view, as the server asks for one: the viewport is the box.
  const box = (id, width, height, scale) => ({ id, width, height, maxHeight: height, mobile: false, from: 0, box: { scale } });
  process.stdout.write(
    JSON.stringify({
      root: path.join(work, "files"),
      names: readdirSync(path.join(work, "files")),
      out: path.join(work, "scratch", "sized", "out"),
      profile: path.join(work, "scratch", "sized", "profile"),
      browser,
      pages: [
        { file: "sized.html", kind: "html" },
        { file: "drawing.svg", kind: "svg" },
      ],
      views: [box("twice", 1200, 630, 2), box("half", 1200, 630, 0.5), box("odd", 1201, 631, 1.5)],
      pageTimeoutMs: 25000,
      maxBytes: 3750000,
    }),
  );
}

if (command === "verify-sized") {
  const [work] = args;
  let failures = 0;
  const check = (holds, what, seen = "") => {
    console.log(`${holds ? "ok   " : "FAIL "} ${what}${holds || seen === "" ? "" : ` (${seen})`}`);
    if (!holds) failures += 1;
  };
  const out = path.join(work, "scratch", "sized", "out");
  const reportFile = path.join(out, "report.json");
  if (!existsSync(reportFile)) {
    check(false, "the renderer wrote its report of the sized pictures");
    process.exit(1);
  }
  const [sized, drawing] = JSON.parse(readFileSync(reportFile, "utf8")).pages;
  const picture = (name) => (existsSync(path.join(out, name)) ? decodePng(readFileSync(path.join(out, name))) : null);
  const size = (png) => `${png?.width}x${png?.height}`;
  const shot = (page, view) => page.shots.find((s) => s.view === view);

  check(sized.error === null && sized.shots.length === 3, "a page is pictured at each exact size asked", sized.error ?? `${sized.shots.length} picture(s)`);
  const twice = picture("1-twice.png");
  const half = picture("1-half.png");
  const odd = picture("1-odd.png");
  check(twice?.width === 2400 && twice?.height === 1260, "a 1200 by 630 box at scale 2 is a PNG of exactly 2400 by 1260", size(twice));
  check(half?.width === 600 && half?.height === 315, "the same box at scale 0.5 is a PNG of exactly 600 by 315", size(half));
  // 1201 x 1.5 and 631 x 1.5 each leave half a px over: the browser rounds
  // them up, as the server's Math.round does.
  check(odd?.width === 1802 && odd?.height === 947, "a 1201 by 631 box at scale 1.5 is a PNG of exactly 1802 by 947, each side rounded by itself", size(odd));
  if (twice && half && odd) {
    check(twice.at(100, 100) === "255,0,0" && half.at(25, 25) === "255,0,0", "the page's top left corner is the picture's top left corner", `${twice.at(100, 100)} / ${half.at(25, 25)}`);
    check(twice.at(2000, 1000) === "0,128,0", "at scale 2 the page is drawn for a 2x screen (devicePixelRatio 2), not enlarged", twice.at(2000, 1000));
    check(half.at(500, 250) === "0,0,255", "under 1 the page is drawn for a 1x screen and the picture scaled down", half.at(500, 250));
    check(odd.at(1500, 800) === "128,128,128", "at scale 1.5 the page is told a device ratio that is neither 1 nor 2", odd.at(1500, 800));
  }
  const reported = ["twice", "half", "odd"].map((view) => shot(sized, view)).every((s) => s?.contentWidth === 1400 && s?.contentHeight === 900 && s?.cut === true);
  check(reported, "a layout larger than the box is reported at its own size, 1400 by 900 CSS px, at every scale", JSON.stringify(sized.shots.map((s) => [s.view, s.contentWidth, s.contentHeight, s.cut])));
  const marks = new Set(sized.missing);
  for (const family of ["Inter-Variable", "Inter", "EB-Garamond", "JetBrains-Mono"]) {
    check(marks.has(`font-${family}-drawn`) && !marks.has(`font-${family}-MISSING`), `a page that names ${family.replace(/-/g, " ")} is drawn in it`, [...marks].join(" "));
  }

  check(drawing.error === null && drawing.shots.length === 3, "an SVG drawing is pictured at each exact size asked", drawing.error ?? `${drawing.shots.length} picture(s)`);
  const drawn = picture("2-twice.png");
  check(drawn?.width === 2400 && drawn?.height === 1260 && picture("2-half.png")?.width === 600, "as a PNG of exactly 2400 by 1260 at scale 2, and 600 wide at scale 0.5", size(drawn));
  if (drawn) {
    check(drawn.at(0, 0) === "0,0,255" && drawn.at(2399, 1259) === "0,0,255", "the drawing fills its box from the top left: no margin, and a percent height is the box's", `${drawn.at(0, 0)} / ${drawn.at(2399, 1259)}`);
    check(drawn.at(300, 300) === "255,0,0", "the picture saved beside the drawing is drawn in it", drawn.at(300, 300));
    // Half a CSS px wide at x = 300.5: one whole picture px at 2x, and grey
    // over two if the 1x drawing had been enlarged.
    check(
      drawn.at(601, 20) === "0,0,0" && drawn.at(600, 20) === "0,0,255" && drawn.at(602, 20) === "0,0,255",
      "a line half a CSS px wide is one whole picture px at scale 2: drawn at 2x, not enlarged",
      `${drawn.at(600, 20)} | ${drawn.at(601, 20)} | ${drawn.at(602, 20)}`,
    );
  }
  const fits = shot(drawing, "twice");
  check(
    fits?.contentWidth === 1200 && fits?.contentHeight === 630 && fits?.cut === false && drawing.missing.length === 0,
    "a drawing that fits its box is not said to overflow it",
    `${fits?.contentWidth}x${fits?.contentHeight} cut=${fits?.cut} ${drawing.missing.join(" ")}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

if (command === "verify") {
  const [work, port] = args;
  let failures = 0;
  const check = (holds, what, seen = "") => {
    console.log(`${holds ? "ok   " : "FAIL "} ${what}${holds || seen === "" ? "" : ` (${seen})`}`);
    if (!holds) failures += 1;
  };
  const out = path.join(work, "scratch", "out");
  const reportFile = path.join(out, "report.json");
  if (!existsSync(reportFile)) {
    check(false, "the renderer wrote its report");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const [page, notes, leave, alerting, stored] = report.pages;
  const picture = (name) => (existsSync(path.join(out, name)) ? decodePng(readFileSync(path.join(out, name))) : null);

  check(page.error === null && page.shots.length === 2, "the page is pictured at both widths", page.error ?? "");
  const desktop = picture("1-desktop.png");
  const phone = picture("1-phone.png");
  check(desktop?.width === 1280 && desktop?.height === 2000, "the desktop picture is 1280 by 2000, the whole page", `${desktop?.width}x${desktop?.height}`);
  check(phone?.width === 390 && phone?.height === 2044, "the phone picture is 390 by 2044, the whole page", `${phone?.width}x${phone?.height}`);
  if (desktop && phone) {
    check(desktop.at(10, 10) === "255,0,0" && phone.at(10, 10) === "255,0,0", "the picture saved beside the page is drawn", `${desktop.at(10, 10)} / ${phone.at(10, 10)}`);
    // The first screen is the 100vh section and what follows it is not: had
    // the capture stretched the viewport, the section would fill the picture.
    check(desktop.at(640, 700) === "0,0,255" && desktop.at(640, 900) === "0,128,0", "a 100vh section is one screen tall in the desktop picture", `${desktop.at(640, 700)} then ${desktop.at(640, 900)}`);
    check(phone.at(200, 800) === "0,0,255" && phone.at(200, 900) === "0,128,0", "and in the phone picture", `${phone.at(200, 800)} then ${phone.at(200, 900)}`);
  }
  const missing = new Set(page.missing);
  for (const probe of ["loopback", "remote", "fetch", "localhost"]) {
    check(
      missing.has(`check-${probe}-refused`) && !missing.has(`check-${probe}-LOADED`),
      `the page's ${probe} request loaded nothing`,
      [...missing].join(" "),
    );
  }
  check(
    page.asked.includes(`127.0.0.1:${port}`) && page.asked.includes("example.com"),
    "the report names what the page asked the network for",
    page.asked.join(" "),
  );

  check(notes.error === null && notes.shots.length === 2 && notes.missing.length === 0, "a markdown file is set as a page, its picture beside it found", notes.error ?? notes.missing.join(" "));
  check(picture("2-desktop.png")?.width === 1280 && picture("2-phone.png")?.width === 390, "at both widths");

  check(leave.shots.length === 0 && leave.error !== null, "a page that sends the browser elsewhere is not pictured", String(leave.error));

  check(
    alerting.error === null && alerting.shots.length === 2 && alerting.dialogs === 2,
    "a page that stops on alert() is pictured behind its dialog at both widths, and the report says it opened one each time",
    `${alerting.error ?? "no error"}, ${alerting.shots.length} picture(s), ${alerting.dialogs} dialog(s)`,
  );

  check(
    stored.error === null && stored.shots.length === 2 && stored.missing.length === 0,
    "a page and the picture beside it are found in the other Unicode form than they were asked for in",
    stored.error ?? stored.missing.join(" "),
  );
  check(picture("5-desktop.png")?.at(10, 10) === "255,0,0", "and that picture is drawn");

  const hits = existsSync(path.join(work, "hits")) ? readFileSync(path.join(work, "hits"), "utf8").split("\n").filter(Boolean) : [];
  check(hits.includes("GET /control"), "the other loopback port answers this host");
  check(hits.length === 1, "and no request of a page reached it", hits.join(" "));
  process.exit(failures === 0 ? 0 : 1);
}
EOF

"$NODE" "$WORK/check.mjs" listen "$WORK/hits" "$WORK/port" &
listener=$!
i=0
while [ ! -s "$WORK/port" ] && [ $i -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
PORT=$(cat "$WORK/port" 2>/dev/null)
if [ -z "$PORT" ]; then
  fail "the stand-in loopback server did not start"
  echo "page capture: $failures check(s) FAILED"
  exit 1
fi
"$NODE" -e "fetch('http://127.0.0.1:$PORT/control').then((r) => r.text()).catch(() => process.exit(1))"

"$NODE" "$WORK/check.mjs" fixtures "$WORK/files" "$PORT"
JOB=$("$NODE" "$WORK/check.mjs" job "$WORK" "$BROWSER")

# --- the input folder, as the server hands a kept delivery over ----------------
# page-capture.server.ts copies a delivery's files into a folder of its own that
# the agent group passes through and reads (0710, each file 0640): the renderer
# opens a file by the name it is given, and can neither list the folder nor put
# anything in it.
chgrp -R viberr-agents "$WORK/files" && chmod 0640 "$WORK/files"/* && chmod 0710 "$WORK/files"
as_agent() {
  VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "$1" >/dev/null 2>&1
}
if as_agent "cat '$WORK/files/page.html'"; then
  pass "an agent uid reads a file of the input folder by its name"
else
  fail "an agent uid cannot read a file of the input folder"
fi
if as_agent "ls '$WORK/files'"; then
  fail "an agent uid can list the input folder"
else
  pass "an agent uid cannot list the input folder"
fi
as_agent "echo planted > '$WORK/files/planted.html'"
if [ -e "$WORK/files/planted.html" ]; then
  fail "an agent uid put a file in the input folder"
else
  pass "an agent uid cannot put a file in the input folder"
fi

# --- the scratch, as the server makes it ---------------------------------------
# page-capture.server.ts keeps a render's scratch in the task's own directory:
# `.captures/` and the run's folder in it are the server's own, 0710 in the
# agent group, and only the one render's folder is the agents' to write. No
# agent can put an entry, so no link, where the server makes a folder.
if as_agent "ls '$WORK'"; then
  fail "an agent uid can list the folder its scratch is in"
else
  pass "an agent uid cannot list the folder its scratch is in"
fi
as_agent "ln -s /tmp '$WORK/planted'"
if [ -L "$WORK/planted" ]; then
  fail "an agent uid put a link beside its scratch"
else
  pass "an agent uid cannot put a link beside its scratch"
fi
if as_agent "touch '$SCRATCH/probe' && rm '$SCRATCH/probe'"; then
  pass "an agent uid writes in the scratch it is given"
else
  fail "an agent uid cannot write in the scratch it is given"
fi

# Run the renderer over one job, as the agent uid through the launcher.
render() {
  (
    cd "$SCRATCH" || exit 1
    # The job on the renderer's standard input, as the server hands it over.
    printf '%s' "$1" | HOME="$SCRATCH" TMPDIR="$SCRATCH/tmp" TMP="$SCRATCH/tmp" TEMP="$SCRATCH/tmp" \
      VIBERR_RUN_ID="$TAG" VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC="$NODE" \
      "$LAUNCH" "$CHILD"
  )
}

started=$(date +%s)
render "$JOB"
code=$?
took=$(($(date +%s) - started))
if [ "$code" -eq 0 ]; then
  pass "the renderer ran as uid $UID_C through the launcher (five pages in ${took} s)"
else
  fail "the renderer exited $code"
fi
owner=$(stat -c '%u' "$SCRATCH/out/report.json" 2>/dev/null)
[ "$owner" = "$UID_C" ] && pass "its report is uid $UID_C's own" || fail "its report is owned by '$owner'"

"$NODE" "$WORK/check.mjs" verify "$WORK" "$PORT" || failures=$((failures + 1))

# --- a picture of an exact size --------------------------------------------------
# `capture_page` with `width` and `height`: one box per view, the viewport
# itself, at the scale asked for. A page and a drawing, each at three sizes.
SIZED=$("$NODE" "$WORK/check.mjs" job-sized "$WORK" "$BROWSER")
started=$(date +%s)
render "$SIZED"
code=$?
took=$(($(date +%s) - started))
if [ "$code" -eq 0 ]; then
  pass "the renderer pictured a page and a drawing at three exact sizes each (${took} s)"
else
  fail "the renderer exited $code on the sized pictures"
fi
"$NODE" "$WORK/check.mjs" verify-sized "$WORK" || failures=$((failures + 1))
# The tool saves nothing on the task: the run that asked copies the picture
# from here. The renderer ran as the task owner's agent uid and the run may be
# another person's, so the picture must be the agent group's to read.
if VIBERR_LAUNCH_UID=$UID_R VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "cat '$SCRATCH/sized/out/1-twice.png'" 2>/dev/null | cmp -s - "$SCRATCH/sized/out/1-twice.png"; then
  pass "another agent uid reads the picture the renderer saved, to copy it onto the task"
else
  fail "another agent uid cannot read the picture the renderer saved"
fi

# --- nothing left running -------------------------------------------------------
left=0
for dir in /proc/[0-9]*; do
  [ "$(stat -c '%u' "$dir" 2>/dev/null)" = "$UID_C" ] && left=$((left + 1))
done
[ "$left" -eq 0 ] && pass "no process of uid $UID_C is left running" || fail "$left process(es) of uid $UID_C are still running"

# --- the image's fonts ----------------------------------------------------------
# `system-ui` is the generic family Chromium asks fontconfig for; with
# fonts-liberation alone it answered Liberation Mono.
system_ui=$(fc-match system-ui 2>/dev/null)
case "$system_ui" in
  *"Liberation Sans"*) pass "a page set in system-ui gets a proportional face ($system_ui)" ;;
  *) fail "a page set in system-ui gets: $system_ui" ;;
esac
if fc-list 2>/dev/null | grep -qi "Noto Color Emoji"; then
  pass "an emoji has a font to draw it"
else
  fail "no emoji font is installed (fonts-noto-color-emoji)"
fi
# The fonts a drawn picture can name are there to be named and change no
# default: a delivered page that names none of them is pictured as before.
for generic in "sans-serif:Liberation Sans" "serif:Liberation Serif" "monospace:Liberation Mono"; do
  family=${generic%%:*}
  face=${generic#*:}
  answer=$(fc-match "$family" 2>/dev/null)
  case "$answer" in
    *"$face"*) pass "$family still means $face" ;;
    *) fail "$family now means: $answer" ;;
  esac
done
# Inter is installed as `Inter Variable`, and the name a drawing asks for is
# `Inter`: the configuration says they are one family.
inter=$(fc-match Inter 2>/dev/null)
case "$inter" in
  *"Inter Variable"*) pass "a page that names Inter is answered with Inter Variable ($inter)" ;;
  *) fail "a page that names Inter is answered with: $inter" ;;
esac
for named in "Inter:fonts-inter-variable" "EB Garamond:fonts-ebgaramond" "JetBrains Mono:fonts-jetbrains-mono"; do
  family=${named%%:*}
  package=${named#*:}
  if fc-list : family 2>/dev/null | grep -q "$family"; then
    pass "$family is installed ($(fc-list : family | grep "$family" | sort -u | head -n 1))"
  else
    fail "$family is not installed ($package)"
  fi
done

echo
if [ "$failures" -eq 0 ]; then
  echo "page capture: every check holds"
  exit 0
fi
echo "page capture: $failures check(s) FAILED"
exit 1
