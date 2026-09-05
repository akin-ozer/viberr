import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import {
  closeDb,
  ensureBaselineColumns,
  getDb,
  getProjectionDbPath,
  isDatabaseShuttingDown,
  openDatabase,
  shutdownDatabase,
} from "./sqlite.server";

describe("ensureBaselineColumns (pass 32 C02-R11; ruling 121 controller tables)", () => {
  it("adds every baseline column a pre-existing root lacks, idempotently", () => {
    // A data root that applied 0001 BEFORE the columns existed never re-runs
    // the file (migrations stay squashed pre-prod), and `patchRun` naming a
    // missing column would fail every agent completion on that root. The
    // backstop applies the boot WARN's own remedy (ALTER TABLE … ADD COLUMN).
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-runrow-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE agent_runs (id TEXT PRIMARY KEY, outcome_key TEXT)`,
      );
      const columns = () =>
        // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
        (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      expect(columns()).toEqual(["id", "outcome_key"]);
      ensureBaselineColumns(db);
      expect(columns()).toEqual([
        "id",
        "outcome_key",
        "dispatched_by_name",
        "dispatched_by_user_id",
        // Ruling 127: `upsertRun` names the credential principal on every
        // insert, so a root without this column could not start a run at all.
        "credential_user_id",
      ]);
      // Second boot: nothing to add, nothing thrown.
      ensureBaselineColumns(db);
      expect(columns()).toHaveLength(5);
      db.prepare(`UPDATE agent_runs SET dispatched_by_name = ? WHERE id = ?`).run("x", "none");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 121 (review G1). The dock's loader names `task_key` on the FIRST
   * signed-in page of every surface, so on a root that applied 0001 before
   * ruling 121 the missing column would 500 that loader and, fetcher errors
   * going to the route's boundary, replace every page with the root error
   * page. Reproduced here against the PRE-121 controller schema.
   */
  it("adds the ruling-121 controller columns and the scope index a pre-121 root lacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ctlrow-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      // The exact shape 0001 created before ruling 121: no task_key, no
      // surface, and only the per-user index.
      db.exec(
        `CREATE TABLE controller_conversations (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_label TEXT NOT NULL,
           project_slug TEXT, title TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT);
         CREATE INDEX idx_controller_conversations__user
           ON controller_conversations (user_id, last_message_at DESC);
         CREATE TABLE controller_messages (
           id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
           author TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, run_id TEXT,
           created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));`,
      );
      const columns = (table: string) =>
        // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      // The failure this backstop exists to prevent, proven first.
      expect(() =>
        db.prepare(`SELECT id FROM controller_conversations WHERE task_key IS NULL`).all(),
      ).toThrow(/task_key/);

      ensureBaselineColumns(db);

      expect(columns("controller_conversations")).toContain("task_key");
      expect(columns("controller_messages")).toContain("surface");
      // SAFETY: sqlite_master rows carry a TEXT `name`; only `name` is read.
      const indexes = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'controller_conversations'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes).toContain("idx_controller_conversations__scope");
      // The reads and writes the dock and the store make now work.
      expect(
        db.prepare(`SELECT id FROM controller_conversations WHERE task_key IS NULL`).all(),
      ).toEqual([]);
      db.prepare(
        `INSERT INTO controller_conversations
           (id, user_id, user_label, project_slug, task_key, title, created_at, updated_at)
         VALUES ('c1', 'u1', 'a@b.dev', 'p', 'VIB-1', '', '2026-09-02', '2026-09-02')`,
      ).run();
      db.prepare(
        `INSERT INTO controller_messages
           (id, conversation_id, seq, author, user_id, text, run_id, surface, created_at)
         VALUES ('m1', 'c1', 1, 'user', 'u1', 'hi', NULL, '/projects/p/board', '2026-09-02')`,
      ).run();
      // Idempotent: a second boot adds nothing and throws nothing.
      ensureBaselineColumns(db);
      expect(columns("controller_conversations").filter((c) => c === "task_key")).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P13-D-43: nothing ever closed the database. `closeDb()` had no non-test
 * caller and no `wal_checkpoint` existed anywhere, so an exited container was
 * observed leaving a 4.1 MB `-wal` and a `-shm` beside a stale
 * `projection.sqlite` — and this file is PRIMARY storage for users, sessions
 * and PATs, none of which a rescan can rebuild.
 *
 * SQLite unlinks both sidecars on a clean close, so their absence is the
 * observable proof the shutdown happened.
 */

let dataRoot: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.VIBERR_DATA_ROOT;
  dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-shutdown-"));
  process.env.VIBERR_DATA_ROOT = dataRoot;
  resetEnvCacheForTests();
  closeDb();
});

afterEach(() => {
  closeDb();
  if (previousRoot === undefined) delete process.env.VIBERR_DATA_ROOT;
  else process.env.VIBERR_DATA_ROOT = previousRoot;
  resetEnvCacheForTests();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("shutdownDatabase", () => {
  it("checkpoints the WAL and closes, leaving no -wal/-shm behind", () => {
    const db = getDb();
    const dbPath = getProjectionDbPath();
    db.prepare(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('u_1', 'a@b.dev', 'A', 'member', '2026-07-24', '2026-07-24')`,
    ).run();
    // Journal mode is WAL, so the write lives in the sidecar until checkpointed.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    shutdownDatabase();

    expect(db.isOpen).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("leaves the committed rows durable in the main file", () => {
    const db = getDb();
    const dbPath = getProjectionDbPath();
    db.prepare(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('u_keep', 'keep@b.dev', 'Keep', 'admin', '2026-07-24', '2026-07-24')`,
    ).run();
    shutdownDatabase();

    const reopened = openDatabase(dbPath);
    try {
      expect(
        reopened.prepare(`SELECT role FROM users WHERE id = 'u_keep'`).get(),
      ).toEqual({ role: "admin" });
    } finally {
      reopened.close();
    }
  });

  /**
   * F21-24 (live, UC-31 — `docker restart` mid-run): SIGTERM closed sqlite, and
   * then an in-flight request took `getDb`'s lazy-open branch and logged "sqlite
   * ready" BETWEEN "sqlite closed" and process exit. The drain re-opened the
   * database it had just checkpointed and released, re-ran migrations against
   * it, and left a second handle for a process that was dying — which is exactly
   * what the single-writer story (B-FD1/F18-5) exists to prevent.
   *
   * This test USED to assert the opposite ("forgets the cached handle so the
   * next getDb() reopens"), which is how the behavior survived: the defect was
   * pinned as the contract.
   */
  it("refuses to lazily reopen once the shutdown has closed it", () => {
    const first = getDb();
    shutdownDatabase();
    expect(first.isOpen).toBe(false);
    expect(isDatabaseShuttingDown()).toBe(true);
    expect(() => getDb()).toThrow(/shutting down/i);
    // Twice: the refusal is a latch, not a one-shot.
    expect(() => getDb()).toThrow(/shutting down/i);
  });

  it("latches even when the handle was already closed — a total shutdown path", () => {
    getDb();
    closeDb();
    shutdownDatabase();
    expect(isDatabaseShuttingDown()).toBe(true);
    expect(() => getDb()).toThrow(/shutting down/i);
  });

  it("closeDb clears the latch, so tests (and only tests) can reopen", () => {
    getDb();
    shutdownDatabase();
    closeDb();
    expect(isDatabaseShuttingDown()).toBe(false);
    expect(getDb().isOpen).toBe(true);
  });

  it("is a no-op (never throws) when nothing is open — the shutdown path must be total", () => {
    closeDb();
    expect(() => shutdownDatabase()).not.toThrow();
    expect(() => shutdownDatabase()).not.toThrow();
  });
});

describe("ensureBaselineColumns — baseline TABLES a pre-existing root lacks", () => {
  it("creates user_backend_credentials on a root that predates ruling 127", () => {
    // The healer's own sibling miss: ruling 127 added BOTH the
    // `agent_runs.credential_user_id` column and the `user_backend_credentials`
    // table to the squashed baseline, but only the column was added to the
    // healer's list. 0001 never re-runs, so a root created before that commit
    // booted with the column and WITHOUT the table — and the first read of
    // Profile → Agent accounts, or the first run start, 500s on "no such
    // table". Canary: drop the table from BASELINE_TABLES and this fails.
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ubc-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO users (id) VALUES (?)`).run("u1");
      const hasTable = () =>
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          )
          .get("user_backend_credentials") !== undefined;
      expect(hasTable(), "the old root starts without it").toBe(false);
      ensureBaselineColumns(db);
      expect(hasTable(), "the healer must create it").toBe(true);
      // The shape readers actually name, and idempotent on the next boot.
      db.prepare(
        `INSERT INTO user_backend_credentials
           (id, user_id, backend, kind, detail_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("ubc_1", "u1", "claude", "login", "{}", "t", "t");
      ensureBaselineColumns(db);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM user_backend_credentials`).get(),
      ).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
