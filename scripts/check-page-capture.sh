#!/bin/sh
# Ruling 691's in-image check: the page capture's renderer against the REAL
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
#   - the image's fonts give `system-ui` a proportional face and draw an emoji
#     (the Dockerfile's chromium layer);
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
TAG="capture-check-$$"
# A directory shared the way a task's workspace is, outside projects/, which
# the server's file watcher follows.
WORK="$DATA/runtimes/$TAG"
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
    # What the agent wrote is the agent's to remove (ruling 485).
    VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "rm -rf '$WORK/out' '$WORK/profile' '$WORK/tmp'" >/dev/null 2>&1
    rm -rf "$WORK" 2>/dev/null
  fi
}
trap cleanup EXIT

echo "page capture check (ruling 691) as $(id -un) with $BROWSER"

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
mkdir -p "$WORK" && chgrp viberr-agents "$WORK" && chmod 2770 "$WORK"
mkdir -p "$WORK/files"
for dir in out profile tmp; do
  mkdir -p "$WORK/$dir" && chmod 2770 "$WORK/$dir"
done

# The fixtures, the stand-in for "another port on this host", and the reading
# of what came back, in one helper: Node is what the image has.
cat >"$WORK/check.mjs" <<'EOF'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
}

if (command === "job") {
  const [work, browser] = args;
  process.stdout.write(
    JSON.stringify({
      root: path.join(work, "files"),
      out: path.join(work, "out"),
      profile: path.join(work, "profile"),
      browser,
      pages: [
        { file: "page.html", kind: "html" },
        { file: "notes.md", kind: "markdown" },
        { file: "leave.html", kind: "html" },
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

if (command === "verify") {
  const [work, port] = args;
  let failures = 0;
  const check = (holds, what, seen = "") => {
    console.log(`${holds ? "ok   " : "FAIL "} ${what}${holds || seen === "" ? "" : ` (${seen})`}`);
    if (!holds) failures += 1;
  };
  const out = path.join(work, "out");
  const reportFile = path.join(out, "report.json");
  if (!existsSync(reportFile)) {
    check(false, "the renderer wrote its report");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const [page, notes, leave] = report.pages;
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

started=$(date +%s)
(
  cd "$WORK" || exit 1
  HOME="$WORK" TMPDIR="$WORK/tmp" TMP="$WORK/tmp" TEMP="$WORK/tmp" \
    VIBERR_RUN_ID="$TAG" VIBERR_LAUNCH_UID=$UID_C VIBERR_LAUNCH_EXEC="$NODE" \
    "$LAUNCH" "$CHILD" "$JOB"
)
code=$?
took=$(($(date +%s) - started))
if [ "$code" -eq 0 ]; then
  pass "the renderer ran as uid $UID_C through the launcher (three pages in ${took} s)"
else
  fail "the renderer exited $code"
fi
owner=$(stat -c '%u' "$WORK/out/report.json" 2>/dev/null)
[ "$owner" = "$UID_C" ] && pass "its report is uid $UID_C's own" || fail "its report is owned by '$owner'"

"$NODE" "$WORK/check.mjs" verify "$WORK" "$PORT" || failures=$((failures + 1))

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

echo
if [ "$failures" -eq 0 ]; then
  echo "page capture: every check holds"
  exit 0
fi
echo "page capture: $failures check(s) FAILED"
exit 1
