import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";
import {
  isCorruptionError,
  projectionDbState,
  selfHealProjectionDbIfCorrupt,
} from "./self-heal.server";

/**
 * Boot self-heal. The guarantees that matter: it heals ONLY on real corruption
 * (never nukes a healthy-but-unreadable DB), it salvages the prefix of a
 * partially-corrupt table (auth/PATs on healthy pages survive), it leaves the
 * file-derived projection tables EMPTY so the rescan rebuilds them, it preserves
 * the corrupt file AND its WAL, and the swap is atomic.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-selfheal-"));
  dirs.push(dir);
  return path.join(dir, "projection.sqlite");
}

/** A valid database on the real baseline: `users` (+ a github PAT) on early
 *  pages, optional excluded-table rows, and filler `notifications` so the file
 *  spans many pages. `users` first (early pages) so a mid-file garble spares
 *  it unless `usersFirst` is false. */
function seedRealDb(
  dbPath: string,
  opts: { users?: number; filler?: number; excluded?: boolean; usersFirst?: boolean } = {},
): void {
  const { users = 3, filler = 8000, excluded = false, usersFirst = true } = opts;
  const db = openDatabase(dbPath);
  runMigrations(db);
  const now = "2026-08-21T00:00:00.000Z";
  const insertUsers = () => {
    const u = db.prepare(
      "INSERT INTO users (id,email,name,role,idp,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < users; i++) {
      // Pad the name so each row spans real bytes → many pages for a large
      // count, so a mid-file garble lands inside the users btree.
      u.run(`u${i}`, `u${i}@viberr.dev`, `User ${i} ${"x".repeat(240)}`, "admin", "local", now, now);
    }
    db.prepare(
      "INSERT INTO github_pats (id,user_id,label,encrypted_token,token_suffix,created_at) VALUES (?,?,?,?,?,?)",
    ).run("pat1", "u0", "owner PAT", "sealed-blob", "6411", now);
  };
  if (usersFirst) insertUsers();
  if (excluded) {
    // `provenance` is the canonical "leave empty for the rescan" table and
    // shares the exact skip path with projects/task_projections/etc.
    db.prepare(
      "INSERT INTO provenance (source_path,content_hash,observed_at,action) VALUES (?,?,?,?)",
    ).run("projects/p1/project.md", "hash", now, "projected");
  }
  const n = db.prepare(
    "INSERT INTO notifications (id,user_id,kind,text,occurred_at,created_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < filler; i++) {
    n.run(`n${i}`, "u0", "mention", "x".repeat(200), now, now);
  }
  if (!usersFirst) insertUsers();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

/** Garble ONE page a fraction through the file — quick_check fails while other
 *  btrees still read. */
function garblePage(dbPath: string, fraction = 0.5): void {
  const PAGE = 4096;
  const pages = Math.floor(statSync(dbPath).size / PAGE);
  const fd = openSync(dbPath, "r+");
  try {
    writeSync(fd, Buffer.alloc(PAGE, 0xdb), 0, PAGE, Math.floor(pages * fraction) * PAGE);
  } finally {
    closeSync(fd);
  }
}

describe("isCorruptionError", () => {
  it("is true for SQLITE_CORRUPT / SQLITE_NOTADB and malformed messages", () => {
    expect(isCorruptionError({ errcode: 11 })).toBe(true);
    expect(isCorruptionError({ errcode: 26 })).toBe(true);
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true);
  });
  it("is FALSE for I/O and permission errors (which must never heal)", () => {
    expect(isCorruptionError({ errcode: 14 })).toBe(false); // SQLITE_CANTOPEN
    expect(isCorruptionError(new Error("EACCES: permission denied, open"))).toBe(false);
    expect(isCorruptionError(new Error("EMFILE: too many open files"))).toBe(false);
  });
});

describe("projectionDbState", () => {
  it("ok for a missing file (fresh boot) and a healthy database", () => {
    expect(projectionDbState(tmpDb())).toBe("ok");
    const p = tmpDb();
    seedRealDb(p, { users: 1, filler: 10 });
    expect(projectionDbState(p)).toBe("ok");
  });
  it("corrupt for garbage bytes and for a garbled btree page", () => {
    const g = tmpDb();
    writeFileSync(g, Buffer.from("this is not a sqlite database at all"));
    expect(projectionDbState(g)).toBe("corrupt");
    const b = tmpDb();
    seedRealDb(b);
    garblePage(b);
    expect(projectionDbState(b)).toBe("corrupt");
  });
  it("does NOT call a permission-blocked file corrupt (would nuke a healthy DB)", () => {
    const p = tmpDb();
    seedRealDb(p, { users: 1, filler: 10 });
    chmodSync(p, 0o000);
    try {
      // Either the owner can still read it ("ok") or it is "unreadable" — never
      // "corrupt", so the heal never fires over a permissions blip.
      expect(projectionDbState(p)).not.toBe("corrupt");
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

describe("selfHealProjectionDbIfCorrupt", () => {
  it("leaves a HEALTHY database untouched (no false positive)", () => {
    const p = tmpDb();
    seedRealDb(p, { users: 3, filler: 10 });
    const before = statSync(p).mtimeMs;
    const result = selfHealProjectionDbIfCorrupt(p);
    expect(result.healed).toBe(false);
    expect(result.movedTo).toBeUndefined();
    expect(statSync(p).mtimeMs).toBe(before);
    const db = new DatabaseSync(p, { readOnly: true });
    // SAFETY: a bare COUNT(*) always returns exactly one row, and `c` is its
    // only column — an INTEGER SQLite cannot report as anything else.
    expect((db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c).toBe(3);
    db.close();
  });

  it("salvages the PREFIX of a partially-corrupt users table (not just loses it whole)", () => {
    const p = tmpDb();
    // Large users table so a mid-file page is a users leaf; PAT is inserted with
    // the users, on early pages.
    seedRealDb(p, { users: 2000, filler: 0 });
    garblePage(p, 0.5);
    const result = selfHealProjectionDbIfCorrupt(p);
    expect(result.healed).toBe(true);
    // Some users survived, but NOT all — the whole-table drop bug would give 0.
    expect(result.salvaged.users).toBeGreaterThan(0);
    expect(result.salvaged.users).toBeLessThan(2000);
    // The live file is valid again.
    expect(projectionDbState(p)).toBe("ok");
    // The corrupt original is preserved.
    expect(existsSync(result.movedTo!)).toBe(true);
  });

  it("EXCLUDES the file-derived tables so the rescan rebuilds them", () => {
    const p = tmpDb();
    seedRealDb(p, { users: 3, filler: 4000, excluded: true });
    garblePage(p, 0.6); // a notifications page — projects/provenance read fine
    const result = selfHealProjectionDbIfCorrupt(p);
    expect(result.healed).toBe(true);
    // Auth salvaged…
    expect(result.salvaged.users).toBe(3);
    // …but the rescan-owned tables are NOT salvaged, and are EMPTY in the fresh
    // file (so the boot rescan re-projects them from the .md files).
    expect(result.salvaged.provenance).toBeUndefined();
    const db = new DatabaseSync(p, { readOnly: true });
    // SAFETY: a bare COUNT(*) always returns exactly one row, and `c` is its
    // only column — an INTEGER SQLite cannot report as anything else.
    expect((db.prepare("SELECT count(*) c FROM provenance").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it("recovers CATASTROPHIC corruption and PRESERVES the corrupt file + its WAL", () => {
    const p = tmpDb();
    writeFileSync(p, Buffer.from("not a sqlite database, only garbage bytes ".repeat(60)));
    // A WAL sidecar holds the newest committed rows — it must be preserved, not
    // deleted (this feature's founding incident was WAL-borne PAT loss).
    writeFileSync(p + "-wal", Buffer.from("wal bytes representing the newest txns"));
    const result = selfHealProjectionDbIfCorrupt(p, () => new Date("2030-01-02T03:04:05.678Z"));
    expect(result.healed).toBe(true);
    expect(result.salvaged).toEqual({});
    // The corrupt file AND its WAL are preserved beside the healed file (the
    // WAL holds the newest committed rows — the founding-incident data).
    expect(result.movedTo).toBe(`${p}.corrupt-2030-01-02T03-04-05-678Z`);
    expect(existsSync(result.movedTo!)).toBe(true);
    expect(existsSync(result.movedTo! + "-wal")).toBe(true);
    // The stale live sidecar was cleared before the swap, so it cannot replay
    // into the fresh file: the healed DB opens clean.
    expect(projectionDbState(p)).toBe("ok");
  });
});
