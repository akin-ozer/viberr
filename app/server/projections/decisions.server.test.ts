import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  OPEN_DECISION,
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
import type { TaskFrontmatter } from "~/schemas/task-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** A task at a non-terminal stage carrying an open packet. */
function seedOpenDecision(
  store: ReturnType<typeof setupTestStore>,
  key: string,
  patch: Partial<TaskFrontmatter> = {},
) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "review", ...patch }),
    packet: OPEN_DECISION,
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
      packet: OPEN_DECISION,
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
      packet: OPEN_DECISION,
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

    it("a CONFLICTING PR: no acceptance decision, and NOT acceptable in the queue", () => {
      const store = setupTestStore(ctx);
      // Ruling 304: murat owns it, so the queue lists it as his row too.
      const owned = { ownerUserId: store.users.murat.id };
      // Baseline: approved, mergeable PR → both surfaces promise the acceptance.
      seedAcceptanceReady(store, "VIB-320", owned);
      expect(
        decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.kind),
      ).toEqual(["acceptance"]);
      expect(queue(store).acceptableKeys).toEqual(["VIB-320"]);
      expect(queue(store).completions.map((r) => r.key)).toEqual(["VIB-320"]);

      // Same task, GitHub now reports the head conflicts with the base branch.
      seedAcceptanceReady(store, "VIB-320", {
        ...owned,
        pr: {
          number: 300,
          state: "review",
          title: "Task VIB-320",
          mergeable: "conflicting",
        },
      });
      expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
      const after = queue(store);
      expect(after.acceptableKeys).toHaveLength(0);
      // Ruling 304: nothing on it is a decision anybody can make now, so the
      // queue lists it no more than the inbox does (the projected reason itself
      // is rebuilder.server.test.ts's).
      expect(after.completions).toHaveLength(0);
      expect(after.decisions).toHaveLength(0);
    });

    /**
     * F37-71 (pass 37, live on SHOP-12). UX19-3 put both missing refusals into
     * `validation_block_reason` "so the ONE predicate below is again the whole
     * gate and the two readers cannot drift" — and wired it into the ACCEPTANCE
     * query only. The sibling query two lines above it, the one that picks up a
     * task carrying a pending RECOMMENDATION, has no acceptance gate at all.
     *
     * An `accept_completion` recommendation IS an acceptance, so the same task
     * that UX19-3 correctly drops as `kind: "acceptance"` comes straight back in
     * as `kind: "recommendation"` the moment the operator files a card for it.
     *
     * Live: SHOP-12's PR #14 was `mergeable: conflicting` (GitHub agreed), the
     * task page disabled its Accept button and printed the refusal, the review
     * queue filed it under "Still in review" and said "Nothing waits on you" —
     * and the notifications page said "Waiting on you · 1 decision · Accept
     * completion and move SHOP-12 to Done".
     */
    it("F37-71: an accept_completion RECOMMENDATION is gated by the same conflict", () => {
      const store = setupTestStore(ctx);
      // The optional-key convention: an ABSENT `mergeable` is "GitHub has not
      // said", which is not the same as passing undefined through a typed field.
      const prFor = (mergeable?: "conflicting"): TaskFrontmatter["pr"] => {
        const pr = { number: 300, state: "review" as const, title: "Task VIB-322" };
        return mergeable ? { ...pr, mergeable } : pr;
      };
      const withOffer = (mergeable?: "conflicting") =>
        seedAcceptanceReady(store, "VIB-322", {
          pr: prFor(mergeable),
          recommendations: [
            {
              id: "rec_1",
              kind: "accept_completion",
              toStageId: "done",
              label: "Accept completion and move VIB-322 to Done",
              detail: "The review is clean and the work meets the goal.",
              forHeadSha: REVISION.headSha,
            },
          ],
        });

      // Baseline: a clean PR, so the offer is real and both surfaces say so.
      withOffer();
      expect(
        decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.kind),
      ).toEqual(["recommendation"]);
      expect(queue(store).acceptableKeys).toEqual(["VIB-322"]);

      // The PR now conflicts. The acceptance the card offers is refused.
      withOffer("conflicting");
      expect(queue(store).acceptableKeys).toHaveLength(0);
      // CANARY: this is the shipped state — the card walks back in through the
      // recommendation query and the inbox demands a decision nobody can make.
      expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(0);
    });

    it("F37-71: a recommendation that is NOT an acceptance still counts while the PR conflicts", () => {
      // The other half, and the reason this cannot be a blanket filter on
      // `validation_block_reason`: a stage-transition card is actionable whatever
      // GitHub thinks of the merge, and hiding it would lose a real decision.
      const store = setupTestStore(ctx);
      seedAcceptanceReady(store, "VIB-323", {
        pr: {
          number: 300,
          state: "review",
          title: "Task VIB-323",
          mergeable: "conflicting",
        },
        recommendations: [
          {
            id: "rec_2",
            kind: "transition",
            toStageId: "impl",
            label: "Move VIB-323 back to Build",
            detail: "The branch needs a rebase before review can finish.",
          },
        ],
      });
      expect(
        decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.kind),
      ).toEqual(["recommendation"]);
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
          // Ruling 304: murat's own, so the queue lists the packet as his row.
          ownerUserId: store.users.murat.id,
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
        packet: { ...OPEN_DECISION, type: "blocked", kind: "Blocked decision" },
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      // Still exactly one decision — but it is the packet the human must resolve,
      // not an acceptance the accept action would refuse.
      const mine = decisionsRequiring(store.db, store.users.murat.id).mine;
      expect(mine.map((d) => [d.taskKey, d.kind])).toEqual([["VIB-321", "packet"]]);
      // The queue agrees: not acceptance-ready, and the row is the packet's.
      const after = queue(store);
      expect(after.acceptableKeys).toHaveLength(0);
      expect(after.decisions.map((r) => r.key)).toEqual(["VIB-321"]);
    });
  });
});
