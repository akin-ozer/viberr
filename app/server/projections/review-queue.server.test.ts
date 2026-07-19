import { afterEach, describe, expect, it } from "vitest";
import { LIGHTWEIGHT_TEMPLATE } from "~/shared/workflow/templates";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
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
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });

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
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });

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
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(queue.ready[0]!.pr).toEqual({ number: 318, state: "review" });
    expect(queue.ready[0]!.validation).toBe("changed");
    expect(queue.working[0]!.validation).toBe("healthy");
  });

  it("returns empty panels for a project with no review-stage tasks", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(queue).toEqual({ ready: [], working: [], total: 0 });
  });

  // WI-1: on a Lightweight board (todo/doing/done) the review role resolves to
  // `doing` (the stage with an edge into the terminal). A literal-"review"
  // filter left this queue permanently empty while the rail badge counted it.
  it("resolves the review stage from workflow roles, not the literal id 'review'", () => {
    const store = setupTestStore(ctx);
    writeProject(store.dataRoot, {
      name: "Lite",
      slug: "lite",
      repo: null,
      defaultBranch: "main",
      taskPrefix: "LP",
      nextTaskNumber: 1,
      stages: LIGHTWEIGHT_TEMPLATE.stages,
      workflow: LIGHTWEIGHT_TEMPLATE.workflow,
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

    const queue = getReviewQueue(store.db, "lite", { dataRoot: store.dataRoot });
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

  it("unscoped (no viewer) keeps the state-based split — any human-waiting task is ready", () => {
    const store = setupTestStore(ctx);
    seedBareHumanReview(store, null);
    const q = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(q.ready.map((t) => t.key)).toEqual(["VIB-201"]);
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
    const q = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });
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
    const q = getReviewQueue(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(q.ready.map((t) => t.key)).toContain("VIB-8");
    expect(q.ready.find((t) => t.key === "VIB-8")!.blockReason).toBeNull();
  });
});
