import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  Engagement,
  TaskFrontmatter,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  applyRecommendation,
  completeTaskMerge,
  forceAcceptCompletion,
  manualDeliverForReview,
  performDelivery,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";
import {
  deliverGate,
  operatorAcceptCompletion,
  operatorDeliverForReview,
  type OperatorAuthority,
} from "./operator-actions.server";

/**
 * R15-2 (owner ruling 2026-07-28): delivery — push the task branch + open the
 * review PR — is an OPERATOR decision, not a stage side-effect. Plus the
 * F15-15/B-GH1 conflict cluster (never open a PR over a stale remote), the
 * R15-1 verdict gate, B-WF1 (in-lock re-check), and F15-13 (already-merged
 * honesty). Every test here FAILS against pre-pass-15 main.
 */

// The delivery/acceptance collaborators ride `TaskActionContext`'s test seams
// instead of module mocks: push-workspace, pr-open and the merge are injected
// as typed doubles through the ctx `deps` bag, and the PR-head gate's GitHub
// reads run a REAL `getProjectGithubContext` over the canned transport
// (`fetchImpl`) — `githubReportsHead` seeds the credential and the routes. With
// no credential seeded the context degrades to `no_pat_configured`, the same
// shape the old default mock returned.
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import type { mergeTaskPr } from "~/server/github/github-reconciler.server";
import {
  fakeGithubFetch,
  type FakeGithub,
} from "../../../test-support/fake-github";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { TaskActionContext } from "./task-actions.server";

const pushMock = vi.fn<typeof pushWorkspaceBranch>();
const openPrMock = vi.fn<typeof openTaskPr>();
const mergeMock = vi.fn<typeof mergeTaskPr>();
let github: FakeGithub | null = null;

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  vi.clearAllMocks();
  github = null;
  pushMock.mockResolvedValue({
    status: "no_commits",
    reason: "no local commits ahead of the default branch",
  });
  openPrMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
  mergeMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
});

afterEach(() => ctx.cleanup());

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

function seed(patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function fm() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed;
}

const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};

function revision(id = "rev_1", sha = "a".repeat(40)): WorkRevision {
  return {
    id,
    headSha: sha,
    treeSha: sha === "a".repeat(40) ? "t".repeat(40) : "u".repeat(40),
    branch: "vib-1",
    createdAt: "2026-07-28T09:00:00.000Z",
    sourceProfileId: "developer",
  };
}

function approval(revisionId = "rev_1", sha = "a".repeat(40)) {
  return {
    profileId: "reviewer",
    revisionId,
    headSha: sha,
    result: "approve" as const,
    reason: "clean",
    at: "2026-07-28T09:30:00.000Z",
  };
}

function authority(
  modes: Record<string, "direct" | "recommend" | "human" | "off"> = {},
  autonomy: "supervised" | "full" = "supervised",
  humanGatedBeforeWork = false,
): OperatorAuthority {
  return {
    policy: new Map(Object.entries(modes)),
    autonomy,
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: true,
    humanGatedBeforeWork,
  };
}

/** Every entry point gets the injected doubles; the canned transport rides
 *  along once a test has installed one via `githubReportsHead`. */
function dataCtx(): TaskActionContext {
  const callCtx: TaskActionContext = {
    dataRoot: store.dataRoot,
    deps: {
      pushWorkspaceBranch: pushMock,
      openTaskPr: openPrMock,
      mergeTaskPr: mergeMock,
    },
  };
  if (github) callCtx.fetchImpl = github.fetchImpl;
  return callCtx;
}

describe("R15-2: transitionStage no longer auto-delivers on review entry", () => {
  it("entering the review stage opens NO PR and instead writes the typed 'Review reached with no PR yet' event", async () => {
    // Fails on main twice over: openTaskPr fired on the review transition, and
    // no such event existed (a non-delivering Review entry was silent, F15-17).
    seed({ stage: "impl" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    // The safety-net event is fire-and-forget — let it land.
    await new Promise((r) => setTimeout(r, 80));
    expect(openPrMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    const events = fm().timeline;
    const reached = events.find(
      (e) => e.type === "github" && e.text.includes("no live review pull request"),
    );
    expect(reached).toBeDefined();
    expect(reached!.text).toContain("operator decides delivery");
  });

  it("no safety-net event when a live PR already stands", async () => {
    seed({
      stage: "impl",
      pr: { number: 4, state: "review", title: "[VIB-1] t" },
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(
      fm().timeline.some((e) => e.text.includes("no live review pull request")),
    ).toBe(false);
  });
});

describe("F15-15/B-GH1: performDelivery refuses a PR over a conflicted or failed push", () => {
  it("push_conflict: no PR is opened, the event names a history conflict — never the credential", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason:
        "the remote branch `vib-1` holds commits that are not in the local delivery (non-fast-forward)",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome.status).toBe("push_conflict");
    // Fails on main: no push_conflict status existed, the PR was opened anyway
    // over the stale remote content, and the copy blamed the credential.
    expect(openPrMock).not.toHaveBeenCalled();
    const event = fm().timeline.find((e) => e.type === "github");
    expect(event).toBeDefined();
    expect(event!.text).toContain("not a credential problem");
    expect(event!.text).toContain("No review PR was opened");
    expect(event!.text).toContain("`vib-1`");
  });

  it("push_failed: the PR attempt is refused too (a stale-head PR reviews the wrong content)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_failed",
      reason: "git push returned non-zero",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome.status).toBe("push_failed");
    // Fails on main: the old best-effort flow still attempted the PR.
    expect(openPrMock).not.toHaveBeenCalled();
  });

  it("a delivered push opens (or reuses) the PR and reports it", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2 });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 9,
      created: true,
      url: "https://github.com/x/y/pull/9",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 9, created: true });
  });

  // A3: `grant_withheld` / `push_conflict` / `push_failed` refused; the other
  // four push outcomes fell straight through to `openTaskPr` and opened a
  // review PR over a remote nobody had just written to. Each has to name its
  // own cause — "no PR was opened" is only useful if it says why.
  const NOT_DELIVERABLE = [
    {
      // R19-8: `no_commits` carries the workspace evidence too. A CLEAN tree is
      // what makes "nothing to review" a verified statement rather than a guess.
      push: {
        status: "no_commits" as const,
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: { verified: true as const },
      },
      outcome: "nothing_to_review",
      says: "no commits ahead",
    },
    {
      // …and the same status over a tree the delivery commit failed to clean is
      // a genuine failure: the deliverable is still sitting uncommitted.
      push: {
        status: "no_commits" as const,
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: {
          verified: false as const,
          why: "the workspace still has uncommitted changes after the delivery commit attempt",
        },
      },
      outcome: "failed",
      says: "no commits ahead",
    },
    {
      push: { status: "no_workspace" as const, reason: "no workspace git repo" },
      outcome: "failed",
      says: "no workspace clone",
    },
    {
      push: { status: "no_repo" as const, reason: "project has no repo" },
      outcome: "failed",
      says: "no GitHub repository configured",
    },
    {
      push: { status: "no_branch" as const, reason: "HEAD not on a task branch (main)" },
      outcome: "failed",
      says: "not on a task branch",
    },
  ];
  for (const c of NOT_DELIVERABLE) {
    const label =
      c.push.status === "no_commits"
        ? `a no_commits push over a ${c.push.defaultBranchEvidence?.verified ? "CLEAN" : "DIRTY"} tree`
        : `a ${c.push.status} push`;
    it(`A3: ${label} opens NO PR and says so`, async () => {
      seed({ stage: "review", branch: "vib-1" });
      pushMock.mockResolvedValue(c.push);
      const outcome = await performDelivery(
        store.db,
        dataCtx(),
        store.slug,
        "VIB-1",
        actor(store.users.arda),
      );
      expect(openPrMock, "no PR over an unknown remote state").not.toHaveBeenCalled();
      expect(outcome.status).toBe(c.outcome);
      expect(outcome.status === "delivered" ? "" : outcome.message).toContain(c.says);
      // …and the refusal reaches the timeline, like every other delivery failure.
      const event = fm().timeline.find((e) => e.type === "github");
      expect(event?.text).toContain(c.says);
      // R17-2: an empty branch (nothing_to_review) marks the task as a verified
      // no-change completion so acceptance can close it to Done cleanly; the
      // other not-deliverable outcomes are genuine failures and must NOT.
      if (c.outcome === "nothing_to_review") {
        expect(fm().frontmatter.noChanges).toBe(true);
      } else {
        expect(fm().frontmatter.noChanges).toBeFalsy();
      }
    });
  }
});

describe("R15-2: the operator's deliver_for_review decision", () => {
  it("deliverGate: absent grant = direct; explicit off = deny; recommend promotes to direct only at full autonomy", () => {
    expect(deliverGate(authority({}))).toBe("direct");
    expect(deliverGate(authority({ "deliver-review-pr": "off" }))).toBe("deny");
    expect(deliverGate(authority({ "deliver-review-pr": "human" }))).toBe("deny");
    expect(deliverGate(authority({ "deliver-review-pr": "recommend" }))).toBe("recommend");
    expect(
      deliverGate(authority({ "deliver-review-pr": "recommend" }, "full")),
    ).toBe("direct");
  });

  it("R15-9: an ABSENT grant resolves from the project's governance, not a constant", () => {
    // `deliver-review-pr` postdates every pre-R15-2 deployment, so "absent" is
    // the normal state on existing projects. Resolving it to a flat `direct`
    // meant a strict project created before the pass pushed branches on its own
    // while an identical one created after asked a human first — the same
    // governance behaving differently by creation date.
    // Canary: return "direct" unconditionally from absentDeliverReviewPrMode.
    expect(deliverGate(authority({}, "supervised", false))).toBe("direct");
    expect(deliverGate(authority({}, "supervised", true))).toBe("recommend");

    // An EXPLICIT grant always wins over the derived default, in both directions.
    expect(
      deliverGate(authority({ "deliver-review-pr": "direct" }, "supervised", true)),
    ).toBe("direct");
    expect(
      deliverGate(authority({ "deliver-review-pr": "off" }, "supervised", true)),
    ).toBe("deny");
  });

  it("recommend mode posts a `delivery` recommendation card that round-trips the task file", async () => {
    seed({ stage: "review", branch: "vib-1" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority({ "deliver-review-pr": "recommend", "append-typed-events": "direct" }),
    );
    expect(r.outcome).toBe("recommended");
    expect(pushMock).not.toHaveBeenCalled();
    const recs = fm().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    // Fails on main: "delivery" was not a RECOMMENDATION_KIND — the tolerant
    // parser would have dropped the card on round-trip.
    expect(recs[0]!.kind).toBe("delivery");
  });

  it("direct mode performs the delivery and reports push + PR honestly (push_conflict included)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason: "the remote branch `vib-1` holds commits that are not in the local delivery (non-fast-forward)",
    });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(), // absent grant = direct
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("CONFLICTED");
    expect(r.message).toContain("not a credential problem");
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("github.delivery.operator");
  });

  it("a live open PR makes delivery a noop (idempotent — no wasted re-push)", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      pr: { number: 4, state: "review", title: "[VIB-1] t" },
    });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(),
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("PR #4");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("explicit off denies the delivery", async () => {
    seed({ stage: "review", branch: "vib-1" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority({ "deliver-review-pr": "off" }),
    );
    expect(r.outcome).toBe("denied");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("F17-1: the operator's delivery calls openTaskPr operator-authorized (so the PR-open event is the Operator, not a guest)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 1 });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 9,
      created: true,
      url: "https://github.com/x/y/pull/9",
    });
    await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(),
    );
    expect(openPrMock).toHaveBeenCalled();
    // The third arg is the actor; a delivery THROUGH the operator tool must mark
    // it operator-authorized so pr-open renders {kind:"operator"}, not a human.
    // Canary: drop `operatorAuthorized: true` in operatorDeliverForReview and
    // this reads false.
    const actorArg = openPrMock.mock.calls.at(-1)![2];
    expect(actorArg.operatorAuthorized).toBe(true);
  });
});

describe("R15-2 safety net (b): manual delivery from the task page", () => {
  it("maintainer delivers; the act is audited github.delivery.manual", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2 });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 12,
      created: true,
      url: "https://github.com/x/y/pull/12",
    });
    const outcome = await manualDeliverForReview(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.murat),
      dataCtx(),
    );
    expect(outcome.status).toBe("delivered");
    const audit = listAuditEvents(store.db, {}).find(
      (a) => a.action === "github.delivery.manual",
    );
    expect(audit).toBeDefined();
  });

  it("the task's contributor OWNER may deliver; a non-owner contributor and a viewer may not", async () => {
    seed({ stage: "review", branch: "vib-1", ownerUserId: store.users.selin.id });
    await expect(
      manualDeliverForReview(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.elif), // viewer
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const outcome = await manualDeliverForReview(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.selin), // contributor OWNER
      dataCtx(),
    );
    expect(outcome.status).not.toBe(undefined);

    // Ownership moved elsewhere → the same contributor is refused.
    seed({ stage: "review", branch: "vib-1", ownerUserId: store.users.murat.id });
    await expect(
      manualDeliverForReview(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.selin),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("R15-2: an applied `delivery` recommendation performs the delivery", () => {
  const REC = {
    id: "r-deliver",
    kind: "delivery" as const,
    label: "Deliver the branch & open the review PR",
    detail: "Committed work is ready for review.",
  };

  it("apply → performDelivery; a delivered outcome consumes the card", async () => {
    seed({ stage: "review", branch: "vib-1", recommendations: [REC] });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2 });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 21,
      created: true,
      url: "https://github.com/x/y/pull/21",
    });
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-deliver" },
      actor(store.users.murat),
      dataCtx(),
    );
    expect(openPrMock).toHaveBeenCalled();
    expect(fm().frontmatter.recommendations).toHaveLength(0);
  });

  it("a FAILED delivery refuses the apply with the honest reason and keeps the card for retry", async () => {
    seed({ stage: "review", branch: "vib-1", recommendations: [REC] });
    openPrMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-deliver" },
        actor(store.users.murat),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Delivery did not complete"),
    });
    expect(fm().frontmatter.recommendations).toHaveLength(1);
  });
});

describe("R15-1: the verdict gate on human acceptance (F15-19)", () => {
  it("refuses acceptance of a delivered revision with NO verdict — the live VIB-9 hole", async () => {
    // Fails on main: with no verdict-capable reviewer engaged, acceptance
    // sailed through and merged the PR ("awaiting verdict" chip and all).
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no approving verdict"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("refuses delivered work with NO review PR (gate 1)", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      validation: "changed",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no review pull request"),
    });
  });

  it("accepts once a verdict-capable reviewer approved the delivered revision", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(task.stage).toBe("done");
  });

  it("a task with NOTHING delivered stays acceptable (planning / non-repo work)", async () => {
    seed({ stage: "review" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(task.stage).toBe("done");
  });

  it("admin force-accept remains the audited bypass for the missing verdict", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, {}).find(
      (a) => a.action === "task.acceptance.forced",
    );
    expect(forced).toBeDefined();
    expect(JSON.stringify(forced!.details)).toContain("no approving verdict");
  });
});

describe("R15-1 gate 2 (F15-15): the PR head must contain the delivered revision", () => {
  /** Point the head gate at a REAL GitHub context — a real credential on the
   *  project's repo — served by the canned transport: the `/pulls/` head and
   *  the `/compare/` verdict below, 404 (unknown, never a refusal) for
   *  anything else. */
  function githubReportsHead(headSha: string, compareStatus = "diverged") {
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0001" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: headSha } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${headSha}`]: {
        body: { status: compareStatus },
      },
    });
  }

  const healthySeed = () =>
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 114, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });

  it("refuses acceptance of a PR whose head does not contain the delivered revision — even FORCED", async () => {
    // The F15-15 endgame: a PR opened over stale remote junk would have merged
    // with a green review attached. Fails on main: no head check existed.
    healthySeed();
    githubReportsHead("f".repeat(40), "diverged");
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    // Force-accept bypasses verdicts and packets — NEVER the head mismatch.
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("a head that CONTAINS the delivered revision (delivery + auto-commit) is accepted", async () => {
    healthySeed();
    githubReportsHead("f".repeat(40), "ahead");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
  });

  it("an unreachable GitHub is UNKNOWN, not a refusal (offline acceptance keeps its merge-pending honesty)", async () => {
    healthySeed();
    // Default degraded context: the check returns null and acceptance proceeds.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
  });

  it("A2: the full-autonomy OPERATOR acceptance is refused by the head gate too", async () => {
    // The docstring called this "the ONE gate force can NEVER bypass" while two
    // of the four Done writers never called it. `operatorAcceptCompletion`
    // checked `acceptanceRefusalFor` only, so a full-autonomy operator stamped
    // `pr.state: accepted` (merge pending) on a PR carrying content its task
    // never delivered — and the poller then nudged a human to merge it.
    // Canary: drop the headCheck from applyAcceptanceWrite and this accepts.
    healthySeed();
    githubReportsHead("f".repeat(40), "diverged");
    // Fails CLOSED: the shared Done write throws, which aborts the operator's
    // action (and, on the Codex path, the rest of its plan) rather than
    // recording a Done nobody verified.
    await expect(
      operatorAcceptCompletion(
        store.db,
        dataCtx(),
        { projectSlug: store.slug, taskKey: "VIB-1" },
        authority({ "completion-for-acceptance": "direct" }, "full"),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(fm().frontmatter.pr?.state).toBe("review");
  });

  it("A2: completeTaskMerge refuses a stale-head merge instead of performing it", async () => {
    // The other bypassed writer, and the dangerous one: it calls mergeTaskPr,
    // which is irreversible. The merge-pending nudge points a human straight at
    // this button. Canary: drop the headCheck and mergeTaskPr is called.
    seed({
      stage: "done",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 114, state: "accepted", title: "[VIB-1] t" },
      validation: "healthy",
    });
    githubReportsHead("f".repeat(40), "diverged");
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(mergeMock).not.toHaveBeenCalled();
    expect(fm().frontmatter.pr?.state).toBe("accepted");
  });

  it("A2: a PR swapped under the acceptance during the verification refuses (the head was checked against the old one)", async () => {
    // The head gate is a live network read, so it cannot run inside the write
    // lock. The pair it verified is re-asserted there instead — otherwise the
    // window between "verified #114" and the Done write is a hole exactly as
    // wide as a GitHub round-trip.
    healthySeed();
    githubReportsHead("a".repeat(40), "identical"); // #114 verifies clean
    mergeMock.mockImplementation(async () => {
      const current = fm();
      writeTask(store.dataRoot, store.slug, {
        frontmatter: {
          ...current.frontmatter,
          // A different PR now stands for this task — nobody verified ITS head.
          pr: { number: 999, state: "review", title: "[VIB-1] t" },
        },
        goal: current.goal,
        timeline: current.timeline,
      });
      return { status: "merged", prNumber: 114, sha: null };
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed while the acceptance was being verified"),
    });
    expect(fm().frontmatter.stage).toBe("review");
  });
});

describe("F15-11: no acceptance affordance on a task already at the terminal stage", () => {
  it("resolveAcceptanceAffordance denies on Done (the button used to render live)", async () => {
    const { resolveAcceptanceAffordance } = await import("./task-actions.server");
    seed({ stage: "done" });
    const affordance = resolveAcceptanceAffordance(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        viewerUserId: store.users.arda.id,
      },
      dataCtx(),
    );
    expect(affordance.hasAuthority).toBe(true);
    expect(affordance.atBoundary).toBe(false);
    expect(affordance.canAccept).toBe(false);
  });
});

describe("B-WF1: the in-lock re-check after the merge await", () => {
  it("a revision delivered DURING the merge await refuses the acceptance instead of closing on it", async () => {
    // Fails on main: the direct path re-checked nothing after the merge await —
    // the stale acceptance closed the task over the brand-new revision.
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    mergeMock.mockImplementation(async () => {
      // Simulate a new delivery landing while the merge round-trips: rev_2
      // exists, nothing has judged it.
      const current = fm();
      writeTask(store.dataRoot, store.slug, {
        frontmatter: {
          ...current.frontmatter,
          workRevision: revision("rev_2", "b".repeat(40)),
          validation: "changed",
        },
        goal: current.goal,
        timeline: current.timeline,
      });
      return { status: "merged", prNumber: 7, sha: null };
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fm().frontmatter.stage).toBe("review");
  });
});

describe("F15-13: already-merged honesty in the acceptance event", () => {
  it("accepting a PR merged out of band says so — and never claims the merge as the human's act", async () => {
    // Fails on main: the event read "…the review PR is accepted, merge pending"
    // (or claimed a fresh merge) and pr.state was DOWNGRADED merged → accepted.
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "merged", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(mergeMock).not.toHaveBeenCalled(); // nothing left to merge
    const parsed = fm();
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("already been merged on GitHub");
    expect(completion!.text).not.toContain("merge pending");
    expect(parsed.frontmatter.pr?.state).toBe("merged"); // never downgraded
  });
});

describe("gap 1: resolvePacket's accept_completion is the THIRD Done writer and carries every gate", () => {
  const ACCEPT_PACKET: TaskPacket = {
    id: "pkt_accept",
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Accept completion, or send back?",
    body: "The review is clean.",
    observations: [],
    options: [
      {
        kind: "accept_completion",
        t: "Accept completion",
        d: "Mark done and merge.",
        rec: true,
      },
    ],
  };

  function seedWithPacket(patch: Partial<TaskFrontmatter> = {}): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", patch),
      packet: ACCEPT_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("refuses the packet acceptance when the PR head does not contain the delivered revision (F15-15)", async () => {
    // Fails on wave-1 (and on main): the packet path never called
    // acceptancePrHeadMismatch — the junk-head PR merged through the
    // operator's own acceptance packet.
    // As in githubReportsHead: a real credential + canned transport, answering
    // this packet's PR #7 with a junk head and the compare with "diverged".
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0002" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/7": {
        body: { head: { sha: "f".repeat(40) } },
      },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${"f".repeat(40)}`]: {
        body: { status: "diverged" },
      },
    });
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("refuses the packet acceptance for a delivered revision with NO verdict (R15-1 on path 3)", async () => {
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no approving verdict"),
    });
    expect(fm().frontmatter.stage).toBe("review");
  });

  it("packet acceptance of an out-of-band-merged PR says so and never downgrades (F15-13 on path 3)", async () => {
    // Fails on wave-1: the packet mutate wrote `reallyMerged ? merged :
    // accepted` — an already-merged PR was downgraded and the event claimed
    // "merge pending".
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "merged", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(mergeMock).not.toHaveBeenCalled();
    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.pr?.state).toBe("merged");
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("already been merged on GitHub");
    expect(completion!.text).not.toContain("merge pending");
  });

  it("acceptance consumes EVERY standing recommendation card, not just the closing kinds (gap 3)", async () => {
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
      recommendations: [
        {
          id: "rec_run",
          kind: "run_specialist",
          label: "Run the specialist",
          detail: "leftover offer",
          profileId: "developer",
        },
      ],
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      dataCtx(),
    );
    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    // A Done task keeps NO applicable offers — a leftover run card would start
    // a run on a closed task if applied later.
    expect(parsed.frontmatter.recommendations).toEqual([]);
  });
});
