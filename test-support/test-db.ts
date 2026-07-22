import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
  makeDb(): DatabaseSync;
  makeTempDir(): string;
  cleanup(): void;
}

export function createTestDbContext(): TestDbContext {
  let tempDirs: string[] = [];
  let openDbs: DatabaseSync[] = [];

  return {
    makeTempDir(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "viberr-test-"));
      tempDirs.push(dir);
      return dir;
    },
    makeDb(): DatabaseSync {
      const dir = mkdtempSync(path.join(tmpdir(), "viberr-test-"));
      tempDirs.push(dir);
      const db = openDatabase(path.join(dir, "state", "test.sqlite"));
      runMigrations(db, DEFAULT_MIGRATIONS_DIR);
      openDbs.push(db);
      return db;
    },
    cleanup(): void {
      for (const db of openDbs) if (db.isOpen) db.close();
      openDbs = [];
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
      tempDirs = [];
    },
  };
}
