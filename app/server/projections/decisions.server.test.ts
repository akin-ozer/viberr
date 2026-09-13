import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import {
  parseProjectFileContent,
  serializeProjectFile,
} from "~/server/files/project-file.server";
import { rebuildAll } from "./rebuilder.server";
import { decisionsRequiring } from "./decisions.server";
import { getReviewQueue } from "./review-queue.server";
import type { TaskFrontmatter, TaskPacket } from "~/schemas/task-file.schema";

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
  patch: Partial<TaskFrontmatter> = {},
) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "review", ...patch }),
    packet: PACKET,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** Archive the fixture PROJECT through its canonical file, membership and all
 *  else untouched — the projection follows the store, as in the real action. */
function archiveProject(store: ReturnType<typeof setupTestStore>): void {
  const filePath = projectFilePath(store.slug, store.dataRoot);
  const { parsed } = parseProjectFileContent(readFileSync(filePath, "utf8"));
  writeFileAtomic(
    filePath,
    serializeProjectFile({
      ...parsed,
      frontmatter: { ...parsed.frontmatter, archived: true },
    }),
  );
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
    patch: Partial<TaskFrontmatter> = {},
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
            rounds: 1,
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
            rounds: 1,
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

  it("does NOT count a delivered revision with zero verdict-capable engagements (R15-1)", () => {
    const store = setupTestStore(ctx);
    // The live hole: no reviewer is ENGAGED, so `acceptanceBlockedReason` has
    // nothing to require and the task read as acceptance-ready — while the
    // server's own affordance answered canAccept:false with R15-1's verdict
    // gate. Home's count and the notifications inbox promised a decision the
    // accept action then refused.
    seedAcceptanceReady(store, "VIB-307", {
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
    });
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
    // Same shape, one approving verdict from an engaged reviewer → a real
    // decision again (the gate blocks the unverdicted case, not acceptance).
    seedAcceptanceReady(store, "VIB-307");
    expect(
      decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.kind),
    ).toEqual(["acceptance"]);
  });

  it("does NOT count delivered work that has no review PR (R15-1 gate 1)", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-308", { pr: null });
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
  });

  it("an ARCHIVED PROJECT yields no decisions at all — it is read-only (R6-3)", () => {
    const store = setupTestStore(ctx);
    seedAcceptanceReady(store, "VIB-309");
    seedOpenDecision(store, "VIB-310");
    expect(
      decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.taskKey).sort(),
    ).toEqual(["VIB-309", "VIB-310"]);

    archiveProject(store);

    const after = decisionsRequiring(store.db, store.users.murat.id);
    expect(after.mine).toHaveLength(0);
    // Not an override case either: nobody can act inside an archived project.
    expect(after.overrideEligible).toHaveLength(0);
    expect(decisionsRequiring(store.db, store.users.arda.id).mine).toHaveLength(0);
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

  /**
   * UX19-3 — the two readers of the acceptance gate, asserted TOGETHER.
   *
   * `acceptanceRows` filtered on `validation_block_reason` and `pr.state` only,
   * and the projected column left the open-blocked-packet and conflicting-PR
   * refusals to each reader. The review queue re-derived them locally; this inbox
   * re-derived neither, so the same task was "Still in review" on one surface and
   * a `kind: "acceptance"` decision on the other — an acceptance the server
   * refuses. Both surfaces are checked in one test on purpose: a future scoped
   * fix to one of them fails here instead of shipping a fresh divergence.
   */
  describe("parity with the review queue on the gates the column used to omit", () => {
    const queue = (store: ReturnType<typeof setupTestStore>) =>
      getReviewQueue(store.db, store.slug, {
        viewerUserId: store.users.murat.id,
      });

    it("a CONFLICTING PR: no acceptance decision, and NOT in the queue's ready panel", () => {
      const store = setupTestStore(ctx);
      // Baseline: approved, mergeable PR → both surfaces promise the acceptance.
      seedAcceptanceReady(store, "VIB-320");
      expect(
        decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.kind),
      ).toEqual(["acceptance"]);
      expect(queue(store).ready.map((r) => r.key)).toEqual(["VIB-320"]);

      // Same task, GitHub now reports the head conflicts with the base branch.
      seedAcceptanceReady(store, "VIB-320", {
        pr: {
          number: 300,
          state: "review",
          title: "Task VIB-320",
          mergeable: "conflicting",
        },
      });
      expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
      const after = queue(store);
      expect(after.ready).toHaveLength(0);
      expect(after.working.map((r) => r.key)).toEqual(["VIB-320"]);
      // And the projected reason NAMES the conflict on both surfaces.
      expect(after.working[0]!.blockReason).toContain(
        "conflicts with the base branch",
      );
    });

    it("an OPEN BLOCKED PACKET: the decision is the PACKET, never an acceptance", () => {
      const store = setupTestStore(ctx);
      seedAcceptanceReady(store, "VIB-321");
      // Re-write the same acceptance-ready task with an operator-raised blocked
      // decision open on it. Packets set `waiting: human`, so nothing else about
      // the acceptance shape changes.
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-321", {
          stage: "review",
          waiting: "human",
          readiness: "blocked",
          branch: REVISION.branch,
          pr: { number: 300, state: "review", title: "Task VIB-321" },
          workRevision: REVISION,
          engagements: [
            {
              profileId: "reviewer",
              backend: "claude",
              role: "Review",
              delivers: false,
              verdictCapable: true,
            },
          ],
          verdicts: [
            {
              profileId: "reviewer",
              revisionId: REVISION.id,
              headSha: REVISION.headSha,
              result: "approve",
              reason: "looks good",
              at: "2026-07-04T01:00:00.000Z",
              rounds: 1,
            },
          ],
        }),
        packet: { ...PACKET, type: "blocked", kind: "Blocked decision" },
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      // Still exactly one decision — but it is the packet the human must resolve,
      // not an acceptance the accept action would refuse.
      const mine = decisionsRequiring(store.db, store.users.murat.id).mine;
      expect(mine.map((d) => [d.taskKey, d.kind])).toEqual([["VIB-321", "packet"]]);
      // The queue agrees: not acceptance-ready.
      const after = queue(store);
      expect(after.ready).toHaveLength(0);
      expect(after.working.map((r) => r.key)).toEqual(["VIB-321"]);
    });
  });
});
