import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runMigrations } from "~/server/db/migration-runner.server";
import { openDatabase } from "~/server/db/sqlite.server";
import { createTempDirs } from "./temp-dirs";

/**
 * Temp-dir DB helper for tests (phase-1 pattern, centralized).
 * Usage:
 *   const ctx = createTestDbContext();
 *   afterEach(ctx.cleanup);
 *   const db = ctx.makeDb(); // fresh migrated database
 */
export interface TestDbContext {
  makeDb(): DatabaseSync;
  /** A temp dir `cleanup` removes; `prefix` names it (default `viberr-test-`). */
  makeTempDir(prefix?: string): string;
  cleanup(): void;
}

export function createTestDbContext(): TestDbContext {
  const tempDirs = createTempDirs();
  let openDbs: DatabaseSync[] = [];

  return {
    makeTempDir(prefix = "viberr-test-"): string {
      return tempDirs.make(prefix);
    },
    makeDb(): DatabaseSync {
      const dir = tempDirs.make("viberr-test-");
      const db = openDatabase(path.join(dir, "state", "test.sqlite"));
      runMigrations(db);
      openDbs.push(db);
      return db;
    },
    cleanup(): void {
      for (const db of openDbs) if (db.isOpen) db.close();
      openDbs = [];
      tempDirs.cleanup();
    },
  };
}
