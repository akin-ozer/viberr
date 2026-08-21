import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  deliveringEngagement,
  type Engagement,
  type TaskPacket,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  createNotification,
  listNotifications,
} from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";

import { getTaskDetail } from "~/server/projections/task-query.server";
import { getBoard } from "~/server/projections/board-query.server";
import {
  classifyReviewerVerdict,
  completeTaskMerge,
  forceAcceptCompletion,
  recordAgentCompletion,
  reorderTask,
  resolvePacket,
  setTaskArchived,
  transitionStage,
  updateTaskGoal,
} from "./task-actions.server";
import { listAuditEvents } from "../../../test-support/audit-log";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** The two columns these cases read back off a notification row. */
const notificationReadRowSchema = z.object({
  id: z.string(),
  read_at: z.string().nullable(),
});

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

const PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "Accept completion, or send back for one fix?",
  body: "Body.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "", rec: true, accept: true },
    { kind: "request_edit", t: "Request one edit", d: "", rec: false, ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance." },
    { kind: "block_on_policy", t: "Block on policy", d: "", rec: false },
    { kind: "hold_runtime_debug", t: "Hold for runtime debug", d: "", rec: false },
    { kind: "redirect", t: "Start a fresh specialist", d: "", rec: false },
  ],
};

/** The delivering developer engagement (workspace owner; never a required
 *  reviewer). */
const DEV_ENGAGEMENT: Engagement = {
  profileId: "dev",
  backend: "codex",
  role: "developer",
  delivers: true,
  verdictCapable: false,
};
/** A verdict-capable reviewer whose profileId matches recordReviewerReply's
 *  actorRef ("reviewer") — so its verdict binds to the current revision AND
 *  gates acceptance (F10-15). */
const REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
/** An immutable delivered revision under review. */
function workRev(id = "rev_1"): WorkRevision {
  return {
    id,
    headSha: "a".repeat(40),
    treeSha: "t".repeat(40),
    branch: "vib-1-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "dev",
  };
}
/** A standing request_changes verdict bound to `revisionId` (a live rejection
 *  on the current revision). */
function rejectionVerdict(revisionId = "rev_1") {
  return {
    profileId: "reviewer",
    revisionId,
    headSha: "a".repeat(40),
    result: "request_changes" as const,
    reason: "standing rejection",
    at: "2026-07-04T01:00:00.000Z",
  };
}

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
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function seedTasks(store: TestStore, tasks: { key: string; stage: string }[]): void {
  for (const t of tasks) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(t.key, { stage: t.stage }),
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function stageOrder(store: TestStore, stageId: string): string[] {
  const board = getBoard(store.db, store.slug)!;
  return board.columns.find((c) => c.stage.id === stageId)!.tasks.map((t) => t.key);
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

  it("P11-71: a resolution note is recorded on the decision timeline event", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, PACKET);
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 1, // request_edit
        note: "Gate the /health/scripts route for contributor+ only.",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const decisionEvent = file.parsed.timeline.find((e) => e.text.includes("Decision"));
    expect(decisionEvent?.text).toContain("Gate the /health/scripts route");
  });

  it("packet: a non-owner contributor is still forbidden (C3)", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, PACKET);
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.selin), // contributor, NOT the owner
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("packet: the contributor OWNER CAN accept_completion (R6-2 owner exception)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", ownerUserId: store.users.selin.id },
      PACKET,
    );
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 }, // accept_completion
      actor(store.users.selin), // contributor who OWNS this task
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
  });

  it("packet: a NON-owner contributor still cannot accept_completion (R6-2)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", ownerUserId: store.users.arda.id }, // owned by admin, not selin
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin), // contributor, NOT the owner
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("packet: a viewer OWNER cannot accept_completion (owner exception needs contributor+)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", ownerUserId: store.users.elif.id }, // viewer owner
      PACKET,
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.elif), // viewer — read+comment only, can't own or accept
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a bare re-entry into review does NOT launder a standing failing (#9)", async () => {
    const store = prepared();
    // failing, at impl, with NO new revision since the rejection: a live
    // request_changes verdict bound to the current work revision.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [rejectionVerdict("rev_1")],
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
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // No rework → failing must survive the re-entry (not laundered to changed).
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("failing");
  });

  it("acceptCompletion (via packet) refuses a failing-validation task (C2)", async () => {
    const store = prepared();
    // A required reviewer requested changes on the current revision — acceptance
    // is blocked by acceptanceBlockedReason (F10-15), which the packet honors.
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [rejectionVerdict("rev_1")],
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

  it("forceAcceptCompletion lets an ADMIN override a blocked task, audited (DG-2)", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [rejectionVerdict("rev_1")], // required reviewer requested changes
        validation: "failing",
      },
      PACKET,
    );
    const res = await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda), // admin
      { dataRoot: store.dataRoot },
    );
    expect(res.task.stage).toBe("done");
    // The override is audited with the exact reason it bypassed.
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(forced[0]!.details!.bypassed).toContain("request");
    // N20-14 (§5c): the bypass is also a DURABLE frontmatter fact, so the
    // hero/card don't recompute "awaiting verdict" onto the force-accepted Done
    // task. The audit row alone was not enough (deriveValidation re-derived it).
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.acceptance).toBe("forced");
    // And it is projected for the read models (C-VOCAB reads it).
    expect(res.task.acceptance).toBe("forced");
  });

  it("forceAcceptCompletion on an already-Done task is a no-op — no misleading audit (DG-2)", async () => {
    const store = prepared();
    withTask(store, { stage: "done", ownerUserId: store.users.arda.id, validation: "healthy" });
    const res = await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(res.task.stage).toBe("done");
    // Overrode nothing → no forced-acceptance audit row.
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(0);
  });

  it("forceAcceptCompletion denies a NON-admin (maintainer) — admin-only override (DG-2)", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [rejectionVerdict("rev_1")],
        validation: "failing",
      },
      PACKET,
    );
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat), // maintainer, not admin
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("dragging a card into Done reports acceptance, not a bare move (C4)", async () => {
    const store = prepared();
    withTask(store, { stage: "review", ownerUserId: store.users.arda.id, validation: "healthy" });
    const res = await reorderTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", beforeKey: null },
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
      { projectSlug: store.slug, taskKey: "VIB-1", goal: "New acceptance criteria: must contain a test." },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.goal).toContain("must contain a test");
    // P13-LV-03: a human editing the goal is a neutral note, not a violation.
    expect(file.parsed.timeline[0]).toMatchObject({ type: "note", title: "Goal updated" });
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
    // Delivered work under review with no verdicts yet → review entry derives
    // the live "changed" signal (a revision is up but unjudged).
    withTask(store, {
      stage: "impl",
      validation: "none",
      branch: "vib-1-work",
      workRevision: workRev("rev_1"),
    });
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
    withTask(store, { stage: "review", waiting: "human" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
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
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.length;
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.timeline).toHaveLength(before);
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
    const row = notificationReadRowSchema
      .pick({ read_at: true })
      .parse(
        store.db
          .prepare(
            `SELECT read_at FROM notifications WHERE id = 'n-test-approval'`,
          )
          .get(),
      );
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
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // An admin can — and it lands + posts a transition timeline comment.
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("impl");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "transition" });
    expect(detail?.timeline[0]?.text).toContain("moved VIB-1 from Triage to In Progress");
  });

  it("allows a BACKWARD manual move (review→ready) for a maintainer", async () => {
    const store = prepared();
    withTask(store, { stage: "review" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
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
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "nope", manual: true },
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
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
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
    expect(file.parsed.frontmatter.boardRank).toBeTypeOf("number");
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
      { projectSlug: store.slug, taskKey: "VIB-3", toStageId: "impl", beforeKey: "VIB-2" },
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
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
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
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: "VIB-2" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("resolvePacket kind matrix", () => {
  it("accept_completion is human-acceptance-gated (admin|maintainer only)", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human", pr: { number: 318, state: "review", title: "PR" } }, PACKET);
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin), // reviewer — cannot accept
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
    expect(task.waiting).toBe("none");
    expect(task.displayReadiness).toBe("accepted");
    // P14-LV-02: acceptance no longer STAMPS "healthy". This task has no
    // delivered work revision at all, so the derived state is "none" — the
    // synthesized green chip is exactly what let a Triage task with no diff
    // claim it had been validated.
    expect(task.validation).toBe("none");
    // D3: no reachable GitHub merge in the test env, so the PR is recorded as
    // "accepted" (merge pending) — NEVER a false "merged".
    expect(task.pr).toMatchObject({ state: "accepted" });
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "completion",
      title: "Completion accepted",
    });
    expect(detail?.timeline[0]!.text).toContain("accepted, merge pending");
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

  it("R20-1 block_on_policy: UNBLOCKS (readiness→ready, waiting→agent), resolves, refuses a second confirm", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    // R20-1 (F20-5): the label promises an UNBLOCK, so this records one and the
    // packet is CLEARED — it used to record a "hold" and re-accept forever.
    expect(task.readiness).toBe("ready");
    expect(task.waiting).toBe("agent");
    // B-WF2 stands: `validation` (the review cache) is never touched by a policy
    // decision.
    expect(task.validation).toBe("none");
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "transition",
      text: "**Decision:** policy / credential updated. VIB-1 is unblocked and the operator re-runs to re-check. If it is still blocked, a new decision packet is opened.",
    });
    // A second confirm on the already-resolved packet is a 409 (no repeat).
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("R20-1: a settled hold-decision consumes its inbox notification (no lingering open packet)", async () => {
    // Before R20-1 the hold options kept their packet open and the notification
    // stayed unread; now every recovery option RESOLVES the packet, so the
    // decision is made and the inbox item is consumed.
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    createNotification(store.db, {
      userId: store.users.murat.id,
      kind: "packet",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      title: "Decision required",
      text: "hold or proceed",
      bypassPrefs: true,
    });
    const unreadFor = () =>
      listNotifications(store.db, store.users.murat.id).filter(
        (n) => n.taskKey === "VIB-1" && n.kind === "packet" && n.unread,
      );
    expect(unreadFor()).toHaveLength(1); // the decision is in the inbox
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(unreadFor()).toHaveLength(0); // …and the settled decision clears it
  });

  it("R20-1 hold_runtime_debug: resolves + stays blocked/waiting-human, NO run, refuses a second confirm", async () => {
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
    // R20-1: the hold now RESOLVES (clears) the packet — it just starts no run.
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      "**Decision:** hold for runtime debug. VIB-1 stays blocked while the provider-native session is inspected. Coordination is paused and no operator run was started. Use **Run operator** on the task page when the inspection is done.",
    );
    // A repeat confirm on the resolved packet is refused.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 3 },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
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

  // 20s (see the routing tests): resolving this packet starts a real run through
  // the fake adapter, which under full-suite parallelism can exceed the 5s default.
  it("retry_other_backend: packet cleared, run restarts on the target backend, switch persists to the snapshot", { timeout: 20_000 }, async () => {
    const { interruptRun } = await import(
      "~/server/runtimes/run-service.server"
    );
    installFakeRuntime();
    const store = prepared();
    const RETRY_PACKET: TaskPacket = {
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Work stalled — pick a recovery path",
      body: "",
      observations: [],
      options: [
        {
          kind: "retry_other_backend",
          t: "Retry on Claude Code",
          d: "",
          rec: true,
          backend: "claude",
        },
        { kind: "redirect", t: "Redirect", d: "", rec: false },
      ],
    };
    // The failed codex assignment the packet recovers from.
    withTask(
      store,
      {
        stage: "impl",
        waiting: "human",
        readiness: "blocked",
        engagements: [
          { profileId: "dev", backend: "codex", role: "developer", delivers: true, verdictCapable: false },
        ],
      },
      RETRY_PACKET,
    );

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.waiting).toBe("agent");
    expect(task.readiness).toBe("ready");
    expect(task.packet).toBeNull();

    // The promised run actually started — on the OTHER backend.
    const { listRunsForTaskRows } = await import(
      "~/server/runtimes/run-store.server"
    );
    const runs = listRunsForTaskRows(store.db, store.slug, "VIB-1");
    expect(runs.length).toBe(1);
    expect(runs[0]!.backend).toBe("claude");
    expect(runs[0]!.kind).toBe("primary");
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: runs[0]!.id },
      actor(store.users.murat),
    );

    // The switch persisted to the assignment snapshot (D4 stickiness).
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(deliveringEngagement(file.parsed.frontmatter)?.backend).toBe("claude");
    const texts = file.parsed.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("switched from Codex"))).toBe(true);
    expect(
      texts.some((t) => t.includes("**Decision:** Retry on Claude Code")),
    ).toBe(true);
  });

  // The recovery packet the operator authors on a closed-without-merge PR
  // (pr-diverged trigger): rework / archive / archive+delete-branch.
  const RECOVERY_PACKET: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "PR #318 was closed without merging — choose a recovery path",
    body: "Reopening the PR on GitHub is also valid — Viberr detects it automatically.",
    observations: [],
    options: [
      { kind: "custom", t: "Rework and re-run the Developer", d: "", rec: true },
      { kind: "archive_task", t: "Archive the task (keep the branch)", d: "", rec: false },
      {
        kind: "archive_task",
        t: "Archive and delete branch vib-1-work",
        d: "Discards the rejected work entirely.",
        rec: false,
        deleteBranch: true,
      },
    ],
  };

  it("archive_task: runs the real R14-3 archive (schedules cancelled, packet cleared, audited); a contributor-OWNER is refused", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id, // contributor owner — may resolve packets…
        pr: { number: 318, state: "closed", title: "PR" },
        branch: "vib-1-work",
        schedules: [
          {
            id: "sch_arch1",
            action: "run-operator",
            dueAt: new Date(Date.now() + 3_600_000).toISOString(),
            note: "re-check",
            createdBy: store.users.arda.id,
            createdByLabel: "Arda",
            createdAt: new Date().toISOString(),
            status: "pending",
            firedAt: null,
            claimedAt: null,
            retries: 0,
          },
        ],
      },
      RECOVERY_PACKET,
    );

    // …but archiving is the board-management tier (approve-transition): the
    // owner exception that admits selin to the PACKET does not widen R14-3.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { task, option } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    expect(option.kind).toBe("archive_task");
    expect(task.packet).toBeNull();

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.archived).toBe(true);
    expect(fm.waiting).toBe("none");
    // P14-RV-03 belt-and-braces rides along: the pending operator re-run dies
    // with the archive instead of firing on abandoned work.
    expect(fm.schedules[0]!.status).toBe("cancelled");
    // Stage untouched — archiving is a disposition, not a transition.
    expect(fm.stage).toBe("review");

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const texts = detail!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("**Decision:** Archive the task (keep the branch)"))).toBe(true);
    expect(texts.some((t) => t.includes("was archived"))).toBe(true);
    expect(listAuditEvents(store.db, { action: "task.archived" })).toHaveLength(1);
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toMatchObject({ optionKind: "archive_task" });
  });

  it("archive_task + deleteBranch: the archive stands even when GitHub is unconfigured, with an honest failure note", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        pr: { number: 318, state: "closed", title: "PR" },
        branch: "vib-1-work",
      },
      RECOVERY_PACKET,
    );
    // No project credential in this fixture — the deletion degrades typed
    // (no_pat_configured), and the archive must NOT be rolled back by that.
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.packet).toBeNull();
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.archived).toBe(true);

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const texts = detail!.timeline.map((e) => e.text);
    expect(
      texts.some((t) => t.includes("The branch was **not** deleted") && t.includes("no GitHub repo or credential")),
    ).toBe(true);
  });

  // F20-6 (R20-2): the operator's discard option now EXECUTES on confirm.
  const DISCARD_PACKET: TaskPacket = {
    type: "input",
    kind: "Completion report",
    from: "operator",
    title: "The branch is empty — discard it, or refine the goal?",
    body: "vib-1-work was never pushed.",
    observations: [],
    options: [
      { kind: "discard_branch", t: "Discard the empty vib-1-work branch", d: "", rec: true },
      { kind: "edit_goal", t: "Refine the goal instead", d: "", rec: false },
    ],
  };

  function gitc(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  }

  /** A REAL workspace clone with a local task branch `vib-1-work`, at the dir
   *  findWorkspaceRepoDir resolves to for this project (repo `.../viberr`). */
  function initTaskWorkspace(store: TestStore, opts: { onRemote?: boolean } = {}): string {
    const repoDir = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      "viberr",
    );
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    gitc(repoDir, ["init", "-q", "-b", "main"]);
    gitc(repoDir, ["config", "user.email", "t@viberr.local"]);
    gitc(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
    gitc(repoDir, ["add", "-A"]);
    gitc(repoDir, ["commit", "-q", "-m", "init"]);
    gitc(repoDir, ["checkout", "-q", "-b", "vib-1-work"]);
    writeFileSync(path.join(repoDir, "w.txt"), "w\n");
    gitc(repoDir, ["add", "-A"]);
    gitc(repoDir, ["commit", "-q", "-m", "work"]);
    gitc(repoDir, ["checkout", "-q", "main"]);
    if (opts.onRemote) {
      const remoteDir = path.join(store.dataRoot, "bare-origin.git");
      mkdirSync(remoteDir, { recursive: true });
      gitc(remoteDir, ["init", "-q", "--bare"]);
      gitc(repoDir, ["remote", "add", "origin", remoteDir]);
      gitc(repoDir, ["push", "-q", "origin", "vib-1-work"]);
    }
    return repoDir;
  }

  it("discard_branch: a contributor-OWNER is refused (it destroys commits → approve-transition tier)", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id, // contributor owner — may resolve packets…
        branch: "vib-1-work",
      },
      DISCARD_PACKET,
    );
    // …but the discard destroys commits (approve-transition): the owner exception
    // that admits selin to the PACKET does not widen the branch-disposition tier.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // The refused resolution leaves the packet untouched.
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(fm.packet).not.toBeNull();
  });

  it("discard_branch: deletes the local branch, clears fm.branch, writes the note + task.branch.discarded", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", waiting: "human", branch: "vib-1-work" },
      DISCARD_PACKET,
    );
    initTaskWorkspace(store);
    const { task, option } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    expect(option.kind).toBe("discard_branch");
    expect(task.packet).toBeNull();
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.branch).toBeNull();
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(
      texts.some((t) => t.includes("was deleted from this") && t.includes("nothing was pushed")),
    ).toBe(true);
    const discarded = listAuditEvents(store.db, { action: "task.branch.discarded" });
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.details).toMatchObject({ branch: "vib-1-work", basis: "local_only" });
  });

  it("discard_branch / ruling 17: refuses an on-remote branch, keeps fm.branch, still resolves the packet", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", waiting: "human", branch: "vib-1-work" },
      DISCARD_PACKET,
    );
    initTaskWorkspace(store, { onRemote: true });
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    // The packet resolves in every case (the discard is best-effort after it).
    expect(task.packet).toBeNull();
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // A refused discard must NOT clear the branch the task still owns.
    expect(fm.branch).toBe("vib-1-work");
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(
      texts.some((t) => t.includes("was **not** discarded") && t.includes("exists on GitHub")),
    ).toBe(true);
    expect(listAuditEvents(store.db, { action: "task.branch.discard_refused" })).toHaveLength(1);
  });

  it("F20-24: archive_task + deleteBranch discards the LOCAL branch too so 'discard work' leaves nothing to re-deliver", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        pr: { number: 318, state: "closed", title: "PR" },
        branch: "vib-1-work",
      },
      RECOVERY_PACKET,
    );
    // A real workspace holding a local-only `vib-1-work`. No credential in the
    // fixture, so the REMOTE delete degrades typed (no_pat_configured) — the
    // local-discard wiring is what this test exercises.
    initTaskWorkspace(store);
    const repoDir = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      "viberr",
    );
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 }, // archive + delete branch
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.packet).toBeNull();
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.archived).toBe(true);
    // The commit is truly gone: fm.branch is cleared AND the branch is removed
    // from the workspace, so restore cannot re-push it. Canary: drop the
    // local-discard block and fm.branch stays "vib-1-work".
    expect(fm.branch).toBeNull();
    expect(() =>
      gitc(repoDir, ["rev-parse", "--verify", "refs/heads/vib-1-work"]),
    ).toThrow();
    const discarded = listAuditEvents(store.db, { action: "task.branch.discarded" });
    expect(
      discarded.some((a) => a.details!.basis === "archive_cleanup"),
    ).toBe(true);
  });

  it("F20-25: restore names the next step, and archive drops the false 'reopen the question' promise", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, RECOVERY_PACKET);
    await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: true },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const archivedNote = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline[0]!.text;
    expect(archivedNote).toContain("withdrawn");
    // The old promise restore could not keep is gone (it said "reopen the
    // question" but withdrew the packet's options).
    expect(archivedNote).not.toContain("reopen the question");

    const { archived } = await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: false },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(archived).toBe(false);
    const back = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    // The waiting contract is preserved (a restored task waits on a human)…
    expect(back.frontmatter.waiting).toBe("human");
    // …but it is no longer stranded silently — the restore note names the next
    // step, so "Waiting on: Human decision" reads as actionable.
    expect(back.timeline[0]!.text).toContain("Run the operator");
  });

  // F20-18 (N20-7): a contributor-owner handed a packet whose every option needs
  // maintainer authority has an in-app path — route the decision UP.
  const STRANDED_PACKET: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Archive the task, or refine the goal?",
    body: "",
    observations: [],
    options: [
      { kind: "archive_task", t: "Archive the task", d: "", rec: true },
      { kind: "edit_goal", t: "Refine the goal", d: "", rec: false },
    ],
  };

  it("F20-18: a contributor-owner routes a stranded packet to the maintainers (notify + note + audit)", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", waiting: "human", ownerUserId: store.users.selin.id },
      STRANDED_PACKET,
    );
    const { requestPacketMaintainerDecision } = await import("./task-actions.server");
    const res = await requestPacketMaintainerDecision(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", note: "please archive this" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    // arda (admin) + murat (maintainer) are notified; selin (the owner) is not.
    expect(res.notified).toBeGreaterThanOrEqual(1);
    expect(listNotifications(store.db, store.users.murat.id).length).toBeGreaterThanOrEqual(1);
    expect(listNotifications(store.db, store.users.selin.id).length).toBe(0);
    // The ask lands on the timeline (with the owner's note) and is audited.
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(
      texts.some((t) => t.includes("asked a maintainer") && t.includes("please archive this")),
    ).toBe(true);
    expect(listAuditEvents(store.db, { action: "task.packet.escalated" })).toHaveLength(1);
    // The packet is NOT resolved — a maintainer still decides through the gate.
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(fm.packet).not.toBeNull();
  });

  it("F20-18: a maintainer is told to resolve it themselves, not route it", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "review", waiting: "human", ownerUserId: store.users.murat.id },
      STRANDED_PACKET,
    );
    const { requestPacketMaintainerDecision } = await import("./task-actions.server");
    await expect(
      requestPacketMaintainerDecision(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edit_goal: packet stays (stamped awaiting goal_edit) until the edited goal lands, then clears instantly", async () => {
    const store = prepared();
    const SCOPE_PACKET: TaskPacket = {
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Scope needed: goal is a placeholder",
      body: "",
      observations: [],
      options: [
        { kind: "edit_goal", t: "Human specifies the goal", d: "", rec: true },
        { kind: "hold_runtime_debug", t: "Hold", d: "", rec: false },
      ],
    };
    withTask(
      store,
      { stage: "triage", waiting: "human", readiness: "blocked" },
      SCOPE_PACKET,
    );

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    // The decision is recorded but the packet's ask isn't fulfilled yet.
    expect(task.waiting).toBe("human");
    expect(task.packet).not.toBeNull();
    const stamped = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(stamped.packet?.awaiting).toBe("goal_edit");
    expect(stamped.timeline[0]!.text).toContain("Waiting for the edited goal");

    // The edit itself fulfills the decision — packet clears with no operator
    // round-trip, and the blocked readiness lifts with it.
    await updateTaskGoal(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        goal: "List all files under the repo root, output as a markdown table.",
      },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(after.packet).toBeNull();
    expect(after.frontmatter.readiness).toBe("ready");
    const texts = after.timeline.map((e) => e.text);
    expect(
      texts.some((t) => t.includes("**Packet resolved:** the requested goal edit landed.")),
    ).toBe(true);
  });

  it("R20-1: an edit_goal-stamped packet refuses a SECOND confirm (waiting for the edited goal)", async () => {
    const store = prepared();
    const SCOPE_PACKET: TaskPacket = {
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Scope needed: goal is a placeholder",
      body: "",
      observations: [],
      options: [
        { kind: "edit_goal", t: "Human specifies the goal", d: "", rec: true },
        { kind: "hold_runtime_debug", t: "Hold", d: "", rec: false },
      ],
    };
    withTask(
      store,
      { stage: "triage", waiting: "human", readiness: "blocked" },
      SCOPE_PACKET,
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    // The packet is stamped awaiting the goal, so a second confirm — of ANY
    // option — is a 409 telling the human to save the goal instead.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("waiting for the edited goal"),
    });
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
      id: "n-test-packet", userId: store.users.arda.id, kind: "packet",
      ptype: "input", text: "t", projectSlug: store.slug, taskKey: "VIB-1",
    });
    createNotification(store.db, {
      id: "n-test-mention", userId: store.users.arda.id, kind: "mention",
      text: "t", projectSlug: store.slug, taskKey: "VIB-1",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const rows = store.db
      .prepare(`SELECT id, read_at FROM notifications ORDER BY id`)
      .all()
      .map((row) => notificationReadRowSchema.parse(row));
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
  it("detects request-changes / failing signals", () => {
    expect(classifyReviewerVerdict("Requesting changes: the tests fail.")).toBe("request_changes");
    expect(classifyReviewerVerdict("This is a no-op — nothing was implemented.")).toBe("request_changes");
    expect(classifyReviewerVerdict("Found a blocker in the migration.")).toBe("request_changes");
  });

  it("detects approve / pass signals", () => {
    expect(classifyReviewerVerdict("LGTM — approved.")).toBe("approve");
    expect(classifyReviewerVerdict("No blocking issues, ready to accept.")).toBe("approve");
  });

  it("parses the required machine-readable verdict marker (F7-REV2)", () => {
    // The reviewer skill now mandates an opening `Verdict: approve` /
    // `Verdict: request-changes` line so the classifier never returns null and
    // the operator never re-runs the reviewer chasing an ambiguous report.
    expect(classifyReviewerVerdict("Verdict: approve\n\nChecked the diff.")).toBe("approve");
    expect(
      classifyReviewerVerdict("Verdict: request-changes\n\nMissing a null guard."),
    ).toBe("request_changes");
    // The exact prose that stalled VIB-5 live — now prefixed with a marker,
    // it classifies instead of returning null.
    expect(
      classifyReviewerVerdict(
        "Verdict: approve\n\nThe task already appears complete; the file is present and correct.",
      ),
    ).toBe("approve");
  });

  it("does NOT misread a clean APPROVE that mentions negated fail/blocker words", () => {
    // The live VSW-3 bug: a thorough approval that says "no blockers" / "no
    // tests fail" must classify as approve, not request_changes.
    expect(
      classifyReviewerVerdict(
        "## Review verdict — **APPROVE**. Verified the diff; no blockers, no tests fail. Ready to accept.",
      ),
    ).toBe("approve");
    expect(
      classifyReviewerVerdict("Verdict: PASS. The change is clean and nothing fails."),
    ).toBe("approve");
    expect(
      classifyReviewerVerdict("Approve — checks don't fail and there are zero blockers."),
    ).toBe("approve");
  });

  it("still catches an assertive failure even alongside an explicit reject verdict", () => {
    expect(
      classifyReviewerVerdict("Verdict: request changes — the new test fails on empty input."),
    ).toBe("request_changes");
    expect(classifyReviewerVerdict("The build fails on CI.")).toBe("request_changes");
  });

  it("returns null on an unclear verdict", () => {
    expect(classifyReviewerVerdict("I looked at the diff.")).toBeNull();
    expect(classifyReviewerVerdict(null)).toBeNull();
    expect(classifyReviewerVerdict("")).toBeNull();
  });

  it("treats none/nothing as negators and catches the failure(s) noun (F3)", () => {
    expect(
      classifyReviewerVerdict("Approve — none of the tests fail; nothing fails."),
    ).toBe("approve");
    expect(classifyReviewerVerdict("The suite has failures on CI.")).toBe(
      "request_changes",
    );
    expect(classifyReviewerVerdict("Approved. No failures were observed.")).toBe(
      "approve",
    );
  });
});

describe("recordAgentCompletion — failing verdict drops a stale accept-completion rec (pass-8)", () => {
  /** The reviewer completion: verdict resolved BY THE CALLER (the classifier
   *  over the same reply — the old recordReviewerVerdict intent), reply posted
   *  atomically with it. */
  async function recordReviewerReply(store: TestStore, replyText: string) {
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: {
          kind: "agent",
          backend: "claude",
          profileId: "reviewer",
          roleHint: "Review & validation",
        },
        runId: "run_rv1",
        replyText,
        verdict: classifyReviewerVerdict(replyText),
        question: null,
      },
    );
  }

  it("clears accept_completion recommendations when the reviewer requests changes", async () => {
    const store = prepared();
    // Review stage, previously clean (validation healthy) with a pending
    // accept-completion recommendation from that earlier pass.
    withTask(store, {
      stage: "review",
      validation: "healthy",
      branch: "vib-1-work",
      engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      workRevision: workRev("rev_1"),
      recommendations: [
        { id: "rec-acc", kind: "accept_completion", toStageId: "done", label: "Accept completion", detail: "Clean review." },
        { id: "rec-tr", kind: "transition", toStageId: "review", label: "Move to Review", detail: "" },
      ],
    });
    await recordReviewerReply(
      store,
      "Requesting changes: the heading is ALL CAPS and the Scope blockquote is missing.",
    );
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    // The stale "Accept completion" card is gone; unrelated recs survive.
    expect(fm.recommendations.map((r) => r.kind)).toEqual(["transition"]);
  });

  it("keeps accept_completion when the reviewer approves (validation stays healthy)", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      validation: "healthy",
      branch: "vib-1-work",
      // The single required reviewer — its approve derives validation → healthy.
      engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      workRevision: workRev("rev_1"),
      recommendations: [
        { id: "rec-acc", kind: "accept_completion", toStageId: "done", label: "Accept completion", detail: "" },
      ],
    });
    await recordReviewerReply(store, "Approve — looks good, all four checks pass.");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.validation).toBe("healthy");
    expect(fm.recommendations.map((r) => r.kind)).toEqual(["accept_completion"]);
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

  it("still refuses a CLOSED PR — the arm below relaxes only the merged one", async () => {
    // R16-3: a PR closed without merging can never be merged. The already-merged
    // no-op must not become a blanket "any settled PR is fine".
    const store = prepared();
    withTask(store, {
      stage: "done",
      pr: { number: 7, state: "closed", title: "PR" },
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

  it("F21-23: an already-merged PR settles as a no-op success, not a 409", async () => {
    // Live (UC-15): a human merged the PR on GitHub while the merge-pending
    // ceremony sat open. The poller adopted `state: merged`, the dialog
    // re-rendered as "Nothing merges … Finish accepting VIB-1" — and this door
    // threw "This PR is already merged." at the button it had just relabelled.
    // The dialog promised what the server refused.
    //
    // CANARY: restore the `pr.state === "merged"` arm of the old conflict throw.
    const store = prepared();
    withTask(store, {
      stage: "done",
      pr: { number: 7, state: "merged", title: "PR" },
    });
    // Typed through the seam's own contract: a call would resolve "merged", so
    // the assertion below cannot pass merely because the double is inert.
    const merge = vi.fn(async () => ({
      status: "merged" as const,
      prNumber: 7,
      sha: null,
    }));
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;

    const result = await completeTaskMerge(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot, deps: { mergeTaskPr: merge } },
    );

    // Honest on both halves: merged on GitHub, nothing merged now.
    expect(result.merged).toBe(true);
    expect(result.message).toMatch(/already merged on GitHub/);
    expect(result.message).toMatch(/nothing merged now/);
    // No merge was attempted, and the no-op wrote nothing — the acceptance that
    // stamped this PR "accepted" already recorded its completion.
    expect(merge).not.toHaveBeenCalled();
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(after.frontmatter.pr?.state).toBe("merged");
    expect(after.frontmatter.stage).toBe(before.frontmatter.stage);
    expect(after.timeline).toHaveLength(before.timeline.length);
  });

  it("keeps the merge authority on the no-op arm (contributor still forbidden)", async () => {
    // The early return must sit BEHIND `requireAcceptCompletion`, or an
    // already-merged PR becomes a free read of the task summary for anyone.
    const store = prepared();
    withTask(store, {
      stage: "done",
      pr: { number: 7, state: "merged", title: "PR" },
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

  it("is admin|maintainer only (contributor forbidden)", async () => {
    const store = prepared();
    withTask(store, {
      stage: "done",
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
      stage: "done",
      pr: { number: 7, state: "accepted", title: "PR" },
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
