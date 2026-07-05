import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
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
    const queue = getReviewQueue(store.db, store.slug);

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

    const bare = queue.working.find((t) => t.key === "VIB-103")!;
    expect(bare.packet).toBeNull();
    expect(bare.latestEventText).toBeNull();
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
    expect(queue).toEqual({ ready: [], working: [], total: 0 });
  });
});
