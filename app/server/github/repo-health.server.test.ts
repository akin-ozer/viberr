import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import {
  readRepoHealth,
  readRepoHealthMany,
  recordRepoAccess,
} from "./repo-health.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/**
 * U33-2 — the remembered repository probe.
 *
 * The point of the table is that the board and the home card can say "this
 * repository is unreachable" without calling GitHub, so these assert the two
 * properties that makes true: a write survives a read, and a read that cannot
 * make sense of the row is SILENT rather than loud (a board loader must not
 * throw because an observation drifted).
 */
describe("repository health (U33-2)", () => {
  it("remembers a probe and hands it back", () => {
    const store = setupTestStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/sandbox",
    });
    const found = readRepoHealth(store.db, store.slug);
    expect(found?.result).toEqual({
      status: "repo_not_found",
      repo: "akin-ozer/sandbox",
    });
    expect(found?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("overwrites in place — one row per project, no history to prune", () => {
    const store = setupTestStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/sandbox",
    });
    recordRepoAccess(store.db, store.slug, {
      status: "connected",
      repo: "akin-ozer/sandbox",
      remoteDefaultBranch: "main",
      private: true,
    });
    expect(readRepoHealth(store.db, store.slug)?.result.status).toBe("connected");
  });

  it("a project nobody probed reads as null, not as a failure", () => {
    const store = setupTestStore(ctx);
    expect(readRepoHealth(store.db, store.slug)).toBeNull();
  });

  it("reads a whole list in one query, skipping the unprobed", () => {
    const store = setupTestStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "forbidden",
      repo: "akin-ozer/viberr",
      message: "refused",
    });
    const many = readRepoHealthMany(store.db, [store.slug, "never-probed"]);
    expect(many.size).toBe(1);
    expect(many.get(store.slug)?.result.status).toBe("forbidden");
    expect(readRepoHealthMany(store.db, [])).toEqual(new Map());
  });

  it("a row this code can no longer parse is SILENT — the board still renders", () => {
    // The row outlives the code that wrote it. A drifted payload has to read as
    // "no reading" so a surface stays quiet, never as an exception on a loader
    // path that has nothing to do with GitHub.
    const store = setupTestStore(ctx);
    store.db
      .prepare(
        `INSERT INTO project_github_health (project_slug, result_json, checked_at)
         VALUES (?, ?, ?)`,
      )
      .run(store.slug, JSON.stringify({ status: "a_status_from_the_future" }), "2026-09-03T00:00:00.000Z");
    expect(readRepoHealth(store.db, store.slug)).toBeNull();
  });
});
