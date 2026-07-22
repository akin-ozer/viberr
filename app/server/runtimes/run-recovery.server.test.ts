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
import { listAuditEvents } from "../../../test-support/audit-log";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import {
  finalizeOrphanedRuns,
  recoverUnreactedAgentRuns,
  RECOVERY_REINVOKE_CAP,
} from "./run-recovery.server";
import { getRun, insertRunLine, upsertRun } from "./run-store.server";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
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

describe("recoverUnreactedAgentRuns (NFR17/B9 crash-loop backstop)", () => {
  // A finished specialist run whose in-process reply callback was dropped by a
  // restart: the task is stalled at waiting=agent and no `task.agent.replied`
  // audit exists for the run, so the recovery reconciler selects it. The project
  // has no operator deployed (test store `agents: []`), so completion effects post
  // the reply and settle waiting→human without an awaited operator re-invoke.
  function seedDroppedReplyRun(id: string): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun(id, {
      kind: "primary",
      role: "Primary specialist",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store.db, {
      runId: id,
      seq: 1,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: {
        t: "1",
        ev: "text",
        tag: "assistant",
        text: "done: delivered the change and opened the PR",
      },
    });
  }

  function countReplayAudits(runId: string): number {
    return listAuditEvents(store.db, { action: "run.recovery.reply_replayed" }).filter(
      (e) => (e.details as { runId?: string } | null)?.runId === runId,
    ).length;
  }

  it("records a replay-attempt audit and recovers a dropped reply under the cap", async () => {
    seedDroppedReplyRun("run_dropped");
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(0);
    expect(res.recovered).toBe(1);
    // The attempt audit is recorded BEFORE the effects run — so the next boot
    // counts it even if the effects (or the process) die mid-flight.
    expect(countReplayAudits("run_dropped")).toBe(1);
  });

  it("does not reprocess a run after a successful recovery (idempotent)", async () => {
    seedDroppedReplyRun("run_dropped");
    expect((await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot })).recovered).toBe(1);
    // `task.agent.replied` now exists → the NOT EXISTS clause excludes the run.
    const second = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(second.recovered).toBe(0);
    expect(second.capped).toBe(0);
    // No second attempt audit either.
    expect(countReplayAudits("run_dropped")).toBe(1);
  });

  it("skips a run once the replay cap is hit, without re-firing effects", async () => {
    // Simulate CAP prior replays for THIS run within the window (a boot→recover→
    // crash loop where the reply write kept failing so `task.agent.replied` never
    // landed and the run was re-selected every boot).
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { runId: "run_loop", attempt: i + 1 },
      });
    }
    seedDroppedReplyRun("run_loop");
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(1);
    expect(res.recovered).toBe(0);
    // No NEW attempt audit was written (count stays exactly at the cap).
    expect(countReplayAudits("run_loop")).toBe(RECOVERY_REINVOKE_CAP);
    // The run was NEVER reacted to: no reply audit landed.
    expect(
      listAuditEvents(store.db, { action: "task.agent.replied" }).filter(
        (e) => (e.details as { runId?: string } | null)?.runId === "run_loop",
      ).length,
    ).toBe(0);
  });

  it("caps per run — a distinct run on the same task is still recovered", async () => {
    // The capped run's prior replays must NOT starve a sibling run on the task.
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { runId: "run_capped", attempt: i + 1 },
      });
    }
    // Two dropped runs on the SAME task: one already at the cap, one fresh.
    seedDroppedReplyRun("run_capped");
    seedRun("run_fresh", {
      kind: "primary",
      role: "Primary specialist",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store.db, {
      runId: "run_fresh",
      seq: 1,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: { t: "1", ev: "text", tag: "assistant", text: "done: sibling delivery" },
    });
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(1); // run_capped skipped
    expect(res.recovered).toBe(1); // run_fresh recovered
    expect(countReplayAudits("run_fresh")).toBe(1);
    expect(countReplayAudits("run_capped")).toBe(RECOVERY_REINVOKE_CAP);
  });
});
