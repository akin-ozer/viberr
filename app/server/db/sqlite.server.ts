import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnv } from "../config/env.server";
import { logger } from "../logging/logger.server";
import { runMigrations } from "./migration-runner.server";

/**
 * Opens (creating parent directories as needed) a SQLite database
 * with the app's standard pragmas. Used by getDb(), scripts and tests.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;`);
  return db;
}

/** Resolves the projection database path under the configured data root. */
export function getProjectionDbPath(): string {
  const env = getEnv();
  return path.resolve(env.VIBERR_DATA_ROOT, "state", "projection.sqlite");
}

// Singleton survives dev-server HMR module reloads via a well-known symbol.
const DB_CACHE_KEY = Symbol.for("viberr.db");

/**
 * Returns the process-wide app database handle. On first call it opens
 * ${VIBERR_DATA_ROOT}/state/projection.sqlite and applies any pending
 * migrations from db/migrations/.
 */
export function getDb(): DatabaseSync {
  const cache = globalThis as unknown as Record<
    symbol,
    DatabaseSync | undefined
  >;
  let db = cache[DB_CACHE_KEY];
  if (!db || !db.isOpen) {
    const dbPath = getProjectionDbPath();
    db = openDatabase(dbPath);
    const result = runMigrations(db);
    logger.info("sqlite ready", {
      dbPath,
      migrationsApplied: result.applied,
      migrationsAlreadyApplied: result.alreadyApplied.length,
    });
    cache[DB_CACHE_KEY] = db;
  }
  return db;
}

/** Closes and forgets the cached handle (tests / graceful shutdown). */
export function closeDb(): void {
  const cache = globalThis as unknown as Record<
    symbol,
    DatabaseSync | undefined
  >;
  const db = cache[DB_CACHE_KEY];
  if (db?.isOpen) db.close();
  cache[DB_CACHE_KEY] = undefined;
}
