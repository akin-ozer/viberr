import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getEnv } from "../config/env.server";
import { logger } from "../logging/logger.server";
import { runMigrations } from "./migration-runner.server";
import { reconcileSchemaFromMigrations } from "./schema-reconcile.server";

/**
 * Opens (creating parent directories as needed) a better-sqlite3 database
 * with the app's standard pragmas. Used by getDb(), scripts and tests.
 */
export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
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
export function getDb(): Database.Database {
  const cache = globalThis as unknown as Record<
    symbol,
    Database.Database | undefined
  >;
  let db = cache[DB_CACHE_KEY];
  if (!db || !db.open) {
    const dbPath = getProjectionDbPath();
    db = openDatabase(dbPath);
    const result = runMigrations(db);
    // Heal added-column drift from edited migrations before any projection
    // rebuild reads/writes the schema (pass-4 F-MIG1).
    const healed = reconcileSchemaFromMigrations(db);
    logger.info("sqlite ready", {
      dbPath,
      migrationsApplied: result.applied,
      migrationsAlreadyApplied: result.alreadyApplied.length,
      schemaHealed: healed,
    });
    cache[DB_CACHE_KEY] = db;
  }
  return db;
}

/** Closes and forgets the cached handle (tests / graceful shutdown). */
export function closeDb(): void {
  const cache = globalThis as unknown as Record<
    symbol,
    Database.Database | undefined
  >;
  const db = cache[DB_CACHE_KEY];
  if (db?.open) db.close();
  cache[DB_CACHE_KEY] = undefined;
}
