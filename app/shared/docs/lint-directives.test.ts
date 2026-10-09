import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ruling 7: a lint finding is fixed, never accepted, and no disable directive
 * for a lint rule is added. Lint itself cannot hold this: a directive is how a
 * finding leaves its report, and one for a rule the config does not enable
 * reads as a waiver nobody granted. Every source tree we lint is walked here;
 * the vendored anti-slop plugin under `tools/` is upstream's.
 */
const ROOT = process.cwd();
const TREES = ["app", "scripts", "test-support", "e2e"];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/** A line or block comment that opens with a disable directive, spelled in
 *  two halves so this file is not one. */
const DIRECTIVE = new RegExp(String.raw`\/[/*]\s*(?:es|ox)lint-` + "disable");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (SOURCE.test(name)) out.push(abs);
  }
  return out;
}

describe("ruling 7: no lint disable directive in the tree", () => {
  it("finds none in app/, scripts/, test-support/ or e2e/", () => {
    // CANARY: restore a deleted directive (the `no-control-regex` one above
    // a control-character pattern) and this names its file and line.
    const found: string[] = [];
    for (const tree of TREES) {
      const dir = path.join(ROOT, tree);
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const file of walk(dir)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (DIRECTIVE.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
