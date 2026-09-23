import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Ruling 454: which npm packages a client module pulls in STATICALLY, found
 * without a build. Follows `import … from`, `export … from` and bare
 * `import "…"` statements through the app's own files (the `~/` alias and
 * relative paths); `import type` statements and dynamic `import()` calls are
 * not edges, which is the point: a package reached only through `import()`
 * lands in a lazy chunk, not in the route's closure.
 *
 * Server modules (`*.server.*`, `app/server/**`) are not followed, because
 * the client build never contains them. The walk over-approximates otherwise
 * (an import used only by a loader counts), so a package it does NOT reach is
 * certainly absent from the route's static client closure.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "app");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const STATEMENT =
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;

function resolveLocal(from: string, specifier: string): string | null {
  const bare = specifier.split("?")[0]!;
  const base = bare.startsWith("~/")
    ? path.join(APP, bare.slice(2))
    : path.resolve(path.dirname(from), bare);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function isServerOnly(file: string): boolean {
  return /\.server\.tsx?$/.test(file) || file.startsWith(path.join(APP, "server") + path.sep);
}

/** The packages reachable from `entry` (a path relative to the repo root)
 *  through static imports of client modules. */
export function staticPackagesOf(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [path.join(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(STATEMENT)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || specifier.startsWith("~/")) {
        const next = resolveLocal(file, specifier);
        if (next && !isServerOnly(next)) queue.push(next);
        continue;
      }
      packages.add(packageName(specifier));
    }
  }
  return packages;
}
