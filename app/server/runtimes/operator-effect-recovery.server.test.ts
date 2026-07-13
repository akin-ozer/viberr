import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { upsertRun } from "./run-store.server";
import { recoverUnappliedOperatorEffects } from "./operator-effect-recovery.server";
import { openSystemRecovery } from "~/server/tasks/task-recovery.server";
import {
  allowProjectCompletionEffects,
  completeProjectRunEffects,
  revokeProjectCompletionEffects,
  waitForProjectCompletionEffects,
} from "./run-completion-state.server";

describe("operator terminal-effect boot recovery", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        ownerUserId: store.users.arda.id,
        readiness: "ready",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => ctx.cleanup());

  function seedPending(input: {
    id: string;
    state: "finished" | "error" | "interrupted";
    source?: string;
    effect?: "pending" | "applied" | "recovery";
  }): void {
    upsertRun(store.db, {
      id: input.id,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: `op-${input.id}`,
      role: "Operator",
      kind: "operator",
      backend: "codex",
      simulated: false,
      model: "gpt-5.4",
      sdk: "Codex SDK",
      state: input.state,
      completionSourceRunId: input.source ?? null,
      operatorEffectState: input.effect ?? "pending",
      taskIncarnation: readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.createdAt,
    });
  }

  it("surfaces an ambiguous finished plan once instead of replaying it", async () => {
    seedPending({ id: "run_unconfirmed", state: "finished" });

    expect(await recoverUnappliedOperatorEffects(store.db, store.dataRoot)).toEqual({
      recovered: 1,
      skippedMissing: 0,
    });
    expect(
      store.db
        .prepare(`SELECT operator_effect_state FROM agent_runs WHERE id = ?`)
        .get("run_unconfirmed"),
    ).toEqual({ operator_effect_state: "recovery" });
    const first = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(first.packet?.from).toBe("system:runtime-recovery");
    expect(first.timeline[0]?.actor).toMatchObject({
      kind: "system",
      systemId:
        "runtime-recovery-operator-effect-unconfirmed-run-unconfirmed",
    });

    expect(await recoverUnappliedOperatorEffects(store.db, store.dataRoot)).toEqual({
      recovered: 0,
      skippedMissing: 0,
    });
    const second = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(second.timeline).toHaveLength(first.timeline.length);
  });

  it("turns an interrupted source reservation into a durable human boundary", async () => {
    seedPending({
      id: "run_reserved",
      state: "interrupted",
      source: "run_specialist",
    });

    await recoverUnappliedOperatorEffects(store.db, store.dataRoot);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.timeline[0]?.actor).toMatchObject({
      kind: "system",
      systemId:
        "runtime-recovery-operator-reaction-interrupted-run-reserved",
    });
  });

  it("ignores operator effects already applied", async () => {
    seedPending({ id: "run_applied", state: "finished", effect: "applied" });
    expect(await recoverUnappliedOperatorEffects(store.db, store.dataRoot)).toEqual({
      recovered: 0,
      skippedMissing: 0,
    });
  });

  it("does not surface an archived operator callback after the project is restored", async () => {
    seedPending({ id: "run_archived", state: "interrupted" });
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;

    // Archive cleanup deliberately abandons every still-pending callback.
    // Restoring ownership must not turn that deliberate cancellation into an
    // ambiguous-crash packet on the next recovery pass.
    expect(completeProjectRunEffects(store.db, store.slug)).toBe(1);
    allowProjectCompletionEffects(store.db, store.slug);

    expect(await recoverUnappliedOperatorEffects(store.db, store.dataRoot)).toEqual({
      recovered: 0,
      skippedMissing: 0,
    });
    expect(
      store.db
        .prepare(`SELECT operator_effect_state FROM agent_runs WHERE id = ?`)
        .get("run_archived"),
    ).toEqual({ operator_effect_state: "recovery" });
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(after.packet).toEqual(before.packet);
    expect(after.timeline).toEqual(before.timeline);
  });

  it("makes archive drain wait for an already-entered operator recovery write", async () => {
    seedPending({ id: "run_operator_race", state: "finished" });
    let entered!: () => void;
    let release!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mayWrite = new Promise<void>((resolve) => {
      release = resolve;
    });

    const recovery = recoverUnappliedOperatorEffects(
      store.db,
      store.dataRoot,
      {
        openRecovery: async (...args) => {
          entered();
          await mayWrite;
          return openSystemRecovery(...args);
        },
      },
    );
    await didEnter;

    revokeProjectCompletionEffects(store.db, store.slug);
    let drained = false;
    const drain = waitForProjectCompletionEffects(store.db, store.slug).then(
      () => {
        drained = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);

    release();
    await drain;
    completeProjectRunEffects(store.db, store.slug);
    expect(await recovery).toEqual({ recovered: 1, skippedMissing: 0 });
    expect(
      store.db
        .prepare(`SELECT operator_effect_state FROM agent_runs WHERE id = ?`)
        .get("run_operator_race"),
    ).toEqual({ operator_effect_state: "recovery" });
  });

  it("cannot open an old recovery packet on a same-key replacement task", async () => {
    seedPending({ id: "run_replaced", state: "finished" });

    expect(
      await recoverUnappliedOperatorEffects(store.db, store.dataRoot, {
        openRecovery: async (...args) => {
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-1", {
              ownerUserId: store.users.arda.id,
              readiness: "ready",
              createdAt: "2026-07-02T09:00:00.000Z",
            }),
          });
          rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
          return openSystemRecovery(...args);
        },
      }),
    ).toEqual({ recovered: 0, skippedMissing: 0 });

    const replacement = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacement.frontmatter.createdAt).toBe(
      "2026-07-02T09:00:00.000Z",
    );
    expect(replacement.packet).toBeNull();
    expect(replacement.timeline).toEqual([]);
    expect(
      store.db
        .prepare(`SELECT operator_effect_state FROM agent_runs WHERE id = ?`)
        .get("run_replaced"),
    ).toEqual({ operator_effect_state: "pending" });
  });
});
