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
  writeProject,
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
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";

import { getTaskDetail } from "~/server/projections/task-query.server";
import { getBoard, listProjectTasks } from "~/server/projections/board-query.server";
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
import { resolveRemoteBranchCollision } from "~/server/github/github-reconciler.server";

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
    { kind: "accept_completion", t: "Accept completion", d: "", rec: true },
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
    rounds: 1,
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
    // F32-11 (pass 32): the open decision (PACKET) died with this acceptance —
    // said on the timeline and in the audit trail, never silently. Live
    // (VIB-3) a force-accept at Triage cleared a packet with no trace.
    // Canary: drop the `withdrawn` block in applyAcceptanceWrite.
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.packet).toBeNull();
    expect(
      detail.timeline.some(
        (e) => e.type === "note" && e.text.includes(`Withdrew the open decision "${PACKET.title}"`),
      ),
    ).toBe(true);
    const withdrawn = listAuditEvents(store.db, { action: "task.packet.withdrawn" });
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.details).toMatchObject({
      title: PACKET.title,
      kind: PACKET.kind,
      by: "force-accept",
    });
  });

  it("forceAcceptCompletion on a task with NO open decision records no withdrawal (F32-11)", async () => {
    const store = prepared();
    withTask(store, {
      stage: "review",
      ownerUserId: store.users.arda.id,
      branch: "vib-1-work",
      engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      workRevision: workRev("rev_1"),
      verdicts: [rejectionVerdict("rev_1")],
      validation: "failing",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(0);
    expect(
      getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.some((e) =>
        e.text.includes("Withdrew the open decision"),
      ),
    ).toBe(false);
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
    // Ruling 98: every real move records where the task CAME from — the
    // durable previous-stage fact the operator's agent choice weighs.
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.previousStageId).toBe("triage");
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

  /**
   * F32-10 (pass 32, RBAC probe D1): the idempotent short-circuit sat ABOVE
   * every guard, so a viewer posting the task's current stage got `ok: true`
   * and "Moved …" with no denial row — a deny that answered allow. An
   * idempotent success is still a success and has to be earned: the same-stage
   * move pays the same gate a real move would, and the refusal is audited.
   */
  it("refuses a same-stage move to a role that could not make the real move, and audits it", async () => {
    const store = prepared();
    withTask(store, { stage: "ready" });
    const denialsBefore = listAuditEvents(store.db, {
      action: "project.authority.denied",
    }).length;
    for (const who of [store.users.elif, store.users.selin]) {
      await expect(
        transitionStage(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
          actor(who),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(
      listAuditEvents(store.db, { action: "project.authority.denied" }).length,
    ).toBe(denialsBefore + 2);
    // The maintainer's no-op still succeeds and still writes nothing.
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.length;
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
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

  it("ruling 98: a packet-resolved acceptance records the stage it came from", async () => {
    // CANARY: drop the previousStageId line from resolvePacket's accept arm —
    // the Done task still claims it arrived from `impl`.
    //
    // Every stage write records where the task came from, and this is the one
    // Done door that writes the terminal stage itself rather than going through
    // `applyAcceptanceWrite`. Left alone, the field names the stage two hops
    // back and the next operator turn is told the task arrived from there.
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        previousStageId: "impl", // the stamp impl -> review left behind
        waiting: "human",
        pr: { number: 318, state: "review", title: "PR" },
      },
      PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.stage).toBe("done");
    expect(fm.previousStageId).toBe("review");
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

  it("ruling 152(c) + 164: the option that says the window has reset RETIRES the exhaustion record", async () => {
    // The specialist quota packet's "The window has reset …, or the Codex
    // account changed: send @dev back to continue" and the operator's "…: re-run"
    // are the person's statement that the stored record is stale. Nothing else
    // retires it — only a run that COMPLETES on the backend clears it, and the
    // dispatch hold stops any run from starting until the recorded instant
    // passes — so the option resolved, the dispatch was held again and the
    // stated remedy was overridden by the record it contradicts. Canary: drop
    // the `clearBackendQuotaExhaustion` call from `resolvePacket`.
    const store = prepared();
    const quotaPacket: TaskPacket = {
      ...PACKET,
      options: [
        {
          kind: "request_edit",
          t: "The window has reset (Sep 7, 2026 · 16:00 UTC), or the Codex account changed: send @dev back to continue",
          d: "Closes this decision and re-runs the agent on the owner's current account with the same directive.",
          rec: true,
          backend: "codex",
        },
        { kind: "redirect", t: "Redirect with sharper guidance", d: "", rec: false },
      ],
    };
    withTask(store, { stage: "review", waiting: "human" }, quotaPacket);
    const { recordBackendQuotaExhaustion, backendDispatchHold } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const record = {
      credentialUserId: store.users.arda.id,
      credentialLabel: "Arda",
      resetsAt: Math.round(Date.now() / 1000) + 6 * 3600,
      resetsAtPrecision: "clock" as const,
      providerText: "You've hit your usage limit.",
      runId: "run_refused",
      observedAt: new Date().toISOString(),
    };
    recordBackendQuotaExhaustion(store.db, "codex", record);
    const hold = { credentialUserId: store.users.arda.id };
    expect(backendDispatchHold(store.db, "codex", hold)).not.toBeNull();

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(backendDispatchHold(store.db, "codex", hold)).toBeNull();

  });

  it("an option that asserts nothing about quota names no backend and leaves the record standing", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    const { recordBackendQuotaExhaustion, backendDispatchHold } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    recordBackendQuotaExhaustion(store.db, "codex", {
      credentialUserId: store.users.arda.id,
      credentialLabel: "Arda",
      resetsAt: Math.round(Date.now() / 1000) + 6 * 3600,
      resetsAtPrecision: "clock",
      providerText: "You've hit your usage limit.",
      runId: "run_refused",
      observedAt: new Date().toISOString(),
    });
    // Option 1 is the plain "Request one edit": a send-back that says nothing
    // about anyone's usage window.
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(
      backendDispatchHold(store.db, "codex", { credentialUserId: store.users.arda.id }),
    ).not.toBeNull();
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
    // Ruling 130(c) (pass 34, F34-12): without a pre-authored `ev` the record
    // restates the option's OWN words. It used to assert "policy / credential
    // updated" whatever the option said, and an operator reading that record
    // told a specialist a GitHub-scope block had been lifted (JC-6).
    // Canary: reinstate the fixed "policy / credential updated" sentence.
    expect(detail?.timeline[0]).toMatchObject({
      type: "transition",
      text: "**Decision:** Block on policy. VIB-1 is unblocked and the operator re-runs to re-check. If it is still blocked, a new decision packet is opened.",
    });
    expect(detail?.timeline[0]?.text).not.toContain("policy / credential updated");
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
      "**Decision:** hold for runtime debug. VIB-1 stays blocked while the provider-native session is inspected. Coordination is paused and no operator run was started. **Run operator** on the task page restarts it — that control belongs to a maintainer or an admin, so ask one if you do not see it.",
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
  it("ruling 133: a retry_other_backend resolution starts the retry for a deliverer scoped away from the current stage", { timeout: 20_000 }, async () => {
    // Canary: reinstate the unconditional `assertStageEligible` in
    // dispatchAgentRun (the resolution's retry is refused).
    installFakeRuntime();
    const store = prepared();
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }],
          extras: [],
          definition: { kind: "specialist", name: "dev", role: "developer", backends: ["codex", "claude"], model: "gpt-5.5", stages: ["review"] },
        },
      ],
    });
    withTask(
      store,
      {
        stage: "impl",
        waiting: "human",
        readiness: "blocked",
        ownerUserId: store.users.arda.id,
        engagements: [{ profileId: "dev", backend: "codex", role: "developer", delivers: true, verdictCapable: false }],
      },
      {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Work stalled: pick a recovery path",
        body: "",
        observations: [],
        options: [
          { kind: "retry_other_backend", t: "Retry @dev on Claude now", d: "", rec: true, backend: "claude" },
          { kind: "redirect", t: "Redirect", d: "", rec: false },
        ],
      },
    );
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.packet).toBeNull();
    expect(task.waiting).toBe("agent");
    const started = listAuditEvents(store.db).find((e) => e.action === "task.agent.run_started");
    expect(started?.details).toMatchObject({ profileId: "dev", backend: "claude", stageEligibility: "engaged-deliverer" });
  });

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
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: runs[0]!.id, dataRoot: store.dataRoot },
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

  /**
   * T7 (pass 31) — the packet is where the STICKY switch is actually decided,
   * and the test above stops one field short of it. It asserts the snapshot
   * (`engagement.backend`) moved, which a plain profile edit also does; the
   * pin (`pinnedBackend`) is the thing that makes the human's choice outrank
   * the live profile on every later run, and no test connected the two.
   *
   * Live 2026-08-31 (UC-2): a Codex quota error raised a recovery packet, the
   * human picked "Retry on Claude", and the switch had to survive the fact
   * that the Developer profile was still deployed on Codex.
   */
  it(
    "T7/F27-B1: resolving retry_other_backend PINS the engagement — the switch outlives the live profile",
    { timeout: 20_000 },
    async () => {
      // Canary: drop the `engaged.pinnedBackend = input.backendOverride`
      // write-back in specialist-run and the pin assertion fails; keep it but
      // reorder the resolver to prefer the live deployment and the second run
      // comes back on codex.
      const { interruptRun } = await import("~/server/runtimes/run-service.server");
      const { startAgentRun } = await import("./specialist-run.server");
      const { readProjectFile } = await import("~/server/files/project-writer.server");
      installFakeRuntime();
      const store = prepared();
      // The Developer profile is DEPLOYED ON CODEX — the backend the retry
      // exists to escape. Without a pin, every later run reverts to it.
      const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
      writeProject(store.dataRoot, {
        ...project.parsed.frontmatter,
        repo: null,
        agents: [
          {
            profileId: "dev",
            capabilities: [],
            extras: [],
            definition: {
              kind: "specialist",
              name: "dev",
              role: "developer",
              backends: ["codex"],
              model: "gpt-5.6-terra",
              effort: "",
            },
          },
        ],
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

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
        {
          type: "blocked",
          kind: "Blocked decision",
          from: "operator",
          title: "The Codex run failed — pick a recovery path",
          body: "",
          observations: [],
          options: [
            { kind: "retry_other_backend", t: "Retry on Claude Code", d: "", rec: true, backend: "claude" },
            { kind: "redirect", t: "Redirect", d: "", rec: false },
          ],
        },
      );

      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      );

      const read = () =>
        readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
          .parsed.frontmatter;
      const { listRunsForTaskRows } = await import("~/server/runtimes/run-store.server");
      const first = listRunsForTaskRows(store.db, store.slug, "VIB-1");
      expect(first).toHaveLength(1);
      expect(first[0]!.backend).toBe("claude");
      await interruptRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", runId: first[0]!.id, dataRoot: store.dataRoot },
        actor(store.users.murat),
      );

      // The packet's choice was recorded as a PIN, not just a snapshot refresh.
      expect(deliveringEngagement(read())?.pinnedBackend).toBe("claude");

      // …so the next ordinary run stays on Claude even though the deployed
      // profile still says Codex.
      const later = await startAgentRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      );
      await interruptRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", runId: later.runId, dataRoot: store.dataRoot },
        actor(store.users.murat),
      );
      expect(later.backend).toBe("claude");
    },
  );

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
            profileId: null,
            prompt: "re-check",
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

  // F31-6: the branch-collision remedy — refused tiers, honest degradation.
  const COLLISION_PACKET: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "Branch vib-1-work collides with an unrelated remote branch",
    body: "deliver_for_review push-conflicted: the remote branch holds unrelated commits.",
    observations: [],
    options: [
      {
        kind: "resolve_remote_collision",
        t: "Delete the stale remote branch, then redeliver",
        d: "",
        rec: true,
      },
      { kind: "custom", t: "Something else", d: "", rec: false },
    ],
  };

  it("resolve_remote_collision: contributor-owner refused (approve-transition tier); unconfigured GitHub degrades honestly", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id,
        branch: "vib-1-work",
        workRevision: {
          id: "rev_collision2",
          headSha: "c".repeat(40),
          treeSha: "d".repeat(40),
          branch: "vib-1-work",
          createdAt: new Date().toISOString(),
          sourceProfileId: "developer",
          kind: "delivered",
        },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    // Same tier as the sibling destructive options: the owner exception admits
    // selin to the packet, but clearing a collision deletes a remote ref.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { task, option } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(option.kind).toBe("resolve_remote_collision");
    // The decision stands even though GitHub is unconfigured in this fixture…
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const texts = detail!.timeline.map((e) => e.text);
    // …and the degradation is honest: not cleared, nothing re-delivered.
    expect(
      texts.some(
        (t) =>
          t.includes("The branch collision was **not** cleared") &&
          t.includes("Nothing was re-delivered"),
      ),
    ).toBe(true);
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toMatchObject({
      optionKind: "resolve_remote_collision",
    });
  });

  it("resolve_remote_collision: closes the unowned PR, deletes the stale remote branch, clears the R15-15 record, and reports the redelivery outcome", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const patActor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_collision00000000000000000000001" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    const github = fakeGithubFetch({
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: {
          id: "rev_collision3",
          headSha: "e".repeat(40),
          treeSha: "f".repeat(40),
          branch: "vib-1-work",
          createdAt: new Date().toISOString(),
          sourceProfileId: "developer",
          kind: "delivered",
        },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );

    // Both GitHub writes went out, and the DELETE went FIRST (C05-B): a
    // refused delete then leaves GitHub untouched, instead of having closed a
    // PR the refusal text went on to say nothing about.
    expect(github.callsTo("PATCH /repos/akin-ozer/viberr/pulls/232")).toHaveLength(1);
    expect(
      github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work"),
    ).toHaveLength(1);
    const order = github.calls.map((c) => `${c.method} ${c.url.pathname}`);
    expect(
      order.indexOf("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work"),
    ).toBeLessThan(order.indexOf("PATCH /repos/akin-ozer/viberr/pulls/232"));

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // The stale-collision record is cleared with the ref, not left to the next
    // reconcile poll.
    expect(fm.github?.unownedPr ?? null).toBeNull();

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const texts = detail!.timeline.map((e) => e.text);
    // U36-7 (pass 36): the ceremony's own event names BOTH facts.
    expect(
      texts.some((t) =>
        t.includes("Branch collision cleared: closed PR #232 and deleted branch `vib-1-work`"),
      ),
    ).toBe(true);
    expect(texts.some((t) => t.includes("Deleted branch `vib-1-work`"))).toBe(true);
    // No workspace exists in this fixture, so the redelivery degrades honestly
    // — cleared, but the push did not complete, with the next step named.
    expect(
      texts.some((t) =>
        t.includes("the re-delivery did not complete"),
      ),
    ).toBe(true);
    // V11: the lift is delivery-gated — a re-delivery that did NOT complete
    // leaves the block standing (the failure arm's block is still real).
    expect(fm.readiness).toBe("blocked");
    expect(
      listAuditEvents(store.db, { action: "github.pr.closed_unowned" }),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "github.branch.deleted" }),
    ).toHaveLength(1);
  });

  /** The collision tests' GitHub credential: a PAT on the project so the
   *  reconciler's writes reach the fake. */
  async function collisionCredential(store: TestStore): Promise<void> {
    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const patActor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_collision00000000000000000000002" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
  }

  /** Ruling 136(c): the reads the in-ceremony re-confirm makes when the
   *  task's own PR stands on the branch, as GitHub reports it. */
  function ownPrRoutes(number: number, state: "open" | "closed", headSha = "1".repeat(40)) {
    const pr = {
      number,
      html_url: `https://github.com/akin-ozer/viberr/pull/${number}`,
      title: "VIB-1: own review PR",
      state,
      draft: false,
      merged: false,
      merged_at: null,
      head: { sha: headSha },
      additions: 1,
      deletions: 0,
      changed_files: 1,
    };
    return {
      "GET /repos/akin-ozer/viberr/compare/main...vib-1-work": {
        body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [pr] },
      [`GET /repos/akin-ozer/viberr/pulls/${number}`]: { body: pr },
      [`GET /repos/akin-ozer/viberr/commits/${headSha}/check-runs`]: { body: { total_count: 0, check_runs: [] } },
      "GET /repos/akin-ozer/viberr/branches/vib-1-work": { body: { commit: { sha: headSha } } },
      "GET /repos/akin-ozer/viberr/git/ref/heads/main": { body: { object: { sha: "c".repeat(40) } } },
    };
  }

  const COLLISION_REVISION: WorkRevision = {
    id: "rev_collision4",
    headSha: "1".repeat(40),
    treeSha: "2".repeat(40),
    branch: "vib-1-work",
    createdAt: new Date().toISOString(),
    sourceProfileId: "developer",
    kind: "delivered",
  };

  it("resolve_remote_collision: the task's OWN open PR on the ref is no collision — nothing is closed or deleted, and the ceremony does what was asked (C05-B, ruling 136(b))", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    // GitHub confirms PR #5 open on the branch (ruling 136(c)); the DELETE
    // and PATCH routes exist so a regression that reaches them is caught.
    const github = fakeGithubFetch({
      ...ownPrRoutes(5, "open"),
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: { number: 5, state: "review", title: "VIB-1: own review PR" },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );
    expect(task.packet).toBeNull();
    // Canary: swap the order back (close, then delete) and the PATCH goes out.
    expect(github.callsTo("PATCH /repos/akin-ozer/viberr/pulls/232")).toHaveLength(0);
    expect(
      github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work"),
    ).toHaveLength(0);

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    // The premise was false and the note says so; with no workspace in this
    // fixture the delivery that would push the work cannot complete, so the
    // block stays and the note says that too.
    expect(
      texts.some(
        (t) =>
          t.includes("No collision to clear: PR #5 on `vib-1-work` is VIB-1's own review PR") &&
          t.includes("did not complete") &&
          t.includes("The block stays"),
      ),
    ).toBe(true);
    expect(texts.some((t) => t.includes("was **not** cleared"))).toBe(false);
    expect(fm.readiness).toBe("blocked");
    expect(texts.some((t) => t.includes("Closed unrelated PR"))).toBe(false);
    expect(listAuditEvents(store.db, { action: "github.pr.closed_unowned" })).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "github.collision.resolved" })[0]!.details).toMatchObject({
      outcome: "own_pr_delivery_failed",
      prNumber: 5,
      delivered: false,
      blockLifted: false,
    });
  });

  it("ruling 136(b): own PR open and origin merely BEHIND: the block lifts and the delivery actually runs", async () => {
    // Canary: keep `readiness: blocked` on every refusal.
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const pushed = "1".repeat(40);
    const github = fakeGithubFetch({
      ...ownPrRoutes(5, "open", "0".repeat(40)),
      // The re-confirm (ruling 136(c)) re-measures the record: origin's head
      // is an ancestor of the delivered revision.
      [`GET /repos/akin-ozer/viberr/compare/${pushed}...${"0".repeat(40)}`]: {
        body: { ahead_by: 0, behind_by: 1, status: "behind", commits: [] },
      },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: {
          number: 5, state: "review", title: "VIB-1: own review PR", headSha: "0".repeat(40),
          unpushedRevision: { revisionSha: pushed, prHeadSha: "0".repeat(40), relation: "behind" },
        },
        // The live JC-6/JC-5 shape: the recorded "collision" IS the task's own PR.
        github: { commits: [], changed: null, unownedPr: 5 },
      },
      COLLISION_PACKET,
    );
    const pushes: string[] = [];
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      {
        dataRoot: store.dataRoot,
        fetchImpl: github.fetchImpl,
        deps: {
          pushWorkspaceBranch: async () => {
            pushes.push("push");
            return { status: "pushed", branch: "vib-1-work", commits: 1, headSha: pushed, remoteHeadBefore: "0".repeat(40), workflowFiles: [] };
          },
        },
      },
    );
    expect(pushes).toEqual(["push"]);
    expect(github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work")).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.readiness).toBe("ready");
    expect(fm.github?.unownedPr ?? null, "a self-referencing collision record is cleared").toBeNull();
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("No collision to clear: PR #5") && t.includes("was pushed to it, and the block is lifted"))).toBe(true);
    expect(texts.some((t) => t.includes("Pushed `1111111` to **PR #5**"))).toBe(true);
    expect(listAuditEvents(store.db, { action: "github.collision.resolved" })[0]!.details).toMatchObject({
      outcome: "own_pr_pushed",
      prNumber: 5,
      delivered: true,
      blockLifted: true,
    });
  });

  it("ruling 136(b): own PR open and origin DIVERGED: the block stays and the note names the history", async () => {
    // Canary: lift on every `own_pr_open`.
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch({
      ...ownPrRoutes(5, "open", "0".repeat(40)),
      // The re-confirm re-measures the record and GitHub confirms `diverged`.
      [`GET /repos/akin-ozer/viberr/compare/${"1".repeat(40)}...${"0".repeat(40)}`]: {
        body: { ahead_by: 1, behind_by: 1, status: "diverged", commits: [] },
      },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: {
          number: 5, state: "review", title: "VIB-1: own review PR", headSha: "0".repeat(40),
          unpushedRevision: { revisionSha: "1".repeat(40), prHeadSha: "0".repeat(40), relation: "diverged" },
        },
        github: { commits: [], changed: null, unownedPr: 5 },
      },
      COLLISION_PACKET,
    );
    const pushes: string[] = [];
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      {
        dataRoot: store.dataRoot,
        fetchImpl: github.fetchImpl,
        deps: {
          pushWorkspaceBranch: async () => {
            pushes.push("push");
            return { status: "pushed", branch: "vib-1-work", commits: 1, headSha: "1".repeat(40), remoteHeadBefore: null, workflowFiles: [] };
          },
        },
      },
    );
    expect(pushes).toEqual([]);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.readiness).toBe("blocked");
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("No collision to clear: PR #5") && t.includes("holds commits this workspace does not") && t.includes("A person resolves the branch history"))).toBe(true);
    expect(listAuditEvents(store.db, { action: "github.collision.resolved" })[0]!.details).toMatchObject({ outcome: "own_pr_diverged", blockLifted: false });
  });

  it("ruling 136: GitHub refused the delete: the block stays and the operator is handed the typed reason", async () => {
    // Canary: lift on every refusal.
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch({
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 500, body: { message: "Server Error" } },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.readiness).toBe("blocked");
    expect(fm.github?.unownedPr).toBe(232);
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.filter((t) => t.includes("The branch collision was **not** cleared") && t.includes("GitHub refused the deletion"))).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "github.collision.resolved" })[0]!.details).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("GitHub refused the deletion"),
      delivered: false,
      blockLifted: false,
    });
  });

  it("ruling 136(c), the JC-3 shape: a cached open PR that GitHub reports CLOSED is re-confirmed, the ref deleted, the unowned PR closed", async () => {
    // Canary: decide from the cache and the DELETE never goes out.
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch({
      ...ownPrRoutes(5, "closed"),
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: { number: 5, state: "review", title: "VIB-1: own review PR" },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );
    expect(github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work")).toHaveLength(1);
    expect(github.callsTo("PATCH /repos/akin-ozer/viberr/pulls/232")).toHaveLength(1);
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("Deleted branch `vib-1-work`"))).toBe(true);
    // No workspace in this fixture: the re-delivery degrades honestly.
    expect(texts.some((t) => t.includes("the re-delivery did not complete"))).toBe(true);
    expect(listAuditEvents(store.db, { action: "github.collision.resolved" })[0]!.details).toMatchObject({ outcome: "cleared_delivery_failed" });
    // Nobody was told "PR #5 closed: VIB-1 needs a decision" by the re-confirm.
    const { listNotifications } = await import("~/server/projections/notifications.server");
    for (const user of Object.values(store.users)) {
      expect(
        listNotifications(store.db, user.id).filter((n) => /closed on GitHub|needs a decision/.test(n.title ?? "")),
      ).toEqual([]);
    }
  });

  it("resolve_remote_collision: a 403 on the PR close opens the pull_request:write scope violation instead of vanishing (C05-D)", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch({
      "PATCH /repos/akin-ozer/viberr/pulls/232": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );

    // The half-remedy is honest: the ref is gone (GitHub closes the PR on its
    // side), the collision record is cleared, and NO close is claimed.
    expect(
      github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work"),
    ).toHaveLength(1);
    expect(github.callsTo("PATCH /repos/akin-ozer/viberr/pulls/232")).toHaveLength(1);
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.unownedPr ?? null).toBeNull();
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes("Deleted branch `vib-1-work`"))).toBe(true);
    expect(texts.some((t) => t.includes("Closed unrelated PR"))).toBe(false);
    expect(listAuditEvents(store.db, { action: "github.pr.closed_unowned" })).toHaveLength(0);
    // …and the missing scope is the SAME fact openTaskPr/mergeTaskPr flag —
    // a violation with its policy event, not best-effort silence. Canary:
    // drop the 403 arm in resolveRemoteBranchCollision.
    const opened = listAuditEvents(store.db, { action: "github.scope_violation.opened" });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.details).toMatchObject({ scope: "pull_request:write" });
    expect(opened[0]!.taskKey).toBe("VIB-1");
    expect(
      texts.some((t) => t.includes("pull_request:write") && t.includes("#232")),
    ).toBe(true);
  });

  it("resolveRemoteBranchCollision: a system actor is refused before any GitHub write (C05-C)", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch({
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );
    // Closing someone else's PR and deleting a remote ref are HUMAN decisions;
    // the exported function refuses an anonymous actor itself (the ref delete's
    // own guard is the second line), and no write leaves the process.
    const result = await resolveRemoteBranchCollision(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      { userId: null, label: "system" },
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );
    expect(result).toEqual({ status: "refused", reason: "no_actor", message: "No acting user." });
    expect(github.calls).toHaveLength(0);
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.unownedPr).toBe(232);
  });

  /**
   * F33-2 (pass 33) — the decision event states the DECISION, not its effect.
   *
   * Both destructive arms wrote their outcome into the resolution event, which
   * is written unconditionally and BEFORE the work it describes. Live (VIB-1)
   * the remedy refused, and the canonical timeline then held the refusal note
   * ("The branch collision was **not** cleared: PR #270 is still open on
   * `vib-1` … Nothing was re-delivered.") one millisecond above a decision event
   * asserting the branch had been removed and the work re-delivered.
   */
  it("F33-2: the collision decision event claims no outcome — the refusal note is the only writer of one", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch(ownPrRoutes(270, "open"));
    // The task's own review PR stands on the ref (confirmed live, ruling
    // 136(c)), so the delete refuses — the safe outcome the C05-B ordering
    // exists to produce.
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: { number: 270, state: "review", title: "VIB-1: own review PR" },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );

    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map(
      (e) => e.text,
    );
    // The decision, in full, with nothing appended about what it achieved.
    expect(texts).toContain(
      "**Decision:** Delete the stale remote branch, then redeliver.",
    );
    expect(
      texts.some((t) => t.includes("The stale remote branch is removed")),
    ).toBe(false);
    // …and the outcome is on the timeline exactly once, from the note (ruling
    // 136(b): the task's own PR on the ref is no collision, and with no
    // workspace here the delivery that would push the work cannot complete).
    expect(
      texts.filter((t) => t.includes("No collision to clear: PR #270")),
    ).toHaveLength(1);
    expect(texts.some((t) => t.includes("was **not** cleared"))).toBe(false);
  });

  it("F33-2: the discard decision event claims no outcome either, and `ev` still overrides", async () => {
    const store = prepared();
    const packet: TaskPacket = {
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "The branch is empty — discard it?",
      body: "b",
      observations: [],
      options: [
        { kind: "discard_branch", t: "Discard the branch", d: "", rec: true },
      ],
    };
    // No branch at all: the discard has nothing to do, and its own note says so.
    withTask(store, { stage: "impl", waiting: "human" }, packet);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );

    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map(
      (e) => e.text,
    );
    expect(texts).toContain("**Decision:** Discard the branch.");
    expect(
      texts.some((t) => t.includes("local workspace branch is discarded")),
    ).toBe(false);
    expect(
      texts.some((t) =>
        t.includes("no workspace branch, so there is nothing to discard"),
      ),
    ).toBe(true);

    // The operator's own `ev` override is untouched by the trim.
    const store2 = prepared();
    const evPacket: TaskPacket = {
      ...packet,
      options: [
        {
          kind: "discard_branch",
          t: "Discard the branch",
          d: "",
          rec: true,
          ev: "**Decision:** drop the dead branch. Murat confirmed it holds nothing.",
        },
      ],
    };
    withTask(store2, { stage: "impl", waiting: "human" }, evPacket);
    await resolvePacket(
      store2.db,
      { projectSlug: store2.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store2.users.murat),
      { dataRoot: store2.dataRoot },
    );
    expect(
      getTaskDetail(store2.db, store2.slug, "VIB-1")!.timeline.map((e) => e.text),
    ).toContain(
      "**Decision:** drop the dead branch. Murat confirmed it holds nothing.",
    );
  });

  /**
   * F33-4 (pass 33) — ruling 110 ends "And it never strands", and F32-7 hung
   * that guarantee on the RE-DELIVERY: full autonomy re-queues the operator,
   * supervised records the "Move to <review>" card. The REFUSING arm runs no
   * re-delivery, so it inherited neither. Live (VIB-1): `stage: impl`,
   * `readiness: ready`, `waiting: human`, empty recommendations, no packet, and
   * PR #270 open on the branch — the strand ruling 110 quotes, reached through
   * the safe path the delete-first ordering exists to produce.
   */
  it("F33-4: a refused collision remedy still leaves the task actionable — the Move-to-review card over the PR it already carries", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    const github = fakeGithubFetch(ownPrRoutes(270, "open"));
    withTask(
      store,
      {
        // VIB-1's live shape: mid-flow, its own PR already open on the branch,
        // which is exactly WHY `deleteTaskRemoteBranch` refuses the ref.
        stage: "impl",
        waiting: "human",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        pr: { number: 270, state: "review", title: "VIB-1: own review PR" },
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // The remedy really did refuse — no WRITE reached GitHub (the ruling 136(c)
    // re-confirm reads). The live read finds the task's own PR on the branch,
    // so the stale collision record is cleared by the reconcile itself.
    expect(github.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(fm.github?.unownedPr ?? null).toBeNull();
    // …and the task is not stranded: one card, over the PR that IS open.
    expect(fm.recommendations).toHaveLength(1);
    expect(fm.recommendations[0]).toMatchObject({
      kind: "transition",
      toStageId: "review",
      label: "Move the task to Review",
    });
    expect(fm.recommendations[0]!.detail).toContain("#270");
    expect(fm.recommendations[0]!.detail).toContain("Recorded by Viberr");
    expect(
      listAuditEvents(store.db, { action: "github.delivery.next_step" }),
    ).toHaveLength(1);
  });

  it("F33-4: no card is invented when the refusal leaves no open PR to move to review over", async () => {
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    await collisionCredential(store);
    // No credential-free refusal here: the fake answers nothing, so the ref
    // delete fails and the remedy refuses with no PR anywhere on the task.
    const github = fakeGithubFetch({});
    withTask(
      store,
      {
        stage: "impl",
        waiting: "human",
        branch: "vib-1-work",
        workRevision: COLLISION_REVISION,
        github: { commits: [], changed: null, unownedPr: 232 },
      },
      COLLISION_PACKET,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // A "review pull request #N is open" card with no N would be a lie; the
    // refusal note names the remedy instead.
    expect(fm.recommendations).toHaveLength(0);
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map(
      (e) => e.text,
    );
    expect(
      texts.some((t) => t.includes("The branch collision was **not** cleared")),
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

  it("ruling 161 (G35-6): the discard retires the reported revision: kind discarded, validation none, note and audit name it", async () => {
    // Canary: drop the `retires` block from the discard_branch resolution and
    // the revision stays `delivered` with its approve keeping the task healthy.
    const store = prepared();
    const revisionId = "rev_MBEIgNbXXyFX";
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        branch: "vib-1-work",
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review",
            delivers: false,
            verdictCapable: true,
          },
        ],
        workRevision: {
          id: revisionId,
          headSha: "8c463b7".padEnd(40, "0"),
          treeSha: "b".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-09-06T18:56:57.000Z",
          sourceProfileId: "developer",
          kind: "delivered",
        },
        verdicts: [
          {
            profileId: "reviewer",
            revisionId,
            headSha: "8c463b7".padEnd(40, "0"),
            result: "approve",
            reason: "fine",
            at: "2026-09-06T19:00:00.000Z",
            rounds: 1,
          },
        ],
        validation: "healthy",
      },
      DISCARD_PACKET,
    );
    initTaskWorkspace(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.branch).toBeNull();
    expect(fm.workRevision?.id).toBe(revisionId);
    expect(fm.workRevision?.kind).toBe("discarded");
    // The verdict is history, not erased; the derived cache says nothing is owed.
    expect(fm.verdicts).toHaveLength(1);
    expect(fm.validation).toBe("none");
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(
      texts.some(
        (t) => t.includes(`Revision \`${revisionId}\``) && t.includes("is retired with it"),
      ),
    ).toBe(true);
    const discarded = listAuditEvents(store.db, { action: "task.branch.discarded" });
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.details).toMatchObject({
      branch: "vib-1-work",
      localSha: expect.any(String),
      basis: "local_only",
      remoteSha: null,
      retiredRevisionId: revisionId,
    });
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

  it("ruling 161 (U35-8): archive + deleteBranch records BOTH heads: the local sha and the foreign remote head it deleted", async () => {
    // Live (KNC-21): the audit named the local head 8c463b7 while the deleted
    // remote `knc-21` held the foreign fixture commit d5f23aa. Canary: drop
    // the pre-delete ref read in `deleteTaskRemoteBranch` (remoteSha null) or
    // write `sha` instead of `localSha`/`remoteSha` on the archive row.
    const store = prepared();
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const patActor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_foreignhead000000000000000000001" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    const remoteSha = "d5f23aa".padEnd(40, "1");
    const github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/git/ref/heads/vib-1-work": {
        status: 200,
        body: { ref: "refs/heads/vib-1-work", object: { sha: remoteSha, type: "commit" } },
      },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
    });
    withTask(
      store,
      {
        stage: "review",
        waiting: "human",
        pr: { number: 318, state: "closed", title: "PR" },
        branch: "vib-1-work",
        github: {
          commits: [],
          changed: null,
          foreignHead: { sha: remoteSha, prNumber: null },
        },
      },
      RECOVERY_PACKET,
    );
    const repoDir = initTaskWorkspace(store);
    const localSha = gitc(repoDir, ["rev-parse", "refs/heads/vib-1-work"]);
    expect(localSha).not.toBe(remoteSha);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
    );
    expect(
      github.callsTo("DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work"),
    ).toHaveLength(1);
    const deleted = listAuditEvents(store.db, { action: "github.branch.deleted" });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.details).toMatchObject({ branch: "vib-1-work", sha: remoteSha });
    const discarded = listAuditEvents(store.db, { action: "task.branch.discarded" });
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.details).toEqual({
      branch: "vib-1-work",
      localSha,
      remoteSha,
      basis: "archive_cleanup",
    });
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map((e) => e.text);
    expect(texts.some((t) => t.includes(`Its head was \`${remoteSha.slice(0, 12)}\``))).toBe(true);
    expect(
      texts.some((t) => t.includes(`Origin's copy stood at \`${remoteSha.slice(0, 12)}\``)),
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
    // Ruling 138: the packet records WHICH option was chosen, by whom, when —
    // what a reload renders as decided. Canary: drop the `decided` stamp.
    expect(stamped.packet?.decided).toMatchObject({ optionIndex: 0, byUserId: store.users.murat.id });
    expect(stamped.packet?.decided?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
        { id: "rec-tr", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" },
        { id: "rec-run", kind: "run_agent", profileId: "developer", label: "Run Developer", detail: "Keep going." },
      ],
    });
    await recordReviewerReply(
      store,
      "Requesting changes: the heading is ALL CAPS and the Scope blockquote is missing.",
    );
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    // The stale "Accept completion" card is gone, and so is the "move on" card
    // (F36-6, pass 36: a failing verdict voids any pending transition card);
    // unrelated recs survive.
    expect(fm.recommendations.map((r) => r.kind)).toEqual(["run_agent"]);
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

/**
 * Ruling 164 (pass 35, F35-14) — the two kinds that perform what their title
 * promises.
 *
 * Live: KNC-3's `custom` "Force-accept as admin without a fresh verdict"
 * recorded a decision and re-ran the operator into a no-op behind the verdict
 * gate; KNC-16's `redirect` "Move KNC-16 back to Review" moved nothing. These
 * cases assert the acts themselves, on the same paths their buttons take.
 */
describe("ruling 164: force_accept and move_stage perform their option's promise", () => {
  const forcePacket: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "No verdict-capable agent can run at this stage",
    body: "b",
    observations: [],
    options: [
      {
        kind: "force_accept",
        t: "Force-accept as admin without a fresh verdict",
        d: "",
        rec: true,
      },
    ],
  };

  const movePacket = (toStage: string): TaskPacket => ({
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "The reviewer cannot run where the task stands",
    body: "b",
    observations: [],
    options: [
      {
        kind: "move_stage",
        t: "Move VIB-1 back to Review so the reviewer can verdict",
        d: "",
        rec: true,
        toStage,
      },
    ],
  });

  /** A task wedged exactly as KNC-3 was: a standing rejection on the current
   *  revision, so the acceptance gate refuses and only the override is left. */
  function wedged(store: TestStore, packet: TaskPacket): void {
    withTask(
      store,
      {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [rejectionVerdict("rev_1")],
        validation: "failing",
      },
      packet,
    );
  }

  it("force_accept: an admin's confirm closes the task through the force path, audited", async () => {
    const store = prepared();
    wedged(store, forcePacket);

    const res = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda), // admin: the Force accept button's own tier
      { dataRoot: store.dataRoot },
    );
    expect(res.option.kind).toBe("force_accept");

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // The act, not just its record: the task is closed and the durable bypass
    // fact is stamped, exactly as the button leaves it.
    expect(fm.stage).toBe("done");
    expect(fm.acceptance).toBe("forced");
    // The same audited bypass record, naming the gate it overrode.
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(String(forced[0]!.details!.bypassed)).toContain("request");
    // The decision is on the record too, above the acceptance it caused.
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map(
      (e) => e.text,
    );
    expect(texts).toContain(
      "**Decision:** Force-accept as admin without a fresh verdict.",
    );
    expect(texts.some((t) => t.includes("Completion accepted"))).toBe(false);
  });

  it("force_accept: a maintainer is refused in the Force accept button's own words, and the packet stands", async () => {
    const store = prepared();
    wedged(store, forcePacket);

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.murat), // maintainer: may resolve packets, may not force
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/force-accept past the review gate/i);

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    // Refused BEFORE the write: the decision is still open and nothing closed.
    expect(parsed.frontmatter.stage).toBe("impl");
    expect(parsed.packet).not.toBeNull();
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(0);
  });

  it("move_stage: the confirm moves the task on the stage picker's path, with its transition record", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      },
      movePacket("review"),
    );

    const res = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat), // maintainer: the stage picker's own tier
      { dataRoot: store.dataRoot },
    );
    expect(res.task.stage).toBe("review");

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.stage).toBe("review");
    expect(parsed.frontmatter.previousStageId).toBe("impl");
    expect(parsed.packet).toBeNull();
    const texts = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.map(
      (e) => e.text,
    );
    // The decision states the decision; the move's own event states the move.
    expect(texts).toContain(
      "**Decision:** Move VIB-1 back to Review so the reviewer can verdict.",
    );
    expect(
      texts.some((t) => t.includes("**Transition:**") && t.includes("to Review")),
    ).toBe(true);
    const moves = listAuditEvents(store.db, { action: "task.transition" });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.details!.to).toBe("review");
    expect(moves[0]!.details!.manual).toBe(true);
  });

  /**
   * Ruling 224 (F37-44). The Codex window went at 23:28 with the provider
   * naming its own reopening, and six tasks stalled at once behind a packet
   * whose every option was wrong right then. The wait is the remedy, and
   * viberr already had the runner for it — what it lacked was a way to say so
   * that also closed the decision.
   */
  it("wait_for_window: the confirm closes the decision and schedules the resume (ruling 224)", async () => {
    const store = prepared();
    const due = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    withTask(
      store,
      {
        stage: "impl",
        waiting: "agent",
        readiness: "blocked",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      },
      {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Work stalled: pick a recovery path",
        body: "Codex refused the agent run: over its usage limit.",
        observations: [],
        options: [
          {
            kind: "wait_for_window",
            t: "Wait for the window and resume @dev automatically",
            d: "",
            rec: true,
            dueAt: due,
          },
        ],
      },
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.packet).toBeNull();
    // The block the packet held down goes with it…
    expect(parsed.frontmatter.readiness).toBe("ready");
    // …and the board must NOT claim an agent: none is coming for three hours,
    // which is F37-33's lie by another road.
    expect(parsed.frontmatter.waiting).toBe("human");
    // CANARY: drop the schedule effect and this is empty — the decision then
    // promises an automatic resume that nothing performs.
    expect(parsed.frontmatter.schedules).toHaveLength(1);
    const sched = parsed.frontmatter.schedules[0]!;
    // The OPERATOR, not the agent: after a gap of hours the board may have
    // moved, and every other timed resume viberr has re-invokes the operator
    // for exactly that reason.
    expect(sched.action).toBe("run-operator");
    expect(sched.status).toBe("pending");
    // Just AFTER the provider's instant: a window that reopens "at 02:27" is
    // not open at 02:27:00.
    expect(Date.parse(sched.dueAt)).toBeGreaterThan(Date.parse(due));
    expect(sched.prompt).toContain("has reopened");
    // (That this resolution must start NO run is asserted in
    // `delivery-requeue.server.test.ts`, where `runOperator` is mocked — this
    // store deploys no operator, so a run-count assertion here would pass
    // against code with no NO_REQUEUE entry at all.)
  });

  it("wait_for_window: a schedule that cannot be written says so and leaves the decision resolved (ruling 224)", async () => {
    const store = prepared();
    const due = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    withTask(
      store,
      {
        stage: "impl",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
        archived: true, // a closed task refuses a schedule (ruling 177)
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      },
      {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Work stalled: pick a recovery path",
        body: "b",
        observations: [],
        options: [
          {
            kind: "wait_for_window",
            t: "Wait for the window and pick it back up automatically",
            d: "",
            rec: true,
            dueAt: due,
          },
        ],
      },
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    // The decision stands — a refused side effect never un-resolves a decision
    // a human made, exactly as the move_stage ceremony behaves.
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.schedules).toHaveLength(0);
    // CANARY: swallow the failure silently and the timeline promises an
    // automatic resume that will never come, which is worse than the stall.
    expect(
      parsed.timeline.some(
        (e) =>
          e.text.includes("was **not** scheduled to resume") &&
          e.text.includes("run it yourself"),
      ),
    ).toBe(true);
  });

  it("move_stage: resolving a BLOCKED packet lifts the block it was holding down", async () => {
    // Canary: restore `mutate = () => {}` in the move_stage arm. The packet
    // clears, `transitionStage` deliberately lets a stored `blocked` survive a
    // move, and the board is left showing a blocked task with no decision on
    // it and nothing a person can do — the shape this kind was created for
    // (KNC-16: the reviewer cannot run where the task stands, which arrives as
    // a `blocked` packet).
    const store = prepared();
    const blockedMove: TaskPacket = { ...movePacket("review"), type: "blocked" };
    withTask(
      store,
      {
        stage: "impl",
        readiness: "blocked",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      },
      blockedMove,
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.stage).toBe("review");
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.readiness).toBe("ready");
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.displayReadiness).not.toBe("blocked");
  });

  it("move_stage: a stage this project does not have is refused before the packet clears", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, movePacket("nowhere"));

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/not a stage of this project/i);

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.stage).toBe("impl");
    expect(parsed.packet).not.toBeNull();
  });

  it("move_stage: a contributor owner hears the stage picker's tier, not a silent widening", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.selin.id }, // selin = contributor
      movePacket("review"),
    );

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/change the task stage/i);

    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("impl");
  });
});

/**
 * Ruling 189 (pass 37, F37-10): a person's decision joins the task's CONTRACT.
 *
 * Live on SHOP-7, the goal said "the agent must not select a provider … ask
 * Arda to choose". Arda chose; the agent recorded the choice; the required
 * reviewer re-anchored on the canonical file — as its prompt tells it to —
 * found the deliverable contradicting the goal and requested changes; the
 * operator told the agent to "remove every claim that mock-only was selected";
 * and a second packet asked Arda the same question again. The decision lived in
 * the timeline, the contract lived in the goal, and the goal is what a fresh
 * run reads.
 */
describe("ruling 189: a resolved decision amends the task goal", () => {
  const QUESTION: TaskPacket = {
    type: "input",
    kind: "Agent question",
    from: "agent:codex/architect (Architect)",
    title: "Choose the payment provider",
    body: "Stripe, Adyen or mock-only?",
    observations: [],
    // `custom` is what a real agent question carries — SHOP-7's live packet
    // offered Stripe / Adyen / Mock-only as `custom` options.
    options: [
      { kind: "custom", t: "Stripe", d: "Hosted Stripe Checkout.", rec: true },
      { kind: "custom", t: "Mock-only", d: "Deterministic, non-monetary.", rec: false },
    ],
  };

  const goalOf = (store: TestStore): string =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.goal;

  /**
   * Ruling 284 (owner's call, 2026-09-15) inverted this test's subject.
   *
   * Ruling 189 welded a typed directive into the goal "because a person wrote
   * it". One text box takes both a scope decision and a word to the operator
   * about its own tooling, so the kind of the answer was unknowable — and live
   * on SHOP-27 a directive that was mostly "call read_board before you offer a
   * create_task option" went into the goal of the orders service, where every
   * future run on it re-anchors. The line is drawn by CHANNEL now: choosing a
   * structured option is a decision and amends the contract; typing free text
   * is conversation and does not.
   */
  it("ruling 284: a typed CUSTOM directive answers the packet and does NOT touch the goal", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, QUESTION);
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        custom: "Mock-only, behind a PaymentProvider port. No provider SDK.",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const goal = goalOf(store);
    expect(goal).not.toContain("Mock-only, behind a PaymentProvider port");
    expect(goal).not.toContain("the decision wins");
    // Nothing is lost by leaving it out: the directive is on the timeline
    // verbatim, which is where a human and the operator both read it.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.timeline.map((e) => e.text).join("\n")).toContain(
      "Mock-only, behind a PaymentProvider port",
    );
  });

  it("ruling 189 still stands for a CHOSEN option: it amends the contract", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, QUESTION);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const goal = goalOf(store);
    expect(goal).toContain("Choose the payment provider");
    // The clause that settles the contradiction the amendment may create — the
    // reviewer must not read the answer as an agent overstepping.
    expect(goal).toContain("the decision wins");
  });

  it("writes a CHOSEN option into the goal too, title and description", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, QUESTION);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const goal = goalOf(store);
    expect(goal).toContain("Mock-only");
    expect(goal).toContain("Deterministic, non-monetary");
  });

  it("keeps the original goal above it — the amendment adds, never replaces", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", ownerUserId: store.users.arda.id }, QUESTION);
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(goalOf(store).startsWith(before.trimEnd())).toBe(true);
  });

  it("does NOT amend for a RECOVERY choice — that decides what happens next, not what the work is", async () => {
    const store = prepared();
    // Live on SHOP-7 the goal collected "Work stalled: pick a recovery path →
    // Redirect with sharper guidance" beside the real provider decision. A
    // recovery choice is process, and process accumulating in the text every
    // future run re-anchors on is the noise this exclusion prevents.
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        title: "Work stalled: pick a recovery path",
        options: [
          { kind: "redirect", t: "Redirect with sharper guidance", d: "", rec: true },
          { kind: "request_edit", t: "Send back for another attempt", d: "", rec: false },
        ],
      },
    );
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(goalOf(store)).toBe(before);
  });

  /**
   * Found by the pass's own self-review (ruling 200(h)): the ruling's stated
   * exclusion is "a resolution that ENDS the task", and `acceptsInto` catches
   * only ONE of the two doors that do. `force_accept` closes the task through
   * `forceAcceptCompletion` and never assigns it, so a task being closed in the
   * same breath still collected a contract amendment binding future work it
   * will never have.
   */
  it("does NOT amend when the resolution FORCE-ACCEPTS the task closed", async () => {
    const store = prepared();
    withTask(
      store,
      {
        stage: "review",
        ownerUserId: store.users.arda.id,
        workRevision: {
          id: "rev_fa",
          headSha: "f".repeat(40),
          treeSha: "t".repeat(40),
          branch: "vib-1",
          createdAt: "2026-09-13T09:00:00.000Z",
          sourceProfileId: "dev",
        },
        noChanges: true,
      },
      {
        ...QUESTION,
        title: "Acceptance is wedged",
        options: [
          {
            kind: "force_accept",
            t: "Force-accept as admin without a fresh verdict",
            d: "",
            rec: true,
          },
        ],
      },
    );
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: test only `acceptsInto !== null` again and a closed task's goal
    // grows a decision block nobody will ever act on.
    expect(goalOf(store)).toBe(before);
  });

  it("does NOT amend on block_on_policy — an unblock is what happens next, not what the work is", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        type: "blocked",
        title: "The run failed on a credential",
        options: [{ kind: "block_on_policy", t: "Unblock", d: "", rec: true }],
      },
    );
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop `block_on_policy` from PROCESS_ONLY_OPTION_KINDS and "I
    // fixed the credential, carry on" lands in the task's contract.
    expect(goalOf(store)).toBe(before);
  });

  it("F37-60: does NOT amend on wait_for_window or block_on_dependencies either", async () => {
    // Both kinds POSTDATE ruling 189, so neither was added to its exclusion
    // list, and the defect the ruling exists to stop came back through them.
    // Live on SHOP-18: its goal carried five decision blocks, THREE of them
    // "pick a recovery path → Wait for the window and pick the task back up
    // automatically" — the same sentence ruling 189 quotes from SHOP-7 as the
    // thing that must not be in a contract.
    // CANARY: drop either kind from PROCESS_ONLY_OPTION_KINDS.
    for (const option of [
      {
        kind: "wait_for_window" as const,
        t: "Wait for the window and pick the task back up automatically",
        d: "",
        rec: true,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      {
        kind: "block_on_dependencies" as const,
        t: "Hold this until those land",
        d: "",
        rec: true,
        blockedBy: ["VIB-2"],
      },
    ]) {
      const store = prepared();
      withTask(
        store,
        { stage: "impl", ownerUserId: store.users.arda.id },
        { ...QUESTION, title: "Work stalled: pick a recovery path", options: [option] },
      );
      const before = goalOf(store);
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(goalOf(store)).toBe(before);
    }
  });

  /**
   * Ruling 269 (pass 37, F37-101): the resolution CREATES the task. Live on
   * SHOP-26 the recommended option's own text read "You create the task — no
   * option here can", because no kind could: the operator had found a
   * published contract with no producer, the project's conventions say a
   * reported gap has to end up owned by a live task, and the packet mechanism
   * could only describe one.
   */
  /**
   * Ruling 287 (pass 37, F37-122): connect it in the direction the work runs.
   *
   * Ruling 269 let a decision CREATE a task and say what the new task waits on.
   * A task is usually created to UNBLOCK something, though, so the dependency
   * points the other way — from the existing work to the new task — and that
   * direction could not be expressed at all. Live on SHOP-28 the operator wrote
   * it into its own packet prose: "add the new amendment key to SHOP-41's
   * waits… only you can add it; I can only set SHOP-28's own." The ordering was
   * settled and recorded, and delivered as a chore in a person's head, with
   * nothing on SHOP-41 saying an edit was owed.
   */
  it("ruling 287: create_task makes the EXISTING task wait on the new one, and says so on both", async () => {
    const store = prepared();
    // The task that must not start until the new one lands.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "triage" }),
      goal: "Mount the route against the published shapes.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        title: "The shapes this needs are not published",
        options: [
          {
            kind: "create_task",
            t: "Create the contracts amendment",
            d: "",
            rec: true,
            newTask: {
              title: "Contracts amendment: publish the webhook shapes",
              goal: "Three exports. The rest of the freeze stands.",
              blocks: ["VIB-9"],
            },
          },
        ],
      },
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const made = listProjectTasks(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (t) => t.title === "Contracts amendment: publish the webhook shapes",
    )!;
    // CANARY: drop the `spec.blocks` loop and VIB-9 keeps an empty wait while
    // the decision reads as fully delivered.
    const other = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-9",
      dataRoot: store.dataRoot,
    })!;
    expect(other.parsed.frontmatter.blockedBy).toContain(made.key);
    // A wait that appears with no reason on a task nobody was looking at reads
    // as Viberr deciding something on its own, so the provenance lands THERE.
    //
    // Matched on THIS note's own words, not merely on the new key: the
    // dependency writer posts its own "waits on" note naming the same key, so
    // a looser assertion passes with the provenance note written to the wrong
    // task entirely — which is how a canary comes out green on the mutation it
    // was written to catch.
    const note = other.parsed.timeline.find((e) =>
      e.text.includes("to unblock this task"),
    );
    expect(note, "VIB-9 was not told why its wait grew").toBeTruthy();
    expect(note!.text).toContain(made.key);
    expect(note!.text).toContain("VIB-1");
    expect(note!.title).toBe("Now waits on a new task");
    // …and it is NOT on the deciding task, which already carries its own join
    // note and would otherwise read as if its own wait had changed.
    const here = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(here.parsed.timeline.some((e) => e.text.includes("to unblock this task"))).toBe(
      false,
    );
  });

  it("ruling 287: a reverse wait that CANNOT be written says so, and never undoes the task", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        title: "The shapes this needs are not published",
        options: [
          {
            kind: "create_task",
            t: "Create the contracts amendment",
            d: "",
            rec: true,
            newTask: {
              title: "Contracts amendment: publish the webhook shapes",
              goal: "Three exports. The rest of the freeze stands.",
              // A key this project does not have — the operator can offer one
              // it read from a document, which is a claim until it is checked.
              blocks: ["VIB-404"],
            },
          },
        ],
      },
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // The task the person confirmed still exists: one unwritable edge must not
    // undo a decision they made or the work it already produced.
    const made = listProjectTasks(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (t) => t.title === "Contracts amendment: publish the webhook shapes",
    );
    expect(made, "a bad reverse key destroyed the created task").toBeTruthy();
    // …and the half that did NOT happen is on the record, with the remedy.
    // CANARY: swallow the catch and a settled ordering silently is not applied.
    const here = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const failure = here.parsed.timeline.find((e) => e.text.includes("was NOT set to wait on it"));
    expect(failure, "the unwritten wait was silent").toBeTruthy();
    expect(failure!.text).toContain("VIB-404");
  });

  it("ruling 269: a create_task resolution makes the task, joins the record, and leaves this one alone", async () => {
    const store = prepared();
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        title: "A published contract has no producer",
        options: [
          {
            kind: "create_task",
            t: "Inventory serves the batch contract",
            d: "",
            rec: true,
            newTask: {
              title: "Inventory: serve the batch stock contract",
              goal: "GET /stock serves the batch shape. Done when a producer exists.",
              labels: ["service"],
            },
          },
        ],
      },
    );
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop the post-write `createTask` hook and the decision resolves
    // into a closed packet and nothing else — the promise unkept, silently.
    const made = listProjectTasks(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (t) => t.title === "Inventory: serve the batch stock contract",
    );
    expect(made, "the decision created no task").toBeTruthy();
    expect(made!.labels).toContain("service");
    // The goal is the CONTRACT, so it has to reach the task the agent reads.
    const madeFile = readTaskFile({
      projectSlug: store.slug,
      taskKey: made!.key,
      dataRoot: store.dataRoot,
    })!;
    expect(madeFile.parsed.goal).toContain("GET /stock serves the batch shape");

    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    // The two are joined on the record: this option says something about work
    // that is NOT this task, so the connection is the only thing it leaves here.
    expect(after.parsed.timeline.some((e) => e.text.includes(made!.key))).toBe(true);
    expect(after.parsed.packet).toBeNull();
    // …and it changes nothing else about this task. CANARY: add a `mutate`
    // that flips `waiting`, and a decision about other work starts claiming
    // this one.
    expect(goalOf(store)).toBe(before);
    expect(after.parsed.frontmatter.stage).toBe("impl");
    // The decision event is a NOTE, not a transition: sibling kinds write a
    // transition because they move this task, and this one does not.
    // CANARY: write it as `type: "transition"` and the timeline claims a state
    // change that never happened.
    const decision = after.parsed.timeline.find((e) =>
      e.text.includes("Inventory serves the batch contract"),
    )!;
    expect(decision.type).toBe("note");
  });

  it("ruling 284: a directive typed on a RECOVERY packet stays out of the goal too", async () => {
    const store = prepared();
    // Ruling 189 amended here because "a typed directive is content a person
    // wrote". Ruling 284 keeps free text out of the contract whatever packet it
    // was typed on — the channel decides, not the packet.
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        title: "Work stalled: pick a recovery path",
        options: [{ kind: "redirect", t: "Redirect with sharper guidance", d: "", rec: true }],
      },
    );
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        custom: "Drop the Redis dependency entirely; use Postgres advisory locks.",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(goalOf(store)).not.toContain("Postgres advisory locks");
    // …and it still reaches the record: the timeline carries it verbatim, and
    // the operator's re-queue carries it in its own `note` field.
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!
        .parsed.timeline.map((e) => e.text)
        .join("\n"),
    ).toContain("Postgres advisory locks");
  });

  it("does NOT amend when the packet stays open for a human to edit the goal", async () => {
    const store = prepared();
    // `edit_goal` is the one kind that KEEPS its packet open: the person is
    // about to rewrite the goal themselves, so appending a line saying they
    // chose to rewrite it would be noise in the text they are editing.
    withTask(
      store,
      { stage: "impl", ownerUserId: store.users.arda.id },
      {
        ...QUESTION,
        options: [{ kind: "edit_goal", t: "Refine the goal", d: "", rec: true }],
      },
    );
    const before = goalOf(store);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(goalOf(store)).toBe(before);
  });
});
