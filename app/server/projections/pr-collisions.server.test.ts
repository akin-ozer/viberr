import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { PrRef } from "~/schemas/task-file.schema";
import { rebuildAll } from "./rebuilder.server";
import { taskMergeCollisions } from "./pr-collisions.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function pr(number: number, state: PrRef["state"], changed: string[]): PrRef {
  return { number, state, title: `PR ${number}`, paths: { headSha: `h${number}`, changed, truncated: false } };
}

/**
 * Ruling 244 (F40-55 (c)): the task page's accept dialog reads, from the
 * projections, which other open review PRs share a changed path with the one
 * it merges. Live on akinozer-com WEB-4 and WEB-2 both changed `package.json`
 * and the dialog that merged WEB-4 said nothing.
 */
describe("ruling 244: taskMergeCollisions", () => {
  it("names the other open PRs that share a path, and never an archived, merged or path-less one", () => {
    // CANARY: drop the `archived = 0` clause and the archived WEB-5 is named.
    const store = setupTestStore(ctx);
    const seed = (key: string, prRef: PrRef | null, archived = false) =>
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "review", pr: prRef, archived }),
      });
    seed("WEB-4", pr(2, "review", ["package.json", "src/app.tsx"]));
    seed("WEB-2", pr(3, "review", ["package.json"]));
    seed("WEB-3", pr(4, "review", ["README.md"]));
    seed("WEB-5", pr(5, "review", ["package.json"]), true);
    seed("WEB-6", pr(6, "merged", ["src/app.tsx"]));
    seed("WEB-7", { number: 7, state: "review", title: "PR 7" });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const mine = { key: "WEB-4", pr: pr(2, "review", ["package.json", "src/app.tsx"]) };
    expect(taskMergeCollisions(store.db, store.slug, mine)).toEqual([
      { taskKey: "WEB-2", prNumber: 3, paths: ["package.json"], partial: false },
    ]);
    // A task with nothing open to merge reads nothing.
    expect(taskMergeCollisions(store.db, store.slug, { key: "WEB-6", pr: pr(6, "merged", ["src/app.tsx"]) })).toEqual([]);
  });
});
