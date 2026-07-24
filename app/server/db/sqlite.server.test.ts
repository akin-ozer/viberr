import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import {
  closeDb,
  getDb,
  getProjectionDbPath,
  openDatabase,
  shutdownDatabase,
} from "./sqlite.server";

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

  it("forgets the cached handle so the next getDb() reopens", () => {
    const first = getDb();
    shutdownDatabase();
    const second = getDb();
    // Identity compared as a boolean: vitest pretty-prints a mismatch, and
    // inspecting a CLOSED DatabaseSync throws "database is not open".
    expect(second === first).toBe(false);
    expect(first.isOpen).toBe(false);
    expect(second.isOpen).toBe(true);
  });

  it("is a no-op (never throws) when nothing is open — the shutdown path must be total", () => {
    closeDb();
    expect(() => shutdownDatabase()).not.toThrow();
    expect(() => shutdownDatabase()).not.toThrow();
  });
});
