import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VALIDATION_VALUES, WAITING_VALUES } from "~/schemas/task-file.schema";

/**
 * F21-1: the `task_projections.validation` CHECK and the TS `VALIDATION_VALUES`
 * union were hand-mirrored with no single source, and they drifted.
 *
 * `deriveValidation` returns a `VALIDATION_VALUES` member and the rebuilder binds
 * it straight into the column. The baseline's CHECK listed only the four original
 * values, so once `bypassed` (N20-14 force-accept) joined the enum the INSERT
 * threw `CHECK constraint failed`, `rebuildPath`'s catch swallowed it as
 * "projection rebuild failed", and a force-accepted task with a `workRevision`
 * simply stopped projecting — a stale row and no surface saying why.
 *
 * The sibling test in `app/server/projections/rebuilder.server.test.ts` pins the
 * BEHAVIOR for `bypassed` specifically: it force-accepts a task and asserts the
 * row comes back. That test only ever covers the value someone thought to write
 * a fixture for. This one is STRUCTURAL — it pins the two lists as sets, so the
 * NEXT enum member is caught by adding it, with no fixture to remember.
 *
 * Edit the enum; this test makes the migration a mechanical follow-up.
 *
 * CANARY: drop a value from the CHECK in `db/migrations/0001_baseline.sql` (e.g.
 * back to ('healthy','changed','failing','none')) and this fails, naming it.
 */
describe("task_projections.validation — single source (F21-1)", () => {
  it("the baseline migration CHECK lists exactly VALIDATION_VALUES", () => {
    const sql = readFileSync(
      path.join(__dirname, "..", "..", "..", "db", "migrations", "0001_baseline.sql"),
      "utf8",
    );
    // Anchor to the task_projections table FIRST — a whole-file match would pin
    // whichever `validation`-shaped CHECK happens to come first if another table
    // ever grows one.
    const table = sql.match(/CREATE TABLE task_projections \(([\s\S]*?)\n\);/);
    expect(table, "task_projections table not found in baseline").toBeTruthy();
    const match = table![1]!.match(
      /validation TEXT NOT NULL CHECK \(validation IN\s*\(([^)]+)\)\)/,
    );
    expect(match, "task_projections.validation CHECK not found in baseline").toBeTruthy();
    const inCheck = match![1]!
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(inCheck).toEqual([...VALIDATION_VALUES].sort());
  });
});

/**
 * Ruling 225 (F37-45): the same hand-mirrored CHECK, one column over, and the
 * same drift the moment `schedule` joined `WAITING_VALUES` — the projector
 * derived it, the store refused it, `rebuildPath` swallowed the refusal, and
 * every clock-resting task would have gone stale with nothing saying why. The
 * canary above caught it before the deploy did; this is the structural pin so
 * the NEXT member needs no fixture either.
 *
 * CANARY: drop 'schedule' from the CHECK in `db/migrations/0001_baseline.sql`
 * and this fails, naming it.
 */
describe("task_projections.waiting — single source (ruling 225)", () => {
  it("the baseline migration CHECK lists exactly WAITING_VALUES", () => {
    const sql = readFileSync(
      path.join(__dirname, "..", "..", "..", "db", "migrations", "0001_baseline.sql"),
      "utf8",
    );
    const table = sql.match(/CREATE TABLE task_projections \(([\s\S]*?)\n\);/);
    expect(table, "task_projections table not found in baseline").toBeTruthy();
    const match = table![1]!.match(
      /waiting TEXT NOT NULL CHECK \(waiting IN\s*\(([^)]+)\)\)/,
    );
    expect(match, "task_projections.waiting CHECK not found in baseline").toBeTruthy();
    const inCheck = match![1]!
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(inCheck).toEqual([...WAITING_VALUES].sort());
  });
});
