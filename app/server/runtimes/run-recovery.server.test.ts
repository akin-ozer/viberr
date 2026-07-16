import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { configureRunServiceForTests } from "./run-service.server";
import { finalizeOrphanedRuns } from "./run-recovery.server";
import { getRun, upsertRun } from "./run-store.server";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  configureRunServiceForTests(); // no real backend → operator re-invoke is simulated
});

afterEach(() => ctx.cleanup());

function seedRun(id: string, over: Partial<Parameters<typeof upsertRun>[1]> = {}) {
  upsertRun(store.db, {
    id, taskKey: "VIB-1", projectSlug: store.slug, threadId: `op-${id}`,
    role: "Operator", kind: "operator", backend: "claude", simulated: false,
    model: "sonnet", sdk: "Claude Agent SDK", state: "running",
    startedAt: new Date().toISOString(), ...over,
  } as Parameters<typeof upsertRun>[1]);
}

describe("finalizeOrphanedRuns (F-RUN1)", () => {
  it("flips a real running run to error with interrupted_by=restart", () => {
    seedRun("run_orphan", { state: "running" });
    const { finalized } = finalizeOrphanedRuns(store.db);
    expect(finalized).toBe(1);
    const row = getRun(store.db, "run_orphan")!;
    expect(row.state).toBe("error");
    expect(row.interrupted_by).toBe("restart");
    expect(row.finished_at).toBeTruthy();
  });

  it("also finalizes a queued run", () => {
    seedRun("run_queued", { state: "queued" });
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(1);
    expect(getRun(store.db, "run_queued")!.state).toBe("error");
  });

  it("retires simulated seed runs to finished (R6-5: no masquerading as live)", () => {
    seedRun("run_sim", { state: "running", simulated: true });
    const res = finalizeOrphanedRuns(store.db);
    expect(res.simulated).toBe(1);
    const row = getRun(store.db, "run_sim")!;
    expect(row.state).toBe("finished");
    // Not an error, not interrupted — a quiet demo completion.
    expect(row.interrupted_by).toBeNull();
  });

  it("leaves already-terminal runs untouched and is idempotent", () => {
    seedRun("run_done", { state: "finished", finishedAt: new Date().toISOString() });
    seedRun("run_live", { state: "running" });
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(1);
    expect(getRun(store.db, "run_done")!.state).toBe("finished");
    // Second boot finds nothing running.
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(0);
  });
});
