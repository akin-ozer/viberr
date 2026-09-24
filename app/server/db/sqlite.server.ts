import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnv } from "../config/env.server";
import { logger } from "../logging/logger.server";
import {
  isProcessAlive,
  judgeDataRootLock,
  type LockHolder,
} from "./data-root-lock.server";
import { runMigrations } from "./migration-runner.server";
import { backfillControllerReplyLinks } from "../controller/controller-reply-links.server";
import { toError } from "../../shared/errors";

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

/** Where a reader's copy lives, relative to `state/`: `state/tmp/reader-<pid>/`. */
export const READER_SNAPSHOT_DIR = "tmp";

/**
 * A read-only handle on the projection database (ruling 158). `db` is either
 * the live file itself or a private copy of it; `close` releases the handle and
 * removes the copy. Callers never hold a bare `DatabaseSync` here, so the copy
 * cannot be left behind by a caller that closed the handle and forgot the
 * directory.
 */
export interface ReadOnlyDatabase {
  db: DatabaseSync;
  /** The file `db` opened: the live projection, or the copy under `state/tmp/`. */
  path: string;
  /**
   * Set when a `writer.lock` was there at all and the reader copied the database
   * before opening it, with the holder that file named (null when it could not
   * be read as one); null when the root carried no lock, so it was just files
   * and `db` is the live file, opened read-only.
   */
  snapshot: { dir: string; holder: LockHolder | null } | null;
  /** Idempotent: closes `db` and, for a snapshot, removes its directory. */
  close(): void;
}

/** How many times a reader retakes a copy the writer moved under it. */
const READER_COPY_ATTEMPTS = 3;

/**
 * The identity of a write-ahead log: the salt in its 32-byte header (bytes
 * 16..24), or null when there is no WAL beside the database. SQLite changes the
 * salt every time it RESETS the file (`salt1` is incremented on a checkpoint
 * that restarts or truncates it), and never for the frames it appends, so an
 * unchanged identity across a copy means every frame the copied WAL holds still
 * belongs to the main file that was copied with it. A header shorter than 32
 * bytes is a WAL that was just truncated: its own identity, distinct from both
 * a missing file and any salt.
 */
export function readWalIdentity(walPath: string): string | null {
  if (!existsSync(walPath)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(walPath, "r");
    const header = Buffer.alloc(32);
    const read = readSync(fd, header, 0, 32, 0);
    return read < 32 ? "truncated" : header.subarray(16, 24).toString("hex");
  } catch {
    // Unreadable for a moment (the writer replacing it) counts as a change:
    // two unreadable probes in a row are not proof of a pinned pair either.
    return "unreadable";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Copies `projection.sqlite` and its `-wal` to `copyPath`, pinned: the WAL's
 * identity is read before the first copy and after the last, and a copy that
 * straddles a WAL reset is discarded and retaken. Throws when the writer keeps
 * resetting the WAL under every attempt, which is honest: the alternative is a
 * copy that can pass an integrity check and still be wrong.
 */
export function copyStorePair(dbPath: string, copyPath: string): void {
  const wal = `${dbPath}-wal`;
  let straddled = "";
  for (let attempt = 1; attempt <= READER_COPY_ATTEMPTS; attempt += 1) {
    const before = readWalIdentity(wal);
    copyFileSync(dbPath, copyPath);
    if (existsSync(wal)) copyFileSync(wal, `${copyPath}-wal`);
    else rmSync(`${copyPath}-wal`, { force: true });
    const after = readWalIdentity(wal);
    if (before === after) return;
    straddled = `${before ?? "no wal"} then ${after ?? "no wal"}`;
    logger.info("reader copy straddled a WAL reset — retaking it", {
      dbPath,
      attempt,
      wal: straddled,
    });
  }
  rmSync(`${copyPath}-wal`, { force: true });
  rmSync(copyPath, { force: true });
  throw new Error(
    `could not copy ${dbPath} with its WAL: the writer reset the log during every attempt (${straddled}). Retry, or stop the app and read the root directly.`,
  );
}

/**
 * Opens the database for READING, never as the second connection to a live root
 * (ruling 158). Used by the read-only maintenance CLIs (`npm run backup`,
 * `npm run keys -- status`), which must work against a LIVE instance and
 * therefore cannot take the writer lock.
 *
 * Until pass 35 this opened the file with `readOnly: true` and called that a
 * reader. It is not one, on either side of the container boundary: a second
 * connection maps the WAL index (`-shm`) the server has memory-mapped, and on
 * the shipped deployment (a bind mount over VirtioFS) the open path's lock probe
 * on that file is unreliable, so a reader can truncate the index under the
 * server. Pass 34 saw the server die with SIGBUS (exit 135) one second after a
 * host-side reader; pass 35 saw the same exit one second after an IN-CONTAINER
 * `readOnly: true` reader, and boot recovery then interrupted 23 runs. "Read
 * only" was never the protection; not sharing the mapping is.
 *
 * So the writer lock decides which case this is, by its PRESENCE and nothing
 * else (`judgeDataRootLock`; a reader cannot judge a holder's liveness across a
 * pid namespace, and the boot's `stale` verdict answered for a live holder in a
 * second container would open the live file, which is the whole hazard):
 *  - `absent`: no lock file, so nothing holds the root, the database is just a
 *    file, and it is opened read-only in place, as before;
 *  - `present`: the server may be writing, so `projection.sqlite`
 *    and `projection.sqlite-wal` (when present) are copied to a fresh directory
 *    next to the store (`state/tmp/reader-<pid>/`), the COPY is opened
 *    read-write so SQLite recovers the copied WAL into it, and `close` removes
 *    the directory. The `-shm` is never copied: it is the wal-index the copy
 *    rebuilds for itself, and sharing it is the hazard. The copy is a moment's
 *    snapshot (the main file first, then the WAL; a torn WAL tail fails its
 *    frame checksum and is dropped by recovery), which is what a reader against
 *    a live writer can honestly have, and `backup`'s `VACUUM INTO` then runs on
 *    it and stays a single-file artefact.
 *
 * The pair is PINNED across the two copies (`copyStorePair`). Frame checksums
 * cover a torn tail and nothing else: when SQLite checkpoints and RESETS the
 * WAL between the two copies, the copied WAL holds frames numbered from 1 again
 * under a new salt and recovery applies them to a main file that predates the
 * checkpoint. That is not detectable after the fact — reproduced on this
 * machine both ways: "database disk image is malformed" on open, and (small
 * window) a copy that answers `PRAGMA quick_check` with `ok` and has lost a
 * table. So the WAL's salt is read before the main file is copied and again
 * after the WAL is copied; a change (or the `-wal` appearing or vanishing)
 * means the pair straddles a reset, and the copy is discarded and retaken.
 *
 * No migrations are run either way: a reporting command has no business
 * changing a schema, and on the copy a change would be thrown away with it.
 */
export function openDatabaseReadOnly(dbPath: string): ReadOnlyDatabase {
  const stateDir = path.dirname(dbPath);
  const lock = judgeDataRootLock(stateDir);
  if (lock.verdict === "absent" || !existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      db,
      path: dbPath,
      snapshot: null,
      close() {
        if (db.isOpen) db.close();
      },
    };
  }
  const tmpRoot = path.join(stateDir, READER_SNAPSHOT_DIR);
  sweepStaleReaderSnapshots(tmpRoot);
  const dir = path.join(tmpRoot, `reader-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, path.basename(dbPath));
  let db: DatabaseSync;
  try {
    copyStorePair(dbPath, copy);
    db = new DatabaseSync(copy);
  } catch (error) {
    // A copy that failed to open is not a snapshot anybody will close: remove
    // it now rather than leave it for the next reader's sweep.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    db,
    path: copy,
    snapshot: { dir, holder: lock.holder },
    close() {
      if (db.isOpen) db.close();
      rmSync(dir, { recursive: true, force: true });
      // `state/tmp/` exists only while a reader holds a copy: gone when the
      // last one leaves, left alone while a sibling still reads.
      try {
        rmdirSync(tmpRoot);
      } catch {
        // Not empty (another reader), or already gone: both fine.
      }
    },
  };
}

/**
 * A reader that died mid-read leaves `state/tmp/reader-<pid>/` behind. The next
 * reader removes every sibling whose pid is gone; a directory whose pid is alive
 * (another reader, or a pid this side of a container boundary cannot judge) is
 * left alone. Best effort: a directory this process may not remove is not a
 * reason to refuse the read.
 */
function sweepStaleReaderSnapshots(tmpRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^reader-(\d+)$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    try {
      rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
    } catch (error) {
      logger.warn("a dead reader's snapshot directory could not be removed", {
        dir: path.join(tmpRoot, entry),
        err: toError(error),
      });
    }
  }
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
function ensureSingleFlightIndexes(db: DatabaseSync): void {
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs__one_live_per_support
         ON agent_runs (project_slug, task_key, agent_profile_id)
         WHERE kind = 'reviewer' AND state IN ('queued', 'running')`,
    );
  } catch (error) {
    logger.warn(
      "single-flight index for supporting runs could not be ensured — duplicate live rows may exist; it will be retried next boot",
      { err: toError(error) },
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
  columns: readonly {
    name: string;
    ddl: string;
    /**
     * Run ONCE, right after this column is added, to give the rows that
     * predate it their meaning. A DEFAULT is a value, not a meaning: a column
     * whose 0 says "no provider figure landed for this run" would otherwise
     * claim that of every historical row, and readers that skip those rows
     * (the Insights token sums) would drop a whole store's history the first
     * time an upgraded root booted. Only for columns whose default is WRONG
     * for existing rows; omitted everywhere the default is the truth.
     */
    backfill?: string;
    /** The same, when the meaning cannot be one statement (ruling 465's reply
     *  links replay the writers' order, message by message). */
    backfillWith?: (db: DatabaseSync) => void;
  }[];
}[] = [
  {
    table: "agent_runs",
    columns: [
      { name: "dispatched_by_name", ddl: "dispatched_by_name TEXT" },
      { name: "dispatched_by_user_id", ddl: "dispatched_by_user_id TEXT" },
      // Ruling 127: the run's credential principal. `upsertRun` names it on
      // EVERY insert, so a root that predates the baseline edit would fail
      // every run start rather than degrade — the exact failure this healer
      // exists for.
      { name: "credential_user_id", ddl: "credential_user_id TEXT" },
      // Pass 35 U35-7: the reason an `interrupted` run stopped ('restart' from
      // boot recovery, NULL for a person's interrupt). `patchRun` names it on
      // every orphan sweep and the run projection reads it on every task page.
      // ALTER TABLE cannot carry the baseline's CHECK; the two writers only
      // ever store 'restart', which is the enforcement on an upgraded root.
      { name: "interrupted_reason", ddl: "interrupted_reason TEXT" },
      // F35-1: the sink patches it on every persisted line, so a root that
      // predates it would fail every run's first line. Before the column
      // existed the token columns of a FINISHED run held the provider's own
      // figures (the sink folded them from the result envelope; there was no
      // estimate to hold), so those rows are backfilled as final and keep
      // counting in the Insights token sums. A row that was stopped or errored
      // carried the old live placeholder instead, which is not a total: it
      // stays 0 and the card names it with the rest.
      {
        name: "usage_final",
        ddl: "usage_final INTEGER NOT NULL DEFAULT 0",
        backfill: "UPDATE agent_runs SET usage_final = 1 WHERE state = 'finished'",
      },
      // Ruling 248 (F37-77): the run executed with no working tree. Named by
      // `patchRun` on every completion registration, so a root that predates it
      // would fail every run's completion. No backfill: the default is the
      // honest value for a row written before viberr recorded the fact — 0 says
      // "nothing here says this run was checkout-less", which is exactly true.
      { name: "no_checkout", ddl: "no_checkout INTEGER NOT NULL DEFAULT 0" },
      // Ruling 316: 0 is the TRUTH for every historical row — no run before
      // this column existed had its verdict channel withheld, because nothing
      // could withhold it — so this needs no backfill.
      {
        name: "verdict_withheld",
        ddl: "verdict_withheld INTEGER NOT NULL DEFAULT 0",
      },
      // Ruling 369: the prompt-cache columns the sink folds on every persisted
      // line, so a root that predates them would fail every run's first line.
      // No backfill on any of them: a row written before the columns existed
      // carries no first-call figure (NULL says so), wrote no counted cache
      // tokens, holds no peak and compacted nothing THAT WAS RECORDED — and
      // the console prints each absence as an absence. `credential_kind` stays
      // NULL too; the resume policy reads an unknown kind as a sign-in.
      { name: "cache_write_tokens", ddl: "cache_write_tokens INTEGER NOT NULL DEFAULT 0" },
      { name: "first_call_prompt_tokens", ddl: "first_call_prompt_tokens INTEGER" },
      { name: "first_call_cache_write", ddl: "first_call_cache_write INTEGER" },
      { name: "first_call_cache_read", ddl: "first_call_cache_read INTEGER" },
      { name: "first_call_warm", ddl: "first_call_warm INTEGER" },
      { name: "first_call_miss_reason", ddl: "first_call_miss_reason TEXT" },
      { name: "cache_ttl_bucket", ddl: "cache_ttl_bucket TEXT" },
      { name: "peak_prompt_tokens", ddl: "peak_prompt_tokens INTEGER NOT NULL DEFAULT 0" },
      { name: "last_prompt_tokens", ddl: "last_prompt_tokens INTEGER NOT NULL DEFAULT 0" },
      { name: "compactions", ddl: "compactions INTEGER NOT NULL DEFAULT 0" },
      { name: "credential_kind", ddl: "credential_kind TEXT" },
    ],
  },
  {
    table: "controller_conversations",
    columns: [
      { name: "task_key", ddl: "task_key TEXT" },
      // O39-d: what the owner has seen. Every conversation that predates the
      // column counts as read to its newest message, so a deploy does not
      // mark every old thread as a new reply.
      {
        name: "seen_seq",
        ddl: "seen_seq INTEGER NOT NULL DEFAULT 0",
        backfill:
          "UPDATE controller_conversations SET seen_seq = COALESCE((SELECT MAX(seq) FROM controller_messages m WHERE m.conversation_id = controller_conversations.id), 0)",
      },
    ],
  },
  // Ruling 176: an org MCP server's marked write tools and its discovered tool
  // names. `listMcpServers` names both on every Settings render and every run
  // mount, so a root that predates them would fail both.
  {
    table: "org_mcp_servers",
    columns: [
      { name: "tool_policy_json", ddl: "tool_policy_json TEXT" },
      { name: "tool_names_json", ddl: "tool_names_json TEXT" },
      // Ruling 469: an OAuth sign-in, sealed and public halves. Every MCP read
      // names `oauth_json` and the gateway and probes name `oauth_ref`. No
      // backfill: NULL is the truth for every row that predates them (no
      // connection was signed in with OAuth before they existed).
      { name: "oauth_ref", ddl: "oauth_ref TEXT" },
      { name: "oauth_json", ddl: "oauth_json TEXT" },
    ],
  },
  {
    table: "controller_messages",
    columns: [
      { name: "surface", ddl: "surface TEXT" },
      // Ruling 465: the user message a controller row answers. NULL is WRONG
      // for the replies an older root already holds: boot recovery notes every
      // user message no reply names, so it would write a restart note under
      // each old one. Its backfill is `unlinked_history`'s, added right after
      // it in the same pass: one walk writes both columns.
      { name: "reply_to", ddl: "reply_to TEXT" },
      // Ruling 465 (dated 2026-09-25): 1 on an old user message whose answer
      // the backfill cannot prove (a restart or a failed start lost it, or the
      // order stopped proving anything): earlier history, not linked, which
      // recovery never notes. Its backfill links what the writers' order
      // proves and marks the rest. A root the first backfill already linked
      // gains this column too, so the walk runs there once more and corrects
      // the FIFO links that first backfill wrote past a lost message.
      {
        name: "unlinked_history",
        ddl: "unlinked_history INTEGER NOT NULL DEFAULT 0",
        backfillWith: backfillControllerReplyLinks,
      },
    ],
  },
  // Ruling 463: which repositories a connection's token reaches. Every
  // connection reader names it (the Instance settings card, the New project
  // modal's connection list, the controller's `list_github_connections`), so a
  // root that predates it would fail all three. No backfill: NULL says "not
  // read yet", which is exactly true of every connection saved before the
  // read existed, and the card offers Re-check to read it.
  {
    table: "github_connections",
    columns: [{ name: "reach_json", ddl: "reach_json TEXT" }],
  },
  // Ruling 178: the project's resolved required-reviewer rules. The rebuilder
  // names the column on every project write and every task walk reads it, so
  // a root that predates it would stop projecting entirely; its DEFAULT is the
  // honest value for every existing project (none declared).
  {
    table: "projects",
    columns: [
      {
        name: "required_reviewers_json",
        ddl: "required_reviewers_json TEXT NOT NULL DEFAULT '[]'",
      },
    ],
  },
  {
    table: "task_projections",
    columns: [
      // F37-71: the DISTINCT kinds of a task's pending recommendations. The
      // rebuilder names it on EVERY task write, so a root that predates the
      // baseline edit would fail every projection rather than degrade — the
      // exact failure this healer exists for. No backfill: the very next
      // rebuild of each task writes the real value, and the empty default
      // means "no pending recommendations", which is what a row with
      // `recommendation_count = 0` already says.
      {
        name: "recommendation_kinds",
        ddl: "recommendation_kinds TEXT NOT NULL DEFAULT ''",
      },
    ],
  },
];

/**
 * Tables the baseline gained after a root applied it. Same reasoning as the
 * columns above and the indexes below: the squashed baseline never re-runs, so
 * a store created before this table exists would answer a 500 the first time a
 * reader named it. `IF NOT EXISTS` makes each free on a fresh root.
 */
const BASELINE_TABLES: readonly string[] = [
  // U33-2 (pass 33): the last repository-access probe per project, so the board
  // and the home card can say a repo is unreachable WITHOUT calling GitHub on a
  // hot path. App-owned observation, not derived from any file — a rebuild must
  // not clear it, which is why it is its own table and not a `projects` column.
  `CREATE TABLE IF NOT EXISTS project_github_health (
     project_slug TEXT PRIMARY KEY,
     result_json TEXT NOT NULL,
     checked_at TEXT NOT NULL
   )`,
  // Ruling 127: the per-person agent backends. Same sibling as the
  // `runs.credential_user_id` column above — that commit added the column to
  // BASELINE_COLUMNS but left the TABLE it points at out of this list, so a
  // root created before it boots with the column and without the table and
  // 500s the first time anyone opens Profile → Agent accounts or starts a run.
  `CREATE TABLE IF NOT EXISTS user_backend_credentials (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
     kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key', 'access_token')),
     method TEXT,
     secret_box TEXT,
     secret_suffix TEXT,
     detail_json TEXT NOT NULL DEFAULT '{}',
     verified_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (user_id, backend)
   )`,
  // Ruling 460: each person's agent uid. A root that predates it would refuse
  // every run start in the image ("no such table") — the uid is allocated
  // before the launch.
  `CREATE TABLE IF NOT EXISTS agent_os_users (
     user_id TEXT PRIMARY KEY,
     os_uid INTEGER NOT NULL UNIQUE,
     created_at TEXT NOT NULL
  )`,
];

/** Indexes the baseline gained after a root applied it. `IF NOT EXISTS` makes
 *  each free on a fresh root; on an upgraded one it follows the column above. */
const BASELINE_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_controller_conversations__scope
     ON controller_conversations (user_id, project_slug, task_key, last_message_at DESC)`,
  // Ruling 457: the task page's GitHub freshness reads, which otherwise walk
  // every task's reconcile rows (the audit heartbeat grows ~288 rows a day per
  // delivered task and is kept 90 days).
  `CREATE INDEX IF NOT EXISTS idx_audit_events__task_action
     ON audit_events (project_slug, task_key, action, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_provenance__path_action
     ON provenance (source_path, action)`,
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
        const statement = column.backfill;
        const backfill = statement ? () => db.exec(statement) : column.backfillWith;
        if (backfill) {
          // Its own try: a backfill that cannot run (an older root whose table
          // lacks a column the statement names) must not skip the columns
          // still to be added for this table.
          try {
            backfill(db);
          } catch (error) {
            logger.warn(
              "a baseline column was added but its backfill did not run — rows that predate the column keep the column default",
              {
                table,
                column: column.name,
                err: toError(error),
              },
            );
          }
        }
      }
    } catch (error) {
      logger.warn(
        "baseline columns could not be ensured — writers that name them will fail until the root is re-baselined",
        { table, err: toError(error) },
      );
    }
  }
  for (const ddl of BASELINE_TABLES) {
    try {
      db.exec(ddl);
    } catch (error) {
      logger.warn(
        "a baseline table could not be ensured — readers that name it degrade until the root is re-baselined",
        { err: toError(error) },
      );
    }
  }
  for (const ddl of BASELINE_INDEXES) {
    try {
      db.exec(ddl);
    } catch (error) {
      logger.warn(
        "a baseline index could not be ensured — reads stay correct but unindexed; it is retried next boot",
        { err: toError(error) },
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
      err: toError(error),
    });
  }
  try {
    closeDb();
    logger.info("sqlite closed");
  } catch (error) {
    logger.error("sqlite close failed during shutdown", {
      err: toError(error),
    });
  } finally {
    // F21-24: latch AFTER `closeDb` (which clears the flag for the test path),
    // and in a `finally` so a failed close still stops the lazy reopener. Every
    // statement in this function is synchronous, so nothing can slip in between.
    cache[DB_SHUTDOWN_KEY] = true;
  }
}
