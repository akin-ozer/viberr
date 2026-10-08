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
import { z } from "zod";
import { runMigrations } from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";
import { selfHealProjectionDbIfCorrupt } from "./self-heal.server";

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
      // Pad the name so each row spans real bytes → many leaf pages for a
      // large count, so a garbled middle leaf leaves a readable prefix.
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

const PAGE = 4096;

/** Overwrite one page (0-based index) with garbage. */
function garblePageAt(dbPath: string, index: number): void {
  const fd = openSync(dbPath, "r+");
  try {
    writeSync(fd, Buffer.alloc(PAGE, 0xdb), 0, PAGE, index * PAGE);
  } finally {
    closeSync(fd);
  }
}

/** Garble ONE page a fraction through the file — quick_check fails while other
 *  btrees still read. */
function garblePage(dbPath: string, fraction = 0.5): void {
  const pages = Math.floor(statSync(dbPath).size / PAGE);
  garblePageAt(dbPath, Math.floor(pages * fraction));
}

const leafPagesSchema = z.array(z.object({ pageno: z.number() }));

/** Garble the MIDDLE leaf of `table`'s own btree, found with `dbstat`, so a
 *  full scan reads a prefix of its rows and then hits the corrupt page. The
 *  btree is located rather than guessed from a fraction of the file: the
 *  baseline's longer DDL moves every page along, and a fixed offset can then
 *  land on one of the table's INDEX leaves, which a table scan never reads. */
function garbleMiddleLeafOf(dbPath: string, table: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let leaves: number[];
  try {
    leaves = leafPagesSchema
      .parse(
        db
          .prepare(
            "SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno",
          )
          .all(table),
      )
      .map((row) => row.pageno);
  } finally {
    db.close();
  }
  const middle = leaves[Math.floor(leaves.length / 2)];
  if (middle === undefined || leaves.length < 3) {
    throw new Error(`${table} spans ${leaves.length} leaf pages; the test needs several`);
  }
  // dbstat numbers pages from 1; the file offset is 0-based.
  garblePageAt(dbPath, middle - 1);
}

describe("selfHealProjectionDbIfCorrupt", () => {
  it("never heals a file it cannot open, nor one that is not there", () => {
    // A permissions blip is not corruption, and a heal over it would replace a
    // healthy database. The mode bites only for an unprivileged user, which is
    // how CI runs the suite (ruling 622). CANARY: read every open failure as
    // corruption and the blocked file no longer comes back unhealed.
    const blocked = tmpDb();
    seedRealDb(blocked, { users: 1, filler: 10 });
    chmodSync(blocked, 0o000);
    try {
      expect(selfHealProjectionDbIfCorrupt(blocked)).toEqual({
        healed: false,
        salvaged: {},
        skipped: {},
      });
    } finally {
      chmodSync(blocked, 0o644);
    }
    // A fresh boot: nothing to heal, and nothing created in its place.
    const absent = tmpDb();
    expect(selfHealProjectionDbIfCorrupt(absent)).toEqual({ healed: false, salvaged: {}, skipped: {} });
    expect(existsSync(absent)).toBe(false);
  });

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
    // Large users table so it spans many leaves, the middle one garbled; the
    // PAT is inserted with the users, on early pages.
    seedRealDb(p, { users: 2000, filler: 0 });
    garbleMiddleLeafOf(p, "users");
    const result = selfHealProjectionDbIfCorrupt(p);
    expect(result.healed).toBe(true);
    // Some users survived, but NOT all — the whole-table drop bug would give 0.
    expect(result.salvaged.users).toBeGreaterThan(0);
    expect(result.salvaged.users).toBeLessThan(2000);
    // The live file is valid again: the next boot finds nothing to heal.
    expect(selfHealProjectionDbIfCorrupt(p).healed).toBe(false);
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
    expect(selfHealProjectionDbIfCorrupt(p).healed).toBe(false);
  });
});
