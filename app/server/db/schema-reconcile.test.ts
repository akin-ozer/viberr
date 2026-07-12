import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migration-runner.server";
import { reconcileSchemaFromMigrations } from "./schema-reconcile.server";

/**
 * F-MIG1 regression: a column added to an already-shipped migration must be
 * healed onto any database that applied the older version of that file.
 */
describe("reconcileSchemaFromMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  function columns(table: string): string[] {
    return (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((r) => r.name);
  }

  it("re-adds a projection column an old database is missing", () => {
    runMigrations(db);
    expect(columns("projects")).toContain("archived");

    // Simulate a pre-edit database: drop the archived column that was later
    // added to 0003 (SQLite 3.35+ supports DROP COLUMN).
    db.exec(`ALTER TABLE projects DROP COLUMN archived`);
    expect(columns("projects")).not.toContain("archived");

    const healed = reconcileSchemaFromMigrations(db);
    expect(healed).toContain("projects.archived");
    expect(columns("projects")).toContain("archived");

    // The healed column carries the migration's declared default so existing
    // rows are valid under its NOT NULL constraint.
    db.exec(
      `INSERT INTO projects (slug, name, task_prefix, source_path, content_hash, parsed_at)
       VALUES ('p','P','P','x','h','t')`,
    );
    const row = db
      .prepare(`SELECT archived FROM projects WHERE slug = 'p'`)
      .get() as { archived: number };
    expect(row.archived).toBe(0);
  });

  it("is a no-op on an up-to-date database", () => {
    runMigrations(db);
    expect(reconcileSchemaFromMigrations(db)).toEqual([]);
  });

  it("only heals tables that already exist (never creates them)", () => {
    // Fresh DB with no migrations: nothing exists, so nothing is healed.
    expect(reconcileSchemaFromMigrations(db)).toEqual([]);
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all(),
    ).toEqual([]);
  });
});
