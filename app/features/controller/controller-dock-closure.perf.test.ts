import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";

/**
 * Ruling 454, FL-1 / CTL-1: root mounts the controller dock on every signed-in
 * page, so whatever the dock imports STATICALLY is in every route's first
 * download, closed or not. The figure is the dock module's static import
 * closure from source (app modules plus npm packages, type-only imports and
 * `import()` excluded), so it needs no build; `node scripts/measure-routes.mjs`
 * gives the gzip bytes after one.
 */

const APP = path.join(process.cwd(), "app");

/** Static, value-carrying import specifiers of one module. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  // The clause is a default name, a `{ … }` list or a `* as x`, or a default
  // name and one of the other two: nothing looser, so prose that happens to
  // say `from "…"` in a comment is never read as an import.
  const fromClause =
    /^\s*(import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)|[\w$]+)\s+from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(fromClause)) {
    const [, , typeOnly, clause, spec] = match;
    if (typeOnly) continue;
    // `import { type A, type B } from` carries no value either.
    const named = /^\{([\s\S]*)\}$/.exec(clause!.trim());
    if (named) {
      const names = named[1]!.split(",").map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    out.push(spec!);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(match[1]!);
  return out;
}

function resolveModule(from: string, spec: string): string | null {
  const base = spec.startsWith("~/")
    ? path.join(APP, spec.slice(2))
    : path.resolve(path.dirname(from), spec);
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const file = base + ext;
    if (existsSync(file) && /\.(ts|tsx)$/.test(file)) return file;
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Every app module and package the entry reaches through static imports. */
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(APP, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const id = path.relative(APP, file);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("~/")) {
        const resolved = resolveModule(file, spec);
        // A stylesheet or asset is not a JS module of the closure.
        if (resolved) stack.push(resolved);
      } else {
        seen.add(`npm:${packageName(spec)}`);
      }
    }
  }
  return seen;
}

describe("the closed controller dock's static import closure (ruling 454, FL-1)", () => {
  it("stays small, because root ships it to every page", () => {
    const closure = staticClosure("features/controller/controller-dock.tsx");
    expectWithinBudget("controller:closed-dock.static-modules", closure.size);
  });

  it("keeps the markdown pipeline and the run console out of root", () => {
    // CANARY: import `Markdown` in controller-dock.tsx again, or take
    // `NotConnectedNote` from controller-page.tsx, and root carries them.
    const root = staticClosure("root.tsx");
    const heavy = [
      "npm:react-markdown",
      "npm:remark-gfm",
      "npm:@number-flow/react",
      "npm:thinking-orbs",
      "ui/markdown.tsx",
      "features/controller/controller-page.tsx",
      "features/controller/controller-dock-panel.tsx",
      "features/runtime/runs-panels.tsx",
      "features/runtime/use-run-log-stream.ts",
      "features/runtime/run-log-store.ts",
      "features/runtime/console-fold.ts",
    ];
    expect(heavy.filter((id) => root.has(id))).toEqual([]);
  });
});
