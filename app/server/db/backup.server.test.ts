import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { acquireDataRootLock } from "./data-root-lock.server";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";
import {
  BACKUP_FORMAT,
  createBackup,
  projectionPathIn,
  readManifest,
  restoreBackup,
  restoreStoreFile,
} from "./backup.server";

/**
 * Gap 14 — there was no backup tooling at all, and the documented procedure
 * (copy the directory) is not consistent on a live WAL database. These pin the
 * two claims that matter: the artefact captures committed-but-not-checkpointed
 * rows that a raw copy misses, and it restores.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

interface Fixture {
  dataRoot: string;
  db: DatabaseSync;
  out: string;
}

/** A data root shaped like the real one: state/projection.sqlite + markdown. */
function fixture(): Fixture {
  const dataRoot = ctx.makeTempDir();
  const db = openDatabase(projectionPathIn(dataRoot));
  runMigrations(db, DEFAULT_MIGRATIONS_DIR);
  db.prepare(
    `INSERT INTO users (id, email, name, title, role, idp, avatar_tone,
       pwreset_required, theme, disabled, created_at, updated_at, created_by)
     VALUES ('u_arda', 'arda@viberr.dev', 'Arda', NULL, 'admin', 'local', NULL,
             0, 'system', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL)`,
  ).run();
  const taskDir = path.join(dataRoot, "projects", "viberr-core", "tasks", "VIB-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "task.md"), "---\nkey: VIB-1\n---\n\n## Goal\n\nShip.\n");
  mkdirSync(path.join(dataRoot, "kb", "handbook"), { recursive: true });
  writeFileSync(path.join(dataRoot, "kb", "handbook", "style.md"), "# Style\n");
  // A half-written atomic write in flight — never content.
  writeFileSync(path.join(taskDir, "task.md.abcd.tmp"), "half written");
  return { dataRoot, db, out: ctx.makeTempDir() };
}

describe("createBackup", () => {
  it("captures rows that a raw file copy would miss, because they are still in the WAL", () => {
    const f = fixture();
    // Committed, NOT checkpointed — exactly the live-container state the
    // deployment doc concedes a hot directory copy gets wrong.
    f.db.prepare(
      `INSERT INTO users (id, email, name, title, role, idp, avatar_tone,
         pwreset_required, theme, disabled, created_at, updated_at, created_by)
       VALUES ('u_murat', 'murat@viberr.dev', 'Murat', NULL, 'member', 'local', NULL,
               0, 'system', 0, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL)`,
    ).run();
    expect(existsSync(`${projectionPathIn(f.dataRoot)}-wal`)).toBe(true);

    // The naive procedure: copy the main file only.
    const naive = path.join(f.out, "naive.sqlite");
    copyFileSync(projectionPathIn(f.dataRoot), naive);

    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });

    const fromBackup = new DatabaseSync(
      path.join(backup.dir, "projection.sqlite"),
      { readOnly: true },
    );
    const fromNaive = new DatabaseSync(naive, { readOnly: true });
    try {
      expect(
        (fromBackup.prepare(`SELECT count(*) c FROM users`).get() as { c: number }).c,
      ).toBe(2);
      // …and this is what the prose procedure would have handed you: the
      // main file has not even got the SCHEMA yet, let alone the rows.
      const naiveTables = (
        fromNaive
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(naiveTables).not.toContain("users");
    } finally {
      fromBackup.close();
      fromNaive.close();
    }
    // No sidecars in the artefact: VACUUM INTO writes one self-contained file.
    expect(existsSync(path.join(backup.dir, "projection.sqlite-wal"))).toBe(false);
  });

  it("carries the file-native store and skips in-flight *.tmp writes", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });

    expect(
      readFileSync(
        path.join(backup.dir, "store", "projects", "viberr-core", "tasks", "VIB-1", "task.md"),
        "utf8",
      ),
    ).toContain("Ship.");
    expect(
      existsSync(path.join(backup.dir, "store", "kb", "handbook", "style.md")),
    ).toBe(true);
    expect(
      existsSync(
        path.join(backup.dir, "store", "projects", "viberr-core", "tasks", "VIB-1", "task.md.abcd.tmp"),
      ),
    ).toBe(false);
    expect(backup.manifest.store.dirs).toEqual(["projects", "kb"]);
  });

  it("states what the artefact contains and what it does NOT", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    const manifest = readManifest(backup.dir);

    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.projection?.rows.users).toBe(1);
    expect(manifest.contains.join(" ")).toContain("sealed GitHub PATs");
    // The two exclusions an operator must not have to guess at.
    expect(manifest.excludes.join(" ")).toContain("runtimes/");
    expect(manifest.excludes.join(" ")).toContain("VIBERR_SECRET_ENCRYPTION_KEY");
    // Same inventory in the artefact itself, for whoever finds it later.
    const readme = readFileSync(path.join(backup.dir, "README.txt"), "utf8");
    expect(readme).toContain("DOES NOT CONTAIN");
    expect(readme).toContain("npm run restore");
    // And on stdout.
    expect(backup.text).toContain("DOES NOT CONTAIN");
    expect(backup.text).toContain("users: 1 rows");
  });

  it("carries runtimes/ only when asked", () => {
    const f = fixture();
    mkdirSync(path.join(f.dataRoot, "runtimes", "codex-home"), { recursive: true });
    writeFileSync(path.join(f.dataRoot, "runtimes", "codex-home", "auth.json"), "{}");

    const without = createBackup({ dataRoot: f.dataRoot, destination: f.out, name: "a" });
    expect(existsSync(path.join(without.dir, "store", "runtimes"))).toBe(false);

    const with_ = createBackup({
      dataRoot: f.dataRoot,
      destination: f.out,
      name: "b",
      includeRuntimes: true,
    });
    expect(
      existsSync(path.join(with_.dir, "store", "runtimes", "codex-home", "auth.json")),
    ).toBe(true);
    expect(with_.manifest.excludes.join(" ")).not.toContain("runtimes/ —");
  });

  it("refuses to write the artefact inside the data root it is backing up", () => {
    const f = fixture();
    expect(() =>
      createBackup({ dataRoot: f.dataRoot, destination: path.join(f.dataRoot, "backups") }),
    ).toThrow(/inside the data root/);
  });
});

describe("restoreBackup", () => {
  it("brings back the database AND the files after the data root is wrecked", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    f.db.close();

    // Lose everything: a deleted volume, a bad hand-edit, a botched upgrade.
    rmSync(path.join(f.dataRoot, "projects"), { recursive: true, force: true });
    rmSync(projectionPathIn(f.dataRoot), { force: true });
    // …and leave a stale WAL sidecar behind, which is the trap: it belongs to
    // the database being replaced.
    writeFileSync(`${projectionPathIn(f.dataRoot)}-wal`, "stale wal");

    const result = restoreBackup({ artefact: backup.dir, dataRoot: f.dataRoot, force: true });

    expect(result.projectionRestored).toBe(true);
    expect(result.restoredDirs).toContain("projects");
    // The stale sidecar is gone from the live root — it belonged to the
    // database being replaced, and SQLite would have replayed it over the
    // restored file. It is carried into the displaced copy, not destroyed.
    expect(existsSync(`${projectionPathIn(f.dataRoot)}-wal`)).toBe(false);
    expect(
      readFileSync(path.join(result.displacedTo!, "state", "projection.sqlite-wal"), "utf8"),
    ).toBe("stale wal");
    expect(result.removedSidecars).toContain("projection.sqlite-wal");

    const restored = new DatabaseSync(projectionPathIn(f.dataRoot), { readOnly: true });
    try {
      expect(
        (restored.prepare(`SELECT email FROM users`).get() as { email: string }).email,
      ).toBe("arda@viberr.dev");
      // The restore itself is on the record.
      expect(
        (
          restored
            .prepare(`SELECT count(*) c FROM audit_events WHERE action = 'store.restored'`)
            .get() as { c: number }
        ).c,
      ).toBe(1);
    } finally {
      restored.close();
    }
    expect(
      readFileSync(
        path.join(f.dataRoot, "projects", "viberr-core", "tasks", "VIB-1", "task.md"),
        "utf8",
      ),
    ).toContain("Ship.");
  });

  it("refuses to replace a non-empty data root without --force, and displaces rather than deletes with it", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    f.db.close();

    expect(() => restoreBackup({ artefact: backup.dir, dataRoot: f.dataRoot })).toThrow(
      /already holds data/,
    );

    const result = restoreBackup({
      artefact: backup.dir,
      dataRoot: f.dataRoot,
      force: true,
    });
    expect(result.displacedTo).toBeTruthy();
    expect(
      existsSync(path.join(result.displacedTo!, "projects", "viberr-core", "tasks", "VIB-1", "task.md")),
    ).toBe(true);
  });

  it("never displaces the writer lock it is holding", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    f.db.close();
    // `npm run restore` holds this for the whole operation (gap 19).
    const lock = acquireDataRootLock({ dataRoot: f.dataRoot, releaseOnExit: false });

    const result = restoreBackup({
      artefact: backup.dir,
      dataRoot: f.dataRoot,
      force: true,
    });

    // Moving state/ wholesale would have carried the lock off with it — the
    // restore would then be running lock-less, and F18-5's ownership guard
    // would call it stolen.
    expect(existsSync(lock.path)).toBe(true);
    expect(lock.verifyOwnership()).toBe("held");
    expect(
      existsSync(path.join(result.displacedTo!, "state", "writer.lock")),
    ).toBe(false);
    lock.release();
  });

  it("rejects a directory that is not a backup", () => {
    const f = fixture();
    expect(() => restoreBackup({ artefact: f.out, dataRoot: f.dataRoot })).toThrow(
      /not a viberr backup/,
    );
  });
});

describe("restoreStoreFile", () => {
  it("puts back ONE file without touching the database", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    const rel = "projects/viberr-core/tasks/VIB-1/task.md";
    const abs = path.join(f.dataRoot, rel);

    // A botched hand-edit: the frontmatter fence is gone.
    writeFileSync(abs, "---\nkey: VIB-1\ntitle: broken", "utf8");
    // …and a user is added AFTER the backup: the DB must not roll back.
    f.db.prepare(
      `INSERT INTO users (id, email, name, title, role, idp, avatar_tone,
         pwreset_required, theme, disabled, created_at, updated_at, created_by)
       VALUES ('u_new', 'new@viberr.dev', 'New', NULL, 'member', 'local', NULL,
               0, 'system', 0, '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', NULL)`,
    ).run();

    const result = restoreStoreFile({
      artefact: backup.dir,
      dataRoot: f.dataRoot,
      relPath: rel,
    });

    expect(readFileSync(abs, "utf8")).toContain("Ship.");
    // The broken bytes are kept, and NOT under a name the store will project.
    expect(result.displacedTo).toMatch(/task\.md\.broken-/);
    expect(readFileSync(result.displacedTo!, "utf8")).toContain("title: broken");
    // The database is untouched — the whole point of a single-file restore.
    expect(
      (f.db.prepare(`SELECT count(*) c FROM users`).get() as { c: number }).c,
    ).toBe(2);
    expect(result.text).toContain("database was NOT touched");
  });

  it("refuses paths outside the file-native store", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    for (const bad of [
      "state/projection.sqlite",
      "runtimes/codex-home/auth.json",
      "../../etc/passwd",
      "/etc/passwd",
    ]) {
      expect(() =>
        restoreStoreFile({ artefact: backup.dir, dataRoot: f.dataRoot, relPath: bad }),
      ).toThrow();
    }
  });

  it("says so when the file is not in the artefact", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    expect(() =>
      restoreStoreFile({
        artefact: backup.dir,
        dataRoot: f.dataRoot,
        relPath: "projects/viberr-core/tasks/VIB-404/task.md",
      }),
    ).toThrow(/not in this backup/);
  });
});
