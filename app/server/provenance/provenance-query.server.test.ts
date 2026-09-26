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
  latestTaskReconcileAt,
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
 * on and with Viberr's newest push, from the same table, ordered by the
 * table's own ids: a push recorded after the count, or one whose first compare
 * read another head, is a push the count does not describe.
 */
describe("ruling 494: the compare's head and the push it does not describe", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const compare = (db: ReturnType<typeof ctx.makeDb>, headSha: string | null, observedAt: string) =>
    recordProvenance(db, {
      sourcePath: PATH_142,
      action: "github.reconcile",
      details: { sync: "behind_main", behindBy: 6, headSha },
      observedAt,
    });
  const push = (db: ReturnType<typeof ctx.makeDb>, headSha: string | null, observedAt: string) =>
    recordProvenance(db, { sourcePath: PATH_142, action: "github.push", details: { headSha }, observedAt });

  it("reads the newest compare's count, its head and time, and a push recorded after it", () => {
    const db = ctx.makeDb();
    push(db, A, "2026-09-25T21:20:00.000Z");
    compare(db, A, "2026-09-25T21:25:48.527Z");
    const read = createBaseCompareLookup(db);
    // The compare read the head the push before it published.
    expect(read(PATH_142)).toEqual({
      behindBy: 6,
      headSha: A,
      observedAt: "2026-09-25T21:25:48.527Z",
      pushedSince: null,
    });
    // Another task's push never reaches this task's reading.
    recordProvenance(db, { sourcePath: PATH_201, action: "github.push", details: { headSha: B } });
    expect(read(PATH_142)?.pushedSince).toBeNull();
    push(db, B, "2026-09-25T21:25:55.000Z");
    expect(read(PATH_142)?.pushedSince).toEqual({
      headSha: B,
      at: "2026-09-25T21:25:55.000Z",
      afterCompare: true,
    });
  });

  it("reads a push the first compare after it did not read as one the count does not describe, and a later compare at its word", () => {
    // CANARY: read only a push recorded after the compare (the `id > ?`
    // bound this lookup had), and the compare that read `A` right after the
    // push of `B` reads as describing the branch.
    const db = ctx.makeDb();
    compare(db, A, "2026-09-25T21:25:48.527Z");
    push(db, B, "2026-09-25T21:25:55.000Z");
    // The push's own re-compare, answered before GitHub showed the push.
    compare(db, A, "2026-09-25T21:25:56.000Z");
    const read = createBaseCompareLookup(db);
    expect(read(PATH_142)).toEqual({
      behindBy: 6,
      headSha: A,
      observedAt: "2026-09-25T21:25:56.000Z",
      pushedSince: { headSha: B, at: "2026-09-25T21:25:55.000Z", afterCompare: false },
    });
    // The next pass reads the pushed head.
    compare(db, B, "2026-09-25T21:30:48.000Z");
    expect(read(PATH_142)?.pushedSince).toBeNull();
    // A head that moved on GitHub since (a person's commit there) is the
    // branch's head too: a compare after the first one is GitHub's word.
    compare(db, C, "2026-09-25T21:35:48.000Z");
    expect(read(PATH_142)).toMatchObject({ headSha: C, pushedSince: null });
  });

  it("checks the first compare after a push only when both heads are named", () => {
    const db = ctx.makeDb();
    const read = createBaseCompareLookup(db);
    // No compare before the push: the first after it read another head.
    push(db, B, "2026-09-25T21:25:55.000Z");
    compare(db, A, "2026-09-25T21:25:56.000Z");
    expect(read(PATH_142)?.pushedSince).toEqual({
      headSha: B,
      at: "2026-09-25T21:25:55.000Z",
      afterCompare: false,
    });
    // A compare that named no head is head unknown, not another head.
    const other = ctx.makeDb();
    push(other, B, "2026-09-25T21:25:55.000Z");
    compare(other, null, "2026-09-25T21:25:56.000Z");
    expect(createBaseCompareLookup(other)(PATH_142)).toMatchObject({ headSha: null, pushedSince: null });
    // A push git could not name leaves nothing to check the compare after it
    // against; one recorded after the compare still moved the branch.
    const unnamed = ctx.makeDb();
    push(unnamed, null, "2026-09-25T21:25:55.000Z");
    compare(unnamed, A, "2026-09-25T21:25:56.000Z");
    expect(createBaseCompareLookup(unnamed)(PATH_142)?.pushedSince).toBeNull();
    push(unnamed, null, "2026-09-25T21:26:30.000Z");
    expect(createBaseCompareLookup(unnamed)(PATH_142)?.pushedSince).toEqual({
      headSha: null,
      at: "2026-09-25T21:26:30.000Z",
      afterCompare: true,
    });
    // A push after the compare that published the very head it read.
    const same = ctx.makeDb();
    compare(same, B, "2026-09-25T21:25:56.000Z");
    push(same, B, "2026-09-25T21:25:57.000Z");
    expect(createBaseCompareLookup(same)(PATH_142)?.pushedSince).toBeNull();
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
