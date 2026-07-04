import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { AppError } from "../errors/app-error.server";
import { ERROR_CODES } from "../errors/error-codes";

/** Repo-root-relative default location of SQL migrations. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  process.cwd(),
  "db/migrations",
);

export interface MigrationResult {
  /** Migration filenames applied by this run, in order. */
  applied: string[];
  /** Migration filenames that were already recorded and skipped. */
  alreadyApplied: string[];
}

/**
 * Applies every `*.sql` file in `migrationsDir` in filename order.
 * Each migration runs inside its own transaction (statements + bookkeeping
 * row commit or roll back together). Applied filenames are recorded in
 * `schema_migrations`; re-running is a no-op. Do not put BEGIN/COMMIT
 * inside migration files.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): MigrationResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const alreadyAppliedRows = db
    .prepare(`SELECT filename FROM schema_migrations`)
    .all() as Array<{ filename: string }>;
  const alreadyAppliedSet = new Set(
    alreadyAppliedRows.map((row) => row.filename),
  );

  const recordStmt = db.prepare(
    `INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)`,
  );

  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const file of files) {
    if (alreadyAppliedSet.has(file)) {
      result.alreadyApplied.push(file);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const applyOne = db.transaction(() => {
      db.exec(sql);
      recordStmt.run(file, new Date().toISOString());
    });
    try {
      applyOne();
    } catch (cause) {
      throw new AppError({
        code: ERROR_CODES.DB_MIGRATION_FAILED,
        status: 500,
        message: `migration ${file} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: { migration: file },
        kind: "infrastructure",
        cause,
      });
    }
    result.applied.push(file);
  }

  return result;
}
