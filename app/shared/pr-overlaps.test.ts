import { describe, expect, it } from "vitest";
import type { PrRef } from "~/schemas/task-file.schema";
import { mergeCollisions, openPrDiffPaths } from "./pr-overlaps";

/**
 * Ruling 475 (F40-55 (c)): the accept dialog's "Collides" row, as a pure rule
 * both of its doors share. A pull request collides when it is still OPEN on
 * GitHub (`review`, or `accepted` with the merge pending) and changes a path
 * the merging one changes.
 */

function pr(number: number, state: PrRef["state"], changed: string[] | null, truncated = false): PrRef {
  const ref: PrRef = { number, state, title: `PR ${number}` };
  if (changed) ref.paths = { headSha: `h${number}`, changed, truncated };
  return ref;
}

describe("ruling 475: mergeCollisions", () => {
  it("names each other OPEN pull request that shares a path, with only the shared paths", () => {
    // CANARY: drop the `accepted` arm of `openPrDiffPaths` and WEB-6 (merge
    // pending, still open on GitHub) goes unnamed.
    const found = mergeCollisions(
      { key: "WEB-4", pr: pr(2, "review", ["package.json", "src/layout.tsx"]) },
      [
        { key: "WEB-4", pr: pr(2, "review", ["package.json"]) },
        { key: "WEB-2", pr: pr(3, "review", ["package.json", "README.md"]) },
        { key: "WEB-5", pr: pr(4, "review", ["README.md"]) },
        { key: "WEB-6", pr: pr(5, "accepted", ["src/layout.tsx"], true) },
        { key: "WEB-7", pr: pr(6, "merged", ["package.json"]) },
        { key: "WEB-8", pr: pr(7, "closed", ["package.json"]) },
        { key: "WEB-9", pr: pr(8, "review", null) },
        { key: "WEB-10", pr: null },
      ],
    );
    expect(found).toEqual([
      { taskKey: "WEB-2", prNumber: 3, paths: ["package.json"], partial: false },
      { taskKey: "WEB-6", prNumber: 5, paths: ["src/layout.tsx"], partial: true },
    ]);
  });

  it("is empty when the merging task has no open pull request with a read path list", () => {
    const others = [{ key: "WEB-2", pr: pr(3, "review", ["package.json"]) }];
    expect(mergeCollisions({ key: "WEB-4", pr: null }, others)).toEqual([]);
    expect(mergeCollisions({ key: "WEB-4", pr: pr(2, "merged", ["package.json"]) }, others)).toEqual([]);
    expect(mergeCollisions({ key: "WEB-4", pr: pr(2, "review", null) }, others)).toEqual([]);
    expect(openPrDiffPaths({ key: "WEB-4", pr: pr(2, "review", []) })).toBeNull();
  });
});
