import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { getBoard } from "~/server/projections/board-query.server";
import {
  provisionIdentity,
  setMemberRole,
} from "~/server/auth/identity.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  classifyReviewerVerdict,
  applyRecommendation,
  completeTaskMerge,
  recordHumanValidation,
  reorderTask,
  resolvePacket,
  transitionStage,
  updateTaskGoal,
} from "./task-actions.server";

const REVIEW_HEAD = "a".repeat(40);

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

async function validateCompletion(
  store: TestStore,
  validatingActor: {
    userId: string;
    label: string;
    orgRole?: "admin" | "member";
  },
): Promise<void> {
  await recordHumanValidation(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-1" },
    validatingActor,
    { dataRoot: store.dataRoot },
  );
}

const PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "Accept completion, or send back for one fix?",
  body: "Body.",
  observations: [],
  options: [
    {
      kind: "accept_completion",
      t: "Accept completion",
      d: "",
      rec: true,
      accept: true,
    },
    {
      kind: "request_edit",
      t: "Request one edit",
      d: "",
      rec: false,
      ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance.",
    },
    { kind: "block_on_policy", t: "Block on policy", d: "", rec: false },
    {
      kind: "hold_runtime_debug",
      t: "Hold for runtime debug",
      d: "",
      rec: false,
    },
    { kind: "redirect", t: "Start a fresh specialist", d: "", rec: false },
  ],
};

function withTask(
  store: TestStore,
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
  packet: TaskPacket | null = null,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function prepared(): TestStore {
  const store = setupTestStore(ctx);
  const project = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    repo: null,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function seedTasks(
  store: TestStore,
  tasks: { key: string; stage: string }[],
): void {
  for (const t of tasks) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(t.key, { stage: t.stage }),
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function stageOrder(store: TestStore, stageId: string): string[] {
  const board = getBoard(store.db, store.slug)!;
  return board.columns
    .find((c) => c.stage.id === stageId)!
    .tasks.map((t) => t.key);
}

describe("P3.7 governance & lifecycle fixes", () => {
  it("packet: the task OWNER (a contributor) may resolve a non-completion option (C3/Q2)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.selin.id }, // selin = contributor
      PACKET,
    );
    // Option index 1 is request_edit (a non-completion option). The contributor
    // owner may resolve it — no 403.
    const res = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(res.option.kind).toBe("request_edit");
  });

  it("packet: a non-owner contributor is still forbidden (C3)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.selin), // contributor, NOT the owner
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("packet: the contributor OWNER may accept_completion task-scoped", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.selin.id,
        validation: "healthy",
      },
      PACKET,
    );
    await validateCompletion(store, actor(store.users.selin));
    const result = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(result.task.stage).toBe("done");
    const audit = store.db
      .prepare(
        `SELECT details_json FROM audit_events
         WHERE action = 'task.packet.resolved' ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get() as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({
      optionKind: "accept_completion",
      authoritySource: "task_owner",
    });
  });

  it("packet: a non-owner contributor still cannot accept_completion", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", ownerUserId: store.users.arda.id },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("packet: a nonmember org admin may accept through the emergency override", async () => {
    const store = prepared();
    // Request/session claims are deliberately insufficient at a governed
    // boundary. Make Deniz an authoritative org admin in Better Auth while
    // leaving them absent from project.md, which is the emergency-override
    // case this test is intended to exercise.
    provisionIdentity(store.db, {
      id: store.users.deniz.id,
      email: store.users.deniz.email,
      name: store.users.deniz.name,
      role: "admin",
      passwordHash: null,
    });
    setMemberRole(store.db, store.users.deniz.id, "admin");
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.selin.id,
        validation: "healthy",
      },
      PACKET,
    );
    const orgAdmin = {
      ...actor(store.users.deniz),
      orgRole: "admin" as const,
    };
    await validateCompletion(store, orgAdmin);
    const result = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      orgAdmin,
      { dataRoot: store.dataRoot },
    );
    expect(result.task.stage).toBe("done");
    const audit = store.db
      .prepare(
        `SELECT details_json FROM audit_events
         WHERE action = 'task.packet.resolved' ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get() as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({
      authoritySource: "org_admin_override",
    });
  });

  it("a contributor owner may apply an accept-completion recommendation", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      ownerUserId: store.users.selin.id,
      validation: "healthy",
      recommendations: [
        {
          id: "rec_accept",
          kind: "accept_completion",
          label: "Accept completion",
          detail: "Review is healthy.",
        },
      ],
    });
    await validateCompletion(store, actor(store.users.selin));
    const result = await applyRecommendation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        recId: "rec_accept",
      },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(result.task.stage).toBe("done");
  });

  it("a bare re-entry into review does NOT launder a standing failing (#9)", async () => {
    const store = prepared();
    // failing, at impl, with NO rework since the rejection.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        validation: "failing",
      }),
      timeline: [
        {
          occurredAt: new Date().toISOString(),
          type: "quality",
          actor: { kind: "operator" },
          title: "Changes requested",
          text: "**Validation:** failing. Reviewer requested changes.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "review",
        manual: true,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // No rework → failing must survive the re-entry (not laundered to changed).
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.validation).toBe("failing");
  });

  it("acceptCompletion (via packet) refuses a failing-validation task (C2)", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        validation: "failing",
      },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda), // admin
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("completion refuses an unknown validation verdict even for a non-repository task", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", ownerUserId: store.users.arda.id, validation: "none" },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("repository-backed completion requires a linked review PR", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        validation: "healthy",
        repo: "akin-ozer/viberr",
      },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("a closed, unmerged PR cannot be laundered into merge-pending acceptance", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        validation: "healthy",
        repo: "akin-ozer/viberr",
        pr: { number: 318, state: "closed", title: "Closed PR" },
      },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr?.state,
    ).toBe("closed");
  });

  it("a repository task with an already-merged healthy PR may finish", async () => {
    const store = prepared();
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "Already merged completion fixture",
        token: "ghp_already_merged_completion_fixture",
      },
      actor(store.users.arda),
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor(store.users.arda),
    );
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        validation: "healthy",
        repo: "akin-ozer/viberr",
        pr: {
          number: 318,
          state: "merged",
          title: "PR",
          headSha: REVIEW_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        },
      },
      PACKET,
    );
    await validateCompletion(store, actor(store.users.arda));
    let putCalls = 0;
    const githubFetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") {
        putCalls += 1;
      }
      return new Response(
        JSON.stringify({
          state: "closed",
          merged: true,
          merged_at: "2026-07-01T10:00:00.000Z",
          merge_commit_sha: "b".repeat(40),
          head: { sha: REVIEW_HEAD },
          base: {
            ref: "main",
            repo: { full_name: "akin-ozer/viberr" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot, githubFetchImpl },
    );
    expect(putCalls).toBe(0);
    expect(result.completion).toEqual({ completed: true, mergePending: false });
    expect(result.task).toMatchObject({ stage: "done", validation: "healthy" });
    expect(result.task.pr).toMatchObject({ state: "merged" });
  });

  it("completion cannot skip directly from implementation to Done", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        validation: "healthy",
      },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("dragging a card into Done reports acceptance, not a bare move (C4)", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      ownerUserId: store.users.arda.id,
      validation: "healthy",
    });
    await validateCompletion(store, actor(store.users.arda));
    const res = await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        beforeKey: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(res.acceptedIntoDone).toBe(true);
    expect(res.task.stage).toBe("done");
  });

  it("updateTaskGoal edits the canonical goal + records a policy event (X11)", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id });
    await updateTaskGoal(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        goal: "New acceptance criteria: must contain a test.",
      },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.goal).toContain("must contain a test");
    expect(file.parsed.timeline[0]).toMatchObject({
      type: "policy",
      title: "Goal updated",
    });
  });

  it("updateTaskGoal is forbidden for a contributor (X11 RBAC)", async () => {
    const store = prepared();
    withTask(store, { stage: "impl" });
    await expect(
      updateTaskGoal(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", goal: "Sneaky rewrite." },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("transitionStage boundary enforcement", () => {
  it("undeclared boundary (triage→impl) → validation error", async () => {
    const store = prepared();
    withTask(store);
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("approval boundary (impl→review): low-role forbidden, maintainer ok", async () => {
    // impl → review is the `approval` human-gate boundary (triage → ready is now
    // `auto`, tested below).
    const store = prepared();
    withTask(store, { stage: "impl" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("review");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "transition" });
  });

  it("auto boundary (triage→ready): any member incl. viewer; operator attaches", async () => {
    // Post-D2: triage → ready is `auto` — any project member may cross it, and
    // leaving triage attaches an operator (ruling 16 semantics).
    const store = prepared();
    withTask(store);
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
    expect(task.operator).toMatchObject({ assignedAtStageId: "ready" });
  });

  it("auto boundary (ready→impl): any member incl. viewer; guests rejected", async () => {
    const store = prepared();
    withTask(store, { stage: "ready" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.deniz), // non-member
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      actor(store.users.elif), // viewer — auto boundary is any-member
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("impl");
  });

  it("leaving triage clears the input_required gate (readiness→ready)", async () => {
    const store = prepared();
    // Default readiness is input_required (the triage quality gate).
    withTask(store, { stage: "triage", readiness: "input_required" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.murat), // maintainer clears the approval boundary
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
    // The board must not keep showing "input required" once agents can work.
    expect(task.readiness).toBe("ready");
  });

  it("a blocked task keeps its readiness across a transition (only input_required clears)", async () => {
    const store = prepared();
    withTask(store, { stage: "triage", readiness: "blocked" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
    expect(task.readiness).toBe("blocked");
  });

  it("entering the review stage sets validation to 'changed' (FR24 live signal)", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", validation: "none" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      actor(store.users.murat), // maintainer clears the approval boundary
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("review");
    expect(task.validation).toBe("changed");
  });

  it("human boundary (review→done locked): reviewer forbidden, admin ok, waiting→none", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      waiting: "human",
      validation: "healthy",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await validateCompletion(store, actor(store.users.arda));
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
    expect(task.waiting).toBe("none");
    expect(task.displayReadiness).toBe("accepted"); // derived, not stored
  });

  it("is idempotent — transitioning to the current stage writes nothing", async () => {
    const store = prepared();
    withTask(store, { stage: "ready" });
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline
      .length;
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.timeline).toHaveLength(
      before,
    );
  });

  it("marks the task's approval notifications read on transition", async () => {
    const store = prepared();
    withTask(store, { stage: "impl" });
    createNotification(store.db, {
      id: "n-test-approval",
      userId: store.users.arda.id,
      kind: "approval",
      text: "Transition request",
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const row = store.db
      .prepare(`SELECT read_at FROM notifications WHERE id = 'n-test-approval'`)
      .get() as { read_at: string | null };
    expect(row.read_at).not.toBeNull();
  });
});

describe("transitionStage manual mode (board / task-detail dropdown)", () => {
  it("moves across a NON-boundary edge (triage→impl) for a maintainer, forbidden for a reviewer", async () => {
    const store = prepared();
    withTask(store);
    // triage→impl is not a declared boundary — rejected without `manual`.
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });

    // A reviewer cannot manual-move (admin|maintainer only).
    await expect(
      transitionStage(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          toStageId: "impl",
          manual: true,
        },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // An admin can — and it lands + posts a transition timeline comment.
    const task = await transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "impl",
        manual: true,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("impl");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "transition" });
    expect(detail?.timeline[0]?.text).toContain(
      "moved VIB-1 from Triage to In Progress",
    );
  });

  it("allows a BACKWARD manual move (review→ready) for a maintainer", async () => {
    const store = prepared();
    withTask(store, { stage: "review" });
    const task = await transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "ready",
        manual: true,
      },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
  });

  it("rejects a manual move to an unknown stage", async () => {
    const store = prepared();
    withTask(store);
    await expect(
      transitionStage(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          toStageId: "nope",
          manual: true,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("reorderTask (drag-to-reorder, persistent board order)", () => {
  it("reorders WITHIN a stage via a midpoint boardRank — persists a rebuild, no comment", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
      { key: "VIB-3", stage: "impl" },
    ]);
    expect(stageOrder(store, "impl")).toEqual(["VIB-1", "VIB-2", "VIB-3"]);

    // Move VIB-1 to the end of the column (beforeKey null → append).
    await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "impl",
        beforeKey: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-3", "VIB-1"]);

    // The rank lives in the FILE, so it survives a full projection rebuild.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(typeof file.parsed.frontmatter.boardRank).toBe("number");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-3", "VIB-1"]);

    // A same-stage reorder is quiet — no transition timeline comment.
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.timeline.some((e) => e.type === "transition")).toBe(false);
  });

  it("inserts a card immediately before another (beforeKey)", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
      { key: "VIB-3", stage: "impl" },
    ]);
    // Move VIB-3 before VIB-2 → VIB-1, VIB-3, VIB-2.
    await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-3",
        toStageId: "impl",
        beforeKey: "VIB-2",
      },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(stageOrder(store, "impl")).toEqual(["VIB-1", "VIB-3", "VIB-2"]);
  });

  it("a cross-stage drag moves the stage AND writes the transition comment", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "triage" },
      { key: "VIB-2", stage: "impl" },
    ]);
    const res = await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "impl",
        beforeKey: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(res.movedStage).toBe(true);
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-1"]);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.timeline.some((e) => e.type === "transition")).toBe(true);
  });

  it("is admin|maintainer only — a reviewer is rejected", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
    ]);
    await expect(
      reorderTask(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          toStageId: "impl",
          beforeKey: "VIB-2",
        },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("resolvePacket kind matrix", () => {
  it("accept_completion is human-acceptance-gated (admin|maintainer or task owner)", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        validation: "healthy",
        repo: "akin-ozer/viberr",
        pr: {
          number: 318,
          state: "review",
          title: "PR",
          headSha: REVIEW_HEAD,
        },
      },
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin), // reviewer — cannot accept
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    await validateCompletion(store, actor(store.users.arda));

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Repository-backed completion is accepted, but the task remains in Review
    // until the linked PR is truly merged.
    expect(task.stage).toBe("review");
    expect(task.waiting).toBe("human");
    expect(task.displayReadiness).toBe("ready");
    expect(task.validation).toBe("healthy");
    expect(task.pr).toMatchObject({ state: "accepted" });
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "completion",
      title: "Completion accepted · merge pending",
    });
    expect(detail?.timeline[0]!.text).toContain("remains in **Review**");
  });

  it("request_edit: contributor forbidden, maintainer ok — waiting→agent, readiness→ready, packet cleared, ev copy written", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    // Resolving a decision packet steers agent work — admin|maintainer only.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.selin), // contributor — cannot resolve
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.murat), // maintainer may send back
      { dataRoot: store.dataRoot },
    );
    expect(task.waiting).toBe("agent");
    expect(task.readiness).toBe("ready");
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "transition",
      text: PACKET.options[1]!.ev,
    });
  });

  it("block_on_policy: readiness→blocked, waiting→human, packet KEPT", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.readiness).toBe("blocked");
    expect(task.waiting).toBe("human");
    expect(task.validation).toBe("failing"); // a policy block is unhealthy (FR24)
    expect(task.packet).not.toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "blocked",
      text: "**Decision:** hold on policy. VIB-1 stays blocked until the project credential policy is updated.",
    });
  });

  it("hold_runtime_debug: readiness→blocked, packet KEPT, waiting untouched", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 3 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.readiness).toBe("blocked");
    expect(task.waiting).toBe("human");
    expect(task.packet).not.toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      "**Decision:** hold for runtime debug. VIB-1 stays blocked while the provider-native session is inspected — findings come back as task comments.",
    );
  });

  it("redirect without ev → fallback decision copy", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", waiting: "human" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 4 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      "**Decision:** Start a fresh specialist. Operator re-engages the specialist with a summon note.",
    );
  });

  it("resolving an already-resolved packet → 409 conflict, no crash", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("every resolve marks the task's packet + approval notifications read", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    createNotification(store.db, {
      id: "n-test-packet",
      userId: store.users.arda.id,
      kind: "packet",
      ptype: "input",
      text: "t",
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    createNotification(store.db, {
      id: "n-test-mention",
      userId: store.users.arda.id,
      kind: "mention",
      text: "t",
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const rows = store.db
      .prepare(`SELECT id, read_at FROM notifications ORDER BY id`)
      .all() as { id: string; read_at: string | null }[];
    expect(rows.find((r) => r.id === "n-test-packet")?.read_at).not.toBeNull();
    // mention rows are NOT auto-read by packet resolution
    expect(rows.find((r) => r.id === "n-test-mention")?.read_at).toBeNull();
  });

  it("the decision survives in the file — canonical truth check", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.packet).toBeNull();
    expect(file?.parsed.frontmatter.waiting).toBe("agent");
    expect(file?.parsed.timeline[0]?.type).toBe("transition");
  });
});

describe("classifyReviewerVerdict (F4 — reviewer verdict → quality signal)", () => {
  it("accepts exactly one valid structured marker", () => {
    expect(
      classifyReviewerVerdict(
        'Detailed evidence.\nVIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"The diff and tests satisfy the goal."}',
      ),
    ).toBe("approve");
    expect(
      classifyReviewerVerdict(
        'VIBERR_REVIEW_VERDICT: {"verdict":"request_changes","summary":"The empty-input test fails."}',
      ),
    ).toBe("request_changes");
  });

  it("never infers governance state from prose", () => {
    expect(
      classifyReviewerVerdict("LGTM — approved and ready to merge."),
    ).toBeNull();
    expect(
      classifyReviewerVerdict("Requesting changes: the tests fail."),
    ).toBeNull();
    expect(classifyReviewerVerdict("I looked at the diff.")).toBeNull();
    expect(classifyReviewerVerdict(null)).toBeNull();
  });

  it("rejects malformed, unsupported, or ambiguous structured markers", () => {
    expect(
      classifyReviewerVerdict(
        'VIBERR_REVIEW_VERDICT: {"verdict":"pass","summary":"Looks good."}',
      ),
    ).toBeNull();
    expect(
      classifyReviewerVerdict('VIBERR_REVIEW_VERDICT: {"verdict":"approve"}'),
    ).toBeNull();
    expect(
      classifyReviewerVerdict(
        'VIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"One"}\nVIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"Two"}',
      ),
    ).toBeNull();
  });
});

describe("completeTaskMerge (S2 — finish a merge-pending PR)", () => {
  it("rejects a task with no PR", async () => {
    const store = prepared();
    withTask(store, { stage: "done" });
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a PR that is not accepted/merge-pending", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      pr: { number: 7, state: "review", title: "PR" },
    });
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("is admin|maintainer only (contributor forbidden)", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      validation: "healthy",
      repo: "akin-ozer/viberr",
      pr: { number: 7, state: "accepted", title: "PR" },
    });
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.selin), // contributor
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reports an honest failure (not a fake merge) when no credential is configured", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      validation: "healthy",
      repo: "akin-ozer/viberr",
      pr: {
        number: 7,
        state: "review",
        title: "PR",
        headSha: REVIEW_HEAD,
      },
    });
    await validateCompletion(store, actor(store.users.arda));
    const humanValidation = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.humanValidation;
    // Model a completion that was accepted in an earlier request and is now
    // waiting for the explicit merge retry.
    withTask(store, {
      stage: "review",
      validation: "healthy",
      repo: "akin-ozer/viberr",
      humanValidation,
      pr: {
        number: 7,
        state: "accepted",
        title: "PR",
        headSha: REVIEW_HEAD,
      },
    });
    const result = await completeTaskMerge(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.merged).toBe(false);
    expect(result.message).toMatch(/credential|scope|merge/i);
    // The PR stays "accepted" — never silently flipped to "merged".
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("accepted");
  });
});
