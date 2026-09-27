import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type {
  Engagement,
  TaskPacket,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  applyRecommendation,
  dismissRecommendation,
  forceAcceptCompletion,
  OPERATOR_TASK_ACTOR,
  reorderTask,
  resolveAcceptanceAffordance,
  resolvePacket,
  setTaskArchived,
  transitionStage,
} from "./task-actions.server";

/**
 * Pass-14 acceptance contract (P14-LV-02 / LV-06 / LV-07, R14-2, R14-3).
 *
 * The live phase proved acceptance was a side door around the whole product:
 * a task at TRIAGE — no branch, no PR, no reviewer, no verdict — carried an
 * operator "Accept completion" recommendation, and one click moved it to Done,
 * marked it accepted and stamped `validation: healthy`. These tests hold the
 * boundary shut: acceptance is only legal FROM the review boundary, the
 * validation cache is derived rather than synthesized, a merge GitHub refuses
 * refuses the acceptance, and the owner/archive rulings behave.
 */

const ctx = createTestDbContext();
afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

const ACCEPT_PACKET: TaskPacket = {
  id: "pkt_accept_1",
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "Accept completion, or send back for one fix?",
  body: "Body.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "", rec: true },
    { kind: "request_edit", t: "Request one edit", d: "", rec: false },
  ],
};

const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};

function revision(): WorkRevision {
  return {
    id: "rev_1",
    headSha: "a".repeat(40),
    treeSha: "t".repeat(40),
    branch: "vib-1-work",
    createdAt: "2026-07-25T09:00:00.000Z",
    sourceProfileId: "dev",
  };
}

function approval() {
  return {
    profileId: "reviewer",
    revisionId: "rev_1",
    headSha: "a".repeat(40),
    result: "approve" as const,
    reason: "looks right",
    at: "2026-07-25T09:30:00.000Z",
    rounds: 1,
  };
}

function seed(
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

function taskFile(store: TestStore) {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!;
}

describe("P14-LV-02: acceptance respects the workflow graph", () => {
  it("refuses to accept a TRIAGE task through the operator's recommendation (the live defect)", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "triage",
      waiting: "human",
      recommendations: [
        {
          id: "r-accept",
          kind: "accept_completion",
          toStageId: "done",
          label: "Accept completion — move VIB-1 to Done",
          detail: "",
        },
      ],
    });
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-accept" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("triage"); // never moved
    expect(fm.validation).toBe("none"); // never stamped healthy
    // The refusal names where the task is and where acceptance lives.
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-accept" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Review") });
  });

  it("F18-7: an UNKNOWN recommendation id 409s with copy that does not mis-claim 'already resolved'", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "impl",
      waiting: "human",
      recommendations: [
        {
          id: "r-real",
          kind: "transition",
          toStageId: "review",
          label: "Move the task to Review",
          detail: "",
        },
      ],
    });
    const rejection = applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-does-not-exist" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(rejection).rejects.toMatchObject({ status: 409 });
    // The copy hedges (resolved / dismissed / replaced), never a bare
    // "already resolved" that mis-describes a stale or unknown id.
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining("no longer available"),
    });
  });

  it("R15-3: the task OWNER applies an operator TRANSITION rec on their own task — the Apply click IS the authorization", async () => {
    // F15-12 live defect: a contributor-OWNER was shown Apply on a stage rec
    // and then 403'd by the inner approve-transition tier, silently. Owner
    // ruling R15-3 (2026-07-28): the owner may apply ANY recommendation on
    // their own task. This FAILED on pre-pass-15 main (the apply threw 403).
    const store = setupProjectedStore(ctx);
    const rec = {
      id: "r-back",
      kind: "transition" as const,
      toStageId: "impl",
      label: "Move the task to In Progress",
      detail: "Rework per resolver's note.",
    };
    seed(store, {
      stage: "review",
      waiting: "human",
      ownerUserId: store.users.selin.id, // contributor owner
      recommendations: [rec],
    });
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-back" },
      actorOf(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("impl");
    expect(fm.recommendations).toHaveLength(0); // consumed
  });

  it("R15-3 does not widen the outer gate: a contributor who does NOT own the task still cannot apply", async () => {
    const store = setupProjectedStore(ctx);
    const rec = {
      id: "r-back2",
      kind: "transition" as const,
      toStageId: "impl",
      label: "Move the task to In Progress",
      detail: "",
    };
    seed(store, {
      stage: "review",
      waiting: "human",
      ownerUserId: store.users.murat.id, // owned by someone else
      recommendations: [rec],
    });
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-back2" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(taskFile(store).parsed.frontmatter.stage).toBe("review");

    // A maintainer applies it: the task moves back to the work stage.
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-back2" },
      actorOf(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.stage).toBe("impl");
  });

  it("refuses a manual board move from Triage straight to Done", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "triage" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(taskFile(store).parsed.frontmatter.stage).toBe("triage");
  });

  it("accepts from the REVIEW stage — the boundary the workflow declares", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "review", waiting: "human" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "completion" });
  });

  it("V18 (pass-31 review): a real stage move clears the durable deliberate-hold marker", async () => {
    // `heldAtStage` keeps the stranded backstop quiet while the operator's
    // recorded hold stands. Any real move re-litigates it — and a stale marker
    // for a different stage must not ambush the task if it ever returns.
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "triage", waiting: "human", heldAtStage: "triage" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("ready");
    expect(fm.heldAtStage).toBeNull();
  });

  it("derives 'none' for accepted work nothing was ever delivered for", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "review", waiting: "human" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // The old code stamped "healthy" here, which is how a task with no diff at
    // all wore a green validation chip on the board.
    expect(taskFile(store).parsed.frontmatter.validation).toBe("none");
  });

  it("derives 'healthy' when every required reviewer really approved the revision", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      validation: "healthy",
      // R15-1: delivered work needs its review PR to be acceptable.
      pr: { number: 7, state: "review", title: "[VIB-1] Task VIB-1" },
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.validation).toBe("healthy");
  });

  /**
   * R19-5 (owner ruling 2026-08-06) — force-accept MAY skip the remaining
   * stages AND the review gate.
   *
   * A pass-19 implementer inverted this test to assert a 409 from an
   * off-boundary stage ("move the task to the boundary first"); the owner
   * reverted that server refusal. The override exists precisely for a wedged
   * board, so walling it off behind the workflow graph would have removed the
   * only exit. The burden is HONESTY instead: the affordance says it skips the
   * remaining stages and the review gate, and the confirm dialog enumerates
   * which stages those are (`accept-confirm.tsx`). The server's job is to name
   * the bypassed gate in the audit row — which is what this asserts.
   */
  it("an admin can still force-accept off-boundary, and the audit names the graph gate", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "triage" });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(String(forced[0]!.details?.bypassed)).toContain("Triage");
  });

  it("at the review boundary the audited override still works, and names the gate it bypassed", async () => {
    const store = setupProjectedStore(ctx);
    // Delivered work with no approving verdict — the wedged process gate DG-2
    // exists for, at the boundary acceptance is exercised from.
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] Task VIB-1" },
      validation: "changed",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(String(forced[0]!.details?.bypassed)).toContain("approving verdict");
  });

  it("the same gate holds on the packet path", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "impl", waiting: "human" }, ACCEPT_PACKET);
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    // The packet survives the refusal — the decision is still open.
    expect(taskFile(store).parsed.packet).not.toBeNull();
  });
});

describe("P14-LV-07: a merge GitHub refuses refuses the acceptance", () => {
  it("blocks acceptance on a PR the cache knows conflicts, naming the real cause", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      pr: { number: 103, state: "review", title: "PR", mergeable: "conflicting" },
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("conflicts with the base branch"),
    });
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("review");
    expect(fm.pr?.state).toBe("review"); // NOT flipped to "accepted"
  });

  it("refuses when GitHub reports the conflict only at merge time", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      pr: { number: 103, state: "review", title: "PR" },
    });
    const reconciler = await import("~/server/github/github-reconciler.server");
    vi.spyOn(reconciler, "mergeTaskPr").mockResolvedValue({
      status: "not_mergeable",
      prNumber: 103,
      message: "PR #103 conflicts with `main` — rebase the branch, then merge.",
      mergeable: "conflicting",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("conflicts with the base branch"),
    });
    expect(taskFile(store).parsed.frontmatter.stage).toBe("review");
  });

  it("an admin CAN force past a conflict, and the timeline says what is really pending", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      pr: { number: 103, state: "review", title: "PR", mergeable: "conflicting" },
    });
    const reconciler = await import("~/server/github/github-reconciler.server");
    vi.spyOn(reconciler, "mergeTaskPr").mockResolvedValue({
      status: "not_mergeable",
      prNumber: 103,
      message: "PR #103 conflicts with `main` — rebase the branch, then merge.",
      mergeable: "conflicting",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = taskFile(store);
    expect(file.parsed.frontmatter.stage).toBe("done");
    expect(file.parsed.frontmatter.pr?.state).toBe("accepted");
    // The forced acceptance does not inherit the "so it can't be accepted"
    // refusal copy — it states what is still pending.
    expect(file.parsed.timeline[0]!.text).toContain("accepted, merge pending");
    expect(file.parsed.timeline[0]!.text).toContain("conflicts with the base branch");
    expect(file.parsed.timeline[0]!.text).not.toContain("credentials are set");
    expect(
      String(
        listAuditEvents(store.db, { action: "task.acceptance.forced" })[0]!.details
          ?.bypassed,
      ),
    ).toContain("conflicts");
  });

  it("ruling 135: an admin forcing past a conflict on an UNPUSHED revision is told to deliver, never to rebase", async () => {
    // Canary: keep the rebase sentence in `attemptAcceptanceMerge`'s
    // not_mergeable arm regardless of the record.
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      workRevision: { id: "rev_1", headSha: "9".repeat(40), treeSha: null, branch: "vib-1-work", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
      pr: {
        number: 103, state: "review", title: "PR", mergeable: "conflicting", headSha: "1".repeat(40),
        unpushedRevision: { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" },
      },
    });
    const reconciler = await import("~/server/github/github-reconciler.server");
    vi.spyOn(reconciler, "mergeTaskPr").mockResolvedValue({
      status: "not_mergeable",
      prNumber: 103,
      message: "PR #103 conflicts with `main` — rebase the branch, then merge.",
      mergeable: "conflicting",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = taskFile(store);
    expect(file.parsed.frontmatter.stage).toBe("done");
    const text = file.parsed.timeline[0]!.text;
    expect(text).toContain("accepted, merge pending");
    expect(text).toContain("deliver the branch to push it");
    expect(text).not.toMatch(/rebase/i);
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(1);
  });

  it("an unreachable merge still accepts, but names the honest cause", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      pr: { number: 103, state: "review", title: "PR" },
    });
    const reconciler = await import("~/server/github/github-reconciler.server");
    vi.spyOn(reconciler, "mergeTaskPr").mockResolvedValue({
      status: "scope_violation",
      prNumber: 103,
      scope: "pull_request:write",
      violationId: "v1",
      message: "refused",
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = taskFile(store);
    expect(file.parsed.frontmatter.pr?.state).toBe("accepted");
    // NOT the old catch-all "no reachable GitHub merge … credentials are set".
    expect(file.parsed.timeline[0]!.text).toContain("pull_request:write");
  });
});

describe("P14-GV-05: no external merge under a stale decision", () => {
  it("re-checks the packet identity BEFORE the merge call", async () => {
    const store = setupProjectedStore(ctx);
    seed(
      store,
      {
        stage: "review",
        waiting: "human",
        branch: "vib-1-work",
        pr: { number: 103, state: "review", title: "PR" },
      },
      ACCEPT_PACKET,
    );
    const reconciler = await import("~/server/github/github-reconciler.server");
    const merge = vi
      .spyOn(reconciler, "mergeTaskPr")
      .mockResolvedValue({ status: "merged", prNumber: 103, sha: "deadbeef" });

    // Resolve the packet, and let a REPLACEMENT packet land while the
    // resolution is still in flight (the module import is a real await point).
    const pending = resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        waiting: "human",
        branch: "vib-1-work",
        pr: { number: 103, state: "review", title: "PR" },
      }),
      packet: { ...ACCEPT_PACKET, id: "pkt_replacement", title: "Something else came up" },
    });

    await expect(pending).rejects.toMatchObject({ status: 409 });
    // The PR was NOT merged under the superseded decision.
    expect(merge).not.toHaveBeenCalled();
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("review");
    expect(fm.pr?.state).toBe("review");
  });
});

describe("R14-2: a task owner governs the decisions on their own task", () => {
  function ownedRec(store: TestStore, kind: "transition" | "accept_completion") {
    seed(store, {
      stage: "review",
      waiting: "human",
      ownerUserId: store.users.selin.id, // contributor
      recommendations: [
        { id: "r1", kind, toStageId: "done", label: "Move VIB-1 to Done", detail: "" },
      ],
    });
  }

  it("the contributor OWNER may dismiss any recommendation on their task", async () => {
    const store = setupProjectedStore(ctx);
    ownedRec(store, "transition");
    const { label } = await dismissRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r1" },
      actorOf(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(label).toBe("Move VIB-1 to Done");
    expect(taskFile(store).parsed.frontmatter.recommendations).toHaveLength(0);
  });

  it("the contributor OWNER may apply an accept_completion recommendation", async () => {
    const store = setupProjectedStore(ctx);
    ownedRec(store, "accept_completion");
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r1" },
      actorOf(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.stage).toBe("done");
  });

  it("a contributor who does NOT own the task is still refused (403, no existence leak)", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      ownerUserId: null,
      recommendations: [
        { id: "r1", kind: "transition", toStageId: "done", label: "Move", detail: "" },
      ],
    });
    await expect(
      dismissRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r1" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // An unauthorized caller gets 403 for a task that does not exist either —
    // the guard still runs before anything reveals existence (F20).
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-404", recId: "r1" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("R14-3: the task archive", () => {
  it("archives with a note, withdraws the open decision, and is restorable", async () => {
    const store = setupProjectedStore(ctx);
    seed(
      store,
      {
        stage: "review",
        waiting: "human",
        recommendations: [
          { id: "r1", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" },
        ],
      },
      ACCEPT_PACKET,
    );
    const archived = await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: true },
      actorOf(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    expect(archived.archived).toBe(true);
    const file = taskFile(store);
    expect(file.parsed.frontmatter.archived).toBe(true);
    expect(file.parsed.frontmatter.waiting).toBe("none");
    expect(file.parsed.frontmatter.recommendations).toHaveLength(0);
    expect(file.parsed.packet).toBeNull();
    // The whole record survives, with the disposition on top of it.
    expect(file.parsed.timeline[0]).toMatchObject({ type: "note" });
    expect(file.parsed.timeline[0]!.text).toContain("was archived");
    expect(file.parsed.timeline[0]!.text).toContain("withdrawn");
    expect(listAuditEvents(store.db, { action: "task.archived" })).toHaveLength(1);
    // Stage is untouched — archiving is not a transition.
    expect(file.parsed.frontmatter.stage).toBe("review");

    const restored = await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: false },
      actorOf(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(restored.archived).toBe(false);
    const back = taskFile(store).parsed.frontmatter;
    expect(back.archived).toBe(false);
    expect(back.waiting).toBe("human");
    expect(listAuditEvents(store.db, { action: "task.unarchived" })).toHaveLength(1);
  });

  it("is maintainer+ (a contributor — even the owner — cannot archive)", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "review", ownerUserId: store.users.selin.id });
    await expect(
      setTaskArchived(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", archived: true },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("is idempotent — re-archiving writes no second note or audit row", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "review", archived: true });
    const events = taskFile(store).parsed.timeline.length;
    const result = await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: true },
      actorOf(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(result.toast).toContain("already archived");
    expect(taskFile(store).parsed.timeline).toHaveLength(events);
    expect(listAuditEvents(store.db, { action: "task.archived" })).toHaveLength(0);
  });

  it("an archived task cannot be accepted — restore it first (GV-02 copy is now true)", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "review", waiting: "none", archived: true });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("archived"),
    });
  });
});

/**
 * F19-38 (pass 19, live-reproduced) — the SERVER half of "an archived card is
 * inert". The board verifier drove the writers directly with an archived task at
 * `impl`: `transitionStage({toStageId:"review", manual:true})` → `{ok:true}` and
 * `reorderTask({toStageId:"review"})` → `{ok:true,moved:true}`. Only the
 * TERMINAL target refused, because the archived check lived exclusively inside
 * `acceptanceRefusalReason`. F19-8 made the card inert in the UI; without these
 * the UI guard is decoration a crafted POST walks straight past.
 */
describe("F19-38: an archived task cannot be moved on the board", () => {
  it("refuses a MANUAL non-terminal transition (409), and the stage is untouched", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "impl", archived: true });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
        actorOf(store.users.arda), // admin — the widest human authority there is
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "VIB-1 is archived. Restore it before moving it between stages.",
    });
    expect(taskFile(store).parsed.frontmatter.stage).toBe("impl");
  });

  it("refuses the OPERATOR's own transition too — archive outranks agent authority", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "ready", archived: true });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        OPERATOR_TASK_ACTOR,
        { dataRoot: store.dataRoot, operatorAuthorized: true },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(taskFile(store).parsed.frontmatter.stage).toBe("ready");
  });

  it("refuses a cross-stage reorderTask (the drag path) — no stage move, no rank write", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "impl", archived: true, boardRank: 100 });
    await expect(
      reorderTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", beforeKey: null },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    const fm = taskFile(store).parsed.frontmatter;
    expect(fm.stage).toBe("impl");
    expect(fm.boardRank).toBe(100);
  });

  it("refuses a SAME-stage reorderTask as well — the rank write never reaches transitionStage", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "impl", archived: true, boardRank: 100 });
    await expect(
      reorderTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(taskFile(store).parsed.frontmatter.boardRank).toBe(100);
  });

  it("moves normally once RESTORED — the guard is a disposition gate, not a freeze", async () => {
    const store = setupProjectedStore(ctx);
    seed(store, { stage: "impl", archived: true });
    await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", archived: false },
      actorOf(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile(store).parsed.frontmatter.stage).toBe("review");
  });
});

describe("P14-LV-06: the acceptance affordance the queue promises", () => {
  it("is true for a maintainer and for the owner at the boundary — with no recommendation in sight", () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      ownerUserId: store.users.selin.id,
    });
    const forOwner = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.selin.id },
      { dataRoot: store.dataRoot },
    );
    expect(forOwner).toMatchObject({
      hasAuthority: true,
      atBoundary: true,
      blockedReason: null,
      canAccept: true,
    });
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.murat.id },
        { dataRoot: store.dataRoot },
      ).canAccept,
    ).toBe(true);
    // A viewer never holds acceptance.
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.elif.id },
        { dataRoot: store.dataRoot },
      ),
    ).toMatchObject({ hasAuthority: false, canAccept: false });
  });

  it("reports the exact blocker instead of an affordance that would 409", () => {
    const store = setupProjectedStore(ctx);
    seed(store, {
      stage: "review",
      waiting: "human",
      branch: "vib-1-work",
      pr: { number: 103, state: "review", title: "PR", mergeable: "conflicting" },
    });
    const conflicted = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    );
    expect(conflicted.canAccept).toBe(false);
    expect(conflicted.atBoundary).toBe(true);
    expect(conflicted.blockedReason).toContain("conflicts with the base branch");

    // Off-boundary: authority intact, but this is not where acceptance happens.
    seed(store, { stage: "triage" });
    const offBoundary = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    );
    expect(offBoundary).toMatchObject({
      hasAuthority: true,
      atBoundary: false,
      canAccept: false,
    });
  });
});
