import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every "ruling N" in the tree names a ruling `docs/architecture/decisions.md`
 * defines.
 *
 * Code comments, tests, agent prompts and the docs cite the owner's decisions
 * by number, and the decisions file keeps only current truth: a ruling that
 * stops holding is deleted and its citations are repointed in the same change.
 * A citation of a number the file does not define sends its reader nowhere, or
 * to whatever a later ruling happens to be numbered, so it is checked here
 * instead of remembered.
 *
 * CANARY: delete a ruling's heading from decisions.md without repointing the
 * comments that cite it, or cite a number past the last ruling, and this fails
 * naming each file and number.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const DOC_REL = "docs/architecture/decisions.md";

/** Directories that hold no citations of ours: dependencies, build output,
 *  local data, agent worktrees (`.claude/worktrees/`, other checkouts of the
 *  tree) and vendored code. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "data",
  "docker-data",
  "coverage",
  "playwright-report",
  "test-results",
  ".react-router",
  ".agents",
  "worktrees",
  "anti-slop",
  "humanizer",
]);
const TEXT_FILE = /\.(?:ts|tsx|mjs|js|css|md|sql|sh|ya?ml|json|example|c)$|^Dockerfile$/;

function textFiles(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name === "package-lock.json") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (TEXT_FILE.test(name)) out.push(full);
  }
  return out;
}

/** A citation: the keyword, then one number or a list of them ("rulings 12,
 *  40 and 41", "ruling 7(b)", "ruling-12"), possibly wrapped onto a comment's
 *  next line. A date ("ruling 2026-08-20") is not a citation, and neither is a
 *  name that only contains the word ("core-rulings-2"). */
const GAP = String.raw`(?:[ \t]*\n[ \t]*(?:\*(?!/)|//|#|--)?[ \t]*|[ \t]+)`;
const ITEM = String.raw`\d{1,3}(?!\d)(?!-\d)(?!\.\d)(?:\([a-z]{1,4}\))*`;
const SEP = String.raw`(?:${GAP}?(?:,${GAP}(?:and|or)|,|and|or|&|\+|/|–)${GAP}?(?:[Rr]ulings?${GAP})?)`;
const CITATION = new RegExp(
  String.raw`(?<![\w-])[Rr]ulings?(?:${GAP}|-)(${ITEM}(?:${SEP}${ITEM})*)`,
  "g",
);

describe("ruling citations resolve to decisions.md", () => {
  const doc = readFileSync(path.join(ROOT, DOC_REL), "utf8");
  const numbers = [...doc.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
  const defined = new Set(numbers);

  it("numbers each ruling once", () => {
    expect(numbers.length).toBe(defined.size);
  });

  it("every cited ruling number is defined", () => {
    const unresolved: string[] = [];
    let cited = 0;
    for (const file of textFiles(ROOT, [])) {
      const rel = path.relative(ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(CITATION)) {
        for (const n of m[1]!.matchAll(/\d{1,3}/g)) {
          cited += 1;
          if (!defined.has(Number(n[0]))) unresolved.push(`${rel}: ruling ${n[0]}`);
        }
      }
    }
    // CANARY: break the pattern and the sweep finds nothing, which would pass
    // vacuously; the tree cites rulings thousands of times.
    expect(cited).toBeGreaterThan(1000);
    expect(
      unresolved,
      `${DOC_REL} defines no ruling with these numbers. Repoint each citation at the ` +
        `ruling that now holds, or restore the ruling if it should still hold.`,
    ).toEqual([]);
  });
});
