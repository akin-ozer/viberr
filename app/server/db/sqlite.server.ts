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
/** F21-24: set once the graceful shutdown has closed the database. Symbol-keyed
 *  for the same HMR reason as the handle itself. */
const DB_SHUTDOWN_KEY = Symbol.for("viberr.dbShutdown");

interface DbSlot {
  [DB_CACHE_KEY]?: DatabaseSync;
  [DB_SHUTDOWN_KEY]?: boolean;
}

function dbSlot(): DbSlot {
  // SAFETY: `globalThis` carries no static type for a symbol-keyed slot. The keys
  // are module-private, and the only writes to them anywhere in the process are
  // the ones below (`getDb` stores the handle it just opened, `closeDb` clears it
  // and the flag, `shutdownDatabase` raises the flag), so nothing else can put
  // another shape there.
  return globalThis as DbSlot;
}

/**
 * F21-24: has the process closed the database for shutdown?
 *
 * Read by the run pipeline, which is the one thing still writing when this
 * flips: it degrades to a single summarizing warning instead of one error per
 * streamed line (run-sink.server.ts).
 */
export function isDatabaseShuttingDown(): boolean {
  return dbSlot()[DB_SHUTDOWN_KEY] === true;
}

/**
 * Returns the process-wide app database handle. On first call it opens
 * ${VIBERR_DATA_ROOT}/state/projection.sqlite and applies any pending
 * migrations from db/migrations/.
 *
 * F21-24: once `shutdownDatabase` has run, this REFUSES to open a new handle.
 * Live (UC-31, `docker restart` mid-run) an incoming request took the lazy-open
 * branch between "sqlite closed" and process exit and logged "sqlite ready" —
 * re-opening the database (and re-running migrations) on a process that had just
 * released it, which is precisely what the single-writer story forbids. A
 * request arriving during the drain gets a fast, honest error instead.
 */
export function getDb(): DatabaseSync {
  const cache = dbSlot();
  let db = cache[DB_CACHE_KEY];
  if (!db || !db.isOpen) {
    if (isDatabaseShuttingDown()) {
      throw new Error(
        "The server is shutting down — the database is closed and will not be reopened.",
      );
    }
    const dbPath = getProjectionDbPath();
    db = openDatabase(dbPath);
    const result = runMigrations(db);
    ensureSingleFlightIndexes(db);
    ensureBaselineColumns(db);
    logger.info("sqlite ready", {
      dbPath,
      migrationsApplied: result.applied,
      migrationsAlreadyApplied: result.alreadyApplied.length,
    });
    cache[DB_CACHE_KEY] = db;
  }
  return db;
}

/**
 * Idempotent backstop for single-flight indexes added to the baseline AFTER a
 * data root already applied it (migrations stay squashed into 0001 pre-prod by
 * ruling, so an existing root never re-runs the file). `IF NOT EXISTS` makes
 * this free on every boot; the one way it can fail is a root that ALREADY
 * holds duplicate live rows for one supporting profile — the exact corruption
 * the index exists to prevent — and that failure is warned, not fatal: the
 * rows finish or are interrupted, and the next boot creates the index.
 */
export function ensureSingleFlightIndexes(db: DatabaseSync): void {
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs__one_live_per_support
         ON agent_runs (project_slug, task_key, agent_profile_id)
         WHERE kind = 'reviewer' AND state IN ('queued', 'running')`,
    );
  } catch (error) {
    logger.warn(
      "single-flight index for supporting runs could not be ensured — duplicate live rows may exist; it will be retried next boot",
      { err: error instanceof Error ? error : new Error(String(error)) },
    );
  }
}

/**
 * Columns the baseline gained AFTER a data root may already have applied it
 * (migrations stay squashed into 0001 pre-prod by ruling, so an existing root
 * never re-runs the file). Each is nullable and additive — exactly the
 * "additive drift" the boot integrity WARN names `ALTER TABLE … ADD COLUMN` as
 * the remedy for — so the remedy is applied here, idempotently, instead of
 * being left to an operator: a missing column would otherwise fail every
 * writer that names it ("no such column").
 *
 * Ruling 121 added the controller ones. Their absence is worse than the run
 * columns' — `listConversations` names `task_key` on the dock's root-owned
 * loader, which runs on the FIRST signed-in page of every surface, so an
 * upgraded root would answer a 500 there and (fetcher errors going to the
 * route's own boundary) replace every page in the app with the root error
 * page. The boot WARN could not have caught it either: `projectionMissingColumns`
 * inspects the rebuilder's tables, and these are app-owned.
 *
 * What ALTER TABLE cannot carry is the conversation-scope CHECK. It is a
 * constraint, not a column, so an upgraded root keeps rows without it and
 * `createConversation`'s own validation is the enforcement there — which is
 * why that validation exists in code rather than leaning on the schema.
 */
const BASELINE_COLUMNS: readonly {
  table: string;
  columns: readonly { name: string; ddl: string }[];
}[] = [
  {
    table: "agent_runs",
    columns: [
      { name: "dispatched_by_name", ddl: "dispatched_by_name TEXT" },
      { name: "dispatched_by_user_id", ddl: "dispatched_by_user_id TEXT" },
    ],
  },
  {
    table: "controller_conversations",
    columns: [{ name: "task_key", ddl: "task_key TEXT" }],
  },
  {
    table: "controller_messages",
    columns: [{ name: "surface", ddl: "surface TEXT" }],
  },
];

/** Indexes the baseline gained after a root applied it. `IF NOT EXISTS` makes
 *  each free on a fresh root; on an upgraded one it follows the column above. */
const BASELINE_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_controller_conversations__scope
     ON controller_conversations (user_id, project_slug, task_key, last_message_at DESC)`,
];

export function ensureBaselineColumns(db: DatabaseSync): void {
  for (const { table, columns } of BASELINE_COLUMNS) {
    try {
      // SAFETY: `PRAGMA table_info` always yields rows with a TEXT `name`;
      // `table` is a literal from the list above, never caller input.
      const present = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      // No table at all is the migration runner's problem, not this backstop's.
      if (present.size === 0) continue;
      for (const column of columns) {
        if (present.has(column.name)) continue;
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
        logger.info("added a baseline column this data root predated", {
          table,
          column: column.name,
        });
      }
    } catch (error) {
      logger.warn(
        "baseline columns could not be ensured — writers that name them will fail until the root is re-baselined",
        { table, err: error instanceof Error ? error : new Error(String(error)) },
      );
    }
  }
  for (const ddl of BASELINE_INDEXES) {
    try {
      db.exec(ddl);
    } catch (error) {
      logger.warn(
        "a baseline index could not be ensured — reads stay correct but unindexed; it is retried next boot",
        { err: error instanceof Error ? error : new Error(String(error)) },
      );
    }
  }
}

/** Closes and forgets the cached handle (tests / graceful shutdown). Clears the
 *  shutdown flag: a test that closes the db between cases is re-opening on
 *  purpose, and `shutdownDatabase` re-raises the flag AFTER calling this. */
export function closeDb(): void {
  const cache = dbSlot();
  const db = cache[DB_CACHE_KEY];
  if (db?.isOpen) db.close();
  cache[DB_CACHE_KEY] = undefined;
  cache[DB_SHUTDOWN_KEY] = false;
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
  if (!db?.isOpen) {
    // Nothing to close, but the intent still stands: no lazy reopen from here on
    // (F21-24). A shutdown that found the handle already gone must still latch.
    cache[DB_SHUTDOWN_KEY] = true;
    return;
  }
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
  } finally {
    // F21-24: latch AFTER `closeDb` (which clears the flag for the test path),
    // and in a `finally` so a failed close still stops the lazy reopener. Every
    // statement in this function is synchronous, so nothing can slip in between.
    cache[DB_SHUTDOWN_KEY] = true;
  }
}
