import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { createPat } from "~/server/secrets/pat-store.server";
import { getHomeOrgSummary } from "./home-query.server";

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
