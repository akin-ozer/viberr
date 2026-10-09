/**
 * Route-closure bundle measurement (modernization gate; ruling 11 ratchet).
 *
 * For each route id given on the command line (default: the three gate
 * routes), collects the full client asset closure — global entry module +
 * imports + css, plus every ancestor route's and the route's own module,
 * imports, and css from the React Router manifest — de-duplicates it, and
 * reports raw and gzip (zlib level 9) totals. Output is stable JSON so two
 * runs against the same build are byte-identical.
 *
 *   node scripts/measure-routes.mjs [routeId ...]
 *   node scripts/measure-routes.mjs --check
 *
 * `--check` measures every `bundle:<routeId>` entry of
 * test-support/perf-budgets/bundle.json (plus `bundle:root.css`, the root
 * route's render-blocking stylesheets alone) and exits 1 when one exceeds its
 * ceiling or falls below it by more than its slack: the ratchet only moves
 * down, so a smaller closure must be recorded by lowering the ceiling. Run it
 * after `npm run build`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { budgetVerdict } from "../test-support/perf-verdict.ts";

const CLIENT = path.resolve("build/client");
const ASSETS = path.join(CLIENT, "assets");

const manifestFiles = readdirSync(ASSETS).filter(
  (f) => f.startsWith("manifest-") && f.endsWith(".js"),
);
if (manifestFiles.length !== 1) {
  console.error(`expected exactly one manifest-*.js, found ${manifestFiles.length}`);
  process.exit(1);
}
const raw = readFileSync(path.join(ASSETS, manifestFiles[0]), "utf8");
const manifest = JSON.parse(raw.slice(raw.indexOf("=") + 1).replace(/;?\s*$/, ""));

function closureFor(routeId) {
  const files = new Set();
  const add = (p) => p && files.add(p);
  add(manifest.entry.module);
  for (const f of manifest.entry.imports ?? []) add(f);
  for (const f of manifest.entry.css ?? []) add(f);
  let id = routeId;
  while (id) {
    const route = manifest.routes[id];
    if (!route) {
      console.error(`unknown route id: ${id}`);
      process.exit(1);
    }
    add(route.module);
    for (const f of route.imports ?? []) add(f);
    for (const f of route.css ?? []) add(f);
    id = route.parentId;
  }
  return [...files].sort();
}

function measure(files) {
  let rawTotal = 0;
  let gzipTotal = 0;
  for (const file of files) {
    const bytes = readFileSync(path.join(CLIENT, file.replace(/^\//, "")));
    rawTotal += bytes.length;
    gzipTotal += gzipSync(bytes, { level: 9 }).length;
  }
  return { files: files.length, raw: rawTotal, gzip: gzipTotal };
}

const args = process.argv.slice(2);

if (args.includes("--check")) {
  const budgets = JSON.parse(
    readFileSync(path.resolve("test-support/perf-budgets/bundle.json"), "utf8"),
  );
  let failed = false;
  for (const id of Object.keys(budgets)) {
    const target = id.slice("bundle:".length);
    const files =
      target === "root.css" ? manifest.routes.root.css ?? [] : closureFor(target);
    const verdict = budgetVerdict(id, measure(files).gzip, budgets);
    console.log(`${verdict.ok ? "ok  " : "FAIL"} ${verdict.message}`);
    if (!verdict.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const routeIds = args.length
  ? args
  : ["routes/project.board", "routes/project.task", "routes/profile"];

const result = {};
for (const routeId of routeIds) result[routeId] = measure(closureFor(routeId));

console.log(JSON.stringify(result, null, 2));
