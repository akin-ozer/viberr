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
#   - ruling 327: a page on the web is pictured at both widths with the
#     network open (what it draws from another port of this host is drawn, and
#     so is what it fetched after its load event), what moves on it is read on
#     a real page, and a task page pictured after it still reaches nothing;
#   - ruling 194: a page is shown in a state. A control found by its words is
#     really pressed (the page's own script sees a trusted click and its menu
#     is open in the picture, though it shuts when its window is resized), one
#     under the pointer and one focused with Tab have the styles their
#     `:hover` and `:focus-visible` rules give, a press lands on a page a
#     phone shrinks, one that moves to another file of the task is pictured
#     where it led and one that leaves for another site is the act's own
#     failure, and an act that finds nothing says what the controls there are
#     called; `reduce` makes the page's own media query true, and a view
#     without it false;
#   - a whole view of a page five screens long comes back as every stretch, in
#     order, covering it, with what loads only at its end; a moving view comes
#     back as three frames of a page that moved between them;
#   - ruling 328: a page with one low-contrast line, one picture with no
#     `alt`, one control that hides its focus ring and one animation that
#     ignores reduced motion is measured as having each, at its true weight,
#     with a load time on the slow line that the weight accounts for, and
#     each check says it ran. The keyboard walk counts only the page's own
#     controls (a box to write in takes focus and is not one, and a button in
#     a set of fields switched off is none a keyboard should reach), starts
#     at the top of a page that had put focus elsewhere, goes on through a
#     date field, a frame and a card that each keep focus for more than one
#     press and a field that takes one Tab for itself, comes round at a
#     text field that keeps every Tab and at the one button of a dialog,
#     names the controls past a keyboard trap with how
#     many there are in all, and says it was cut only where it used its last
#     press with a control still not come to;
#   - where a part of a page scrolls by itself and hides more than a screen
#     (a shell fixed to its screen, one under a header with or without page
#     below it, a body that scrolls by itself, three lanes side by side, a
#     log in a box on a long page), the report names the one that hides the
#     most at each width, with how much it holds, how tall its own box is
#     and how many such parts there are, and not a part that only hides what
#     does not fit, a body whose overflow is the window's, or the body of a
#     page with no doctype, which is as tall as the page; it is found past
#     five thousand elements;
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
site=""

pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

cleanup() {
  [ -n "$listener" ] && kill "$listener" 2>/dev/null
  [ -n "$site" ] && kill "$site" 2>/dev/null
  if [ -d "$WORK" ]; then
    # What the agent wrote is the agent's to remove (ruling 140).
    VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "rm -rf '$SCRATCH/out' '$SCRATCH/profile' '$SCRATCH/sized' '$SCRATCH/web' '$SCRATCH/closed' '$SCRATCH/states' '$SCRATCH/long' '$SCRATCH/measured' '$SCRATCH/walks' '$SCRATCH/inside' '$SCRATCH/tmp' '$SCRATCH'/.[!.]*" >/dev/null 2>&1
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
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/** A picture of exactly `bytes` bytes: 200 by 100, and a chunk of its own
 *  that a decoder skips for the rest of its weight. */
function heavyPng(bytes) {
  const picture = solidPng(200, 100, [90, 90, 90]);
  const end = picture.length - 12;
  return Buffer.concat([picture.subarray(0, end), chunk("paDd", Buffer.alloc(bytes - picture.length - 12, 120)), picture.subarray(end)]);
}

if (command === "listen") {
  // Another server on this host's loopback, as the app's own port is. It
  // answers a picture's path with a picture, so a page the network is open
  // to draws it, and `/web-late.png` only after a while, as a slow one comes.
  const [hitsFile, portFile] = args;
  const server = createServer((req, res) => {
    appendFileSync(hitsFile, `${req.method} ${req.url}\n`);
    res.setHeader("access-control-allow-origin", "*");
    if (!req.url.endsWith(".png")) {
      res.end("reached");
      return;
    }
    res.setHeader("content-type", "image/png");
    setTimeout(() => res.end(solidPng(100, 100, [255, 0, 0])), req.url === "/web-late.png" ? 600 : 0);
  });
  server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
}

if (command === "site") {
  // A site on the web, as far as the renderer can tell: a page at an address
  // of its own, which draws a picture from the other port, goes on asking
  // once it has loaded (a first request 300 ms after the load event, and a
  // picture 300 ms after that was answered), and moves.
  const [portFile, port] = args;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A site</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;font:16px sans-serif}img{display:block}
header.bar{position:sticky;top:0;height:40px;background:rgb(20,20,20)}
a.nav{color:rgb(200,200,200);transition:color .15s}a.nav:hover{color:rgb(255,255,255)}
.spinner{width:40px;height:40px;background:rgb(0,0,255);animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.reveal{height:200px;margin:900px 0;opacity:0;transition:opacity .6s}.reveal.in{opacity:1}
</style></head><body><header class="bar"><a class="nav" href="#docs">Docs</a></header>
<img src="http://127.0.0.1:${port}/web-pixel.png" width="100" height="100"><div id="late" style="height:100px"></div>
<div class="spinner"></div><section class="reveal">one</section><section class="reveal">two</section>
<script>
const late = () => { const img = new Image(100, 100); img.src = "http://127.0.0.1:${port}/web-late.png"; document.getElementById("late").append(img); };
addEventListener("load", () => setTimeout(() => fetch("http://127.0.0.1:${port}/web-first").then(() => setTimeout(late, 300)), 300));
const seen = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("in"); seen.unobserve(entry.target); } });
document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));
</script></body></html>`;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
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
  // A page with states to show. Its script marks what it saw: the motion its
  // reader asked for at each width, a press on its menu button and whether a
  // person's finger could have made it, and the styles its own rules gave a
  // control under the pointer and one that took focus. The menu shuts when
  // the window is resized, as many do. It holds a `menu` element, which the
  // word "Menu" is also the selector of, a link to another file of the task
  // and a link to another site.
  writeFileSync(
    path.join(dir, "states.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;font:16px sans-serif;background:rgb(255,255,255)}
@media (prefers-reduced-motion: reduce){body{background:rgb(0,128,0)}}
header{position:relative;height:60px;background:rgb(20,20,20)}
#toggle{position:absolute;left:20px;top:10px;width:100px;height:40px;background:rgb(0,0,255);color:rgb(255,255,255);border:0}
#toggle:hover{background:rgb(255,128,0)}
#docs{position:absolute;left:200px;top:20px;color:rgb(255,255,255)}
#docs:focus-visible{outline:6px solid rgb(255,0,255)}
#panel{display:none;position:absolute;left:0;top:60px;width:300px;height:200px;background:rgb(0,128,128)}
#panel.open{display:block}
menu{margin:0;padding:0;height:20px}main{height:1500px}</style></head><body>
<header><button id="toggle">Menu</button><a id="docs" href="#docs">Docs</a></header>
<div id="panel"></div><main><menu></menu>
<p style="margin:300px 20px 0"><a href="shrunk.html">Next page</a> <a href="https://example.com/away">Away</a></p></main>
<script>
const mark = (name) => { new Image().src = name; };
const numbers = (colour) => colour.match(/[0-9]+/g).join("-");
mark("motion-" + innerWidth + "-" + (matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference"));
const toggle = document.getElementById("toggle");
toggle.addEventListener("click", (event) => {
  document.getElementById("panel").classList.add("open");
  mark("menu-" + innerWidth + "-opened-by-a-" + (event.isTrusted ? "real" : "scripted") + "-press");
});
addEventListener("resize", () => document.getElementById("panel").classList.remove("open"));
toggle.addEventListener("mouseenter", () => requestAnimationFrame(() => mark("hover-background-" + numbers(getComputedStyle(toggle).backgroundColor))));
const docs = document.getElementById("docs");
docs.addEventListener("focus", () => requestAnimationFrame(() => {
  const style = getComputedStyle(docs);
  mark("focus-" + (docs.matches(":focus-visible") ? "visible" : "not-visible") + "-outline-" + style.outlineStyle + "-" + numbers(style.outlineColor));
}));
</script></body></html>`,
  );
  // A page with no viewport of its own: a phone lays it out 980 px wide and
  // shrinks it, and its one control is far from the top left.
  writeFileSync(
    path.join(dir, "shrunk.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>html,body{margin:0}body{width:980px;height:3000px}#far{position:absolute;left:700px;top:1500px;width:200px;height:100px;background:rgb(0,0,255);color:rgb(255,255,255);border:0;font-size:40px}</style></head>
<body><button id="far">Menu</button>
<script>document.getElementById("far").addEventListener("click", (event) => { new Image().src = "shrunk-" + innerWidth + "-pressed-" + (event.isTrusted ? "real" : "scripted"); });</script></body></html>`,
  );
  // A page five screens long, each of a colour of its own. A block slides
  // across the first screen from the moment the page loads, and another
  // across the third from the moment it is scrolled to. A last strip is
  // added only once the fifth screen has been scrolled to.
  writeFileSync(
    path.join(dir, "long.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}section{height:100vh}
.slider{position:absolute;left:0;width:50px;height:50px;background:rgb(0,0,0)}
#early{top:100px;animation:slide 4s linear forwards}
#late{top:2000px}#late.in{animation:slide 4s linear forwards}
@keyframes slide{from{left:0}to{left:60vw}}
#tail{height:100px;background:rgb(255,0,255)}</style></head><body>
${[[255, 0, 0], [0, 128, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]].map((c) => '<section style="background:rgb(' + c.join(",") + ')"></section>').join("")}
<div class="slider" id="early"></div><div class="slider" id="late"></div>
<script>
const once = (el, then) => new IntersectionObserver((entries, seen) => { if (entries.some((entry) => entry.isIntersecting)) { seen.disconnect(); then(); } }).observe(el);
once(document.getElementById("late"), () => document.getElementById("late").classList.add("in"));
once(document.querySelectorAll("section")[4], () => { const tail = document.createElement("div"); tail.id = "tail"; document.body.append(tail); });
</script></body></html>`,
  );
  // A page to measure: one line too faint to read, one picture with no
  // `alt`, one button that hides its focus ring, one animation that goes on
  // when reduced motion is asked for beside one that stops, and a picture of
  // a known weight. Besides its three controls it has a link left out of the
  // tab order, a link in a part made inert, a button in a set of fields that
  // is switched off, and a box to write in between the first control and
  // the others, which takes focus and is no control: when it does, the page
  // adds a second picture with no `alt`, so the engine, which runs after
  // the walk, says whether the walk stopped there.
  writeFileSync(path.join(dir, "heavy.png"), heavyPng(300000));
  writeFileSync(
    path.join(dir, "measured.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A page to measure</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;background:rgb(255,255,255);color:rgb(17,17,17);font:16px sans-serif}
.faint{color:rgb(204,204,204)}
button.bare:focus{outline:none}
.loader,.polite{width:40px;height:40px;background:rgb(0,102,204)}
.loader{animation:spin 2s linear infinite}.polite{animation:spin 3s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.polite{animation:none}}
main{min-height:1600px}</style></head><body><main>
<h1>A page to measure</h1><p class="faint">A line too faint to read</p>
<img src="heavy.png" width="200" height="100">
<p><a href="#docs">Docs</a></p>
<div id="notes" contenteditable="true" style="min-height:24px">Notes go here</div>
<p><button class="bare">No ring</button> <button>Ringed</button> <a href="#aside" tabindex="-1">Left out on purpose</a></p>
<p inert><a href="#off">Switched off</a></p>
<fieldset disabled><legend>Not yet</legend><button>Send</button></fieldset>
<div class="loader"></div><div class="polite"></div>
</main>
<script>document.getElementById("notes").addEventListener("focus", () => { const added = new Image(1, 1); added.src = "heavy.png"; document.querySelector("main").append(added); }, { once: true });</script>
</body></html>`,
  );
  // A shell fixed to its screen with its faults on its first screen: a line
  // too faint to read, two buttons 10 px across side by side, and a link in
  // a sentence that nothing but its colour marks. Three screens further
  // down, at the end of the part that scrolls, two ordinary links: a
  // keyboard walk ends there, with the part scrolled to its end.
  writeFileSync(
    path.join(dir, "deep.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A shell with its faults at the top</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}body{background:rgb(255,255,255);color:rgb(17,17,17);font:16px sans-serif}
main.app{height:100%;overflow-y:auto}.faint{color:rgb(188,188,188)}button.tiny{width:10px;height:10px;padding:0;border:0;margin:0 1px;background:rgb(0,0,0)}
a.plain{color:rgb(60,60,60);text-decoration:none}.filler{height:3000px}</style></head><body><main class="app">
<h1>A shell with its faults at the top</h1>
<p class="faint">A line too faint to read</p>
<p><button class="tiny" aria-label="One"></button><button class="tiny" aria-label="Two"></button></p>
<p>A sentence with <a class="plain" href="#plain">a link</a> in it that nothing marks.</p>
<div class="filler"></div>
<p><a href="#first">First</a> <a href="#second">Second</a></p>
</main></body></html>`,
  );
  // A page that traps the keyboard: from its "Close" button Tab goes back to
  // "Open", so the eight links after it are never reached. The seven buttons
  // before it hide their focus ring.
  writeFileSync(
    path.join(dir, "trapped.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A keyboard trap</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}button.bare:focus{outline:none}</style></head><body>
<p><a href="#start">Start</a></p>
<p>${Array.from({ length: 7 }, (_, n) => `<button class="bare">Bare ${n + 1}</button>`).join(" ")}</p>
<p><button id="open">Open</button> <button id="close">Close</button></p>
<p>${Array.from({ length: 8 }, (_, n) => `<a href="#after-${n + 1}">After ${n + 1}</a>`).join(" ")}</p>
<script>document.getElementById("close").addEventListener("keydown", (event) => { if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); document.getElementById("open").focus(); } });</script>
</body></html>`,
  );
  // A page with more stops than a walk presses Tab: a hundred links. The
  // page puts focus on the ninety-first as it loads, and the three from the
  // ninety-fifth hide their focus ring: a walk that starts at the top never
  // meets them, one that starts where the page left focus does.
  const link = (n, bare = false) => `<a href="#link-${n}"${bare ? ' class="bare"' : ""} id="link-${n}">Link ${n}</a>`;
  writeFileSync(
    path.join(dir, "many.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A hundred links</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}a.bare:focus{outline:none}</style></head><body>
<p>${Array.from({ length: 100 }, (_, n) => link(n + 1, n + 1 >= 95 && n + 1 <= 97)).join(" ")}</p>
<script>document.getElementById("link-91").focus();</script>
</body></html>`,
  );
  // One link fewer than a walk presses Tab, and a last one that gives focus
  // up the moment it takes it: the walk's last press leaves nothing focused.
  writeFileSync(
    path.join(dir, "edge.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Seventy-nine links and one</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}</style></head><body>
<p>${Array.from({ length: 79 }, (_, n) => link(n + 1)).join(" ")} <a href="#thrown" id="thrown">Thrown</a></p>
<script>document.getElementById("thrown").addEventListener("focus", (event) => event.target.blur());</script>
</body></html>`,
  );
  // A field that takes one Tab for itself and lets the next through, as a
  // list that opens on focus does to pick its option; then a text field
  // whose own script keeps every Tab, with a button after it. And a dialog
  // over its page with one button in it: the two links
  // behind it are out of a keyboard's reach while it is open, and Tab from
  // its button goes off the page or straight back to it, as the browser
  // chooses.
  writeFileSync(
    path.join(dir, "keeps.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A field that keeps Tab</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}</style></head><body>
<p><a href="#docs">Docs</a></p>
<p><label>City <input id="city"></label></p>
<p><label>Notes <textarea id="notes"></textarea></label></p>
<p><button>Save</button></p>
<script>
let open = false;
const city = document.getElementById("city");
city.addEventListener("focus", () => { open = true; });
city.addEventListener("keydown", (event) => { if (event.key === "Tab" && open) { event.preventDefault(); open = false; } });
document.getElementById("notes").addEventListener("keydown", (event) => { if (event.key === "Tab") event.preventDefault(); });
</script>
</body></html>`,
  );
  writeFileSync(
    path.join(dir, "dialog.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A dialog over the page</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}</style></head><body>
<p><a href="#home">Home</a> <a href="#about">About</a></p>
<dialog id="ask"><p>Before you go on.</p><button>Accept</button></dialog>
<script>document.getElementById("ask").showModal();</script>
</body></html>`,
  );
  // What keeps focus for more than one press of Tab, on a page that takes
  // focus as it loads. A field with `autofocus` stands below the first link.
  // A date field is one element and several stops, a frame holds two links
  // of its own, and a card with a closed shadow tree has a button of its own
  // before the link set into it and another after: focus is on the card, on
  // the link, and on the card again.
  writeFileSync(
    path.join(dir, "crossed.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stops inside stops</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px sans-serif}iframe{height:40px}</style></head><body>
<p><a href="#above">Above the field</a></p>
<p><label>Search <input type="search" autofocus></label></p>
<p><label>Date of birth <input type="date"></label></p>
<p><iframe title="Two links in a frame" srcdoc="<a href='#one'>One</a> <a href='#two'>Two</a>"></iframe></p>
<x-card><a href="#inside">Inside the card</a></x-card>
<p><a href="#after">After the card</a></p>
<script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<button>Before</button><slot></slot><button>After</button>"; } });</script>
</body></html>`,
  );
  // A page fixed to its screen, its content in a part that scrolls: five
  // screens of 800 px in a `main` one screen tall. Below them, in the same
  // `main`, a strip 100 px tall that only hides the six screens it holds:
  // more than the `main` does, and nothing a reader can scroll.
  const screens = (count) => [[255, 0, 0], [0, 128, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]].slice(0, count).map((c) => '<section style="height:800px;background:rgb(' + c.join(",") + ')"></section>').join("");
  writeFileSync(
    path.join(dir, "inside.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>An app in a shell</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}main.app{height:100vh;overflow-y:auto}.strip{height:100px;overflow:hidden}</style></head><body>
<main class="app">${screens(5)}<div class="strip">${screens(6)}</div></main></body></html>`,
  );
  // The same five screens in a `body` that scrolls by itself: its root has
  // an overflow of its own, so the browser does not hand the body's to the
  // window.
  writeFileSync(
    path.join(dir, "shell.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A body that scrolls</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html{height:100%;overflow:hidden}body{height:100%;margin:0;overflow:auto}</style></head><body>
${screens(5)}</body></html>`,
  );
  // A long page, ten screens of it, that keeps a log six screens long in a
  // box of its own 200 px tall. It also has a folded part that hides four
  // screens nobody can scroll to, a reel on its first screen that scrolls by
  // 900 px, and a `body` half a screen tall and told to scroll, which the
  // browser hands to the window: that `body` holds more out of sight than
  // the log does, and is the window's to scroll, not a part of the page.
  writeFileSync(
    path.join(dir, "folded.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A log in a long page</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{height:50vh;margin:0;overflow:auto}.fold{max-height:0;overflow:hidden}.reel{height:800px;overflow:auto}pre.log{height:200px;margin:0;overflow:auto;font:16px/20px monospace}</style></head><body>
<div class="fold">${screens(4)}</div><div class="reel">${screens(2)}<div style="height:100px"></div></div>${screens(1)}<pre class="log">${"a line of the log\n".repeat(250)}</pre><section style="height:6200px;background:rgb(0,0,255)"></section></body></html>`,
  );
  // A shell under a header: a `main` one screen tall, holding thirty, below
  // 56 px of header, so the document is 56 px taller than its screen. Once
  // as it is and once under a root that hides what overflows it.
  for (const [name, root] of [["header.html", ""], ["header-hidden.html", "html{overflow:hidden}"]]) {
    writeFileSync(
      path.join(dir, name),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A shell under a header</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${root}body{margin:0}header{height:56px;background:rgb(0,0,0)}main.app{height:100vh;overflow:auto}</style></head><body>
<header></header><main class="app"><div style="height:24000px;background:rgb(0,128,0)"></div></main></body></html>`,
    );
  }
  // A page of one screen that holds a long text field and a block with a
  // height of its own, each with screens of text out of sight (the block
  // with the more), in a part that fills the screen and only hides the two
  // screens that run past it.
  writeFileSync(
    path.join(dir, "boxes.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two boxes</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:16px/20px monospace}.clip{height:100vh;overflow:hidden}pre.log{height:300px;margin:0;overflow:auto}</style></head><body>
<div class="clip"><p>One screen.</p><textarea rows="8" cols="30">${"a line of text\n".repeat(120)}</textarea><pre class="log">${"a line of the log\n".repeat(250)}</pre><div style="height:1700px"></div></div></body></html>`,
  );
  // Three lanes side by side on a page of one screen, each scrolling by
  // itself and none of them half the screen: the middle one holds the most.
  writeFileSync(
    path.join(dir, "lanes.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Three lanes</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}main{display:flex;height:100vh}section{flex:1;overflow-y:auto}</style></head><body>
<main>${[["todo", 3000], ["doing", 5000], ["done", 4000]].map(([id, high]) => `<section id="${id}"><div style="height:${high}px"></div></section>`).join("")}</main></body></html>`,
  );
  // A shell under a header with more page below it: a `main` one screen
  // tall holding thirty, 56 px of header above and 1,200 px of page after.
  writeFileSync(
    path.join(dir, "below.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A shell with page below</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}header{height:56px;background:rgb(0,0,0)}main.app{height:100vh;overflow:auto}footer{height:1200px;background:rgb(0,0,255)}</style></head><body>
<header></header><main class="app"><div style="height:24000px;background:rgb(0,128,0)"></div></main><footer></footer></body></html>`,
  );
  // A shell fixed to its screen with two panes that each scroll: a rail
  // holding 6,000 px and an article holding 4,000. A note in the article
  // scrolls too, by 300 px, which is less than a screen and so no such part.
  writeFileSync(
    path.join(dir, "panes.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two panes</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}body{display:flex}aside.rail{width:30%;overflow-y:auto}main.article{flex:1;overflow-y:auto}</style></head><body>
<aside class="rail"><div style="height:6000px"></div></aside><main class="article"><div class="note" style="height:100px;overflow:auto"><div style="height:400px"></div></div><div style="height:3900px"></div></main></body></html>`,
  );
  // A page with no doctype, so laid out in the browser's quirks mode, whose
  // root and `body` hide what overflows them sideways: 5,000 px of page that
  // the window scrolls. Its `body` is as tall as what it holds and scrolls
  // nowhere, though in that mode it reports the window's height as its own
  // inner height.
  writeFileSync(
    path.join(dir, "quirks.html"),
    `<html lang="en"><head><meta charset="utf-8"><title>A page with no doctype</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{overflow-x:hidden;margin:0}</style></head><body><div style="height:5000px;background:rgb(0,128,0)"></div></body></html>`,
  );
  // Two small boxes that scroll, then 5,200 elements, then a box 200 px
  // tall inside a border of 10 that holds 9,000: the one that hides the most
  // is far down the document's elements, and its own box is 220 px.
  writeFileSync(
    path.join(dir, "crowd.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A crowded page</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}div.small,div.big{overflow:auto}div.small{height:100px}div.big{height:200px;border:10px solid rgb(0,0,0)}</style></head><body>
<div class="small"><div style="height:2000px"></div></div><div class="small"><div style="height:3000px"></div></div>
<p>${"<i></i>".repeat(5200)}</p>
<div class="big"><div style="height:9000px"></div></div></body></html>`,
  );
  // Two pages whose `body` scrolls by itself, five screens of it, under a
  // root whose overflow-y says nothing: one whose root clips sideways, and
  // one whose `body` is a container for its own queries. Neither hands its
  // overflow to the window.
  for (const [name, css] of [
    ["clip-root.html", "html{overflow-x:clip}body{height:100vh;margin:0;overflow-y:auto}"],
    ["contained.html", "body{container-type:inline-size;height:100vh;margin:0;overflow-y:auto}"],
  ]) {
    writeFileSync(
      path.join(dir, name),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A body that scrolls</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body>${screens(5)}</body></html>`,
    );
  }
  // A long page on a wide screen that is an app in a shell on a narrow one.
  // Its `body` keeps the margin browsers give it, so the shell is 16 px
  // taller than the phone's screen: a page that scrolls by its own margin
  // and no more.
  writeFileSync(
    path.join(dir, "narrow.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A shell on a phone</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>@media (max-width:600px){main.app{height:100vh;overflow-y:auto}}</style></head><body>
<main class="app">${screens(5)}</main></body></html>`,
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

const DESKTOP = { id: "desktop", width: 1280, height: 800, maxHeight: 4800, mobile: false, from: 0 };
const PHONE = { id: "phone", width: 390, height: 844, maxHeight: 5064, mobile: true, from: 0 };

/** A job over the fixture folder whose scratch is `<work>/scratch/<name>`. */
function jobIn(work, browser, name, more) {
  return JSON.stringify({
    root: path.join(work, "files"),
    names: readdirSync(path.join(work, "files")),
    out: path.join(work, "scratch", name, "out"),
    profile: path.join(work, "scratch", name, "profile"),
    browser,
    pageTimeoutMs: 60000,
    maxBytes: 3750000,
    ...more,
  });
}

if (command === "job-web") {
  // A page on the web, whole, at the two widths a reference is kept at.
  const [work, browser, sitePort] = args;
  process.stdout.write(
    jobIn(work, browser, "web", {
      pages: [{ file: "the site", kind: "web", url: `http://127.0.0.1:${sitePort}/` }],
      views: [
        { ...DESKTOP, whole: true, stretches: 2 },
        { ...PHONE, whole: true, stretches: 2 },
      ],
    }),
  );
}

if (command === "job-closed") {
  // A task page again, in a job of its own, after the open one.
  const [work, browser] = args;
  process.stdout.write(jobIn(work, browser, "closed", { pages: [{ file: "page.html", kind: "html" }], views: [DESKTOP] }));
}

if (command === "job-states") {
  const [work, browser] = args;
  const act = (id, view, asked) => ({ ...view, id, act: asked });
  process.stdout.write(
    jobIn(work, browser, "states", {
      pages: [
        { file: "states.html", kind: "html" },
        { file: "shrunk.html", kind: "html" },
      ],
      views: [
        // Reduced motion at a width no other view has, then a view without
        // it straight after, so the page's own marks say which load was
        // told what.
        { ...DESKTOP, id: "reduced", width: 1000, height: 700, reduce: true },
        { ...DESKTOP, id: "plain", width: 900, height: 700 },
        act("press", DESKTOP, { press: "Menu" }),
        act("hover", DESKTOP, { hover: "Menu" }),
        act("keys", DESKTOP, { tab: 2 }),
        act("none", DESKTOP, { press: "Pricing" }),
        act("next", DESKTOP, { press: "Next page" }),
        act("away", DESKTOP, { press: "Away" }),
        act("thumb", PHONE, { press: "Menu" }),
      ],
    }),
  );
}

if (command === "job-long") {
  const [work, browser] = args;
  process.stdout.write(
    jobIn(work, browser, "long", {
      pages: [{ file: "long.html", kind: "html" }],
      views: [
        // More stretches allowed than the page has, each two screens and a
        // bit: the page's end is what stops them.
        { ...DESKTOP, maxHeight: 1700, whole: true, stretches: 5 },
        { ...PHONE, whole: true, stretches: 2 },
        { ...DESKTOP, id: "top", moving: true },
        { ...DESKTOP, id: "down", from: 1700, moving: true },
      ],
    }),
  );
}

if (command === "job-measured") {
  const [work, browser, engine] = args;
  process.stdout.write(
    jobIn(work, browser, "measured", {
      pages: [
        { file: "measured.html", kind: "html" },
        { file: "deep.html", kind: "html" },
      ],
      views: [DESKTOP, PHONE],
      measure: true,
      axe: engine,
    }),
  );
}

if (command === "job-walks") {
  // Measured with no engine named: the keyboard's walk is what is asked.
  const [work, browser] = args;
  process.stdout.write(
    jobIn(work, browser, "walks", {
      pages: ["trapped.html", "many.html", "edge.html", "crossed.html", "keeps.html", "dialog.html"].map((file) => ({ file, kind: "html" })),
      views: [DESKTOP],
      measure: true,
    }),
  );
}

if (command === "job-inside") {
  const [work, browser] = args;
  process.stdout.write(
    jobIn(work, browser, "inside", {
      pages: ["inside.html", "folded.html", "shell.html", "narrow.html", "header.html", "header-hidden.html", "boxes.html", "lanes.html", "below.html", "panes.html", "quirks.html", "crowd.html", "clip-root.html", "contained.html"].map((file) => ({
        file,
        kind: "html",
      })),
      views: [DESKTOP, PHONE],
    }),
  );
}

/** What a verify command reads a job's outcome through. */
function outcomeOf(work, name) {
  let failures = 0;
  const check = (holds, what, seen = "") => {
    console.log(`${holds ? "ok   " : "FAIL "} ${what}${holds || seen === "" ? "" : ` (${seen})`}`);
    if (!holds) failures += 1;
  };
  const out = path.join(work, "scratch", name, "out");
  const reportFile = path.join(out, "report.json");
  if (!existsSync(reportFile)) {
    check(false, `the renderer wrote its report of the ${name} job`);
    process.exit(1);
  }
  return {
    check,
    out,
    pages: JSON.parse(readFileSync(reportFile, "utf8")).pages,
    picture: (file) => (existsSync(path.join(out, file)) ? decodePng(readFileSync(path.join(out, file))) : null),
    hits: () => (existsSync(path.join(work, "hits")) ? readFileSync(path.join(work, "hits"), "utf8").split("\n").filter(Boolean) : []),
    done: () => process.exit(failures === 0 ? 0 : 1),
  };
}

if (command === "verify-web") {
  const [work] = args;
  const { check, pages, picture, hits, done } = outcomeOf(work, "web");
  const [site] = pages;
  const desktop = picture("1-desktop.png");
  const phone = picture("1-phone.png");
  check(site.error === null && site.shots.length === 2, "a page on the web is pictured", site.error ?? `${site.shots.length} picture(s)`);
  check(desktop?.width === 1280 && phone?.width === 390, "at both widths", `${desktop?.width} and ${phone?.width}`);
  if (desktop && phone) {
    check(
      desktop.at(50, 90) === "255,0,0" && phone.at(50, 90) === "255,0,0",
      "what it draws from another port of this host is drawn: the network is open to it",
      `${desktop.at(50, 90)} / ${phone.at(50, 90)}`,
    );
    // Asked for over half a second after the load event and answered 600 ms
    // later: in the picture only because the page was let go quiet first.
    check(
      desktop.at(50, 190) === "255,0,0" && phone.at(50, 190) === "255,0,0",
      "and so is what it fetched after its load event: it is pictured once it has gone quiet",
      `${desktop.at(50, 190)} / ${phone.at(50, 190)}`,
    );
  }
  check(
    ["GET /web-pixel.png", "GET /web-first", "GET /web-late.png"].every((hit) => hits().includes(hit)),
    "the other port saw each of its requests",
    hits().join(" "),
  );
  check(
    site.asked.length === 0 && site.askedCount === 0 && site.missing.length === 0,
    "it reports nothing as asked of the network or missing",
    `${site.asked.join(" ")} ${site.missing.join(" ")}`,
  );
  const motion = site.motion;
  check(
    motion?.runningCount === 1 && motion.running[0]?.name === "spin" && motion.running[0]?.target === "div.spinner" && motion.running[0]?.loops === true,
    "what moves on it is read: the one animation still running a second after the load, and that it loops",
    JSON.stringify(motion?.running),
  );
  check(motion?.sticky?.what === "header.bar" && motion?.sticky?.position === "sticky", "the bar that stays at the top", JSON.stringify(motion?.sticky));
  check(motion?.onScroll === 2, "the two sections that animate in as they are scrolled to", String(motion?.onScroll));
  check(
    motion?.hover.length === 1 && motion.hover[0].what === "a.nav" && motion.hover[0].changes.join() === "color" && motion.hover[0].durationMs === 150,
    "and the link whose colour changes under the pointer, over 150 ms",
    JSON.stringify(motion?.hover),
  );
  done();
}

if (command === "verify-closed") {
  const [work, port] = args;
  const { check, pages, hits, done } = outcomeOf(work, "closed");
  const [page] = pages;
  const missing = new Set(page.missing);
  check(page.error === null && page.shots.length === 1, "a task page is pictured in a job after the open one", page.error ?? "");
  for (const probe of ["loopback", "remote", "fetch", "localhost"]) {
    check(
      missing.has(`check-${probe}-refused`) && !missing.has(`check-${probe}-LOADED`),
      `and its ${probe} request still loaded nothing`,
      [...missing].join(" "),
    );
  }
  check(page.asked.includes(`127.0.0.1:${port}`), "which it is still said to have asked for", page.asked.join(" "));
  check(!hits().some((hit) => hit.includes("/hit-")), "no request of a task page has reached the other port", hits().join(" "));
  done();
}

if (command === "verify-states") {
  const [work] = args;
  const { check, out, pages, picture, done } = outcomeOf(work, "states");
  const [states, shrunk] = pages;
  const act = (page, view) => page.acts.find((entry) => entry.view === view);
  const marks = new Set(states.missing);
  const said = [...marks].join(" ");
  check(states.error === null && shrunk.error === null, "a page is shown in the states asked, and no act is the page's failure", `${states.error} / ${shrunk.error}`);

  // The page's own media query, at the two widths only those views have.
  check(marks.has("motion-1000-reduce") && !marks.has("motion-1000-no-preference"), "a view with reduce makes the page's own media query true", said);
  check(marks.has("motion-900-no-preference") && !marks.has("motion-900-reduce"), "and the view after it, without, false", said);
  check(
    picture("1-reduced.png")?.at(500, 400) === "0,128,0" && picture("1-plain.png")?.at(450, 400) === "255,255,255",
    "each is pictured as its style sheet then draws it",
    `${picture("1-reduced.png")?.at(500, 400)} / ${picture("1-plain.png")?.at(450, 400)}`,
  );

  check(act(states, "press")?.done === 'pressed button "Menu"', "a control is found by its words, not as the menu element its name also selects", JSON.stringify(act(states, "press")));
  check(
    marks.has("menu-1280-opened-by-a-real-press") && !marks.has("menu-1280-opened-by-a-scripted-press"),
    "and really pressed: the page's own script saw a trusted click",
    said,
  );
  check(
    picture("1-press-a.png")?.at(150, 160) === "0,128,128",
    "its menu is open in the picture, though it shuts when its window is resized",
    String(picture("1-press-a.png")?.at(150, 160)),
  );

  check(act(states, "hover")?.done === 'the pointer is on button "Menu"', "a control is put under the pointer", JSON.stringify(act(states, "hover")));
  check(marks.has("hover-background-255-128-0"), "and has the computed style its :hover rule gives", said);
  check(picture("1-hover-a.png")?.at(25, 15) === "255,128,0", "which is how it is pictured", String(picture("1-hover-a.png")?.at(25, 15)));

  check(act(states, "keys")?.done === '2 presses of Tab: focus is on link "Docs"', "Tab moves focus as a keyboard does", JSON.stringify(act(states, "keys")));
  check(marks.has("focus-visible-outline-solid-255-0-255"), "and the control it lands on matches :focus-visible and has that rule's outline", said);
  check(picture("1-keys-a.png")?.at(197, 30) === "255,0,255", "which is how it is pictured", String(picture("1-keys-a.png")?.at(197, 30)));

  check(
    act(states, "none")?.done === null &&
      act(states, "none")?.error === 'nothing at this width is called "Pricing". The controls on it: "Menu", "Docs", "Next page", "Away"',
    "an act that finds nothing says so, with what the controls there are called",
    JSON.stringify(act(states, "none")),
  );
  check(!existsSync(path.join(out, "1-none-a.png")) && !states.shots.some((shot) => shot.view === "none"), "and takes no picture");
  // The other page has no dark bar across its top.
  check(
    act(states, "next")?.done === 'pressed link "Next page"' && picture("1-next-a.png")?.at(640, 30) === "255,255,255",
    "a press that moves to another file of the task is pictured where it led",
    `${JSON.stringify(act(states, "next"))} ${picture("1-next-a.png")?.at(640, 30)}`,
  );
  check(
    act(states, "away")?.done === null && act(states, "away")?.error === "the press sent the browser to another address" && !existsSync(path.join(out, "1-away-a.png")),
    "a press that leaves for another site is that act's own failure, and takes no picture",
    JSON.stringify(act(states, "away")),
  );
  check(states.shots.length === 7, "every other view of the page is pictured", states.shots.map((shot) => shot.file).join(" "));

  // A phone lays this page out 980 px wide and shrinks it to its screen.
  const thumb = shrunk.shots.find((shot) => shot.view === "thumb");
  check(new Set(shrunk.missing).has("shrunk-980-pressed-real"), "on a page a phone shrinks, the press lands on the control", shrunk.missing.join(" "));
  check(
    thumb?.width === 390 && thumb?.height === 844 && thumb?.scale < 1 && thumb?.from > 0,
    "and the screen is pictured where the window went to reach it, at the phone's own size",
    JSON.stringify(thumb),
  );
  done();
}

if (command === "verify-long") {
  const [work] = args;
  const { check, pages, picture, done } = outcomeOf(work, "long");
  const [long] = pages;
  const colours = ["255,0,0", "0,128,0", "0,0,255", "255,255,0", "0,255,255"];
  /** The colour the page has at a height: its five screens, then the strip. */
  const at = (y, screen) => (y >= 5 * screen ? "255,0,255" : colours[Math.floor(y / screen)]);
  const covers = (view, screen) => {
    const shots = long.shots.filter((shot) => shot.view === view);
    let next = 0;
    for (const shot of shots) {
      const png = picture(shot.file);
      if (!png || shot.from !== next || png.height !== shot.height) return `${shot.file} starts at ${shot.from}, not ${next}`;
      if (png.at(600 % png.width, 0) !== at(shot.from, screen)) return `${shot.file} starts with ${png.at(600 % png.width, 0)}`;
      if (png.at(600 % png.width, png.height - 1) !== at(shot.from + shot.height - 1, screen)) return `${shot.file} ends with ${png.at(600 % png.width, png.height - 1)}`;
      next += shot.height;
    }
    return next === 5 * screen + 100 && shots.every((shot) => shot.cut === false && shot.contentHeight === next) ? "" : `they end at ${next}`;
  };
  check(long.error === null, "a page five screens long is pictured whole and moving", long.error ?? "");
  check(long.scrollsInside === null, "and has no part that scrolls inside it", JSON.stringify(long.scrollsInside));
  check(
    long.shots.filter((shot) => shot.view === "desktop").map((shot) => shot.file).join(" ") === "1-desktop.png 1-desktop-s2.png 1-desktop-s3.png",
    "a whole view comes back as its stretches, as many as the page takes",
    long.shots.map((shot) => shot.file).join(" "),
  );
  // 4,100 px: five screens and the strip that is added only once the fifth
  // has been scrolled to, which a walk to the first stretch's end never is.
  check(covers("desktop", 800) === "", "in order, each starting where the one before ended, covering the page to the strip added at its end", covers("desktop", 800));
  check(covers("phone", 844) === "", "and the phone's one stretch covers its taller layout the same way", covers("phone", 844));

  /** Where the black block is on a row of a frame. */
  const block = (file, y) => {
    const png = picture(file);
    if (!png) return -1;
    for (let x = 0; x < png.width; x += 1) if (png.at(x, y) === "0,0,0") return x;
    return -1;
  };
  for (const [view, row, what] of [
    ["top", 125, "what moves as the page loads"],
    // On a page nobody walked first: a walk would have played it already.
    ["down", 325, "what starts to move when it is scrolled to"],
  ]) {
    const frames = long.shots.filter((shot) => shot.view === view);
    const places = frames.map((frame) => block(frame.file, row));
    check(
      frames.length === 3 && frames.every((frame, n) => frame.file === `1-${view}-m${n + 1}.png` && frame.height === 800),
      `a moving view comes back as three frames of one screen (${view})`,
      frames.map((frame) => frame.file).join(" "),
    );
    check(
      frames.length === 3 && frames[0].moment >= 250 && frames[0].moment < 1000 && frames[1].moment >= 1000 && frames[1].moment < 3000 && frames[2].moment >= 3000,
      "taken about 250, 1,000 and 3,000 ms after it came into view",
      frames.map((frame) => frame.moment).join(" "),
    );
    check(places[0] >= 0 && places[2] - places[0] > 300, `and ${what} is somewhere else in the last than in the first`, places.join(" "));
  }
  done();
}

if (command === "verify-measured") {
  const [work] = args;
  const { check, pages, done } = outcomeOf(work, "measured");
  const [page, deep] = pages;
  const measured = page.measured;
  check(page.error === null && page.shots.length === 2, "a measured page is pictured at both widths", page.error ?? "");
  check(measured?.views.map((view) => view.view).join(" ") === "desktop phone", "and measured at each", JSON.stringify(measured?.views.map((view) => view.view)));
  for (const view of measured?.views ?? []) {
    const kinds = new Map(view.faults.kinds.map((kind) => [kind.id, kind]));
    check(view.faults.ran === true, `the accessibility engine ran in the page (${view.view})`, String(view.faults.why));
    // Two: the page's own, and the one its box to write in adds when it takes
    // focus. The engine runs after the walk, so that box was a stop of it.
    check(
      kinds.get("image-alt")?.count === 2 && kinds.get("image-alt")?.impact === "critical",
      "it found the picture with no alt, and the one the page adds when its box to write in takes focus",
      JSON.stringify(view.faults.kinds),
    );
    check(
      kinds.get("color-contrast")?.count === 1 && kinds.get("color-contrast")?.first.join() === ".faint",
      "and the one line of low contrast",
      JSON.stringify(view.faults.kinds),
    );
    check(
      view.faults.worstContrast?.text === "A line too faint to read" && view.faults.worstContrast?.ratio > 1 && view.faults.worstContrast?.ratio < 3,
      "whose ratio and words it reports",
      JSON.stringify(view.faults.worstContrast),
    );
    check(
      view.faults.kindsCount === view.faults.kinds.length && view.faults.kindsCount >= 2,
      "and how many kinds it found in all, which here is as many as it lists",
      `${view.faults.kindsCount} of ${view.faults.kinds.length}`,
    );
    check(
      view.faults.kindsCount === 2 && view.faults.elementsCount === 3,
      "and in how many places: two kinds in three, the two pictures and the faint line",
      `${view.faults.kindsCount} kinds in ${view.faults.elementsCount} places, listed ${JSON.stringify(view.faults.kinds.map((kind) => kind.count))}`,
    );
    check(view.keyboard.ran === true && view.keyboard.cut === false, "the keyboard walk was made, all the way round", JSON.stringify(view.keyboard));
    check(
      view.keyboard.controls === 3 && view.keyboard.stops === 3 && view.keyboard.unreached.length === 0 && view.keyboard.unreachedCount === 0,
      "Tab stops on each of the page's three controls and is said to: the box that also took focus is none of them, nor is the link left out on purpose, the one in a part made inert, or the button in a set of fields switched off",
      JSON.stringify(view.keyboard),
    );
    check(
      view.keyboard.unmarked.join("|") === 'button "No ring"' && view.keyboard.unmarkedCount === 1,
      "the one control that hides its focus ring is the one said to be unmarked",
      JSON.stringify(view.keyboard),
    );
    check(
      view.reduced.ran === true && view.reduced.runningCount === 1 && view.reduced.running[0]?.target === "div.loader" && view.reduced.running[0]?.loops === true,
      "with reduced motion asked for, the page was read: the animation that ignores it is still running and the one that honours it is not",
      JSON.stringify(view.reduced),
    );
  }
  const weight = statSync(path.join(work, "files", "measured.html")).size + statSync(path.join(work, "files", "heavy.png")).size;
  check(measured?.weight.bytes === weight && measured?.weight.files === 2, `one load of it weighs its two files, ${weight} bytes`, JSON.stringify(measured?.weight));
  // 300 KB at 200,000 bytes a second is a second and a half on the wire.
  check(
    measured?.loadMs > 0 && measured?.loadMs >= 1000 && measured?.line === "1.6 Mbit/s down, 150 ms",
    "its load on the slow line takes the time its weight accounts for",
    `${measured?.loadMs} ms on ${measured?.line}`,
  );
  check(page.motion?.runningCount === 2, "and what moves on it is read too: both animations, with no preference asked", JSON.stringify(page.motion?.running));
  // The shell whose faults are on its first screen, and whose last controls
  // are three screens down the part that scrolls: the walk leaves that part
  // at its end, and the engine reads the page as it was pictured.
  check(deep?.error === null && deep?.measured?.views.length === 2, "a shell with its faults on its first screen is pictured and measured at both widths", `${deep?.error}`);
  for (const view of deep?.measured?.views ?? []) {
    const kinds = view.faults.kinds.map((kind) => kind.id).sort().join(" ");
    check(
      view.keyboard.ran === true && view.keyboard.controls === 5 && view.keyboard.stops === 5,
      `the keyboard walk went to the two links at the end of the part that scrolls (${view.view})`,
      JSON.stringify(view.keyboard),
    );
    check(
      view.faults.ran === true && kinds === "color-contrast link-in-text-block target-size" && view.faults.kindsCount === 3,
      "and the engine still found the three kinds of fault on the shell's first screen: the part was put back where the walk found it",
      JSON.stringify(view.faults.kinds.map((kind) => `${kind.id} ${kind.count}`)),
    );
    check(
      view.faults.worstContrast?.text === "A line too faint to read" && view.faults.worstContrast?.ratio < 3,
      "with the faint line's contrast, which the picture shows",
      JSON.stringify(view.faults.worstContrast),
    );
  }
  done();
}

if (command === "verify-walks") {
  const [work] = args;
  const { check, pages, done } = outcomeOf(work, "walks");
  const [trapped, many, edge, crossed, keeps, dialog] = pages;
  const walk = (page) => page.measured?.views[0]?.keyboard;
  const numbered = (kind, word, count) => Array.from({ length: count }, (_, n) => `${kind} "${word} ${n + 1}"`).join("|");
  check(
    pages.length === 6 && pages.every((page) => page.error === null && page.shots.length === 1 && walk(page)?.ran === true),
    "six pages are pictured and their keyboard walks made",
    pages.map((page) => `${page.file}: ${page.error} ${walk(page)?.ran}`).join(", "),
  );
  check(
    trapped.measured?.views[0]?.faults.ran === false && trapped.measured?.views[0]?.faults.why === "no accessibility engine is installed",
    "with no engine named the accessibility check says it did not run, and why",
    JSON.stringify(trapped.measured?.views[0]?.faults),
  );
  // Start, seven bare buttons, Open and Close: ten of eighteen. Then Tab
  // goes back to Open, and on to Close as it did before.
  check(
    walk(trapped)?.cut === false && walk(trapped)?.controls === 18 && walk(trapped)?.stops === 10,
    "a walk into a keyboard trap ends where Tab takes a step it took before, and is no cut walk",
    JSON.stringify(walk(trapped)),
  );
  check(
    walk(trapped)?.unreached.join("|") === numbered("a", "After", 6) && walk(trapped)?.unreachedCount === 8,
    "the links past the trap are named as never reached: six of them, and that there are eight",
    JSON.stringify(walk(trapped)),
  );
  check(
    walk(trapped)?.unmarked.join("|") === numbered("button", "Bare", 6) && walk(trapped)?.unmarkedCount === 7,
    "the buttons that hide their focus ring are named: six of them, and that there are seven",
    JSON.stringify(walk(trapped)),
  );
  check(
    walk(many)?.cut === true && walk(many)?.controls === 100 && walk(many)?.stops === 80,
    "a walk of a page with a hundred links stops at its eightieth press and says it was cut",
    JSON.stringify(walk(many)),
  );
  check(
    walk(many)?.unreached.length === 0 && walk(many)?.unreachedCount === 0,
    "and names none of the twenty it did not get to as never reached: each of them can be",
    JSON.stringify(walk(many)),
  );
  // The page put focus on its ninety-first link as it loaded. A walk from
  // there meets the three links that hide their focus ring within its first
  // seven presses; one from the top stops on the first eighty and never does.
  check(
    walk(many)?.unmarkedCount === 0 && walk(many)?.unmarked.length === 0,
    "the walk began at the top of the page with nothing focused, though the page had put focus far down it: Tab is where a reader's would be",
    JSON.stringify(walk(many)),
  );
  // The last link gives focus up the moment it takes it, so the eightieth
  // press leaves nothing focused. One more shows the walk has been round,
  // whichever way this browser ends its order: off the page, or straight
  // back to the first link.
  check(
    walk(edge)?.cut === false && walk(edge)?.controls === 80 && walk(edge)?.stops === 79 && walk(edge)?.unreached.join("|") === 'a "Thrown"' && walk(edge)?.unreachedCount === 1,
    "a walk whose last press left nothing focused is seen round and is no cut walk: it names the one link that never holds focus",
    JSON.stringify(walk(edge)),
  );
  // The link above the field, the field, the date field, the link in the
  // card and the link after it. The date field holds focus for several
  // presses, and so does the frame; the card holds it before the link set
  // into it and again after.
  check(
    walk(crossed)?.cut === false && walk(crossed)?.controls === 5 && walk(crossed)?.stops === 5 && walk(crossed)?.unreached.length === 0 && walk(crossed)?.unreachedCount === 0,
    "a walk goes on through a date field, a frame and a card that each keep focus for more than one press, on a page whose field took focus as it loaded: every control is reached, and none is named",
    JSON.stringify(walk(crossed)),
  );
  // With the field still focused when its look at rest is noted, it looks
  // the same when focus comes to it.
  check(
    walk(crossed)?.unmarkedCount === 0 && walk(crossed)?.unmarked.length === 0,
    "and the field is not said to look the same with focus as at rest: its look at rest was noted with nothing focused",
    JSON.stringify(walk(crossed)),
  );
  // Docs, then the field that keeps one Tab and lets the next through, then
  // the text field, which has focus at four presses running: a text field
  // holds no stop but itself, so Tab is going nowhere.
  check(
    walk(keeps)?.cut === false && walk(keeps)?.controls === 4 && walk(keeps)?.stops === 3 && walk(keeps)?.unreached.join("|") === 'button "Save"' && walk(keeps)?.unreachedCount === 1,
    "a walk goes on through a field that takes one Tab for itself, comes round at a text field that keeps every Tab, and names the button after it as never reached",
    JSON.stringify(walk(keeps)),
  );
  // The same report whichever way this browser ends the dialog's order: off
  // the page, or straight back to its one button.
  check(
    walk(dialog)?.cut === false && walk(dialog)?.controls === 3 && walk(dialog)?.stops === 1 && walk(dialog)?.unreached.join("|") === 'a "Home"|a "About"' && walk(dialog)?.unreachedCount === 2,
    "a walk of a page under a dialog with one button reaches that button, is no cut walk, and names the two links behind the dialog",
    JSON.stringify(walk(dialog)),
  );
  done();
}

if (command === "verify-inside") {
  const [work] = args;
  const { check, pages, picture, done } = outcomeOf(work, "inside");
  const [inside, folded, shell, narrow, header, hidden, boxes, lanes, below, panes, quirks, crowd, clipRoot, contained] = pages;
  const shot = (page, view) => page.shots.find((entry) => entry.view === view);
  const desktop = picture("1-desktop.png");
  check(
    pages.length === 14 && pages.every((page) => page.error === null),
    "fourteen pages are pictured at both widths",
    pages.map((page) => `${page.file}: ${page.error}`).join(", "),
  );
  check(
    desktop?.height === 800 && shot(inside, "desktop")?.contentHeight === 800 && shot(inside, "desktop")?.cut === false && desktop?.at(640, 400) === "255,0,0",
    "a page fixed to its screen, its content in a part that scrolls, is pictured as the one screen it lays out as",
    `${desktop?.width}x${desktop?.height} ${JSON.stringify(shot(inside, "desktop"))}`,
  );
  // What a page says of each view where a part scrolls inside it: the view,
  // the part that hides the most, how much it holds, how tall its own box
  // is, and how many such parts there are.
  const said = (page) => (page.scrollsInside ?? []).map((at) => `${at.view} ${at.what} ${at.height} ${at.box} ${at.count}`).join(", ");
  const says = (page, words, what) => check(said(page) === words, what, JSON.stringify(page.scrollsInside));
  says(
    inside,
    "desktop main.app 4100 800 1, phone main.app 4100 844 1",
    "and the report says at each width what scrolls inside it, how much that holds in a box how tall, and that it is the one such part: the strip that only hides six screens is none",
  );
  // A document of 8,000 px, and the log's 5,000 in a box of 200.
  says(
    folded,
    "desktop pre.log 5000 200 2, phone pre.log 5000 200 2",
    "a long page with a log in a box of its own says so too: the log, one of two with the reel, and not the body that holds more out of sight, whose overflow is the window's",
  );
  check(shot(folded, "desktop")?.contentHeight === 8000, "and that page is pictured as the long page it is", JSON.stringify(shot(folded, "desktop")));
  says(shell, "desktop body 4000 800 1, phone body 4000 844 1", "a body that scrolls by itself, under a root with an overflow of its own, is the part that scrolls inside a page of one screen");
  check(picture("3-desktop.png")?.height === 800, "and that page is pictured as its one screen", `${picture("3-desktop.png")?.height}`);
  // A long page on the desktop, pictured whole there, and a shell on the
  // phone, where its one screen and the body's own margin are all a picture
  // shows: 844 px and 16.
  check(
    picture("4-desktop.png")?.height === 4016 && shot(narrow, "phone")?.contentHeight === 860 && shot(narrow, "phone")?.cut === false,
    "a page that is a long page on a wide screen and a shell on a narrow one is pictured whole at the one and as its screen at the other",
    `${picture("4-desktop.png")?.height} ${JSON.stringify(shot(narrow, "phone"))}`,
  );
  says(narrow, "phone main.app 4000 844 1", "and has a part that scrolls inside it at the phone's width alone");
  // The document is its screen and the header: 856 px, and 900 on the phone.
  check(shot(header, "desktop")?.contentHeight === 856, "a shell under a header is a document 56 px taller than its screen", JSON.stringify(shot(header, "desktop")));
  says(header, "desktop main.app 24000 800 1, phone main.app 24000 844 1", "and its part that scrolls is said at both widths: thirty screens in a box of one");
  says(hidden, "desktop main.app 24000 800 1, phone main.app 24000 844 1", "and so is the same shell under a root that hides what overflows it");
  says(
    boxes,
    "desktop pre.log 5000 300 2, phone pre.log 5000 300 2",
    "a page of one screen with a long text field and a block with a height of its own names the one that hides the more and counts both, and not the part that only hides what runs past the screen",
  );
  says(
    lanes,
    "desktop section#doing 5000 800 3, phone section#doing 5000 844 3",
    "three lanes side by side, none of them half the screen, are not a page shown whole: the lane that hides the most is named, as one of three",
  );
  // 56 px of header, one screen of main and 1,200 px of page after it.
  check(shot(below, "desktop")?.contentHeight === 2056, "a shell under a header with more page below it is a document of 2,056 px", JSON.stringify(shot(below, "desktop")));
  says(below, "desktop main.app 24000 800 1, phone main.app 24000 844 1", "and its part that scrolls is said the same way, whatever page there is around it");
  says(
    panes,
    "desktop aside.rail 6000 800 2, phone aside.rail 6000 844 2",
    "a shell with two panes that each scroll names the rail, which hides the more, and says there are two such parts: the note that scrolls by less than a screen is none",
  );
  check(
    quirks.scrollsInside === null && shot(quirks, "desktop")?.contentHeight === 5000,
    "a page with no doctype that the window scrolls has no part that scrolls inside it: its body is as tall as what it holds",
    `${JSON.stringify(quirks.scrollsInside)} ${JSON.stringify(shot(quirks, "desktop"))}`,
  );
  says(
    crowd,
    "desktop div.big 9000 220 3, phone div.big 9000 220 3",
    "the part that hides the most is found past five thousand elements, all three such parts are counted, and its box is the 200 px it is tall and its border",
  );
  says(clipRoot, "desktop body 4000 800 1, phone body 4000 844 1", "a body that scrolls by itself under a root that clips sideways is a part that scrolls: its overflow is not the window's");
  says(contained, "desktop body 4000 800 1, phone body 4000 844 1", "and so is a body that is a container for its own queries");
  check(
    picture("13-desktop.png")?.height === 800 && picture("14-desktop.png")?.height === 800,
    "and each of those two pages is pictured as its one screen",
    `${picture("13-desktop.png")?.height} ${picture("14-desktop.png")?.height}`,
  );
  done();
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

# Run one more job and read it back: its name, what it shows, and what the two
# commands of that name are given after the work folder.
further() {
  name=$1
  what=$2
  shift 2
  job=$("$NODE" "$WORK/check.mjs" "job-$name" "$WORK" "$BROWSER" "$@")
  started=$(date +%s)
  render "$job"
  code=$?
  took=$(($(date +%s) - started))
  if [ "$code" -eq 0 ]; then
    pass "the renderer $what (${took} s)"
  else
    fail "the renderer exited $code on the $name job"
  fi
}

# --- a page on the web -----------------------------------------------------------
# Ruling 327: opened at its own address with the network open. The site is a
# second server on this host, and what it draws comes from the first.
"$NODE" "$WORK/check.mjs" site "$WORK/site-port" "$PORT" &
site=$!
i=0
while [ ! -s "$WORK/site-port" ] && [ $i -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
SITE_PORT=$(cat "$WORK/site-port" 2>/dev/null)
if [ -z "$SITE_PORT" ]; then
  fail "the stand-in site did not start"
else
  further web "pictured a page on the web at both widths and read what moves on it" "$SITE_PORT"
  "$NODE" "$WORK/check.mjs" verify-web "$WORK" || failures=$((failures + 1))
fi
# The open network was that job's browser's alone: a task page pictured after
# it is as closed in as the first one was.
further closed "pictured a task page after it"
"$NODE" "$WORK/check.mjs" verify-closed "$WORK" "$PORT" || failures=$((failures + 1))

# --- a page in a state -----------------------------------------------------------
# `capture_page` with an act, or with reduced motion: two pages, nine views.
further states "pictured two pages at nine views each, in a state or with reduced motion"
"$NODE" "$WORK/check.mjs" verify-states "$WORK" || failures=$((failures + 1))

# --- a whole page, and a page while it moves ---------------------------------------
further long "pictured a long page whole and while it moves"
"$NODE" "$WORK/check.mjs" verify-long "$WORK" || failures=$((failures + 1))

# --- a measured page --------------------------------------------------------------
# Ruling 328: with the engine the image ships, named to the renderer by its
# path as the server names it.
ENGINE="$APP/node_modules/axe-core/axe.min.js"
if [ -f "$ENGINE" ]; then
  pass "the accessibility engine is in the image ($ENGINE)"
else
  fail "the accessibility engine $ENGINE is not in the image"
fi
further measured "pictured and measured a page" "$ENGINE"
"$NODE" "$WORK/check.mjs" verify-measured "$WORK" || failures=$((failures + 1))
# How a keyboard gets round six pages: one that traps it, one with more stops
# than a walk presses Tab and focus put far down it, one whose last press
# leaves nothing focused, one whose stops keep focus for more than a press
# and whose field takes focus as it loads, one whose text field keeps Tab,
# and one under a dialog with a single button.
further walks "measured six pages a keyboard walk has to get right"
"$NODE" "$WORK/check.mjs" verify-walks "$WORK" || failures=$((failures + 1))

# --- a page that scrolls inside itself ---------------------------------------------
further inside "pictured fourteen pages and found the parts that scroll inside them"
"$NODE" "$WORK/check.mjs" verify-inside "$WORK" || failures=$((failures + 1))

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
