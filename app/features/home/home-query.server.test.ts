import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { createPat } from "~/server/secrets/pat-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import {
  getHomeOrgSummary,
  listHomeProjectsForUser,
} from "./home-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("getHomeOrgSummary — connection picker", () => {
  it("lists real GitHub connections even before any project references the repo", () => {
    const store = setupTestStore(ctx);
    // A connection exists but NO project uses that owner's repo yet.
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "connection · acme", token: "ghp_testtesttesttesttesttesttest0000" },
      { userId: store.users.arda.id, label: "arda" },
    );
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("acme", "acme", pat.id, now, now);

    const summary = getHomeOrgSummary(store.db, { dataRoot: store.dataRoot });
    // Before the fix this derived owners from project repos and returned [].
    expect(summary.connectionOwners).toContain("acme");
  });
});

describe("listHomeProjectsForUser — membership scoping (D10/Q6)", () => {
  it("a non-member org member sees no projects they don't belong to", () => {
    const store = setupProjectedStore(ctx);
    // deniz is an org MEMBER and NOT a member of the seeded project.
    const forDeniz = listHomeProjectsForUser(store.db, {
      id: store.users.deniz.id,
      role: "member",
    });
    expect(forDeniz).toHaveLength(0);
    // selin IS a project member → sees it.
    const forSelin = listHomeProjectsForUser(store.db, {
      id: store.users.selin.id,
      role: "member",
    });
    expect(forSelin.length).toBeGreaterThan(0);
  });

  it("an ORG admin sees every project, member or not", () => {
    const store = setupProjectedStore(ctx);
    const all = listHomeProjectsForUser(store.db, {
      id: store.users.deniz.id, // non-member...
      role: "admin", // ...but org admin
    });
    expect(all.length).toBeGreaterThan(0);
  });

  it("B-FD5: the card's `waiting on you` counts an acceptance-ready task with no packet", () => {
    const store = setupTestStore(ctx);
    const revision = {
      id: "rev_1",
      headSha: "b".repeat(40),
      treeSha: "u".repeat(40),
      branch: "vib-400-work",
      createdAt: "2026-07-04T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-400", {
        stage: "review",
        waiting: "human",
        branch: revision.branch,
        pr: { number: 400, state: "review", title: "Approved work" },
        workRevision: revision,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: revision.id,
            headSha: revision.headSha,
            result: "approve",
            reason: "looks good",
            at: "2026-07-04T01:00:00.000Z",
            rounds: 1,
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // murat = maintainer → holds the acceptance. Home used to read 0 here while
    // the board chip and the review queue both showed the task (UI-48 union was
    // applied only in the board loader).
    const [card] = listHomeProjectsForUser(store.db, {
      id: store.users.murat.id,
      role: "member",
    });
    expect(card!.waiting).toBe(1);
    // elif = viewer → no acceptance authority, so still nothing waits on her.
    const [viewerCard] = listHomeProjectsForUser(store.db, {
      id: store.users.elif.id,
      role: "member",
    });
    expect(viewerCard!.waiting).toBe(0);
  });
});

/**
 * UI-02 — "updated just now" on projects that did not change.
 *
 * `updatedAt` used to fall back to `projects.parsed_at`, which is `nowIso()` at
 * (re)projection time, so "Rebuild projections" made every TASK-LESS project
 * card read "updated just now" although nothing had changed.
 */
describe("UI-02: a task-less project has no recency signal", () => {
  it("returns null updatedAt instead of the projection timestamp", () => {
    const store = setupProjectedStore(ctx);
    const card = listHomeProjectsForUser(store.db, { id: store.users.arda.id, role: "admin" })
      .find((p) => p.slug === store.slug)!;
    expect(card.total).toBe(0);
    expect(card.updatedAt).toBeNull();
  });

  it("still reports the newest task updated_at when tasks exist", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-903", {
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const card = listHomeProjectsForUser(store.db, { id: store.users.arda.id, role: "admin" })
      .find((p) => p.slug === store.slug)!;
    expect(card.updatedAt).toBe("2026-07-20T10:00:00.000Z");
  });
});
