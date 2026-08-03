/**
 * Route-closure bundle measurement (modernization gate).
 *
 * For each route id given on the command line (default: the three gate
 * routes), collects the full client asset closure — global entry module +
 * imports + css, plus every ancestor route's and the route's own module,
 * imports, and css from the React Router manifest — de-duplicates it, and
 * reports raw and gzip (zlib level 9) totals. Output is stable JSON so two
 * runs against the same build are byte-identical.
 *
 *   node scripts/measure-routes.mjs [routeId ...]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

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

const routeIds = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["routes/project.board", "routes/project.task", "routes/profile"];

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

const result = {};
for (const routeId of routeIds) {
  const files = closureFor(routeId);
  let rawTotal = 0;
  let gzipTotal = 0;
  for (const file of files) {
    const bytes = readFileSync(path.join(CLIENT, file.replace(/^\//, "")));
    rawTotal += bytes.length;
    gzipTotal += gzipSync(bytes, { level: 9 }).length;
  }
  result[routeId] = { files: files.length, raw: rawTotal, gzip: gzipTotal };
}

console.log(JSON.stringify(result, null, 2));
