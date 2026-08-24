import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listProjectLabels } from "./board-query.server";
import { rebuildAll } from "./rebuilder.server";

/**
 * `listProjectLabels` is the label-autocomplete source for the task-detail Details
 * panel; the board's New-task modal computes the SAME vocabulary client-side from
 * the board tasks under this identical contract (F26-15). It must return the
 * project's DISTINCT labels, case-collapsed (first spelling wins) and sorted, and
 * never leak an archived task's labels into the live vocabulary.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function writeWithLabels(
  store: { dataRoot: string; slug: string },
  key: string,
  labels: string[],
  extra: Parameters<typeof baseTaskFrontmatter>[1] = {},
) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { labels, ...extra }),
  });
}

describe("listProjectLabels", () => {
  it("returns distinct labels, case-collapsed and sorted", () => {
    const store = setupTestStore(ctx);
    writeWithLabels(store, "T-1", ["runtime", "Docs"]);
    writeWithLabels(store, "T-2", ["docs", "flaky"]); // "docs" dups "Docs"
    writeWithLabels(store, "T-3", []); // no labels
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // First spelling wins the collapse ("Docs" seen before "docs"); sorted.
    expect(listProjectLabels(store.db, store.slug)).toEqual([
      "Docs",
      "flaky",
      "runtime",
    ]);
  });

  it("excludes labels that live only on archived tasks", () => {
    const store = setupTestStore(ctx);
    writeWithLabels(store, "T-1", ["live"]);
    writeWithLabels(store, "T-2", ["buried"], { archived: true });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    expect(listProjectLabels(store.db, store.slug)).toEqual(["live"]);
  });

  it("is empty for a project with no labelled tasks", () => {
    const store = setupTestStore(ctx);
    writeWithLabels(store, "T-1", []);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    expect(listProjectLabels(store.db, store.slug)).toEqual([]);
  });
});
