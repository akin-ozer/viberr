import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  recordProvenance,
} from "./provenance-recorder.server";
import {
  createBaseCompareLookup,
  createReconcileBehindByLookup,
  latestProjectReconcileAt,
  latestReconcileObservation,
  latestProvenance,
  latestTaskReconcileAt,
  listProvenance,
  taskProvenancePath,
} from "./provenance-query.server";

/**
 * P13-D-16: `app/server/provenance/` was prescribed and never built, so the
 * table had one private writer per producer and three ad-hoc raw-SQL readers in
 * the wrong layers (a feature module twice, and a route LOADER). These are the
 * consolidated read/write signatures those call sites now share.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const SLUG = "viberr-core";
const PATH_142 = taskProvenancePath(SLUG, "VIB-142");
const PATH_201 = taskProvenancePath(SLUG, "VIB-201");

describe("taskProvenancePath", () => {
  it("reproduces the store-relative key the writers use", () => {
    expect(PATH_142).toBe("projects/viberr-core/tasks/VIB-142/task.md");
  });
});

describe("reconcile reads", () => {
  it("returns the NEWEST behindBy per file, and null when never compared", () => {
    const db = ctx.makeDb();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { behindBy: 7 },
      observedAt: "2026-07-24T09:00:00.000Z",
    });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { behindBy: 2 },
      observedAt: "2026-07-24T10:00:00.000Z",
    });

    const behindBy = createReconcileBehindByLookup(db);
    expect(behindBy(PATH_142)).toBe(2);
    // UI-05: null, NOT 0 — "never compared" must stay distinguishable from
    // a real "0 commits behind", or an unreconciled branch paints green.
    expect(behindBy(PATH_201)).toBeNull();
  });

  it("ignores rows of other actions and unparseable details", () => {
    const db = ctx.makeDb();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { behindBy: 3 },
    });
    // A LATER row of a different action must not shadow the reconcile answer.
    recordProvenance(db, { sourcePath: PATH_142, action: "projected" });
    expect(createReconcileBehindByLookup(db)(PATH_142)).toBe(3);

    db.prepare(
      `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
       VALUES (?, NULL, ?, 'github.reconcile', '{not json')`,
    ).run(PATH_201, new Date().toISOString());
    expect(createReconcileBehindByLookup(db)(PATH_201)).toBeNull();
  });

  it("scopes the project-wide latest to the project and the reconcile action", () => {
    const db = ctx.makeDb();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      observedAt: "2026-07-24T09:00:00.000Z",
    });
    recordProvenance(db, {
      sourcePath: PATH_201,
      action: "github.reconcile",
      observedAt: "2026-07-24T11:00:00.000Z",
    });
    // Another project, and a non-reconcile row — neither may leak in.
    recordProvenance(db, {
      sourcePath: "projects/other/tasks/OTH-1/task.md",
      action: "github.reconcile",
      observedAt: "2026-07-24T23:00:00.000Z",
    });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "projected",
      observedAt: "2026-07-24T22:00:00.000Z",
    });

    expect(latestProjectReconcileAt(db, SLUG)).toBe("2026-07-24T11:00:00.000Z");
    expect(latestProjectReconcileAt(db, "nothing-here")).toBeNull();
  });

  it("resolves the per-TASK latest reconcile (the task loader's question)", () => {
    const db = ctx.makeDb();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      observedAt: "2026-07-24T09:00:00.000Z",
    });
    recordProvenance(db, {
      sourcePath: PATH_201,
      action: "github.reconcile",
      observedAt: "2026-07-24T11:00:00.000Z",
    });

    expect(latestTaskReconcileAt(db, SLUG, "VIB-142")).toBe(
      "2026-07-24T09:00:00.000Z",
    );
    expect(latestTaskReconcileAt(db, SLUG, "VIB-999")).toBeNull();
  });
});

/**
 * Ruling 494 (pass 40, F40-70): a count is read with the head it was counted
 * on and with any push Viberr recorded after it, from the same table, ordered
 * by the table's own ids.
 */
describe("ruling 494: the compare's head and the push after it", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("reads the newest compare's count, its head and time, and the newest push recorded after it", () => {
    // Canary: read the push row without the `id > ?` bound, and a push made
    // BEFORE the compare reads as one after it.
    const db = ctx.makeDb();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.push",
      details: { headSha: A },
      observedAt: "2026-09-25T21:20:00.000Z",
    });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { sync: "behind_main", behindBy: 6, headSha: A },
      observedAt: "2026-09-25T21:25:48.527Z",
    });
    const read = createBaseCompareLookup(db);
    expect(read(PATH_142)).toEqual({
      behindBy: 6,
      headSha: A,
      observedAt: "2026-09-25T21:25:48.527Z",
      pushedSince: null,
    });
    // Another task's push never reaches this task's reading.
    recordProvenance(db, { sourcePath: PATH_201, action: "github.push", details: { headSha: B } });
    expect(read(PATH_142)?.pushedSince).toBeNull();
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.push",
      details: { headSha: B },
      observedAt: "2026-09-25T21:25:55.000Z",
    });
    expect(read(PATH_142)?.pushedSince).toEqual({ headSha: B, at: "2026-09-25T21:25:55.000Z" });
  });

  it("answers null exactly where the behindBy lookup does, and reads a missing or unreadable head as none", () => {
    const db = ctx.makeDb();
    const read = createBaseCompareLookup(db);
    expect(read(PATH_142)).toBeNull();
    recordProvenance(db, { sourcePath: PATH_142, action: "github.reconcile", details: { behindBy: null } });
    expect(read(PATH_142)).toBeNull();
    expect(createReconcileBehindByLookup(db)(PATH_142)).toBeNull();
    // A row written before the ruling: a count, no head.
    recordProvenance(db, { sourcePath: PATH_142, action: "github.reconcile", details: { behindBy: 4 } });
    expect(read(PATH_142)).toMatchObject({ behindBy: 4, headSha: null });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { behindBy: 4, headSha: 12 },
    });
    expect(read(PATH_142)).toMatchObject({ behindBy: 4, headSha: null });
  });

  it("the reconciler's own read of the newest row returns its verdict and its head", () => {
    const db = ctx.makeDb();
    expect(latestReconcileObservation(db, PATH_142)).toBeNull();
    recordProvenance(db, { sourcePath: PATH_142, action: "github.reconcile", details: { sync: "synced", behindBy: 0 } });
    expect(latestReconcileObservation(db, PATH_142)).toEqual({ sync: "synced", headSha: null });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { sync: "behind_main", behindBy: 2, headSha: A },
    });
    // A push row is not an observation of the compare.
    recordProvenance(db, { sourcePath: PATH_142, action: "github.push", details: { headSha: B } });
    expect(latestReconcileObservation(db, PATH_142)).toEqual({ sync: "behind_main", headSha: A });
  });
});

describe("generic provenance reads", () => {
  it("lists a file's observations newest-first, optionally by action", () => {
    const db = ctx.makeDb();
    // The rebuilder's kinds had no reader at all before this module.
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "projected",
      contentHash: "aaa",
    });
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "error",
      details: { message: "unparseable frontmatter" },
    });
    recordProvenance(db, { sourcePath: PATH_142, action: "removed" });

    expect(listProvenance(db, { sourcePath: PATH_142 }).map((r) => r.action))
      .toEqual(["removed", "error", "projected"]);
    const errors = listProvenance(db, {
      sourcePath: PATH_142,
      action: "error",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.details).toEqual({ message: "unparseable frontmatter" });
    expect(
      latestProvenance(db, { sourcePath: PATH_142, action: "projected" })
        ?.contentHash,
    ).toBe("aaa");
    expect(
      latestProvenance(db, { sourcePath: PATH_142, action: "rescan" }),
    ).toBeNull();
  });
});
