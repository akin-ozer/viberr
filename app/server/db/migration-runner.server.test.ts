import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isAppError } from "../errors/app-error.server";
import { ERROR_CODES } from "../errors/error-codes";
import { runMigrations } from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";

let tempDirs: string[] = [];
let openDbs: DatabaseSync[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-migrations-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeDb(): DatabaseSync {
  const db = openDatabase(path.join(makeTempDir(), "state", "test.sqlite"));
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) if (db.isOpen) db.close();
  openDbs = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/* `.get()`/`.all()` hand back untyped SQLite cells, so every row below is
 * parsed on read — the SELECT names the column, the schema pins its type. */
const nameRowsSchema = z.array(z.object({ name: z.string() }));
const stepRowsSchema = z.array(z.object({ step: z.string() }));
const countRowSchema = z.object({ c: z.number() });

function tableNames(db: DatabaseSync): string[] {
  return nameRowsSchema
    .parse(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
    .map((row) => row.name);
}

describe("openDatabase", () => {
  it("creates parent directories and applies pragmas", () => {
    const db = makeDb();
    expect(
      z
        .object({ journal_mode: z.string() })
        .parse(db.prepare("PRAGMA journal_mode").get()).journal_mode,
    ).toBe("wal");
    expect(
      z
        .object({ foreign_keys: z.number() })
        .parse(db.prepare("PRAGMA foreign_keys").get()).foreign_keys,
    ).toBe(1);
  });
});

describe("runMigrations", () => {
  it("applies the real app migrations", () => {
    const db = makeDb();
    const result = runMigrations(db);

    // The 13-file chain was squashed into a single pre-prod baseline.
    expect(result.applied).toContain("0001_baseline.sql");
    expect(result.alreadyApplied).toEqual([]);

    const tables = tableNames(db);
    expect(tables).toContain("users");
    expect(tables).toContain("schema_migrations");
    // better-auth owns sessions now; the legacy `sessions` table is dropped (0014).
    expect(tables).not.toContain("sessions");
    expect(tables).toContain("session");
    expect(tables).toContain("account");
    // E8(a): `verification` reads as dead — no app query names it — and pass 16
    // came within one edit of dropping it. better-auth writes it on every social
    // sign-in (`storeStateStrategy` resolves to "database" because we hand it a
    // `database`), so dropping it kills GitHub login and nothing in the suite
    // would have said so. Canary: delete the CREATE TABLE from the baseline.
    expect(tables).toContain("verification");

    const indexes = nameRowsSchema
      .parse(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all())
      .map((row) => row.name);
    expect(indexes).toContain("idx_users__email");
  });

  it("is idempotent", () => {
    const db = makeDb();
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain("0001_baseline.sql");
  });

  it("enforces the schema it created (role check, unique email, fk cascade)", () => {
    const db = makeDb();
    runMigrations(db);
    const now = new Date().toISOString();

    const insertUser = db.prepare(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertUser.run("u1", "a@viberr.test", "Ada", "admin", now, now);

    expect(() =>
      insertUser.run("u2", "b@viberr.test", "Bob", "superuser", now, now),
    ).toThrowError(/CHECK/);
    expect(() =>
      insertUser.run("u3", "a@viberr.test", "Dup", "member", now, now),
    ).toThrowError(/UNIQUE/);

    // FK cascade: user_prefs.user_id → users(id) ON DELETE CASCADE.
    db.prepare(
      `INSERT INTO user_prefs (user_id, key, value_json, updated_at)
       VALUES ('u1', 'home', '{}', ?)`,
    ).run(now);
    db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
    const prefs = countRowSchema.parse(
      db.prepare(`SELECT count(*) AS c FROM user_prefs`).get(),
    );
    expect(prefs.c).toBe(0); // ON DELETE CASCADE
  });

  it("applies migrations in filename order", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "0002_second.sql"),
      `INSERT INTO ordering (step) VALUES ('second');`,
    );
    writeFileSync(
      path.join(dir, "0001_first.sql"),
      `CREATE TABLE ordering (step TEXT); INSERT INTO ordering (step) VALUES ('first');`,
    );
    writeFileSync(path.join(dir, "notes.txt"), "ignored — not sql");

    const db = makeDb();
    const result = runMigrations(db, dir);
    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql"]);

    const steps = stepRowsSchema
      .parse(db.prepare(`SELECT step FROM ordering`).all())
      .map((row) => row.step);
    expect(steps).toEqual(["first", "second"]);
  });

  it("rolls back a failing migration completely", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "0001_bad.sql"),
      `CREATE TABLE will_roll_back (id TEXT);
       INSERT INTO no_such_table (x) VALUES (1);`,
    );

    const db = makeDb();
    let thrown: unknown;
    try {
      runMigrations(db, dir);
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) {
      expect(thrown.code).toBe(ERROR_CODES.DB_MIGRATION_FAILED);
      expect(thrown.details).toEqual({ migration: "0001_bad.sql" });
    }

    // the CREATE TABLE inside the failed migration was rolled back
    expect(tableNames(db)).not.toContain("will_roll_back");
    // and nothing was recorded, so a fixed file would re-apply
    const recorded = countRowSchema.parse(
      db.prepare(`SELECT count(*) AS c FROM schema_migrations`).get(),
    );
    expect(recorded.c).toBe(0);
  });
});
