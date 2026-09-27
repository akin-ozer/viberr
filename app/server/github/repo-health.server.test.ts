import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupProjectedStore } from "../../../test-support/projected-store";
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
 * repository is unreachable" without calling GitHub, so these assert the
 * properties that make that true: a write survives a read, a read that cannot
 * make sense of the row is SILENT rather than loud (a board loader must not
 * throw because an observation drifted), and a reading speaks only for the
 * repository it was taken of (ruling 517). The fixture project points at
 * `akin-ozer/viberr`.
 */
describe("repository health (U33-2)", () => {
  it("remembers a probe and hands it back", () => {
    const store = setupProjectedStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/viberr",
    });
    const found = readRepoHealth(store.db, store.slug);
    expect(found?.result).toEqual({
      status: "repo_not_found",
      repo: "akin-ozer/viberr",
    });
    expect(found?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("overwrites in place — one row per project, no history to prune", () => {
    const store = setupProjectedStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/viberr",
    });
    recordRepoAccess(store.db, store.slug, {
      status: "connected",
      repo: "akin-ozer/viberr",
      remoteDefaultBranch: "main",
      private: true,
    });
    expect(readRepoHealth(store.db, store.slug)?.result.status).toBe("connected");
  });

  it("a project nobody probed reads as null, not as a failure", () => {
    const store = setupProjectedStore(ctx);
    expect(readRepoHealth(store.db, store.slug)).toBeNull();
  });

  it("reads a whole list in one query, skipping the unprobed", () => {
    const store = setupProjectedStore(ctx);
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

  it("ruling 517: a reading of another repository is no reading, whatever the case of the name", () => {
    // Live, a board kept saying "akin-ozer/akin-website · repo not found" (a
    // repository the owner does not have) with nothing left to take it back: a
    // repair or an edit of project.md moves the project to another repository,
    // and the row, keyed by project, kept the old one's verdict.
    const store = setupProjectedStore(ctx);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/akin-website",
    });
    // CANARY: drop `readingIsOf` from `readRepoHealthMany` and the board and
    // Home show the other repository's "repo not found" for this project.
    expect(readRepoHealth(store.db, store.slug)).toBeNull();
    expect(readRepoHealthMany(store.db, [store.slug])).toEqual(new Map());

    // GitHub compares names without case, so the same repository typed in
    // another case is still this project's repository.
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "Akin-Ozer/Viberr",
    });
    expect(readRepoHealth(store.db, store.slug)?.result.status).toBe("repo_not_found");
  });

  it("a row this code can no longer parse is SILENT — the board still renders", () => {
    // The row outlives the code that wrote it. A drifted payload has to read as
    // "no reading" so a surface stays quiet, never as an exception on a loader
    // path that has nothing to do with GitHub.
    const store = setupProjectedStore(ctx);
    store.db
      .prepare(
        `INSERT INTO project_github_health (project_slug, result_json, checked_at)
         VALUES (?, ?, ?)`,
      )
      .run(store.slug, JSON.stringify({ status: "a_status_from_the_future" }), "2026-09-03T00:00:00.000Z");
    expect(readRepoHealth(store.db, store.slug)).toBeNull();
  });
});
