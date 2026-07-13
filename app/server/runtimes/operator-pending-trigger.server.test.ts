import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteProject, setProjectArchived } from "~/features/project-settings/settings-actions.server";
import { projectDir } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { purgeProjectOperationalState } from "~/server/projects/project-operational-state.server";
import { recoverUnreactedAgentRuns } from "./run-recovery.server";
import type { RunCallbacks, RunExit, RunHandle, RunSpec, RuntimeAdapter } from "./adapter.server";
import {
  drainAutoOperatorQueue,
  recoverAutoOperatorQueue,
  resetOperatorDispatchForTests,
} from "./operator-dispatch.server";
import { recoverUnappliedOperatorEffects } from "./operator-effect-recovery.server";
import {
  configureScriptedOperatorHookForTests,
  drainPendingOperatorTriggers,
  resetOperatorLeasesForTests,
  runOperator,
} from "./operator-run.server";
import { configureRunServiceForTests, startRun } from "./run-service.server";
import { setBackendAvailability, type AdapterSet } from "./runtime-registry.server";
import { defaultModelFor } from "./model-catalog.server";
import { getRun, upsertRun } from "./run-store.server";
import {
  allowProjectCompletionEffects,
  readRunCompletionPhase,
  revokeProjectCompletionEffects,
  RUN_COMPLETION_PHASE,
} from "./run-completion-state.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";

interface HeldRun {
  spec: RunSpec;
  callbacks: RunCallbacks;
}

class HeldClaudeAdapter implements RuntimeAdapter {
  readonly backend = "claude" as const;
  readonly starts: HeldRun[] = [];
  readonly pending: HeldRun[] = [];
  readonly interrupted: string[] = [];
  onStart: ((spec: RunSpec) => void) | null = null;

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    const run = { spec, callbacks };
    this.starts.push(run);
    this.pending.push(run);
    this.onStart?.(spec);
    return {
      runId: spec.runId,
      interrupt: () => {
        this.interrupted.push(spec.runId);
        // Lifecycle teardown waits for the provider's exit acknowledgement.
        // Keep the held entry so a test can still deliver a duplicate late
        // exit and prove its detached callback is inert.
        queueMicrotask(() =>
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: "claude",
            simulated: false,
            sessionId: `pending-trigger-${spec.runId}`,
          }),
        );
      },
    };
  }

  finishOne(outcome: RunExit["outcome"] = "finished"): void {
    const run = this.pending.shift();
    if (!run) throw new Error("No held Claude run.");
    run.callbacks.onExit({
      outcome,
      effectiveBackend: "claude",
      simulated: false,
      sessionId: `pending-trigger-${run.spec.runId}`,
    });
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 500; i += 1) {
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

describe("durable coalesced operator triggers", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let adapter: HeldClaudeAdapter;

  const adaptersFor = (next: HeldClaudeAdapter): AdapterSet => ({
    claude: next,
    codex: next,
    simulated: next,
  });

  const pendingRows = () =>
    store.db
      .prepare(
        `SELECT coalescing_key, trigger, backend, autonomy, react_depth,
                human_comment, source_run_id, actor_json, data_root
           FROM operator_pending_triggers
          WHERE project_slug = ? AND task_key = 'VIB-1'
          ORDER BY sequence ASC`,
      )
      .all(store.slug) as Array<Record<string, unknown>>;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
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
            model: defaultModelFor("claude"),
          },
        },
      ] as never,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Durable pending operator trigger",
        stage: "impl",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
      }),
      goal: "Prove every non-substitutable operator trigger survives a process restart.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    adapter = new HeldClaudeAdapter();
    configureRunServiceForTests(adaptersFor(adapter));
    setBackendAvailability("claude", true);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
  });

  afterEach(() => {
    configureRunServiceForTests();
    configureScriptedOperatorHookForTests(null);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
    ctx.cleanup();
  });

  async function startBlocker(): Promise<void> {
    const started = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude",
      autonomy: "full",
      trigger: "manual",
      humanComment: "block the task lease",
      dataRoot: store.dataRoot,
    });
    expect(started.disposition).toBe("started");
    expect(adapter.starts).toHaveLength(1);
  }

  /** Mirrors boot priority: interrupt orphaned runs without dispatching, then
   * reconcile ambiguous operator effects and specialist completions, then
   * drain explicit pending triggers before automatic work. */
  async function restartAndRecover(): Promise<HeldClaudeAdapter> {
    const replacement = new HeldClaudeAdapter();
    configureRunServiceForTests(adaptersFor(replacement));
    setBackendAvailability("claude", true);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
    recoverAutoOperatorQueue(store.db, store.dataRoot, { deferDrain: true });
    await recoverUnappliedOperatorEffects(store.db, store.dataRoot);
    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    await drainPendingOperatorTriggers(store.db, { dataRoot: store.dataRoot });
    await drainAutoOperatorQueue(store.db, store.dataRoot);
    return replacement;
  }

  it("survives restart with the newest manual instruction and its complete context", async () => {
    await startBlocker();
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude",
      autonomy: "supervised",
      trigger: "manual",
      reactDepth: 2,
      humanComment: "older @operator instruction",
      actor: { userId: store.users.arda.id, label: "older actor" },
      dataRoot: store.dataRoot,
    });
    const newestActor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
      auditAuthoritySource: "org_admin_override" as const,
    };
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude",
      autonomy: "full",
      trigger: "manual",
      reactDepth: 7,
      humanComment: "newest @operator instruction",
      actor: newestActor,
      dataRoot: store.dataRoot,
    });

    expect(pendingRows()).toEqual([
      expect.objectContaining({
        coalescing_key: "ordinary",
        trigger: "manual",
        backend: "claude",
        autonomy: "full",
        react_depth: 7,
        human_comment: "newest @operator instruction",
        source_run_id: null,
        data_root: store.dataRoot,
        actor_json: JSON.stringify(newestActor),
      }),
    ]);

    const replacement = await restartAndRecover();
    expect(replacement.starts).toHaveLength(1);
    expect(replacement.starts[0]!.spec.prompt).toContain("newest @operator instruction");
    expect(replacement.starts[0]!.spec.prompt).not.toContain("older @operator instruction");
    expect(pendingRows()).toHaveLength(0);
  });

  for (const order of ["human-first", "source-first"] as const) {
    it(`preserves human and source-reaction slots when they arrive ${order}`, async () => {
      await startBlocker();
      const human = () =>
        runOperator(store.db, {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude" as const,
          autonomy: "full" as const,
          trigger: "manual" as const,
          humanComment: "do not drop this human instruction",
          dataRoot: store.dataRoot,
        });
      const source = () =>
        runOperator(store.db, {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude" as const,
          autonomy: "full" as const,
          trigger: "agent-reply" as const,
          reactDepth: 3,
          completionSourceRunId: "run_specialist_reply",
          dataRoot: store.dataRoot,
        });
      if (order === "human-first") {
        await human();
        await source();
      } else {
        await source();
        await human();
      }

      expect(new Set(pendingRows().map((row) => row.coalescing_key))).toEqual(
        new Set(["ordinary", "source:run_specialist_reply"]),
      );
      const replacement = await restartAndRecover();
      expect(replacement.starts).toHaveLength(1);
      replacement.finishOne();
      await eventually(() => expect(replacement.starts).toHaveLength(2));
      await eventually(() => expect(pendingRows()).toHaveLength(0));

      expect(replacement.starts.some((run) => run.spec.prompt.includes("do not drop this human instruction"))).toBe(
        true,
      );
      const sourceRun = store.db
        .prepare(
          `SELECT id FROM agent_runs
            WHERE kind = 'operator' AND completion_source_run_id = 'run_specialist_reply'`,
        )
        .all() as Array<{ id: string }>;
      expect(sourceRun).toHaveLength(1);
      expect(replacement.starts.map((run) => run.spec.runId)).toContain(sourceRun[0]!.id);
      replacement.finishOne();
    });
  }

  it("does not acknowledge a queued source whose existing reaction still has pending effects", async () => {
    await startBlocker();
    const taskIncarnation = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.createdAt;
    if (!taskIncarnation) throw new Error("Seed task has no incarnation.");
    upsertRun(store.db, {
      id: "run_pending_effect_source",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "source-pending-effect",
      role: "Specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: defaultModelFor("claude"),
      sdk: "test",
      taskIncarnation,
      completionPhase: RUN_COMPLETION_PHASE.verdict,
      state: "finished",
    });
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "agent-reply",
      completionSourceRunId: "run_pending_effect_source",
      expectedTaskIncarnation: taskIncarnation,
      dataRoot: store.dataRoot,
    });
    expect(pendingRows()).toHaveLength(1);

    // Model an earlier process having reserved this source reaction and then
    // failed both its governed effect and recovery write before this mailbox
    // generation drains.
    upsertRun(store.db, {
      id: "run_pending_effect_operator",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "operator-pending-effect",
      role: "Operator",
      kind: "operator",
      backend: "claude",
      simulated: false,
      model: defaultModelFor("claude"),
      sdk: "test",
      taskIncarnation,
      completionSourceRunId: "run_pending_effect_source",
      operatorEffectState: "pending",
      state: "error",
    });

    adapter.finishOne();
    await eventually(() => expect(pendingRows()).toHaveLength(0));
    expect(readRunCompletionPhase(store.db, "run_pending_effect_source")).toBe(
      RUN_COMPLETION_PHASE.verdict,
    );
  });

  it("wakes a DB-inflight coalesced trigger when the provider exits during callback attachment", async () => {
    await startBlocker();
    // Model a process-local lease loss while the durable provider row remains
    // running. The queued microtask exits that provider at the await boundary
    // used to load completion wiring in the DB-inflight coalesce path.
    resetOperatorLeasesForTests();
    queueMicrotask(() => adapter.finishOne());

    const coalesced = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      humanComment: "must wake even if completion wins callback attachment",
      dataRoot: store.dataRoot,
    });
    expect(coalesced.disposition).toBe("coalesced");

    await eventually(() => {
      expect(pendingRows()).toHaveLength(0);
      expect(adapter.starts).toHaveLength(2);
    });
    expect(adapter.starts[1]!.spec.prompt).toContain(
      "must wake even if completion wins callback attachment",
    );
  });

  it("drops a stale pending incarnation instead of coordinating a same-key replacement", async () => {
    await startBlocker();
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      humanComment: "belongs only to the deleted task incarnation",
      dataRoot: store.dataRoot,
    });
    expect(pendingRows()).toHaveLength(1);

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Replacement lifecycle",
        stage: "impl",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T12:00:00.000Z",
      }),
      goal: "This is a distinct replacement task.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const replacement = await restartAndRecover();
    expect(replacement.starts).toHaveLength(0);
    expect(pendingRows()).toHaveLength(0);
  });

  it("rejects a caller's stale incarnation token before acquiring a replacement task lease", async () => {
    const originalIncarnation = "2026-07-01T09:00:00.000Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Replacement before admission",
        stage: "impl",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        createdAt: "2026-07-13T12:30:00.000Z",
        updatedAt: "2026-07-13T12:30:00.000Z",
      }),
      goal: "This replacement must reject intent captured for the old task.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await expect(
      runOperator(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        expectedTaskIncarnation: originalIncarnation,
        trigger: "manual",
        dataRoot: store.dataRoot,
      }),
    ).rejects.toThrow(/changed before admission/);
    expect(adapter.starts).toHaveLength(0);
    expect(pendingRows()).toHaveLength(0);
  });

  it("revokes only the direct operator run when delete/recreate wins inside provider launch", async () => {
    const originalProject = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed;
    let losingRunId: string | null = null;
    let replacementStart: ReturnType<typeof startRun> | null = null;
    adapter.onStart = (spec) => {
      adapter.onStart = null;
      losingRunId = spec.runId;
      // Model the synchronous delete admission/purge boundary inside
      // adapter.start(). The public delete waits for admitted completion
      // effects, so invoking it without awaiting from this synchronous seam
      // would recreate the slug before teardown had actually completed.
      revokeProjectCompletionEffects(store.db, store.slug);
      purgeProjectOperationalState(store.db, store.slug, store.dataRoot);
      rmSync(projectDir(store.slug, store.dataRoot), {
        recursive: true,
        force: true,
      });
      writeProject(store.dataRoot, originalProject.frontmatter, originalProject.description);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          title: "Same-key replacement",
          stage: "impl",
          readiness: "ready",
          waiting: "none",
          ownerUserId: store.users.arda.id,
          createdAt: "2026-07-13T13:00:00.000Z",
          updatedAt: "2026-07-13T13:00:00.000Z",
        }),
        goal: "Keep this replacement run isolated from the deleted lifecycle.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      allowProjectCompletionEffects(store.db, store.slug);
      replacementStart = startRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: "replacement-primary",
        role: "Replacement specialist",
        kind: "primary",
        backend: "claude",
        model: defaultModelFor("claude"),
        prompt: "Run only for the replacement task.",
        dataRoot: store.dataRoot,
      });
    };

    await expect(
      runOperator(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        trigger: "manual",
        dataRoot: store.dataRoot,
      }),
    ).rejects.toThrow(/changed during launch/);
    const replacementPromise = replacementStart as ReturnType<typeof startRun> | null;
    if (!losingRunId || !replacementPromise) throw new Error("Direct launch race did not execute.");
    const replacement = await replacementPromise;

    expect(getRun(store.db, losingRunId)).toBeNull();
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    expect(adapter.interrupted).toEqual([losingRunId]);
  });

  it("wakes a different source slot queued during a scripted drain and acknowledges its source live", async () => {
    await startBlocker();
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude",
      trigger: "manual",
      humanComment: "scripted ordinary slot",
      dataRoot: store.dataRoot,
    });
    upsertRun(store.db, {
      id: "run_scripted_source",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "source-specialist",
      role: "Specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: defaultModelFor("claude"),
      sdk: "test",
      taskIncarnation: "2026-07-01T09:00:00.000Z",
      completionPhase: RUN_COMPLETION_PHASE.verdict,
      state: "finished",
    });

    configureRunServiceForTests();
    resetOperatorLeasesForTests();
    recoverAutoOperatorQueue(store.db, store.dataRoot, { deferDrain: true });
    configureScriptedOperatorHookForTests(async () => {
      configureScriptedOperatorHookForTests(null);
      await runOperator(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        trigger: "agent-reply",
        completionSourceRunId: "run_scripted_source",
        dataRoot: store.dataRoot,
      });
    });

    await drainPendingOperatorTriggers(store.db, { dataRoot: store.dataRoot });
    await eventually(() => expect(pendingRows()).toHaveLength(0));
    await eventually(() =>
      expect(readRunCompletionPhase(store.db, "run_scripted_source")).toBe(RUN_COMPLETION_PHASE.complete),
    );
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM agent_runs
            WHERE kind = 'operator' AND completion_source_run_id = 'run_scripted_source'`,
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("purges every pending slot on archive so restore/restart cannot revive it", async () => {
    await startBlocker();
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      humanComment: "stale after archive",
      dataRoot: store.dataRoot,
    });
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "agent-reply",
      completionSourceRunId: "run_archive_source",
      dataRoot: store.dataRoot,
    });
    expect(pendingRows()).toHaveLength(2);

    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(pendingRows()).toHaveLength(0);
    const replacement = await restartAndRecover();
    expect(replacement.starts).toHaveLength(0);
  });

  it("purges every pending slot on delete so a same-slug lifecycle cannot inherit it", async () => {
    await startBlocker();
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      humanComment: "stale after delete",
      dataRoot: store.dataRoot,
    });
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "agent-reply",
      completionSourceRunId: "run_delete_source",
      dataRoot: store.dataRoot,
    });
    expect(pendingRows()).toHaveLength(2);

    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: "Viberr Core" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM operator_pending_triggers WHERE project_slug = ?`)
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);
    const replacement = await restartAndRecover();
    expect(replacement.starts).toHaveLength(0);
  });
});
