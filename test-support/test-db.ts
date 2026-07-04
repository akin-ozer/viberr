import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "~/server/db/migration-runner.server";
import { openDatabase } from "~/server/db/sqlite.server";

/**
 * Temp-dir DB helper for tests (phase-1 pattern, centralized).
 * Usage:
 *   const ctx = createTestDbContext();
 *   afterEach(ctx.cleanup);
 *   const db = ctx.makeDb(); // fresh migrated database
 */
export interface TestDbContext {
  makeDb(): Database.Database;
  makeTempDir(): string;
  cleanup(): void;
}

export function createTestDbContext(): TestDbContext {
  let tempDirs: string[] = [];
  let openDbs: Database.Database[] = [];

  return {
    makeTempDir(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "viberr-test-"));
      tempDirs.push(dir);
      return dir;
    },
    makeDb(): Database.Database {
      const dir = mkdtempSync(path.join(tmpdir(), "viberr-test-"));
      tempDirs.push(dir);
      const db = openDatabase(path.join(dir, "state", "test.sqlite"));
      runMigrations(db, DEFAULT_MIGRATIONS_DIR);
      openDbs.push(db);
      return db;
    },
    cleanup(): void {
      for (const db of openDbs) if (db.open) db.close();
      openDbs = [];
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
      tempDirs = [];
    },
  };
}
