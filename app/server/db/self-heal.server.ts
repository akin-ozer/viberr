import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { logger } from "../logging/logger.server";
import { runMigrations } from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";
import { errorMessage } from "../../shared/errors";

/**
 * Boot self-heal for a corrupt `projection.sqlite`.
 *
 * The projection database is PRIMARY storage for the non-reconstructable rows
 * (users, sessions, sealed PATs, audit, notifications) AND a projection of the
 * `.md` files on disk. A malformed file — a WAL clobbered over a bind mount, a
 * torn page after a hard kill — used to FATAL the boot (`database disk image is
 * malformed`) and crash-loop the container with no exit but a manual
 * `sqlite3 .recover`. This makes that recovery automatic and, above all, SAFE:
 *
 *  1. Heal ONLY on a corruption verdict (`quick_check` fails, or a read throws
 *     SQLITE_CORRUPT/NOTADB). A file we merely cannot open (EACCES after a host
 *     tool chowned it, EMFILE) is NOT corrupt — healing it would nuke a healthy
 *     database over a permissions blip, so we leave it and let the boot fail
 *     loudly on the real error.
 *  2. Build the replacement at a TEMP path, streaming each salvageable row (so a
 *     torn page loses only the rows AFTER it, not the whole table, and a huge
 *     audit/run-log table never OOMs the boot), in one transaction.
 *  3. Skip the tables the rescan rebuilds from the `.md` files — leaving them
 *     EMPTY so the rescan re-projects every file (the short-circuit reads those
 *     tables' OWN content_hash, so a salvaged hash-carrying row would wrongly
 *     skip its damaged siblings — inaccessible member-only projects, empty
 *     timelines). Mirrors `rebuild.server.ts`'s drop list.
 *  4. COPY the corrupt file AND its `-wal` aside (the WAL holds the newest
 *     committed sessions/PATs — never delete it), drop the stale live sidecars,
 *     then atomically rename the temp file over the original. The original is
 *     untouched until that single atomic rename, so a crash mid-heal leaves the
 *     corrupt file in place and the next boot simply retries.
 */

/** Tables the boot rescan rebuilds from the `.md` source of truth (the
 *  `rebuild.server.ts` drop list) + the ledgers a fresh baseline recreates.
 *  Excluded from salvage so the rescan re-projects them cleanly. */
const REBUILT_FROM_FILES = new Set([
  "provenance", // file→hash ledger; empty ⇒ the rescan re-projects everything
  "schema_migrations", // recreated by runMigrations
  "projects", // rebuild.server.ts drop list (project_members cascades)
  "project_members",
  "task_projections",
  "task_events",
  "diagnostics",
]);

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * What `node:sqlite` throws carries the raw SQLite result code on an `errcode`
 * property its declared type does not mention. Decoding it (rather than
 * asserting a hand-written type onto the thrown value) keeps the corruption
 * verdict off anything the driver did not actually report: a throwable with no
 * numeric `errcode` decodes to `NO_ERRCODE`, which matches no arm — exactly
 * what the previous property read did.
 */
const NO_ERRCODE = -1;
const sqliteErrcodeSchema = z
  .object({ errcode: z.number() })
  .transform((thrown) => thrown.errcode)
  .catch(NO_ERRCODE);

/** True only for a CORRUPTION result code / message — not an I/O or permission
 *  failure (which must never trigger a heal). */
function isCorruptionError(cause: unknown): boolean {
  const errcode = sqliteErrcodeSchema.parse(cause);
  if (errcode === SQLITE_CORRUPT || errcode === SQLITE_NOTADB) return true;
  const message = errorMessage(cause);
  return /malformed|not a database|disk image is malformed/i.test(message);
}

function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function tableNames(db: DatabaseSync): string[] {
  // SAFETY: `name` is the only selected column and is non-null TEXT for every
  // `type='table'` row in sqlite_master.
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  // SAFETY: `PRAGMA table_info` rows always carry a non-null TEXT `name`.
  const rows = db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/** Open a database read-only with a busy timeout, or null when even opening it
 *  fails (catastrophic corruption — nothing to salvage). */
function openReadOnlyOrNull(dbPath: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    // node:sqlite opens lazily, so a garbage file only throws on first read —
    // probe the schema now so the caller gets null (nothing to salvage) rather
    // than a handle that throws mid-loop. A partially-corrupt file still reads
    // its schema page (page 1) here and salvages table-by-table below.
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    return db;
  } catch {
    return null;
  }
}

export type ProjectionDbState = "ok" | "corrupt" | "unreadable";

/**
 * `ok` (healthy, or absent — a fresh boot has nothing to heal), `corrupt` (a
 * real corruption verdict — the ONLY state that heals), or `unreadable` (an
 * open/read failure that is NOT corruption — a permissions/IO problem the boot
 * must surface, never silently rebuild over).
 */
function projectionDbState(dbPath: string): ProjectionDbState {
  if (!existsSync(dbPath)) return "ok";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    // quick_check returns one row/one column, "ok" on a clean file.
    // SAFETY: the column name is `quick_check`; corruption yields a non-"ok"
    // description or throws (handled below).
    const row = db.prepare("PRAGMA quick_check").get() as {
      quick_check?: string;
    };
    return row?.quick_check === "ok" ? "ok" : "corrupt";
  } catch (error) {
    return isCorruptionError(error) ? "corrupt" : "unreadable";
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a broken handle can throw; the file is being replaced anyway */
    }
  }
}

export interface SelfHealResult {
  healed: boolean;
  /** Per-table count of rows carried into the fresh database. */
  salvaged: Record<string, number>;
  /** Per-table count of readable rows that could NOT be reinserted (constraint
   *  violations, bind failures) — a cue that the preserved file has more. */
  skipped: Record<string, number>;
  /** Where the corrupt file (and its WAL) were preserved, when a heal ran. */
  movedTo?: string;
}

/** One table's salvage outcome: rows carried into the fresh database, and rows
 *  that were readable but refused by it. */
interface CopyTableCounts {
  inserted: number;
  skipped: number;
}

/** Stream one table's readable rows from `src` into `dst`, keeping the PREFIX
 *  read before any corrupt page throws. Returns inserted/skipped counts. */
function copyTable(
  src: DatabaseSync,
  dst: DatabaseSync,
  table: string,
): CopyTableCounts {
  const dstCols = columnNames(dst, table);
  let inserted = 0;
  let skipped = 0;
  let stmt: ReturnType<DatabaseSync["prepare"]> | null = null;
  let cols: string[] = [];
  try {
    // `iterate()` already yields `Record<string, SQLOutputValue>` — the exact
    // null|number|bigint|string|Uint8Array set `run()` accepts as bound values,
    // so the row flows through without an assertion.
    for (const row of src.prepare(`SELECT * FROM ${q(table)}`).iterate()) {
      if (!stmt) {
        cols = Object.keys(row).filter((c) => dstCols.has(c));
        if (cols.length === 0) return { inserted: 0, skipped: 0 };
        stmt = dst.prepare(
          `INSERT OR IGNORE INTO ${q(table)} (${cols.map(q).join(",")}) VALUES (${cols
            .map(() => "?")
            .join(",")})`,
        );
      }
      try {
        // INSERT OR IGNORE returns changes:0 when a constraint (e.g. a NOT NULL
        // column a newer baseline added) drops the row.
        const res = stmt.run(...cols.map((c) => row[c]));
        if (res.changes > 0) inserted += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  } catch {
    /* a corrupt page ended the scan — the prefix already inserted is kept */
  }
  return { inserted, skipped };
}

/**
 * If the projection database at `dbPath` is CORRUPT, salvage what is readable
 * into a fresh valid file and preserve the corrupt one. Returns
 * `{ healed: false }` untouched when the file is healthy, absent, or merely
 * unreadable (a non-corruption error the boot must surface).
 *
 * `now` is injectable so the preserved-file suffix is deterministic in tests.
 */
export function selfHealProjectionDbIfCorrupt(
  dbPath: string,
  now: () => Date = () => new Date(),
): SelfHealResult {
  if (projectionDbState(dbPath) !== "corrupt") {
    return { healed: false, salvaged: {}, skipped: {} };
  }

  logger.error(
    "projection database is CORRUPT: self-healing (salvaging auth/PATs/audit; projections rebuild from files)",
    { dbPath },
  );

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const corruptPath = `${dbPath}.corrupt-${stamp}`;
  const tempPath = `${dbPath}.heal-${stamp}`;
  for (const side of ["", "-wal", "-shm"]) {
    try {
      rmSync(tempPath + side);
    } catch {
      /* no leftover from a previous attempt */
    }
  }

  // 1. Build the replacement at a temp path (the original is untouched).
  const fresh = openDatabase(tempPath);
  runMigrations(fresh);
  const salvaged: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  fresh.exec("PRAGMA foreign_keys = OFF;");
  fresh.exec("BEGIN IMMEDIATE;");
  const src = openReadOnlyOrNull(dbPath);
  if (src) {
    const dstTables = new Set(tableNames(fresh));
    for (const table of tableNames(src)) {
      if (REBUILT_FROM_FILES.has(table) || !dstTables.has(table)) continue;
      const { inserted, skipped: sk } = copyTable(src, fresh, table);
      if (inserted > 0) salvaged[table] = inserted;
      if (sk > 0) skipped[table] = sk;
    }
    try {
      src.close();
    } catch {
      /* ignore */
    }
  }
  fresh.exec("COMMIT;");
  fresh.exec("PRAGMA foreign_keys = ON;");
  fresh.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fresh.close();
  for (const side of ["-wal", "-shm"]) {
    try {
      rmSync(tempPath + side);
    } catch {
      /* a clean close already removed them */
    }
  }

  // 2. Preserve the corrupt file AND its WAL (the newest committed rows live in
  //    the WAL — never destroy it). COPY, not move, so the swap below never
  //    leaves dbPath momentarily absent.
  copyFileSync(dbPath, corruptPath);
  for (const side of ["-wal", "-shm"]) {
    try {
      copyFileSync(dbPath + side, corruptPath + side);
    } catch {
      /* a sidecar may not exist */
    }
  }

  // 3. Atomic swap: drop the STALE live sidecars (they belong to the corrupt
  //    file and would replay into the fresh one), then rename the temp OVER the
  //    original in a single POSIX-atomic step.
  for (const side of ["-wal", "-shm"]) {
    try {
      rmSync(dbPath + side);
    } catch {
      /* may already be gone */
    }
  }
  renameSync(tempPath, dbPath);

  logger.error(
    "projection database self-healed: corrupt file + WAL preserved; projections rebuild from the .md files on the boot rescan",
    { movedTo: corruptPath, salvaged, skipped },
  );
  return { healed: true, salvaged, skipped, movedTo: corruptPath };
}
