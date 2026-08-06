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
import {
  installFakeRuntime,
  startedRunSpecs,
} from "../../../test-support/fake-runtime";
import { readTaskFile } from "~/server/files/task-writer.server";
import { getProject } from "~/server/projections/board-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import {
  cancelScheduledAction,
  fireDueSchedules,
  scheduledRunIsMoot,
  scheduleTaskAction,
  tasksWithUnresolvedSchedules,
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
  installFakeRuntime();
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

  it("P14-RV-03: an ARCHIVED task never fires — the run is retired, not started", async () => {
    // R14-3 calls archive a terminal disposition, and the dialog promises the
    // task "leaves the board and the review queue". Archiving withdrew the
    // packet and the recommendations but never touched `schedules`, so the one
    // thing it failed to stop was the one thing that acts with NO human
    // watching (FR39): a scheduled operator re-run on abandoned work.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "impl",
        archived: true,
        schedules: [rawSchedule({ id: "sch_arch" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    // The occurrence is RETIRED (recorded), not left pending to fire later.
    expect(schedules("VIB-9").find((s) => s.id === "sch_arch")!.status).not.toBe(
      "pending",
    );
    // The retirement IS audited (the occurrence must never vanish), but the
    // outcome names WHY it did not run — no operator was enqueued.
    const audit = listAuditEvents(store.db).filter(
      (e) => e.action === "task.schedule.fired",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ outcome: "skipped-archived" });
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

  it("B-WF3: the operator run says it is SCHEDULED and carries the note", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_note", note: "re-check whether CI went green" }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect((await fireDueSchedules(store.db, dctx())).fired).toBe(1);
    await waitForSchedule("VIB-1", "sch_note", "fired");

    // The reason a human scheduled the re-run has to reach the turn: as a bare
    // `manual` trigger the operator could not tell a scheduled re-check from
    // someone pressing "Run operator", and the note existed only in a timeline
    // entry the prompt never pointed at.
    const prompt = startedRunSpecs().find((s) => s.kind === "operator")?.prompt ?? "";
    expect(prompt).toContain("SCHEDULED re-check");
    expect(prompt).toContain("re-check whether CI went green");
  });

  /**
   * Build the exact state a tick opens with when an acceptance (or an archive)
   * lands between the candidate SELECT and this row's claim: the FILE has moved
   * on, the projection row still shows the pre-move stage.
   */
  function withStaleProjection(
    key: string,
    after: { stage?: string; archived?: boolean },
  ): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_race" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Deliberately NOT reprojected — that staleness IS the defect.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        stage: after.stage ?? "impl",
        ...(after.archived ? { archived: true } : {}),
        schedules: [rawSchedule({ id: "sch_race" })],
      }),
    });
  }

  it("F19-20/FR39: a task that reached Done AFTER the tick's snapshot never fires", async () => {
    // `row.stage` came from a SELECT taken at the top of the tick. An
    // acceptance landing before this row's turn left the runner deciding
    // mootness from a pre-accept stage, so it claimed the occurrence and
    // enqueued a real, unwatched operator turn on a task that is Done and
    // merged. FR39 says that never happens; the claim's own locked read now
    // decides.
    // Canary: restore `const isMoot = row.archived === 1 || row.stage ===
    // terminalFor(...)` and use it in the callback → fired becomes 1, an
    // operator run spec appears, and the audit outcome reads "claimed".
    withStaleProjection("VIB-4", { stage: terminalStage() });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-4")[0]!.status).toBe("fired");
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-done");
    expect(startedRunSpecs().some((s) => s.kind === "operator")).toBe(false);
  });

  it("F19-20: an archive that lands mid-tick retires the occurrence with its own words", async () => {
    // Archive survived the stale snapshot only because `setTaskArchived` ALSO
    // cancels the schedules in the file, so the `status !== "pending"` re-check
    // caught it. Both dimensions are now decided from the same locked read, and
    // the note says which one it was.
    // Canary: collapse the two copy branches into one → the "archived" copy
    // assertion fails; drop the archived clause from `mootNow` and rely on the
    // projection again → the outcome reads "claimed".
    withStaleProjection("VIB-5", { archived: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.skipped).toBe(1);
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-archived");
    const timeline = readTaskFile({
      projectSlug: store.slug, taskKey: "VIB-5", dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find((e) => /Scheduled action skipped/.test(e.text ?? ""))?.text ?? "";
    expect(note).toContain("has been archived");
    expect(note).not.toContain("is already Done");
  });
});

describe("scheduledRunIsMoot (F19-20 — FR39 asked at drive time)", () => {
  // The claim-time check closes the tick's own window. This predicate closes
  // the wider one: a scheduled trigger queued behind an in-flight drive is
  // drained on lease release, and the drive it queued behind is frequently the
  // one that accepted the completion.
  it("is moot on a terminal or archived task, and UNKNOWN on a file it cannot read", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-6", { stage: terminalStage() }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", { stage: "impl", archived: true }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-8", { stage: "impl" }),
    });
    const ref = (taskKey: string) => ({
      projectSlug: store.slug, taskKey, dataRoot: store.dataRoot,
    });
    // Canary: drop the terminal comparison → the first assertion fails.
    expect(scheduledRunIsMoot(store.db, ref("VIB-6"))).toBe(true);
    // Canary: drop the archived clause → the second fails.
    expect(scheduledRunIsMoot(store.db, ref("VIB-7"))).toBe(true);
    expect(scheduledRunIsMoot(store.db, ref("VIB-8"))).toBe(false);
    // A file it cannot read is UNKNOWN, not moot — never swallow a scheduled
    // run on a bad read. Canary: `if (!file) return true` → this fails.
    expect(scheduledRunIsMoot(store.db, ref("VIB-404"))).toBe(false);
  });
});

describe("tasksWithUnresolvedSchedules (B-WF5)", () => {
  it("selects on the schedule's own status, whatever the JSON formatting", () => {
    // A fired occurrence is not a candidate; a pending one is.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-4", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_fired",
            status: "fired",
            firedAt: new Date().toISOString(),
          }),
        ],
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-5", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_pending" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(tasksWithUnresolvedSchedules(store.db).map((r) => r.task_key)).toEqual([
      "VIB-5",
    ]);

    // Same data, formatted differently. The old scan matched the literal bytes
    // `"status":"pending"`, so one space after a colon silently dropped a due
    // schedule from every tick — it would never fire and never be reported.
    const raw = store.db
      .prepare(`SELECT schedules_json FROM task_projections WHERE task_key = 'VIB-5'`)
      .get() as { schedules_json: string };
    store.db
      .prepare(`UPDATE task_projections SET schedules_json = ? WHERE task_key = 'VIB-5'`)
      .run(JSON.stringify(JSON.parse(raw.schedules_json), null, 2));

    expect(tasksWithUnresolvedSchedules(store.db).map((r) => r.task_key)).toEqual([
      "VIB-5",
    ]);
  });

  it("ignores a task with no schedules at all", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-6", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(tasksWithUnresolvedSchedules(store.db)).toEqual([]);
  });
});
