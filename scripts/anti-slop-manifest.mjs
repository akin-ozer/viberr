// Re-pin the vendored anti-slop plugin: writes tools/oxlint/anti-slop.manifest.json
// (relative path → sha256) from the tree as it is now. Run it after the
// install-anti-slop skill refreshes tools/oxlint/anti-slop/, then commit both.
// app/shared/docs/anti-slop-vendor-sync.test.ts holds the tree to this manifest
// on every machine (CI included) and to the skill assets where they exist.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const tree = path.join(root, "tools", "oxlint", "anti-slop");
const out = path.join(root, "tools", "oxlint", "anti-slop.manifest.json");

function walk(dir, rel = "") {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) files.push(...walk(abs, relPath));
    else files.push(relPath);
  }
  return files;
}

const manifest = {};
for (const rel of walk(tree)) {
  manifest[rel] = createHash("sha256").update(readFileSync(path.join(tree, rel))).digest("hex");
}
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`pinned ${Object.keys(manifest).length} files → ${path.relative(root, out)}`);
