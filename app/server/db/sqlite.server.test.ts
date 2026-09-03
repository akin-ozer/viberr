import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import {
  closeDb,
  ensureRunRowColumns,
  getDb,
  getProjectionDbPath,
  isDatabaseShuttingDown,
  openDatabase,
  shutdownDatabase,
} from "./sqlite.server";

describe("ensureRunRowColumns (pass 32, C02-R11 additive drift backstop)", () => {
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
      ensureRunRowColumns(db);
      expect(columns()).toEqual([
        "id",
        "outcome_key",
        "dispatched_by_name",
        "dispatched_by_user_id",
        // Ruling 121: `upsertRun` names the credential principal on every
        // insert, so a root without this column could not start a run at all.
        "credential_user_id",
      ]);
      // Second boot: nothing to add, nothing thrown.
      ensureRunRowColumns(db);
      expect(columns()).toHaveLength(5);
      db.prepare(`UPDATE agent_runs SET dispatched_by_name = ? WHERE id = ?`).run("x", "none");
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
