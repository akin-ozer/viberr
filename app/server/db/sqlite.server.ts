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

/**
 * Opens the database READ-ONLY: a reader, never the second writer B-FD1
 * refuses. Used by the read-only maintenance CLIs (`npm run backup`,
 * `npm run keys -- status`), which must work against a LIVE instance and
 * therefore cannot take the writer lock. No migrations are run — a read-only
 * handle could not apply them, and a reporting command has no business
 * changing a schema.
 */
export function openDatabaseReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Resolves the projection database path under the configured data root. */
export function getProjectionDbPath(): string {
  const env = getEnv();
  return path.resolve(env.VIBERR_DATA_ROOT, "state", "projection.sqlite");
}

// Singleton survives dev-server HMR module reloads via a well-known symbol.
const DB_CACHE_KEY = Symbol.for("viberr.db");

interface DbSlot {
  [DB_CACHE_KEY]?: DatabaseSync;
}

function dbSlot(): DbSlot {
  // SAFETY: `globalThis` carries no static type for a symbol-keyed slot. The key
  // is module-private, and the only writes to it anywhere in the process are the
  // two below (`getDb` stores the handle it just opened, `closeDb` clears it), so
  // nothing else can put another shape there.
  return globalThis as DbSlot;
}

/**
 * Returns the process-wide app database handle. On first call it opens
 * ${VIBERR_DATA_ROOT}/state/projection.sqlite and applies any pending
 * migrations from db/migrations/.
 */
export function getDb(): DatabaseSync {
  const cache = dbSlot();
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
  const cache = dbSlot();
  const db = cache[DB_CACHE_KEY];
  if (db?.isOpen) db.close();
  cache[DB_CACHE_KEY] = undefined;
}

/**
 * Graceful-shutdown close: checkpoint the WAL into the main file, then close
 * (P13-D-43).
 *
 * Until this existed, `closeDb()` had no non-test caller and nothing in the app
 * ever checkpointed — the only signal handler closed SSE connections and
 * re-raised. An exited container was observed leaving a 4.1 MB
 * `projection.sqlite-wal` and a `-shm` beside a stale `projection.sqlite`;
 * SQLite unlinks both on a clean close, so their survival is proof the close
 * never happened. That matters because this database is PRIMARY storage for
 * users, sessions, PATs, audit and notifications — rows that no rescan can
 * rebuild — and the backup instructions offer "stop the container" as the clean
 * alternative to copying the sidecars.
 *
 * TRUNCATE (not PASSIVE) so the `-wal` is emptied rather than merely folded in:
 * the visible, on-disk difference is the whole point. Total by construction —
 * a shutdown path must never throw and abort the rest of the shutdown.
 */
export function shutdownDatabase(): void {
  const cache = dbSlot();
  const db = cache[DB_CACHE_KEY];
  if (!db?.isOpen) return;
  try {
    db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
  } catch (error) {
    logger.warn("wal checkpoint failed during shutdown", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  try {
    closeDb();
    logger.info("sqlite closed");
  } catch (error) {
    logger.error("sqlite close failed during shutdown", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
