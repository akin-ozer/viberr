import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import { rebuildAll } from "./rebuilder.server";
import { decisionsRequiring } from "./decisions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const PACKET: TaskPacket = {
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Pick one",
  body: "",
  observations: [],
  options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
};

/** A task at a non-terminal stage carrying an open packet. */
function seedOpenDecision(
  store: ReturnType<typeof setupTestStore>,
  key: string,
  patch: Record<string, unknown> = {},
) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "review", ...patch }),
    packet: PACKET,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

describe("decisionsRequiring (R8-3 single member-scoped source)", () => {
  it("maintainer+ hold every open decision as `mine`; viewers hold none", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-201");

    // arda = admin, murat = maintainer → the decision is theirs.
    expect(decisionsRequiring(store.db, store.users.arda.id).mine).toHaveLength(1);
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(1);
    // selin = contributor (not the owner) + elif = viewer → nothing.
    expect(decisionsRequiring(store.db, store.users.selin.id).mine).toHaveLength(0);
    expect(decisionsRequiring(store.db, store.users.elif.id).mine).toHaveLength(0);
  });

  it("a contributor who OWNS the task holds its decision (owner allowance)", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-202", { ownerUserId: store.users.selin.id });
    // selin is a contributor AND the owner → mine.
    const selin = decisionsRequiring(store.db, store.users.selin.id);
    expect(selin.mine.map((d) => d.taskKey)).toEqual(["VIB-202"]);
    // deniz (non-member) owning nothing → nothing.
    expect(decisionsRequiring(store.db, store.users.deniz.id).mine).toHaveLength(0);
  });

  it("a contributor-owner DOES hold a transition/assign/run recommendation on their own task (R14-2)", () => {
    const store = setupTestStore(ctx);
    // A recommendation-ONLY task (no packet) owned by a contributor. Under the
    // pass-12 narrow exception this was NOT counted as theirs, because neither
    // apply nor dismiss honored an owner. R14-2 widened the server: the owner
    // governs every decision on their own task and can always dismiss it, so
    // counting it here is now honest instead of a dead-end inbox row.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-210", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id,
        recommendations: [
          { id: "r1", kind: "transition", toStageId: "done", label: "Accept", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      decisionsRequiring(store.db, store.users.selin.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-210"]);
    // A maintainer holds it too (maintainer+ can act on any decision).
    expect(
      decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-210"]);
    // A contributor who does NOT own it still holds nothing.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-210", {
        stage: "review",
        waiting: "human",
        ownerUserId: null,
        recommendations: [
          { id: "r1", kind: "transition", toStageId: "done", label: "Accept", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(decisionsRequiring(store.db, store.users.selin.id).mine).toHaveLength(0);
  });

  it("a contributor-owner DOES hold an accept_completion recommendation (owner exception)", () => {
    const store = setupTestStore(ctx);
    // accept_completion is the ONE recommendation kind an owner can act on — the
    // owner exception (R6-2) lets a contributor-owner accept their task's
    // completion, exactly like resolving a completion packet.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-211", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id,
        recommendations: [
          {
            id: "r1",
            kind: "accept_completion",
            toStageId: "done",
            label: "Accept completion",
            detail: "",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      decisionsRequiring(store.db, store.users.selin.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-211"]);
    // A contributor who is NOT the owner still can't accept → not theirs.
    // (Reuse deniz — a non-member — for the clearly-nothing case.)
    expect(decisionsRequiring(store.db, store.users.deniz.id).mine).toHaveLength(0);
  });

  it("an org admin who is a below-tier project member gets overrideEligible (not dropped)", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-212");
    // An ORG admin who is ALSO a project VIEWER (below the maintainer+ tier).
    // resolveProjectAuthority would grant them the audited D2 override, so the
    // decision must surface as overrideEligible — NOT silently dropped.
    const admin = insertUser(store.db, {
      id: "u_orgadmin_viewer",
      email: "orgadmin-viewer@viberr.test",
      name: "Org Admin Viewer",
      role: "admin",
    });
    store.db
      .prepare(
        `INSERT INTO project_members (project_slug, user_id, role) VALUES (?, ?, 'viewer')`,
      )
      .run(store.slug, admin.id);
    const result = decisionsRequiring(store.db, admin.id);
    expect(result.mine).toHaveLength(0);
    expect(result.overrideEligible.map((d) => d.taskKey)).toEqual(["VIB-212"]);
  });

  it("a non-member ORG ADMIN gets `overrideEligible`, never `mine`", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-203");
    // An org admin who is NOT a project member.
    const rec = insertUser(store.db, {
      id: "u_orgadmin_dec",
      email: "orgadmin-dec@viberr.test",
      name: "Org Admin",
      role: "admin",
    });
    const result = decisionsRequiring(store.db, rec.id);
    expect(result.mine).toHaveLength(0);
    expect(result.overrideEligible.map((d) => d.taskKey)).toEqual(["VIB-203"]);
  });

  it("terminal-stage tasks are never counted, even with a leftover packet", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-204", { stage: "done", waiting: "none" }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(decisionsRequiring(store.db, store.users.arda.id).mine).toHaveLength(0);
  });

  it("dedupes to one decision per task and honors projectSlug scoping", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-205");
    seedOpenDecision(store, "VIB-206");
    const all = decisionsRequiring(store.db, store.users.murat.id);
    expect(all.mine.map((d) => d.taskKey).sort()).toEqual(["VIB-205", "VIB-206"]);
    const scoped = decisionsRequiring(store.db, store.users.murat.id, {
      projectSlug: "no-such-project",
    });
    expect(scoped.mine).toHaveLength(0);
  });
});

/**
 * B-FD5: a review-stage task ready for acceptance carries NO decision object.
 * It belongs in the one shared source, so Home's card count and the
 * notifications inbox see what the board and the review queue already saw.
 */
describe("decisionsRequiring — acceptance-ready tasks (B-FD5)", () => {
  const REVISION = {
    id: "rev_1",
    headSha: "b".repeat(40),
    treeSha: "u".repeat(40),
    branch: "vib-300-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };

  /** A review-stage task with an approved delivered revision and NO packet or
   *  recommendation — exactly the review queue's `ready` shape. */
  function seedAcceptanceReady(
    store: ReturnType<typeof setupTestStore>,
    key: string,
    patch: Record<string, unknown> = {},
  ) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        stage: "review",
        waiting: "human",
        branch: REVISION.branch,
        pr: { number: 300, state: "review", title: `Task ${key}` },
        workRevision: REVISION,
        engagements: [
          { profileId: "developer", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: REVISION.id,
            headSha: REVISION.headSha,
            result: "approve",
            reason: "looks good",
            at: "2026-07-04T01:00:00.000Z",
          },
        ],
        ...patch,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("counts an acceptance-ready task with no packet and no recommendation", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-300");
    const murat = decisionsRequiring(store.db, store.users.murat.id);
    expect(murat.mine.map((d) => [d.taskKey, d.kind])).toEqual([["VIB-300", "acceptance"]]);
    // Acceptance authority is the same tier as the rest: a viewer holds nothing.
    expect(decisionsRequiring(store.db, store.users.elif.id).mine).toHaveLength(0);
  });

  it("a contributor OWNER holds their own task's acceptance; a contributor non-owner does not", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-301", { ownerUserId: store.users.selin.id });
    expect(
      decisionsRequiring(store.db, store.users.selin.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-301"]);

    seedAcceptanceReady(store, "VIB-301", { ownerUserId: null });
    expect(decisionsRequiring(store.db, store.users.selin.id).mine).toHaveLength(0);
  });

  it("does not count a task blocked from acceptance, nor one whose PR was closed unmerged", () => {
    const store = setupTestStore(ctx);
    // Awaiting the required reviewer's verdict on the delivered revision.
    seedAcceptanceReady(store, "VIB-302", { verdicts: [] });
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);

    // Approved, but the PR was rejected on GitHub — that needs a rework/archive
    // call, not an acceptance.
    seedAcceptanceReady(store, "VIB-302", {
      pr: { number: 300, state: "closed", title: "Rejected" },
    });
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
  });

  it("a task that is BOTH acceptance-ready and packet-bearing still counts once", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-303", {
        stage: "review",
        waiting: "human",
        branch: REVISION.branch,
        pr: { number: 303, state: "review", title: "Both" },
        workRevision: REVISION,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: REVISION.id,
            headSha: REVISION.headSha,
            result: "approve",
            reason: "looks good",
            at: "2026-07-04T01:00:00.000Z",
          },
        ],
      }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const mine = decisionsRequiring(store.db, store.users.murat.id).mine;
    expect(mine).toHaveLength(1);
    // The packet is the operative decision when a task carries both.
    expect(mine[0]!.kind).toBe("packet");
  });

  it("an archived acceptance-ready task, and a non-review-stage human-waiting task, are not decisions", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-304", { archived: true });
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);

    // Human-waiting in triage is not an acceptance boundary.
    seedAcceptanceReady(store, "VIB-305", { stage: "triage" });
    expect(
      decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.taskKey),
    ).not.toContain("VIB-305");
  });

  it("a non-member ORG ADMIN gets acceptance as overrideEligible, never `mine`", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-306");
    const admin = insertUser(store.db, {
      id: "u_orgadmin_accept",
      email: "orgadmin-accept@viberr.test",
      name: "Org Admin Accept",
      role: "admin",
    });
    const result = decisionsRequiring(store.db, admin.id);
    expect(result.mine).toHaveLength(0);
    expect(result.overrideEligible.map((d) => d.kind)).toEqual(["acceptance"]);
  });
});
