import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunCallbacks,
  RunExit,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { configureRunServiceForTests, startRun } from "./run-service.server";
import { setBackendAvailability, type AdapterSet } from "./runtime-registry.server";
import {
  drainAutoOperatorQueue,
  enqueueAutoOperator,
  getOperatorDispatchStatus,
  recoverAutoOperatorQueue,
  resetOperatorDispatchForTests,
} from "./operator-dispatch.server";
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
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTask } from "~/server/tasks/task-actions.server";
import {
  configureOperatorRecoveryWriterForTests,
  resetOperatorLeasesForTests,
  runOperator,
} from "./operator-run.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { getRun, upsertRun } from "./run-store.server";
import { setProjectArchived } from "~/features/project-settings/settings-actions.server";
import { purgeProjectOperationalState } from "~/server/projects/project-operational-state.server";

class HeldAdapter implements RuntimeAdapter {
  readonly backend = "claude" as const;
  pending: Array<{ spec: RunSpec; callbacks: RunCallbacks }> = [];
  interrupted: string[] = [];
  onStart: ((spec: RunSpec) => void) | null = null;

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.pending.push({ spec, callbacks });
    this.onStart?.(spec);
    return {
      runId: spec.runId,
      interrupt: () => {
        this.interrupted.push(spec.runId);
        // Archive/delete waits for provider termination. Retain the pending
        // entry so finishOne() can also exercise an inert duplicate late exit.
        queueMicrotask(() =>
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: "claude",
            simulated: false,
            sessionId: `held-${spec.runId}`,
          }),
        );
      },
    };
  }

  finishOne(outcome: RunExit["outcome"] = "finished"): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No held operator run.");
    pending.callbacks.onExit({
      outcome,
      effectiveBackend: "claude",
      simulated: false,
      sessionId: `held-${pending.spec.runId}`,
    });
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 1_000; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw last;
}

describe("bounded automatic operator dispatch", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let adapter: HeldAdapter;

  const rawDispatch = (taskKey: string) =>
    store.db
      .prepare(
        `SELECT id, state, run_id, next_attempt_at
           FROM operator_dispatches
          WHERE project_slug = ? AND task_key = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(store.slug, taskKey) as
      | {
          id: string;
          state: string;
          run_id: string | null;
          next_attempt_at: string | null;
        }
      | undefined;

  const seedTask = (taskKey: string) => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(taskKey, {
        title: `Lifecycle ${taskKey}`,
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
      }),
      goal: `Exercise the durable automatic operator lifecycle for ${taskKey}.`,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  };

  const insertDispatch = (taskKey: string, state: "queued" | "claiming" | "running", runId: string | null = null) => {
    const id = `opd_${taskKey.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const now = new Date().toISOString();
    const taskIncarnation =
      readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })?.parsed.frontmatter.createdAt ??
      "missing-task-incarnation";
    store.db
      .prepare(
        `INSERT INTO operator_dispatches
          (id, project_slug, task_key, task_incarnation, trigger, state, run_id,
           estimated_cost_usd, created_at, started_at, finished_at,
           next_attempt_at)
         VALUES (?, ?, ?, ?, 'create', ?, ?, 0.05, ?, ?, NULL, NULL)`,
      )
      .run(id, store.slug, taskKey, taskIncarnation, state, runId, now, state === "queued" ? null : now);
    return id;
  };

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    adapter = new HeldAdapter();
    const adapters: AdapterSet = {
      claude: adapter,
      codex: adapter,
      simulated: adapter,
    };
    configureRunServiceForTests(adapters);
    setBackendAvailability("claude", true);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
  });

  afterEach(async () => {
    while (adapter.pending.length > 0) adapter.finishOne();
    await new Promise((resolve) => setTimeout(resolve, 5));
    configureOperatorRecoveryWriterForTests(null);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
    delete process.env.VIBERR_OPERATOR_AUTO_CONCURRENCY;
    delete process.env.VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD;
    delete process.env.VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD;
    ctx.cleanup();
  });

  it("queues a burst, runs at most two, then drains after completion", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await createTask(
        store.db,
        {
          projectSlug: store.slug,
          title: `Bounded assessment ${i}`,
          goal: `Implement the explicit bounded routing behavior ${i} and verify it with a focused test.`,
        },
        { userId: store.users.arda.id, label: store.users.arda.email },
        { dataRoot: store.dataRoot },
      );
      keys.push(created.key);
      expect(created.operatorTrigger).toBe("queued");
    }

    await eventually(() => expect(adapter.pending).toHaveLength(2));
    expect(
      keys.map(
        (key) =>
          getOperatorDispatchStatus(store.db, store.slug, key, store.dataRoot)
            ?.state,
      ),
    ).toEqual([
      "running",
      "running",
      "queued",
    ]);
    expect(listAuditEvents(store.db, { action: "task.operator.auto_queued" })).toHaveLength(3);

    adapter.finishOne();
    await eventually(() => {
      expect(adapter.pending).toHaveLength(2);
      expect(
        getOperatorDispatchStatus(
          store.db,
          store.slug,
          keys[2]!,
          store.dataRoot,
        )?.state,
      ).toBe("running");
    });
    expect(
      getOperatorDispatchStatus(
        store.db,
        store.slug,
        keys[0]!,
        store.dataRoot,
      )?.state,
    ).toBe("finished");
    expect(
      getOperatorDispatchStatus(
        store.db,
        store.slug,
        keys[2]!,
        store.dataRoot,
      )?.state,
    ).toBe("running");
  });

  it("keeps an automatic dispatch queued behind a manual run and later owns a fresh run", async () => {
    const taskKey = "VIB-MANUAL";
    seedTask(taskKey);

    const manual = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      backend: "claude",
      trigger: "manual",
      dataRoot: store.dataRoot,
    });
    expect(manual.disposition).toBe("started");
    expect(adapter.pending).toHaveLength(1);

    const queued = enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "transition",
      dataRoot: store.dataRoot,
    });
    expect(queued.queued).toBe(true);
    await eventually(() => {
      expect(rawDispatch(taskKey)).toMatchObject({
        state: "queued",
        run_id: null,
      });
    });
    expect(rawDispatch(taskKey)?.run_id).not.toBe(manual.runId);
    expect(adapter.pending).toHaveLength(1);

    adapter.finishOne();
    // No process-local pending trigger fires at manual completion. The durable
    // scheduler owns the retry and the successor's admission accounting.
    expect(adapter.pending).toHaveLength(0);
    await eventually(() => {
      expect(adapter.pending).toHaveLength(1);
      expect(rawDispatch(taskKey)?.state).toBe("running");
    });
    expect(rawDispatch(taskKey)?.run_id).not.toBe(manual.runId);
    expect(rawDispatch(taskKey)?.run_id).toBe(adapter.pending[0]!.spec.runId);
    adapter.finishOne();
    await eventually(() => expect(rawDispatch(taskKey)?.state).toBe("finished"));
  });

  it("uses a deduplicated enqueue as a wake-up for the existing durable row", async () => {
    const taskKey = "VIB-DEDUP";
    seedTask(taskKey);
    const dispatchId = insertDispatch(taskKey, "queued");

    const result = enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "transition",
      dataRoot: store.dataRoot,
    });
    expect(result).toEqual({ queued: false, dispatchId });
    await eventually(() => {
      expect(rawDispatch(taskKey)?.state).toBe("running");
      expect(adapter.pending).toHaveLength(1);
    });
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM operator_dispatches
              WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, taskKey) as { n: number }
      ).n,
    ).toBe(1);
  });

  it("wakes a budget-blocked dispatch when the rolling-hour cost expires", async () => {
    const taskKey = "VIB-BUDGET";
    seedTask(taskKey);
    process.env.VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD = "1";
    process.env.VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD = "0.05";

    upsertRun(store.db, {
      id: "run_recent_budget",
      projectSlug: store.slug,
      taskKey,
      threadId: "budget-history",
      role: "Operator",
      kind: "operator",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      state: "finished",
      finishedAt: new Date().toISOString(),
      totalCostUsd: 1,
    });
    // Leave roughly half a second in the rolling window so the real scheduler
    // timer can prove it wakes without another enqueue/completion/restart.
    store.db
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - (60 * 60 * 1_000 - 500)).toISOString(), "run_recent_budget");

    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    expect(rawDispatch(taskKey)).toMatchObject({ state: "queued" });
    expect(rawDispatch(taskKey)?.next_attempt_at).not.toBeNull();
    expect(adapter.pending).toHaveLength(0);

    await eventually(() => {
      expect(rawDispatch(taskKey)?.state).toBe("running");
      expect(adapter.pending).toHaveLength(1);
    });
  });

  it("recovers every dispatch crash window from its durable run handshake", () => {
    const seedLinkedRun = (
      taskKey: string,
      dispatchState: "claiming" | "running",
      runState: "running" | "finished" | "error",
      effectState: "pending" | "recovery" | "applied" | null,
      attachRunId: boolean,
    ) => {
      seedTask(taskKey);
      const runId = `run_${taskKey.toLowerCase()}`;
      const dispatchId = insertDispatch(
        taskKey,
        dispatchState,
        attachRunId ? runId : null,
      );
      const taskIncarnation = readTaskFile({
        projectSlug: store.slug,
        taskKey,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.createdAt;
      upsertRun(store.db, {
        id: runId,
        projectSlug: store.slug,
        taskKey,
        threadId: `op-${taskKey}`,
        role: "Operator",
        kind: "operator",
        backend: "claude",
        simulated: false,
        model: "sonnet",
        sdk: "test",
        taskIncarnation,
        operatorDispatchId: dispatchId,
        operatorEffectState: effectState,
        state: runState,
        ...(runState === "running"
          ? { startedAt: new Date().toISOString() }
          : { finishedAt: new Date().toISOString() }),
      });
      return { taskKey, dispatchId, runId };
    };

    const pending = seedLinkedRun(
      "VIB-RECOVER-PENDING",
      "claiming",
      "running",
      "pending",
      false,
    );
    const recovery = seedLinkedRun(
      "VIB-RECOVER-BOUNDARY",
      "running",
      "error",
      "recovery",
      true,
    );
    const appliedFinished = seedLinkedRun(
      "VIB-RECOVER-FINISHED",
      "running",
      "finished",
      "applied",
      true,
    );
    const appliedError = seedLinkedRun(
      "VIB-RECOVER-FAILED",
      "claiming",
      "error",
      "applied",
      false,
    );
    const legacy = seedLinkedRun(
      "VIB-RECOVER-LEGACY",
      "running",
      "running",
      null,
      true,
    );
    seedTask("VIB-RECOVER-PRELAUNCH");
    insertDispatch("VIB-RECOVER-PRELAUNCH", "claiming");

    recoverAutoOperatorQueue(store.db, store.dataRoot, { deferDrain: true });

    expect(rawDispatch(pending.taskKey)).toMatchObject({
      state: "cancelled",
      run_id: pending.runId,
    });
    expect(getRun(store.db, pending.runId)?.state).toBe("interrupted");
    expect(rawDispatch(recovery.taskKey)).toMatchObject({
      state: "cancelled",
      run_id: recovery.runId,
    });
    expect(getRun(store.db, recovery.runId)?.state).toBe("error");
    expect(rawDispatch(appliedFinished.taskKey)).toMatchObject({
      state: "finished",
      run_id: appliedFinished.runId,
    });
    expect(rawDispatch(appliedError.taskKey)).toMatchObject({
      state: "failed",
      run_id: appliedError.runId,
    });
    expect(rawDispatch(legacy.taskKey)).toMatchObject({
      state: "queued",
      run_id: null,
    });
    expect(getRun(store.db, legacy.runId)?.state).toBe("interrupted");
    expect(rawDispatch("VIB-RECOVER-PRELAUNCH")).toMatchObject({
      state: "queued",
      run_id: null,
    });
    expect(adapter.pending).toHaveLength(0);
  });

  it("fails the dispatch when provider and recovery effects cannot be applied", async () => {
    const taskKey = "VIB-EFFECT-FAIL";
    seedTask(taskKey);
    configureOperatorRecoveryWriterForTests(async () => {
      throw new Error("simulated recovery write failure");
    });

    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    await eventually(() => {
      expect(rawDispatch(taskKey)?.state).toBe("running");
      expect(adapter.pending).toHaveLength(1);
    });
    const runId = rawDispatch(taskKey)!.run_id!;

    adapter.finishOne("error");

    await eventually(() => expect(rawDispatch(taskKey)?.state).toBe("failed"));
    expect(getRun(store.db, runId)?.operator_effect_state).toBe("pending");
    expect(listAuditEvents(store.db, { action: "task.operator.auto_finished" })).toHaveLength(0);
  });

  it("terminalizes an orphaned operator run on boot and requeues a fresh owned run", async () => {
    const taskKey = "VIB-RESTART";
    seedTask(taskKey);
    upsertRun(store.db, {
      id: "run_restart_zombie",
      projectSlug: store.slug,
      taskKey,
      threadId: "op-zombie",
      role: "Operator",
      kind: "operator",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      state: "running",
      startedAt: new Date().toISOString(),
    });
    insertDispatch(taskKey, "running", "run_restart_zombie");

    recoverAutoOperatorQueue(store.db, store.dataRoot);
    await eventually(() => {
      expect(getRun(store.db, "run_restart_zombie")?.state).toBe("interrupted");
      expect(rawDispatch(taskKey)?.state).toBe("running");
      expect(rawDispatch(taskKey)?.run_id).not.toBe("run_restart_zombie");
      expect(adapter.pending).toHaveLength(1);
    });
    expect(rawDispatch(taskKey)?.run_id).toBe(adapter.pending[0]!.spec.runId);
  });

  it("cancels queued/running dispatches and leases on archive; late exits stay inert", async () => {
    process.env.VIBERR_OPERATOR_AUTO_CONCURRENCY = "1";
    const firstKey = "VIB-ARCHIVE-1";
    const secondKey = "VIB-ARCHIVE-2";
    seedTask(firstKey);
    seedTask(secondKey);
    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey: firstKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey: secondKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    await eventually(() => {
      expect(rawDispatch(firstKey)?.state).toBe("running");
      expect(rawDispatch(secondKey)?.state).toBe("queued");
      expect(adapter.pending).toHaveLength(1);
    });
    const activeRunId = rawDispatch(firstKey)!.run_id!;

    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(rawDispatch(firstKey)).toMatchObject({ state: "cancelled" });
    expect(rawDispatch(secondKey)).toMatchObject({ state: "cancelled" });
    expect(getRun(store.db, activeRunId)?.state).toBe("interrupted");

    // Simulate a provider exit arriving after archive teardown. The disposed
    // callback and conditional dispatch update must not rewrite cancellation or
    // emit a false automatic-finished audit.
    adapter.finishOne();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rawDispatch(firstKey)?.state).toBe("cancelled");
    expect(listAuditEvents(store.db, { action: "task.operator.auto_finished" })).toHaveLength(0);

    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: false },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const afterRestore = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: firstKey,
      backend: "claude",
      trigger: "manual",
      dataRoot: store.dataRoot,
    });
    expect(afterRestore.disposition).toBe("started");
    expect(adapter.pending).toHaveLength(1);
  });

  it("stops only the launched run when delete wins before dispatch ownership", async () => {
    const taskKey = "VIB-DELETE-RACE";
    seedTask(taskKey);
    let orphanRunId: string | null = null;
    let replacementStart: ReturnType<typeof startRun> | null = null;

    adapter.onStart = (spec) => {
      // Run lifecycle cleanup executes inside adapter.start(), before launch()
      // has registered this provider handle. Rebuild immediately to prove the
      // losing dispatcher cannot sweep a new project that reuses the slug.
      adapter.onStart = null;
      orphanRunId = spec.runId;
      purgeProjectOperationalState(store.db, store.slug, store.dataRoot);
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      replacementStart = startRun(store.db, {
        projectSlug: store.slug,
        taskKey,
        threadId: "replacement-after-delete",
        role: "Replacement",
        kind: "primary",
        backend: "claude",
        model: "sonnet",
        prompt: "Keep the recreated project's exact replacement run alive.",
        dataRoot: store.dataRoot,
      });
    };

    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });

    await eventually(() => {
      expect(orphanRunId).toBeTruthy();
      expect(replacementStart).not.toBeNull();
      expect(adapter.interrupted).toEqual([orphanRunId]);
    });
    const orphan = orphanRunId;
    // The assignment occurs inside the adapter callback, which TypeScript's
    // local control-flow analysis cannot observe across the eventual() await.
    const replacementPromise = replacementStart as ReturnType<typeof startRun> | null;
    if (!orphan || !replacementPromise) throw new Error("Launch race did not execute.");
    const replacement = await replacementPromise;

    expect(rawDispatch(taskKey)).toBeUndefined();
    expect(getRun(store.db, orphan)).toBeNull();
    expect(replacement.runId).not.toBe(orphan);
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    expect(adapter.interrupted).toEqual([orphan]);

    // A provider may still report a late exit after best-effort interrupt. Its
    // detached callback must remain inert and leave the replacement untouched.
    adapter.finishOne();
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    expect(adapter.pending[0]?.spec.runId).toBe(replacement.runId);
    expect(rawDispatch(taskKey)).toBeUndefined();
  });

  it("cancels a dispatch whose project/task target is no longer active", async () => {
    const dispatchId = insertDispatch("VIB-MISSING", "queued");
    await drainAutoOperatorQueue(store.db, store.dataRoot);
    expect(store.db.prepare(`SELECT state FROM operator_dispatches WHERE id = ?`).get(dispatchId)).toMatchObject({
      state: "cancelled",
    });
    expect(adapter.pending).toHaveLength(0);
  });

  it("cancels a queued dispatch instead of retargeting a same-key task replacement", async () => {
    const taskKey = "VIB-REPLACED";
    seedTask(taskKey);
    const dispatchId = insertDispatch(taskKey, "queued");
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(taskKey, {
        title: "Distinct replacement lifecycle",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        createdAt: "2026-07-13T16:00:00.000Z",
        updatedAt: "2026-07-13T16:00:00.000Z",
      }),
      goal: "Do not inherit an automatic trigger from the prior task.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await drainAutoOperatorQueue(store.db, store.dataRoot);

    expect(
      store.db
        .prepare(`SELECT state FROM operator_dispatches WHERE id = ?`)
        .get(dispatchId),
    ).toMatchObject({ state: "cancelled" });
    expect(adapter.pending).toHaveLength(0);
  });

  it("keeps automatic triggers and status isolated across same-key task incarnations", async () => {
    process.env.VIBERR_OPERATOR_AUTO_CONCURRENCY = "1";
    const taskKey = "VIB-REINCARNATED";
    seedTask(taskKey);
    const oldIncarnation = readTaskFile({
      projectSlug: store.slug,
      taskKey,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.createdAt;
    if (!oldIncarnation) throw new Error("Seed task has no incarnation.");
    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "create",
      expectedTaskIncarnation: oldIncarnation,
      dataRoot: store.dataRoot,
    });
    await eventually(() => {
      expect(rawDispatch(taskKey)?.state).toBe("running");
      expect(adapter.pending).toHaveLength(1);
    });

    const newIncarnation = "2026-07-13T18:00:00.000Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(taskKey, {
        title: "New lifecycle with the same key",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        createdAt: newIncarnation,
        updatedAt: newIncarnation,
      }),
      goal: "Only a trigger captured for this replacement may coordinate it.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect(
      enqueueAutoOperator(store.db, {
        projectSlug: store.slug,
        taskKey,
        trigger: "transition",
        expectedTaskIncarnation: oldIncarnation,
        dataRoot: store.dataRoot,
      }),
    ).toEqual({ queued: false, dispatchId: null });
    expect(
      enqueueAutoOperator(store.db, {
        projectSlug: store.slug,
        taskKey,
        trigger: "transition",
        expectedTaskIncarnation: newIncarnation,
        dataRoot: store.dataRoot,
      }).queued,
    ).toBe(true);

    // The old provider exits after replacement. Its callback cancels only its
    // stale dispatch; capacity then launches the replacement's own row.
    adapter.finishOne();
    await eventually(() => {
      const rows = store.db
        .prepare(
          `SELECT task_incarnation, state, run_id
             FROM operator_dispatches
            WHERE project_slug = ? AND task_key = ?`,
        )
        .all(store.slug, taskKey) as Array<{
        task_incarnation: string;
        state: string;
        run_id: string | null;
      }>;
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            task_incarnation: oldIncarnation,
            state: "cancelled",
          }),
          expect.objectContaining({
            task_incarnation: newIncarnation,
            state: "running",
          }),
        ]),
      );
      expect(adapter.pending).toHaveLength(1);
    });
    expect(
      getOperatorDispatchStatus(
        store.db,
        store.slug,
        taskKey,
        store.dataRoot,
      ),
    ).toMatchObject({ state: "running", trigger: "transition" });
    expect(listAuditEvents(store.db, { action: "task.operator.auto_queued" })).toHaveLength(2);
  });

  it("finishes an instant scripted run even when it exits before callback attachment", async () => {
    const taskKey = "VIB-INSTANT";
    seedTask(taskKey);
    configureRunServiceForTests();
    setBackendAvailability("claude", false);

    enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey,
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    await eventually(() => expect(rawDispatch(taskKey)?.state).toBe("finished"));
    expect(rawDispatch(taskKey)?.run_id).toBeTruthy();
    expect(listAuditEvents(store.db, { action: "task.operator.auto_finished" })).toHaveLength(1);
  });

  it("does not spend an operator turn for the placeholder goal", async () => {
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Needs concrete intent" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(created.operatorTrigger).toBe("awaiting_input");
    expect(adapter.pending).toHaveLength(0);
    expect(
      getOperatorDispatchStatus(
        store.db,
        store.slug,
        created.key,
        store.dataRoot,
      ),
    ).toBeNull();
  });
});
