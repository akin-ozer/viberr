import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  setupTestStore,
  type TestStore,
} from "../../../test-support/test-store";
import { upsertRun } from "./run-store.server";
import {
  advanceRunCompletionPhase,
  completeProjectRunEffects,
  persistRunCompletionContext,
  readRunCompletionContext,
  readRunCompletionPhase,
  RUN_COMPLETION_PHASE,
  waitForProjectCompletionEffects,
  withProjectCompletionEffect,
} from "./run-completion-state.server";

describe("durable specialist-completion state", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    upsertRun(store.db, {
      id: "run_completion",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "Developer",
      kind: "primary",
      backend: "codex",
      simulated: false,
      model: "gpt-5.4",
      sdk: "Codex SDK",
      state: "finished",
    });
  });

  afterEach(() => ctx.cleanup());

  it("persists the first exact authority/workspace snapshot", () => {
    persistRunCompletionContext(store.db, "run_completion", {
      workdir: "/first/worktree",
      delivery: {
        canBranch: true,
        canCommitPush: false,
        canOpenPr: false,
      },
      agentHandle: "developer",
      operatorRun: {
        backend: "codex",
        autonomy: "supervised",
        reactDepth: 2,
      },
      launchAuthorization: null,
    });
    persistRunCompletionContext(store.db, "run_completion", {
      workdir: "/later/escalated-worktree",
      delivery: {
        canBranch: true,
        canCommitPush: true,
        canOpenPr: true,
      },
      agentHandle: "other",
      operatorRun: null,
      launchAuthorization: null,
    });

    expect(readRunCompletionContext(store.db, "run_completion")).toEqual({
      workdir: "/first/worktree",
      delivery: {
        canBranch: true,
        canCommitPush: false,
        canOpenPr: false,
      },
      agentHandle: "developer",
      operatorRun: {
        backend: "codex",
        autonomy: "supervised",
        reactDepth: 2,
      },
      launchAuthorization: null,
    });
  });

  it("advances checkpoints monotonically and abandons old project ownership", () => {
    advanceRunCompletionPhase(
      store.db,
      "run_completion",
      RUN_COMPLETION_PHASE.verdict,
    );
    advanceRunCompletionPhase(
      store.db,
      "run_completion",
      RUN_COMPLETION_PHASE.reply,
    );
    expect(readRunCompletionPhase(store.db, "run_completion")).toBe(
      RUN_COMPLETION_PHASE.verdict,
    );

    expect(completeProjectRunEffects(store.db, store.slug)).toBe(1);
    expect(readRunCompletionPhase(store.db, "run_completion")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("drains a completion that already entered a project mutation boundary", async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = withProjectCompletionEffect(store.db, store.slug, async () => {
      entered();
      await gate;
    });
    await enteredPromise;

    let drained = false;
    const drain = waitForProjectCompletionEffects(store.db, store.slug).then(
      () => {
        drained = true;
      },
    );
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([effect, drain]);
    expect(drained).toBe(true);
  });

  it("makes archive-cancelled operator effects inert before restore", () => {
    upsertRun(store.db, {
      id: "run_archived_operator",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "operator-archive",
      role: "Operator",
      kind: "operator",
      backend: "codex",
      simulated: false,
      model: "gpt-5.4",
      sdk: "Codex SDK",
      state: "interrupted",
      operatorEffectState: "pending",
    });

    expect(completeProjectRunEffects(store.db, store.slug)).toBe(2);
    expect(
      store.db
        .prepare(`SELECT operator_effect_state FROM agent_runs WHERE id = ?`)
        .get("run_archived_operator"),
    ).toEqual({ operator_effect_state: "recovery" });
  });
});
