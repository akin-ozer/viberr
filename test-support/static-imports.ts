import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Ruling 457: what a client module pulls in STATICALLY, found without a
 * build. The one walk for that question: a route's packages
 * (`staticPackagesOf`) and a module's whole closure (`staticModulesOf`, the
 * controller dock's budget) read the same edges.
 *
 * An edge is an `import … from`, `export … from` or bare `import "…"`
 * statement, followed through the app's own files (the `~/` alias and
 * relative paths). Not edges: `import type` / `export type` statements, which
 * the build erases, and dynamic `import()` calls, which is the point: a
 * package reached only through `import()` lands in a lazy chunk, not in the
 * route's closure. `import { type A } from "x"` IS an edge: under the
 * tsconfig's `verbatimModuleSyntax` the build keeps it as `import "x"`.
 *
 * Server modules (`*.server.*`, `app/server/**`) are not followed, because
 * the client build never contains them. The walk over-approximates otherwise
 * (an import used only by a loader counts), so a package it does NOT reach is
 * certainly absent from the route's static client closure.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "app");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
// The clause is a default name, a `{ … }` list or a `* as x`, or a default
// name and one of the other two: nothing looser, so prose that happens to say
// `from "…"` (a comment, JSX text) is never read as an import.
const FROM_STATEMENT =
  /^\s*(?:import|export)\s+(type\s+)?(?:(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)|[\w$]+)\s+from\s+["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

/** The specifiers one module's source imports statically, for a value or
 *  for its side effects. */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const [, typeOnly, specifier] of source.matchAll(FROM_STATEMENT)) {
    if (!typeOnly) out.push(specifier!);
  }
  for (const [, specifier] of source.matchAll(BARE_IMPORT)) out.push(specifier!);
  return out;
}

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

/**
 * Every client module and package `entry` (a path relative to the repo root)
 * reaches through static imports, itself included: a module as its path
 * relative to `app/` (`ui/markdown.tsx`), a package as `npm:<name>`. A
 * stylesheet or asset import is not a module of the closure.
 */
export function staticModulesOf(entry: string): Set<string> {
  const closure = new Set<string>();
  const queue = [path.join(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const id = path.relative(APP, file);
    if (closure.has(id)) continue;
    closure.add(id);
    for (const specifier of staticSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || specifier.startsWith("~/")) {
        const next = resolveLocal(file, specifier);
        if (next && !isServerOnly(next)) queue.push(next);
        continue;
      }
      closure.add(`npm:${packageName(specifier)}`);
    }
  }
  return closure;
}

/** The packages reachable from `entry` (a path relative to the repo root)
 *  through static imports of client modules. */
export function staticPackagesOf(entry: string): Set<string> {
  const packages = new Set<string>();
  for (const id of staticModulesOf(entry)) {
    if (id.startsWith("npm:")) packages.add(id.slice("npm:".length));
  }
  return packages;
}
