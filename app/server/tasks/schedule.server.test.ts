import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { configureRunServiceForTests } from "~/server/runtimes/run-service.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { getProject } from "~/server/projections/board-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import {
  cancelScheduledAction,
  fireDueSchedules,
  scheduleTaskAction,
} from "./schedule.server";

let ctx: TestDbContext;
let store: TestStore;

const actor = () => ({ userId: store.users.elif.id, label: "Elif Demir" });
const terminalStage = () => {
  const stages = getProject(store.db, store.slug)?.stages ?? [];
  return stages[stages.length - 1]!.id;
};
const schedules = (key: string): TaskSchedule[] =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed
    .frontmatter.schedules;
const dctx = () => ({ dataRoot: store.dataRoot });

/** Poll until a schedule reaches an expected status (the F10-16 finalize is a
 *  detached async step after the synchronous claim). */
async function waitForSchedule(
  key: string,
  id: string,
  status: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (schedules(key).find((s) => s.id === id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const actual = schedules(key).find((s) => s.id === id)?.status;
  throw new Error(`schedule ${id} never reached ${status} (last: ${actual})`);
}

/** A raw schedule object (bypasses the future-only guard) for fire tests. */
function rawSchedule(over: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: "sch_test1",
    action: "run-operator",
    dueAt: new Date(Date.now() - 60_000).toISOString(), // already due
    backend: "claude",
    autonomy: "supervised",
    note: "re-check",
    createdBy: "u_elif",
    createdByLabel: "Elif",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
    ...over,
  };
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // Project the project so getProject() has its stages (terminal-stage checks).
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  configureRunServiceForTests();
});
afterEach(() => ctx.cleanup());

describe("scheduleTaskAction", () => {
  it("adds a pending schedule to the task file + projection", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const s = await scheduleTaskAction(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dueAt: new Date(Date.now() + 3_600_000).toISOString(), backend: "codex", autonomy: "full", note: "check overnight" },
      actor(),
      dctx(),
    );
    expect(s.status).toBe("pending");
    expect(s.backend).toBe("codex");
    expect(schedules("VIB-1")).toHaveLength(1);
    // Projected to schedules_json so the runner can find it.
    const row = store.db.prepare(`SELECT schedules_json FROM task_projections WHERE task_key=?`).get("VIB-1") as { schedules_json: string };
    expect(row.schedules_json).toContain('"status":"pending"');
    // Audited.
    expect(listAuditEvents(store.db).some((e) => e.action === "task.schedule.created")).toBe(true);
  });

  it("rejects a past due time", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      scheduleTaskAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dueAt: new Date(Date.now() - 1000).toISOString(), backend: "claude", autonomy: "supervised" }, actor(), dctx()),
    ).rejects.toThrow(/future/i);
  });

  it("rejects scheduling on a Done (terminal) task", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: terminalStage() }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      scheduleTaskAction(store.db, { projectSlug: store.slug, taskKey: "VIB-2", dueAt: new Date(Date.now() + 3_600_000).toISOString(), backend: "claude", autonomy: "supervised" }, actor(), dctx()),
    ).rejects.toThrow(/Done/i);
  });
});

describe("cancelScheduledAction", () => {
  it("marks a pending schedule cancelled + audits", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", schedules: [rawSchedule({ dueAt: new Date(Date.now() + 3_600_000).toISOString() })] }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await cancelScheduledAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: "sch_test1" }, actor(), dctx());
    expect(res.cancelled).toBe(true);
    expect(schedules("VIB-1")[0]!.status).toBe("cancelled");
    expect(listAuditEvents(store.db).some((e) => e.action === "task.schedule.cancelled")).toBe(true);
    // Idempotent — a second cancel is a no-op.
    expect((await cancelScheduledAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: "sch_test1" }, actor(), dctx())).cancelled).toBe(false);
  });
});

describe("fireDueSchedules", () => {
  it("fires a due pending schedule (marks fired + audits) and leaves a future one pending", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_due" }),
          rawSchedule({ id: "sch_future", dueAt: new Date(Date.now() + 3_600_000).toISOString() }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(1);
    expect(res.skipped).toBe(0);
    // F10-16 lifecycle: the occurrence is CLAIMED synchronously, then finalized
    // to `fired` after the detached operator enqueue completes. Wait for it.
    await waitForSchedule("VIB-1", "sch_due", "fired");
    const after = schedules("VIB-1");
    expect(after.find((s) => s.id === "sch_due")!.status).toBe("fired");
    expect(after.find((s) => s.id === "sch_due")!.firedAt).toBeTruthy();
    expect(after.find((s) => s.id === "sch_due")!.claimedAt).toBeNull();
    expect(after.find((s) => s.id === "sch_future")!.status).toBe("pending");
    const fired = listAuditEvents(store.db).filter((e) => e.action === "task.schedule.fired");
    expect(fired).toHaveLength(1);

    // Idempotent — a second pass finds nothing due (already fired).
    expect((await fireDueSchedules(store.db, dctx())).fired).toBe(0);
  });

  it("F10-16: re-drives a STALLED claim (crash recovery — never lost)", async () => {
    // A claim whose lease expired = the enqueuing tick crashed before finalize.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_stale",
            status: "claimed",
            claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(1); // the stalled claim was recovered and re-driven
    await waitForSchedule("VIB-1", "sch_stale", "fired");
  });

  it("F10-16: does NOT re-drive a FRESH claim (still within its lease)", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_fresh",
            status: "claimed",
            claimedAt: new Date().toISOString(),
          }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0); // an in-flight claim is left alone
    expect(schedules("VIB-1")[0]!.status).toBe("claimed");
  });

  it("retires a due schedule on a Done task WITHOUT running the operator (skipped-done)", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: terminalStage(), schedules: [rawSchedule({ id: "sch_done" })] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-3")[0]!.status).toBe("fired");
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-done");
  });
});
