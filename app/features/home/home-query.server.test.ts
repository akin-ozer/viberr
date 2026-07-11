import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { createPat } from "~/server/secrets/pat-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  getHomeOrgSummary,
  listHomeProjectsForUser,
} from "./home-query.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

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
        `INSERT INTO github_connections (id, owner, pat_id, is_default, repos_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 2, ?, ?)`,
      )
      .run("acme", "acme", pat.id, now, now);

    const summary = getHomeOrgSummary(store.db, { dataRoot: store.dataRoot });
    // Before the fix this derived owners from project repos and returned [].
    expect(summary.connectionOwners).toContain("acme");
  });
});

describe("listHomeProjectsForUser — membership scoping (D10/Q6)", () => {
  it("a non-member org member sees no projects they don't belong to", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
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
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const all = listHomeProjectsForUser(store.db, {
      id: store.users.deniz.id, // non-member...
      role: "admin", // ...but org admin
    });
    expect(all.length).toBeGreaterThan(0);
  });
});
