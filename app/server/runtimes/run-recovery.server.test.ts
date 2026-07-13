import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { postAgentReplyComment } from "~/server/tasks/task-actions.server";
import { captureTaskLaunchAuthorization } from "~/server/tasks/specialist-run.server";
import { openSystemRecovery } from "~/server/tasks/task-recovery.server";
import { insertRunLine, upsertRun } from "./run-store.server";
import {
  completeProjectRunEffects,
  persistRunCompletionContext,
  readRunCompletionPhase,
  revokeProjectCompletionEffects,
  RUN_COMPLETION_PHASE,
  waitForProjectCompletionEffects,
} from "./run-completion-state.server";
import { recoverUnreactedAgentRuns } from "./run-recovery.server";

describe("specialist completion boot recovery", () => {
  let ctx: TestDbContext;
  let store: TestStore;

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
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "Developer",
            backends: ["codex"],
            model: "gpt-5.4",
            effort: "high",
          },
        } as never,
      ],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
        specialist: {
          profileId: "dev",
          backend: "codex",
          role: "Developer",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => ctx.cleanup());

  function task() {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
  }

  function seedRun(input: {
    id: string;
    state?: "queued" | "running" | "finished" | "error" | "interrupted";
    simulated?: boolean;
    text?: string;
    incarnation?: string | null;
  }): void {
    upsertRun(store.db, {
      id: input.id,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: `primary-${input.id}`,
      role: "Developer",
      kind: "primary",
      backend: "codex",
      simulated: input.simulated ?? false,
      model: "gpt-5.4",
      sdk: "Codex SDK",
      agentProfileId: "dev",
      state: input.state ?? "finished",
      runPurpose: "conversation",
      taskIncarnation:
        input.incarnation === undefined
          ? task().frontmatter.createdAt
          : input.incarnation,
    });
    persistRunCompletionContext(store.db, input.id, {
      workdir: null,
      delivery: null,
      agentHandle: "dev",
      operatorRun: null,
      launchAuthorization: captureTaskLaunchAuthorization(
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          kind: "primary",
          profileId: "dev",
        },
      ),
    });
    if (input.text !== undefined) {
      insertRunLine(store.db, {
        runId: input.id,
        seq: 0,
        occurredAt: "2026-07-13T08:00:00.000Z",
        raw: JSON.stringify({ ev: "text", text: input.text }),
        display: {
          t: "08:00:00",
          ev: "text",
          tag: "assistant",
          text: input.text,
        },
      });
    }
  }

  it("converges a finished no-text run instead of keying recovery to reply audit", async () => {
    seedRun({ id: "run_no_text" });

    expect(
      await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot }),
    ).toEqual({ recovered: 1, orphaned: 0 });
    expect(readRunCompletionPhase(store.db, "run_no_text")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
    expect(task().frontmatter.waiting).toBe("human");
    const audit = store.db
      .prepare(
        `SELECT details_json FROM audit_events
          WHERE action = 'task.agent.replied' AND subject_id = 'VIB-1'`,
      )
      .get() as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({
      runId: "run_no_text",
      noText: true,
    });
  });

  it("continues past an early reply audit without duplicating its source-linked comment", async () => {
    seedRun({ id: "run_partial", text: "Work completed before the crash." });
    await postAgentReplyComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        runId: "run_partial",
        actorRef: { kind: "agent", backend: "codex", role: "Developer" },
        replyText: "Work completed before the crash.",
      },
    );

    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    const comments = task().timeline.filter(
      (event) => event.type === "comment" && event.sourceRunId === "run_partial",
    );
    expect(comments).toHaveLength(1);
    expect(task().frontmatter.waiting).toBe("human");
    expect(readRunCompletionPhase(store.db, "run_partial")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("keeps a non-seed simulated crash history-only with no governance reaction", async () => {
    seedRun({
      id: "run_simulated_crash",
      simulated: true,
      text: "Implemented and verified everything.",
    });

    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    const parsed = task();
    expect(parsed.frontmatter.waiting).toBe("human");
    expect(parsed.timeline[0]?.text).toContain("simulated run");
    expect(parsed.timeline.some((event) => event.type === "quality")).toBe(
      false,
    );
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM agent_runs
            WHERE kind = 'operator' AND completion_source_run_id = ?`,
        )
        .get("run_simulated_crash"),
    ).toEqual({ n: 0 });
  });

  it("surfaces a terminal real error through the same recovery pipeline", async () => {
    seedRun({ id: "run_terminal_error", state: "error" });

    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(task().packet?.from).toBe("system:runtime-recovery");
    expect(task().frontmatter.waiting).toBe("human");
    expect(readRunCompletionPhase(store.db, "run_terminal_error")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("makes an old same-slug/key incarnation inert", async () => {
    seedRun({
      id: "run_old_incarnation",
      text: "This belongs to the deleted task.",
      incarnation: "2026-01-01T00:00:00.000Z",
    });

    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(
      task().timeline.some(
        (event) => event.sourceRunId === "run_old_incarnation",
      ),
    ).toBe(false);
    expect(readRunCompletionPhase(store.db, "run_old_incarnation")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("finishes waiting cleanup for an ordinary human-interrupted run", async () => {
    seedRun({
      id: "run_human_interrupted",
      state: "interrupted",
      text: "Partial notes before the human stopped the run.",
    });

    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(task().frontmatter.waiting).toBe("human");
    expect(
      task().timeline.some(
        (event) => event.sourceRunId === "run_human_interrupted",
      ),
    ).toBe(true);
    expect(task().packet).toBeNull();
    expect(readRunCompletionPhase(store.db, "run_human_interrupted")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("retries an interrupted orphan when the first recovery write fails", async () => {
    seedRun({ id: "run_orphan", state: "queued" });
    const first = await recoverUnreactedAgentRuns(
      store.db,
      { dataRoot: store.dataRoot },
      {
        openRecovery: async () => {
          throw new Error("injected canonical write failure");
        },
      },
    );
    expect(first).toEqual({ recovered: 0, orphaned: 0 });
    expect(
      store.db
        .prepare(`SELECT state, step, completion_phase FROM agent_runs WHERE id = ?`)
        .get("run_orphan"),
    ).toEqual({
      state: "interrupted",
      step: "orphan-recovery",
      completion_phase: RUN_COMPLETION_PHASE.pending,
    });

    const second = await recoverUnreactedAgentRuns(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(second).toEqual({ recovered: 0, orphaned: 1 });
    expect(task().packet?.from).toBe("system:runtime-recovery");
    expect(task().frontmatter.waiting).toBe("human");
    expect(readRunCompletionPhase(store.db, "run_orphan")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("cannot write orphan recovery into a replacement task with the same key", async () => {
    seedRun({ id: "run_orphan_replaced", state: "queued" });
    const replacementCreatedAt = "2026-07-13T20:00:00.000Z";

    const result = await recoverUnreactedAgentRuns(
      store.db,
      { dataRoot: store.dataRoot },
      {
        openRecovery: async (...args) => {
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-1", {
              createdAt: replacementCreatedAt,
              stage: "impl",
              readiness: "ready",
              waiting: "none",
            }),
            goal: "This replacement must not inherit an orphan recovery packet.",
          });
          return openSystemRecovery(...args);
        },
      },
    );

    expect(result).toEqual({ recovered: 0, orphaned: 0 });
    expect(task().frontmatter.createdAt).toBe(replacementCreatedAt);
    expect(task().packet).toBeNull();
    expect(
      task().timeline.some(
        (event) =>
          event.actor.kind === "system" &&
          event.actor.systemId.includes("orphaned-specialist-run"),
      ),
    ).toBe(false);
    expect(
      store.db
        .prepare(`SELECT state, step, completion_phase FROM agent_runs WHERE id = ?`)
        .get("run_orphan_replaced"),
    ).toEqual({
      state: "interrupted",
      step: "orphan-recovery",
      completion_phase: RUN_COMPLETION_PHASE.pending,
    });
  });

  it("makes archive drain wait for an already-entered orphan recovery write", async () => {
    seedRun({ id: "run_orphan_race", state: "running" });
    let entered!: () => void;
    let release!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mayWrite = new Promise<void>((resolve) => {
      release = resolve;
    });

    const recovery = recoverUnreactedAgentRuns(
      store.db,
      { dataRoot: store.dataRoot },
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
    expect(await recovery).toEqual({ recovered: 0, orphaned: 1 });
    expect(task().packet?.from).toBe("system:runtime-recovery");
    expect(readRunCompletionPhase(store.db, "run_orphan_race")).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });
});
