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
import { readTaskFile } from "~/server/files/task-writer.server";

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
        actor: { kind: "agent", backend: "codex", role: "Developer" },
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
      pr: { number: 310, state: "closed", title: "Closed fixture" },
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
  it("splits review-stage tasks without calling review+none agent work", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug);

    expect(queue.total).toBe(3);
    expect(queue.ready.map((t) => t.key)).toEqual(["VIB-101"]);
    expect(queue.working.map((t) => t.key)).toEqual(["VIB-102"]);
    expect(queue.unattended.map((t) => t.key)).toEqual(["VIB-103"]);
    expect(queue.unattended[0]?.waiting).toBe(
      "none",
    );
    expect(queue.unattended[0]?.pr?.state).toBe("closed");
  });

  it("carries the subline sources: packet header, newest event text, or nothing", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug);

    const withPacket = queue.ready[0]!;
    expect(withPacket.packet).toEqual({
      kind: "Completion report",
      title: "Accept completion, or send back for one fix?",
    });

    const withTimeline = queue.working.find((t) => t.key === "VIB-102")!;
    expect(withTimeline.packet).toBeNull();
    // Newest-first: position 0 is the transition request, not the comment.
    expect(withTimeline.latestEventText).toContain("**Transition request:**");

    const bare = queue.unattended.find((t) => t.key === "VIB-103")!;
    expect(bare.packet).toBeNull();
    expect(bare.latestEventText).toBeNull();
  });

  it("routes review responsibility to supervisors or the active task owner only", () => {
    const store = setup();
    const ownerFile = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-101",
      dataRoot: store.dataRoot,
    })!;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...ownerFile.parsed.frontmatter,
        ownerUserId: store.users.selin.id,
      },
      packet: ownerFile.parsed.packet,
      timeline: ownerFile.parsed.timeline,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const owner = getReviewQueue(store.db, store.slug, {
      userId: store.users.selin.id,
      projectRole: "contributor",
    });
    expect(owner.ready.map((t) => t.key)).toEqual(["VIB-101"]);

    const otherContributor = getReviewQueue(store.db, store.slug, {
      userId: store.users.elif.id,
      projectRole: "viewer",
    });
    expect(otherContributor.ready).toHaveLength(0);
    expect(otherContributor.others.map((t) => t.key)).toEqual(["VIB-101"]);

    // Emergency org-admin authority is intentionally absent from this read
    // predicate: a nonmember can intervene, but it is not routine work for them.
    const nonmemberOrgAdmin = getReviewQueue(store.db, store.slug, {
      userId: store.users.deniz.id,
      projectRole: null,
    });
    expect(nonmemberOrgAdmin.ready).toHaveLength(0);
  });

  it("keeps pr + validation for the meta cluster", () => {
    const store = setup();
    const queue = getReviewQueue(store.db, store.slug);
    expect(queue.ready[0]!.pr).toEqual({ number: 318, state: "review" });
    expect(queue.ready[0]!.validation).toBe("changed");
    expect(queue.working[0]!.validation).toBe("healthy");
  });

  it("returns empty panels for a project with no review-stage tasks", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const queue = getReviewQueue(store.db, store.slug);
    expect(queue).toEqual({
      ready: [],
      others: [],
      working: [],
      unattended: [],
      total: 0,
    });
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

    const queue = getReviewQueue(store.db, "lite");
    expect(queue.total).toBe(1);
    expect(queue.ready.map((t) => t.key)).toEqual(["LP-1"]);
  });
});
