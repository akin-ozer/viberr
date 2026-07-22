import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import { rebuildAll } from "./rebuilder.server";
import { rebuildProjections } from "./rebuild.server";
import { getTaskDetail } from "./task-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("rebuildProjections (Phase 10 recovery hammer)", () => {
  it("drops and re-projects everything from disk", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Poison a projection row to simulate drift; the rebuild must discard it.
    store.db
      .prepare(
        `UPDATE task_projections SET title = 'stale', content_hash = 'bogus'
         WHERE task_key = 'VIB-1'`,
      )
      .run();

    const summary = rebuildProjections(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(1);
    expect(getTaskDetail(store.db, store.slug, "VIB-1")?.title).toBe(
      "Task VIB-1",
    );
  });

  it("emits projection events only AFTER the write transaction commits (E11)", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Regression: events used to fire from INSIDE the transaction, letting an
    // SSE-triggered revalidation race a half-built (or rolled-back) rebuild.
    const seenInTransaction: boolean[] = [];
    const types: string[] = [];
    const off = onProjectionEvent((e) => {
      seenInTransaction.push(store.db.isTransaction);
      types.push(e.type);
    });
    rebuildProjections(store.db, { dataRoot: store.dataRoot });
    off();

    expect(types).toContain("task.updated");
    expect(types).toContain("project.updated");
    expect(types).toContain("projection.rebuilt");
    expect(seenInTransaction.every((inTx) => inTx === false)).toBe(true);
  });
});
