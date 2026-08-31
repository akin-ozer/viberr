import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { defaultModelFor } from "./model-catalog.server";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import {
  finalizeOrphanedRuns,
  recoverStrandedOperatorPlans,
  recoverUnreactedAgentRuns,
  RECOVERY_REINVOKE_CAP,
} from "./run-recovery.server";
import { getRun, insertRunLine, patchRun, upsertRun } from "./run-store.server";

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
    role: "Operator", kind: "operator", backend: "claude",
    agentProfileId: "operator",
    model: "sonnet", sdk: "Claude Agent SDK", state: "running",
    startedAt: new Date().toISOString(), ...over,
  });
}

describe("outcome_key lives in the run store (C1, pass 31)", () => {
  /**
   * BEFORE: `registerAgentCompletion` persisted the staging key with a raw
   * `UPDATE agent_runs SET outcome_key = ?`, so the store's own `AgentRunRow`
   * did not declare the column and `RunPatch` could not write it — the one
   * column on this table whose reads were untyped and whose writes bypassed
   * `patchRun` entirely. This pins the typed round-trip.
   */
  it("patchRun writes outcome_key and getRun reads it back", () => {
    seedRun("run_oc");
    // A run that never staged an envelope reads null, not undefined — the row
    // type has to admit the column.
    expect(getRun(store.db, "run_oc")!.outcome_key).toBeNull();
    patchRun(store.db, "run_oc", { outcomeKey: "oc_1" });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBe("oc_1");
    // Clearing is expressible too (null is a value, not "leave alone").
    patchRun(store.db, "run_oc", { outcomeKey: null });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBeNull();
    // An omitted key leaves the column untouched (the `undefined` skip).
    patchRun(store.db, "run_oc", { outcomeKey: "oc_2" });
    patchRun(store.db, "run_oc", { phase: "working" });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBe("oc_2");
  });
});

describe("finalizeOrphanedRuns (F-RUN1)", () => {
  it("flips a running run to error with interrupted_by=restart", () => {
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

  it("re-invokes the operator for an orphan under the crash-loop cap", () => {
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
    // SAFETY: `SELECT COUNT(*) AS n` always returns exactly one row whose only
    // column is that integer, so `get` cannot come back undefined here.
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
      agentProfileId: "developer",
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
      (e) => e.details?.runId === runId,
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

  it("consumes a persisted staged report_outcome envelope on recovery (AO-1)", async () => {
    seedDroppedReplyRun("run_staged");
    // Simulate a run whose completion was registered (outcome_key persisted to
    // the row) and whose report_outcome envelope was staged — then the process
    // died before the callback fired. Pre-fix, recovery had no key and the
    // staged row was orphaned (verdict fell back to the prose regex).
    store.db
      .prepare(`UPDATE agent_runs SET outcome_key = 'oc_staged' WHERE id = 'run_staged'`)
      .run();
    store.db
      .prepare(
        `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at)
         VALUES ('oc_staged', '{"kind":"report"}', ?)`,
      )
      .run(new Date().toISOString());

    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.recovered).toBe(1);
    // The staged envelope was TAKEN by its key (consumed once) — proof the
    // recovery path reached it via the persisted outcome_key.
    // SAFETY: as above — a COUNT(*) row always exists and carries `n`.
    const remaining = store.db
      .prepare(`SELECT COUNT(*) AS n FROM staged_outcomes WHERE outcome_key = 'oc_staged'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
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
        (e) => e.details?.runId === "run_loop",
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
      agentProfileId: "developer",
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

// ------------------------------------ P14-RT-08: a stranded codex operator plan

describe("recoverStrandedOperatorPlans (P14-RT-08)", () => {
  /**
   * A Codex operator coordinates AFTER its provider run finishes: the completion
   * callback parses the structured plan and executes it. A restart in that
   * window lost the whole turn with no trace — the finished operator row is
   * outside `finalizeOrphanedRuns` (running/queued only) and outside
   * `recoverUnreactedAgentRuns` (primary/reviewer only).
   */
  function deployCodexOperator(): void {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: [{ capabilityId: "append-typed-events", mode: "direct" }],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
  }

  /** A finished codex operator run holding a valid plan its process never ran. */
  function seedStrandedPlan(id: string, waiting: "agent" | "human" = "agent"): void {
    deployCodexOperator();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting }),
      goal: "Coordinate the implementation.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun(id, {
      backend: "codex",
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
        tag: "agent_message",
        text: JSON.stringify({
          reasoning: "",
          actions: [
            {
              tool: "post_comment",
              profileId: null,
              delivers: null,
              toStageId: null,
              packetType: null,
              text: "Implementation looks complete — moving to review next.",
              reason: null,
              packetOptions: null,
            },
          ],
        }),
      },
    });
  }

  const timeline = () =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;

  it("executes the plan the restart dropped and marks the turn taken", async () => {
    seedStrandedPlan("run_stranded");

    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });

    expect(res.recovered).toBe(1);
    expect(
      timeline().some((e) =>
        e.text.includes("Implementation looks complete"),
      ),
    ).toBe(true);
    expect(
      listAuditEvents(store.db, { action: "runtime.operator.plan_executed" }),
    ).toHaveLength(1);
  });

  it("is idempotent — a turn already taken up is never re-executed", async () => {
    seedStrandedPlan("run_stranded");
    await recoverStrandedOperatorPlans(store.db, { dataRoot: store.dataRoot });

    const second = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(second.recovered).toBe(0);
    // The comment landed exactly once — re-running a plan would duplicate every
    // governed action it contains.
    expect(
      timeline().filter((e) => e.text.includes("Implementation looks complete")),
    ).toHaveLength(1);
  });

  it("leaves a task that is no longer waiting on an agent alone", async () => {
    seedStrandedPlan("run_settled", "human");
    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(res.recovered).toBe(0);
  });

  it("reports an OLD stranded plan instead of re-deciding it", async () => {
    seedStrandedPlan("run_old");
    // A boot hours later is not recovering a dropped turn: the plan named a
    // stage and a profile for a task state that has since moved on.
    store.db
      .prepare(`UPDATE agent_runs SET finished_at = ? WHERE id = 'run_old'`)
      .run(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());

    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(res).toEqual({ recovered: 0, stale: 1 });
    expect(
      timeline().some((e) => e.text.includes("Implementation looks complete")),
    ).toBe(false);
  });
});
