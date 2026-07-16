import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { configureRunServiceForTests } from "./run-service.server";
import { finalizeOrphanedRuns, RECOVERY_REINVOKE_CAP } from "./run-recovery.server";
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

  it("re-invokes the operator for a real orphan under the crash-loop cap", () => {
    seedRun("run_orphan", { state: "running" });
    const res = finalizeOrphanedRuns(store.db);
    expect(res.finalized).toBe(1);
    expect(res.reinvoked).toBe(1);
    expect(res.capped).toBe(0);
  });

  it("finalizes but does NOT re-invoke once the crash-loop cap is hit (F7-BOOT1)", () => {
    // Simulate CAP prior recovery re-invokes for this task (a boot→orphan→crash
    // loop): each real boot recorded a `run.recovery.reinvoked` audit row.
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reinvoked",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { attempt: i + 1 },
      });
    }
    seedRun("run_orphan_loop", { state: "running" });
    const res = finalizeOrphanedRuns(store.db);
    // The orphan row is still finalized to error…
    expect(res.finalized).toBe(1);
    const row = getRun(store.db, "run_orphan_loop")!;
    expect(row.state).toBe("error");
    expect(row.interrupted_by).toBe("restart");
    // …but the operator is NOT re-invoked (capped).
    expect(res.reinvoked).toBe(0);
    expect(res.capped).toBe(1);
    // No new re-invoke audit row was written (count stays at the cap).
    const n = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'run.recovery.reinvoked' AND task_key = 'VIB-1'`,
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(RECOVERY_REINVOKE_CAP);
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
