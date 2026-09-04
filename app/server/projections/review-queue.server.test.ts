import { afterEach, describe, expect, it } from "vitest";
import { CUSTOM_3_STAGE_BOARD } from "../../../test-support/custom-board";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "./rebuilder.server";
import { getReviewQueue } from "./review-queue.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function setup() {
  const store = setupTestStore(ctx);

  // Panel 1: review + waiting human, with a pending packet.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-101", {
      title: "Attach workspace",
      stage: "review",
      waiting: "human",
      validation: "changed",
      pr: { number: 318, state: "review", title: "Attach workspace" },
    }),
    packet: {
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept completion, or send back for one fix?",
      body: "b",
      observations: [],
      options: [],
    },
    timeline: [
      {
        occurredAt: "2026-07-02T09:41:00.000Z",
        type: "completion",
        actor: { kind: "agent", backend: "codex", profileId: "developer", roleHint: "Developer" },
        title: "Completion report",
        text: "Implemented.",
        toAgent: false,
        evidence: null,
      },
    ],
  });

  // Panel 2: review + waiting agent, no packet — subline = newest event.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-102", {
      title: "SSE fan-out",
      stage: "review",
      waiting: "agent",
      validation: "healthy",
      pr: { number: 311, state: "review", title: "SSE fan-out" },
    }),
    timeline: [
      {
        occurredAt: "2026-07-02T10:00:00.000Z",
        type: "transition",
        actor: { kind: "operator" },
        title: null,
        text: "**Transition request:** move VIB-102 to Review — `evidence` attached.",
        toAgent: false,
        evidence: null,
      },
      {
        occurredAt: "2026-07-02T08:00:00.000Z",
        type: "comment",
        actor: { kind: "operator" },
        title: null,
        text: "older event",
        toAgent: false,
        evidence: null,
      },
    ],
  });

  // The review + none combination (contracts §2.2): still-with-agents.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-103", {
      title: "Orphaned review task",
      stage: "review",
      waiting: "none",
    }),
  });

  // Non-review stages never qualify — packets elsewhere stay off-queue.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-104", {
      title: "Blocked in impl",
      stage: "impl",
      waiting: "human",
    }),
    packet: {
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Pick a recovery path",
      body: "b",
      observations: [],
      options: [],
    },
  });

  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

describe("getReviewQueue", () => {
  it("splits review-stage tasks on waiting — review+none lands with agents", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });

    expect(queue.total).toBe(3);
    expect(queue.ready.map((t) => t.key)).toEqual(["VIB-101"]);
    // waiting !== "human" — including the legal review+none combination.
    expect(queue.working.map((t) => t.key)).toEqual(["VIB-102", "VIB-103"]);
    expect(queue.working.find((t) => t.key === "VIB-103")?.waiting).toBe(
      "none",
    );
  });

  it("carries the subline sources: packet header, newest event text, or nothing", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });

    const withPacket = queue.ready[0]!;
    expect(withPacket.packet).toEqual({
      kind: "Completion report",
      title: "Accept completion, or send back for one fix?",
    });

    const withTimeline = queue.working.find((t) => t.key === "VIB-102")!;
    expect(withTimeline.packet).toBeNull();
    // Newest-first: position 0 is the transition request, not the comment.
    expect(withTimeline.latestEventText).toContain("**Transition request:**");

    const bare = queue.working.find((t) => t.key === "VIB-103")!;
    expect(bare.packet).toBeNull();
    expect(bare.latestEventText).toBeNull();
  });

  it("keeps pr + validation for the meta cluster", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(queue.ready[0]!.pr).toEqual({ number: 318, state: "review" });
    // UX19-3: `validation` is a DERIVED cache (task-file.schema.ts: "no longer
    // written as a source of truth"), and the projection now derives it from the
    // same `fm` snapshot that produces `blockReason` — so the row can no longer
    // contradict itself. Neither fixture task has a delivered revision, so the
    // derived value is `none` on both, and the `validation:` lines they carry
    // ("changed" / "healthy") are exactly the stale cache that must NOT reach the
    // pill. This test used to pin that passthrough. (The derivation's own
    // healthy/failing/changed coverage lives in rebuilder.server.test.ts.)
    expect(queue.ready[0]!.validation).toBe("none");
    expect(queue.ready[0]!.validation).not.toBe("changed");
    expect(queue.working[0]!.validation).toBe("none");
    expect(queue.working[0]!.validation).not.toBe("healthy");
  });

  it("returns empty panels for a project with no review-stage tasks", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(queue).toEqual({ ready: [], working: [], total: 0 });
  });

  it("D-1 (pass 24): an ARCHIVED project has an EMPTY review queue (parity with decisionsRequiring)", () => {
    // The review queue counted only archived TASKS, never archived PROJECTS — so
    // an acceptance-ready review task on an archived project showed under "waiting
    // on your acceptance" (and the board chip) while home/notifications said
    // nothing waited and the server refused the accept. Archive the project the
    // way the app does (flip the frontmatter flag + reproject) and the queue is
    // empty, matching `decisionsRequiring`, which drops archived projects.
    // Canary: drop the `!project.archived` guard in getReviewQueue and this fails.
    const store = setup();
    const proj = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, { ...proj.parsed.frontmatter, archived: true });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(queue).toEqual({ ready: [], working: [], total: 0 });
  });

  // WI-1: on a CUSTOM 3-stage board (todo/doing/done) the review role resolves
  // to `doing` (the stage with an edge into the terminal). A literal-"review"
  // filter left this queue permanently empty while the rail badge counted it.
  // (The board used to come from the shipped "Lightweight" preset, deleted in
  // P13-AP-04; custom boards are still supported, so the coverage stays.)
  it("resolves the review stage from workflow roles, not the literal id 'review'", () => {
    const store = setupTestStore(ctx);
    writeProject(store.dataRoot, {
      name: "Lite",
      slug: "lite",
      repo: null,
      defaultBranch: "main",
      taskPrefix: "LP",
      nextTaskNumber: 1,
      stages: CUSTOM_3_STAGE_BOARD.stages,
      workflow: CUSTOM_3_STAGE_BOARD.workflow,
      members: [{ userId: store.users.arda.id, role: "admin" }],
      agents: [],
      credentialPolicy: null,
      guardrails: [],
    });
    writeTask(store.dataRoot, "lite", {
      frontmatter: baseTaskFrontmatter("LP-1", {
        title: "In the review-role stage",
        stage: "doing",
        waiting: "human",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const queue = getReviewQueue(store.db, "lite", {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(queue.total).toBe(1);
    expect(queue.ready.map((t) => t.key)).toEqual(["LP-1"]);
  });
});

describe("getReviewQueue member-scoping by acceptance authority (R8-3)", () => {
  // A review-stage task waiting on a human with NO packet/recommendation (the
  // operator couldn't open a completion packet). It still needs a human to
  // accept it, so the scoping must key on acceptance AUTHORITY (maintainer+ /
  // owner), not on the presence of a decision object.
  function seedBareHumanReview(
    store: ReturnType<typeof setupTestStore>,
    owner: string | null,
  ) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Bare human-waiting review",
        stage: "review",
        waiting: "human",
        ownerUserId: owner,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("a maintainer sees a bare human-waiting review task in `ready`", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, null);
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.murat.id,
    });
    expect(q.ready.map((t) => t.key)).toEqual(["VIB-201"]);
  });

  it("a viewer sees it in `working` but STILL flagged human-waiting (never 'agent working')", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, null);
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.elif.id,
    });
    expect(q.ready).toHaveLength(0);
    const row = q.working.find((t) => t.key === "VIB-201")!;
    // waiting stays "human" → the page renders "waiting on a human", not the
    // false "agent working" (the pre-fix regression).
    expect(row.waiting).toBe("human");
  });

  it("a contributor OWNER sees their bare human-waiting review task in `ready` (owner exception)", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, store.users.selin.id);
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.selin.id,
    });
    expect(q.ready.map((t) => t.key)).toEqual(["VIB-201"]);
  });

  it("a contributor NON-owner does not get it in `ready`", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, store.users.elif.id); // owned by someone else
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.selin.id,
    });
    expect(q.ready).toHaveLength(0);
    expect(q.working.map((t) => t.key)).toEqual(["VIB-201"]);
  });

  it("a NON-MEMBER viewer id gets nothing in `ready` — the task is still listed as in review", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, null);
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.deniz.id, // no membership row at all
    });
    expect(q.ready).toHaveLength(0);
    expect(q.working.map((t) => t.key)).toEqual(["VIB-201"]);
    expect(q.total).toBe(1);
  });

  // E5: the predicate used to open with `if (viewerUserId === undefined) return
  // true` — "may this person accept?" answered yes for everyone. `viewerUserId`
  // is a required parameter now, so no caller can reach that branch by omission;
  // this drives the shape a JS caller (or a future refactor that drops the
  // argument) would still produce, and asserts it fails CLOSED rather than
  // handing back an unfiltered acceptance list.
  /** What `getReviewQueue` requires — named so the cast below states exactly
   *  which required field the simulated caller omits. */
  interface ReviewQueueOptions {
    viewerUserId: string;
    dataRoot: string;
  }

  it("an absent viewer is fail-closed: nothing is acceptance-ready", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, null);
    // SAFETY: deliberately UNSOUND — `viewerUserId` is missing. That is the
    // input under test (see the note above): the JS-caller shape TypeScript
    // alone cannot produce, fed in to prove the predicate fails closed.
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
    } as ReviewQueueOptions);
    expect(q.ready).toHaveLength(0);
    expect(q.working.map((t) => t.key)).toEqual(["VIB-201"]);
  });
});

describe("F10-11: acceptance readiness is revision-bound, not just human-waiting", () => {
  it("a failing task (request_changes on the current revision) is NOT in `ready`", () => {
    const store = setupTestStore(ctx);
    const rev = {
      id: "rev_1",
      headSha: "a".repeat(40),
      treeSha: "t".repeat(40),
      branch: "vib-9-work",
      createdAt: "2026-07-04T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        title: "Rejected work",
        stage: "review",
        waiting: "human",
        branch: "vib-9-work",
        pr: { number: 99, state: "review", title: "Rejected work" },
        workRevision: rev,
        engagements: [
          { profileId: "developer", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: "a".repeat(40),
            result: "request_changes",
            reason: "spec violation",
            at: "2026-07-04T01:00:00.000Z",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    // Human-waiting, but a required reviewer requested changes → NOT acceptable.
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-9");
    const row = q.working.find((t) => t.key === "VIB-9")!;
    expect(row.blockReason).toMatch(/requests changes/i);
  });

  it("a task whose required reviewer approved the current revision IS in `ready`", () => {
    const store = setupTestStore(ctx);
    const rev = {
      id: "rev_1",
      headSha: "b".repeat(40),
      treeSha: "u".repeat(40),
      branch: "vib-8-work",
      createdAt: "2026-07-04T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-8", {
        title: "Approved work",
        stage: "review",
        waiting: "human",
        branch: "vib-8-work",
        pr: { number: 88, state: "review", title: "Approved work" },
        workRevision: rev,
        engagements: [
          { profileId: "developer", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: "b".repeat(40),
            result: "approve",
            reason: "looks good",
            at: "2026-07-04T01:00:00.000Z",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).toContain("VIB-8");
    expect(q.ready.find((t) => t.key === "VIB-8")!.blockReason).toBeNull();
  });

  it("a REJECTED-PR task (closed on GitHub, no reviewer block) is NOT `ready` — it needs a rework/archive decision (NEW-1)", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", {
        title: "Rejected on GitHub",
        stage: "review",
        waiting: "human",
        branch: "vib-7-work",
        // PR was CLOSED without merging (rejected via gh); no required-reviewer block.
        pr: { number: 77, state: "closed", title: "Rejected on GitHub" },
        validation: "healthy",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    // Human-waiting + no blockReason, but the PR was rejected → NOT acceptance-ready.
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-7");
    const row = q.working.find((t) => t.key === "VIB-7")!;
    expect(row.pr).toEqual({ number: 77, state: "closed" }); // closed preserved, not coerced to "review"
  });
});

/**
 * R15-1 (owner ruling, 2026-07-28): delivered work needs a HEALTHY verdict
 * before a human may accept it. The required-reviewer gate only binds when a
 * verdict-capable reviewer is ENGAGED, so an unreviewed delivery used to sit in
 * "Waiting on your acceptance" while the server refused to accept it.
 */
describe("R15-1: the verdict gate reaches the queue through the projection", () => {
  const REV = {
    id: "rev_1",
    headSha: "c".repeat(40),
    treeSha: "v".repeat(40),
    branch: "vib-6-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };

  function seedDelivered(
    store: ReturnType<typeof setupTestStore>,
    key: string,
    patch: Partial<TaskFrontmatter> = {},
  ) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        title: "Delivered, unreviewed",
        stage: "review",
        waiting: "human",
        branch: REV.branch,
        pr: { number: 66, state: "review", title: "Delivered, unreviewed" },
        workRevision: REV,
        // The delivering agent only — NOBODY is engaged to give a verdict.
        engagements: [
          {
            profileId: "developer",
            backend: "claude",
            role: "developer",
            delivers: true,
            verdictCapable: false,
          },
        ],
        verdicts: [],
        ...patch,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("a delivered revision with ZERO verdict-capable engagements is not `ready`", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-6");
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-6");
    const row = q.working.find((t) => t.key === "VIB-6")!;
    expect(row.blockReason).toMatch(/no approving verdict yet/i);
  });

  it("delivered work with NO review PR is not `ready` either", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-5", { pr: null });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-5");
    expect(
      q.working.find((t) => t.key === "VIB-5")!.blockReason,
    ).toMatch(/no review pull request/i);
  });

  it("an UNDELIVERED task (no revision) stays acceptable — planning work is not gated", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-4", { workRevision: null, pr: null, branch: null });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).toContain("VIB-4");
    expect(q.ready.find((t) => t.key === "VIB-4")!.blockReason).toBeNull();
  });

  /**
   * R16-3 (owner ruling 2026-08-04): a terminal GitHub fact outranks the
   * process gates, and force-accept is withheld while the PR is closed. The row
   * used to carry the verdict gate's "…or an admin can force-accept" beside a
   * PR GitHub had already closed — the exact override the task page refuses.
   */
  it("a CLOSED PR on the same delivered task replaces the verdict gate, force-accept and all", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-6", {
      pr: { number: 66, state: "closed", title: "Delivered, unreviewed" },
    });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const row = q.working.find((t) => t.key === "VIB-6")!;
    expect(row.blockReason).toContain("closed on GitHub without merging");
    expect(row.blockReason).not.toContain("force-accept");
    expect(row.blockReason).not.toContain("approving verdict");
    // Unchanged: it was never acceptance-ready (NEW-1 filters closed PRs out).
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-6");
  });

  it("the same task with its PR still OPEN keeps the process-gate sentence", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-6");
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.working.find((t) => t.key === "VIB-6")!.blockReason).toMatch(
      // R19-B added a third way to satisfy the gate, so the sentence names it.
      // Telling a reader only two of the three ways to unblock is the same
      // half-truth this pass has been removing everywhere else.
      /no approving verdict yet\. Run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept/,
    );
  });

  it("a MERGED PR is not terminal — the verdict gate still names the real blocker", () => {
    const store = setupTestStore(ctx);
    seedDelivered(store, "VIB-6", {
      pr: { number: 66, state: "merged", title: "Delivered, unreviewed" },
    });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const row = q.working.find((t) => t.key === "VIB-6")!;
    expect(row.pr).toMatchObject({ number: 66, state: "merged" });
    expect(row.blockReason).toMatch(/no approving verdict yet/);
  });
});

/**
 * F19-32 / ruling 40 (R16-6): "accepted" — a completion accepted with the real
 * GitHub merge still outstanding — is a FIRST-CLASS pr state, and the ruling
 * requires the difference to be visible on the board card AND this queue. The
 * row used to narrow the union to review|merged|closed and coerce everything
 * else through a catch-all `: ("review" as const)`, so the state arrived here
 * indistinguishable from an open PR and `prStatePill`'s amber "merge pending"
 * branch was structurally unreachable from the queue.
 */
describe("the row carries the canonical PR state, uncoerced", () => {
  function seedPrState(
    store: ReturnType<typeof setupTestStore>,
    key: string,
    state: "review" | "accepted" | "merged" | "closed",
  ) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        title: `PR is ${state}`,
        stage: "review",
        waiting: "human",
        pr: { number: 44, state, title: `PR is ${state}` },
      }),
    });
  }

  it("passes ACCEPTED (merge pending) through instead of folding it into 'review'", () => {
    const store = setupTestStore(ctx);
    seedPrState(store, "VIB-21", "accepted");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const row = [...q.ready, ...q.working].find((t) => t.key === "VIB-21")!;
    expect(row.pr).toEqual({ number: 44, state: "accepted" });
    // The point of the fix: NOT "review". A coerced row renders the blue
    // "in review" pill over a PR whose merge is the outstanding human step.
    expect(row.pr!.state).not.toBe("review");
  });

  it("keeps every other state intact (no new coercion replaced the old one)", () => {
    const store = setupTestStore(ctx);
    seedPrState(store, "VIB-22", "review");
    seedPrState(store, "VIB-23", "merged");
    seedPrState(store, "VIB-24", "closed");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const stateOf = (key: string) =>
      [...q.ready, ...q.working].find((t) => t.key === key)!.pr!.state;
    expect(stateOf("VIB-22")).toBe("review");
    expect(stateOf("VIB-23")).toBe("merged");
    // NEW-1's original point: a rejected PR must not read as an open one.
    expect(stateOf("VIB-24")).toBe("closed");
  });
});

/**
 * UX19-3: "Waiting on your acceptance" is a PROMISE, and it was being made for
 * tasks the server refuses to accept. The projected `blockReason` column carries
 * only part of the gate (`acceptanceBlockReason` deliberately omits the open
 * blocked-decision and conflicting-PR refusals that `acceptanceRefusalReason`
 * enforces on every writer), and the panel split re-checked neither — so a row
 * sat under "Waiting on your acceptance" while the task page one click away read
 * "Acceptance is blocked". The row itself stays a triage link (R15-11: it says
 * "Review", never "Accept"); it is the PANEL that must not over-promise.
 */
describe("UX19-3: the acceptance panel asks the same questions the writer does", () => {
  it("a task with an OPEN blocked decision is listed, but never as acceptance-ready", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-31", {
        title: "Blocked at the boundary",
        stage: "review",
        // A blocked packet is what SET waiting to human (operator-actions).
        waiting: "human",
        readiness: "blocked",
        validation: "healthy",
      }),
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Pick a recovery path",
        body: "b",
        observations: [],
        options: [],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-31");
    expect(q.working.map((t) => t.key)).toContain("VIB-31");
    // It stays visible with its packet header — this is a re-file, not a hide.
    expect(q.working.find((t) => t.key === "VIB-31")!.packet).toEqual({
      kind: "Blocked decision",
      title: "Pick a recovery path",
    });
    expect(q.total).toBe(1);
  });

  it("a task whose PR CONFLICTS with the base branch is not acceptance-ready", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-32", {
        title: "Conflicting PR at the boundary",
        stage: "review",
        waiting: "human",
        validation: "healthy",
        pr: {
          number: 55,
          state: "review",
          title: "Conflicting PR at the boundary",
          mergeable: "conflicting",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    // GitHub cannot merge it, so the server refuses the accept — the panel that
    // names "your acceptance" must not claim otherwise.
    expect(q.ready.map((t) => t.key)).not.toContain("VIB-32");
    const row = q.working.find((t) => t.key === "VIB-32")!;
    expect(row.pr!.mergeable).toBe("conflicting");
  });

  it("the same task with a CLEAN PR and no blocked packet is still ready — the gate did not widen", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-33", {
        title: "Mergeable at the boundary",
        stage: "review",
        waiting: "human",
        validation: "healthy",
        pr: {
          number: 56,
          state: "review",
          title: "Mergeable at the boundary",
          mergeable: "clean",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(q.ready.map((t) => t.key)).toEqual(["VIB-33"]);
  });
});

/**
 * P14-LV-07 residual: `prStateSub` has described a conflicting PR since LV-07,
 * but the row it reads never carried `mergeable` — so on every real queue that
 * branch was unreachable and the one PR state that CANNOT be merged looked
 * exactly like a healthy open one.
 */
describe("the row carries GitHub's mergeability", () => {
  it("forwards `mergeable` from the projection", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        title: "Conflicting",
        stage: "review",
        waiting: "human",
        pr: {
          number: 55,
          state: "review",
          title: "Conflicting",
          mergeable: "conflicting",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const row = [...q.ready, ...q.working].find((t) => t.key === "VIB-11")!;
    expect(row.pr!.mergeable).toBe("conflicting");
  });

  it("an unread mergeability is ABSENT, never coerced to a value", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-12", {
        title: "Never reconciled",
        stage: "review",
        waiting: "human",
        pr: { number: 56, state: "review", title: "Never reconciled" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const q = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    const row = [...q.ready, ...q.working].find((t) => t.key === "VIB-12")!;
    // Not "clean": nobody asked GitHub. The subline must not claim mergeability
    // it never read (prStateSub only speaks on an explicit "conflicting").
    expect("mergeable" in row.pr!).toBe(false);
  });
});

/**
 * Ruling 135: the row carries `pr.headSha` and the CURRENT `pr.unpushedRevision`
 * from the REAL projection (a hand-built fixture would let `prStateSub`'s
 * branch pass while the row carried nothing, the P14-LV-07 defect again), and
 * such a task never sits under "Waiting on your acceptance". Canary: stop
 * copying the two fields in the row builder.
 */
describe("ruling 135: the queue row and the unpushed revision", () => {
  it("carries both fields through the projection and keeps the task out of `ready`", () => {
    const store = setupTestStore(ctx);
    const record = { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" as const };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-103", {
        title: "Unpushed rework",
        stage: "review",
        waiting: "human",
        branch: "vib-103",
        workRevision: { id: "rev_1", headSha: "9".repeat(40), treeSha: null, branch: "vib-103", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
        pr: { number: 320, state: "review", title: "Unpushed rework", headSha: "1".repeat(40), unpushedRevision: record },
      }),
    });
    // A stale record (older revision) reads as nothing.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-104", {
        title: "Stale record",
        stage: "review",
        waiting: "human",
        branch: "vib-104",
        workRevision: { id: "rev_2", headSha: "7".repeat(40), treeSha: null, branch: "vib-104", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
        pr: { number: 321, state: "review", title: "Stale record", headSha: "1".repeat(40), unpushedRevision: record },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot, viewerUserId: store.users.arda.id });
    const rows = [...queue.ready, ...queue.working];
    const unpushed = rows.find((r) => r.key === "VIB-103")!;
    expect(unpushed.pr).toEqual({ number: 320, state: "review", headSha: "1".repeat(40), unpushedRevision: record });
    expect(queue.ready.map((r) => r.key)).not.toContain("VIB-103");
    const stale = rows.find((r) => r.key === "VIB-104")!;
    expect(stale.pr).toEqual({ number: 321, state: "review", headSha: "1".repeat(40) });
  });
});

/** Ruling 132: the queue row carries the WHOLE drift record (a projection of
 *  the count alone dropped `baseRefresh` before the row was built). Canary:
 *  restore `pr.revisionDrift = { headSha, authored }`. */
describe("ruling 132: the queue row carries the whole drift record", () => {
  it("baseRefresh rides through the real projection", () => {
    const store = setupTestStore(ctx);
    const record = { headSha: "b".repeat(40), authored: 0, baseRefresh: { merges: 1, commits: 4 } };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-105", {
        title: "Refreshed",
        stage: "review",
        waiting: "human",
        pr: { number: 330, state: "review", title: "Refreshed", revisionDrift: record },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot, viewerUserId: store.users.arda.id });
    const row = [...queue.ready, ...queue.working].find((r) => r.key === "VIB-105")!;
    expect(row.pr?.revisionDrift).toEqual(record);
  });
});
