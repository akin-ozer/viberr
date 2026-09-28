import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  createInstanceSecrets,
  readInstanceSecrets,
} from "../config/instance-secrets.server";
import { acquireDataRootLock, DATA_ROOT_LOCK_FILENAME } from "./data-root-lock.server";
import { runMigrations } from "./migration-runner.server";
import { openDatabase } from "./sqlite.server";
import {
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
  runMigrations(db);
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
  // Ruling 102's durable record of purged audit rows (C01-A3).
  mkdirSync(path.join(dataRoot, "audit-exports"), { recursive: true });
  writeFileSync(
    path.join(dataRoot, "audit-exports", "audit-events-2026-08-01.jsonl"),
    '{"id":"ae_1","action":"task.created"}\n',
  );
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
      // SAFETY: `SELECT count(*) c` always returns exactly one row whose only
      // column is that integer, so `get` cannot come back undefined here.
      expect(
        (fromBackup.prepare(`SELECT count(*) c FROM users`).get() as { c: number }).c,
      ).toBe(2);
      // …and this is what the prose procedure would have handed you: the
      // main file has not even got the SCHEMA yet, let alone the rows.
      // SAFETY: the SELECT names one column, and `sqlite_master.name` is TEXT
      // on every row a `type = 'table'` filter can return.
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

  /**
   * Ruling 158 (pass 35 F35-9). With the app holding the writer lock, the
   * backup must not be the second connection to the live file: it reads a copy
   * taken beside the store, the copy carries the WAL (so the artefact still
   * holds every committed row), the copy is gone when the backup returns, and
   * the manifest says which way the projection was read. Canary: put the
   * pre-158 open back (`new DatabaseSync(source, { readOnly: true })` instead of
   * the reader handle) and the provenance assertions fail; the snapshot
   * semantics themselves are pinned in `sqlite.server.test.ts`.
   */
  it("under a live writer lock, takes the artefact from a copy and says so in the manifest", () => {
    const f = fixture();
    f.db.prepare(
      `INSERT INTO users (id, email, name, title, role, idp, avatar_tone,
         pwreset_required, theme, disabled, created_at, updated_at, created_by)
       VALUES ('u_murat', 'murat@viberr.dev', 'Murat', NULL, 'member', 'local', NULL,
               0, 'system', 0, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL)`,
    ).run();
    expect(existsSync(`${projectionPathIn(f.dataRoot)}-wal`)).toBe(true);
    // The app: this very process, alive by every probe, on this host.
    writeFileSync(
      path.join(f.dataRoot, "state", DATA_ROOT_LOCK_FILENAME),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: "2026-09-06T18:00:00.000Z" }),
    );

    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });

    expect(backup.manifest.projection?.rows.users).toBe(2);
    expect(backup.manifest.contains[0]).toContain(
      "read from a copy of the file and its WAL taken while state/writer.lock named a holder",
    );
    expect(backup.text).toContain("taken while state/writer.lock named a holder");
    // The copy is removed with the handle; the store carries nothing of it.
    expect(existsSync(path.join(f.dataRoot, "state", "tmp", `reader-${process.pid}`))).toBe(false);
    // …and the live database's own sidecar was left alone.
    expect(existsSync(`${projectionPathIn(f.dataRoot)}-wal`)).toBe(true);
  });

  it("with nothing holding the root, reads the file itself and says that instead", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    expect(backup.manifest.contains[0]).toContain(
      "read from the file itself; the root carried no writer lock",
    );
    expect(existsSync(path.join(f.dataRoot, "state", "tmp"))).toBe(false);
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
    // C01-A3 (pass 32): the audit export rides along — it is the only
    // long-term record of purged audit rows. Canary: drop "audit-exports"
    // from BACKED_UP_STORE_DIRS.
    expect(
      existsSync(path.join(backup.dir, "store", "audit-exports", "audit-events-2026-08-01.jsonl")),
    ).toBe(true);
    expect(backup.manifest.store.dirs).toEqual(["projects", "kb", "audit-exports"]);
  });

  it("states what the artefact contains and what it does NOT", () => {
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    const manifest = readManifest(backup.dir);

    expect(manifest.format).toBe("viberr-backup/1");
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
    // Ruling 127: the credential that makes `runtimes/` opt-in is a PERSON's
    // own vendor sign-in, under their runtime home.
    const home = path.join(f.dataRoot, "runtimes", "users", "u_arda", "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "auth.json"), "{}");

    const without = createBackup({ dataRoot: f.dataRoot, destination: f.out, name: "a" });
    expect(existsSync(path.join(without.dir, "store", "runtimes"))).toBe(false);

    const with_ = createBackup({
      dataRoot: f.dataRoot,
      destination: f.out,
      name: "b",
      includeRuntimes: true,
    });
    expect(
      existsSync(
        path.join(
          with_.dir,
          "store",
          "runtimes",
          "users",
          "u_arda",
          "codex-home",
          "auth.json",
        ),
      ),
    ).toBe(true);
    expect(with_.manifest.excludes.join(" ")).not.toContain("runtimes/:");
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
      // SAFETY: the SELECT names one column, 0001_baseline declares
      // `users.email` TEXT NOT NULL, and the restored backup holds two users —
      // so the first row exists and carries this shape.
      expect(
        (restored.prepare(`SELECT email FROM users`).get() as { email: string }).email,
      ).toBe("arda@viberr.dev");
      // The restore itself is on the record.
      // SAFETY: as above — a count(*) row always exists and carries `c`.
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

describe("the secrets an instance generated for itself (ruling 504)", () => {
  it("travel in the artefact, and come back on a fresh root without --force", () => {
    const f = fixture();
    const generated = createInstanceSecrets(f.dataRoot);
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    f.db.close();

    expect(backup.manifest.instanceSecrets).toBe(true);
    expect(statSync(path.join(backup.dir, "instance-secrets.json")).mode & 0o777).toBe(0o600);
    expect(backup.manifest.contains.join(" ")).toContain("treat this artefact as a secret");
    expect(backup.manifest.excludes.join(" ")).not.toContain("NOT in this artefact");

    // A fresh volume, where the restore CLI's own env read already generated
    // a different pair. CANARY: count that file as data and this restore
    // demands --force on an empty root.
    const fresh = ctx.makeTempDir();
    createInstanceSecrets(fresh);
    const result = restoreBackup({ artefact: backup.dir, dataRoot: fresh });

    expect(result.instanceSecretsRestored).toBe(true);
    expect(readInstanceSecrets(fresh)).toEqual(generated);
    expect(result.text).toContain("came back from the artefact");
  });

  it("move the replaced root's own secrets aside with its database, so that copy still opens", () => {
    const source = fixture();
    const sourceSecrets = createInstanceSecrets(source.dataRoot);
    const backup = createBackup({ dataRoot: source.dataRoot, destination: source.out });
    source.db.close();
    const target = fixture();
    const targetSecrets = createInstanceSecrets(target.dataRoot);
    target.db.close();

    const result = restoreBackup({ artefact: backup.dir, dataRoot: target.dataRoot, force: true });

    expect(readInstanceSecrets(target.dataRoot)).toEqual(sourceSecrets);
    expect(existsSync(projectionPathIn(result.displacedTo!))).toBe(true);
    expect(readInstanceSecrets(result.displacedTo!)).toEqual(targetSecrets);
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
    // SAFETY: as above — a count(*) row always exists and carries `c`.
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
      "runtimes/users/u_arda/codex-home/auth.json",
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

describe("createBackup — re-derivable git trees stay out of the artefact", () => {
  it("skips each task's workspace checkout and each project's bare mirror", () => {
    // Both live UNDER projects/, which is copied recursively, so the artefact
    // carried every task's full source checkout and every project's bare
    // mirror: on the tree this was found on, 17M of git against 168K of the
    // markdown that is actually truth — copied while a live run could be
    // mid-write, and never named in the manifest's own excludes list.
    // Canary: drop the two `parts[...]` clauses from the cpSync filter and
    // both files below come back.
    const f = fixture();
    const proj = path.join(f.dataRoot, "projects", "viberr-core");
    const ws = path.join(proj, "tasks", "VIB-1", "workspace", "src");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "index.ts"), "export const x = 1;\n");
    const mirror = path.join(proj, ".repo-mirror", "acme__app.git", "objects");
    mkdirSync(mirror, { recursive: true });
    writeFileSync(path.join(mirror, "pack.idx"), "binary");

    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });
    const stored = path.join(backup.dir, "store", "projects", "viberr-core");

    expect(
      existsSync(path.join(stored, "tasks", "VIB-1", "workspace")),
      "a task checkout is re-cloneable, not backed up",
    ).toBe(false);
    expect(
      existsSync(path.join(stored, ".repo-mirror")),
      "a bare mirror is re-fetchable, not backed up",
    ).toBe(false);
    // The canonical file beside them still is.
    expect(existsSync(path.join(stored, "tasks", "VIB-1", "task.md"))).toBe(true);
    // And the manifest says so instead of leaving an operator to guess.
    expect(
      readManifest(backup.dir).excludes.some((line) => line.includes("workspace/")),
    ).toBe(true);
  });
});

describe("restore and the per-person agent logins under runtimes/", () => {
  /** An artefact taken WITH the runtime homes, plus a live root that already
   *  holds a different person's session. */
  function withRuntimes() {
    const f = fixture();
    const home = path.join(f.dataRoot, "runtimes", "users", "u_arda", "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "auth.json"), '{"token":"FROM-THE-BACKUP"}');
    const backup = createBackup({
      dataRoot: f.dataRoot,
      destination: f.out,
      includeRuntimes: true,
    });
    return { f, backup, home };
  }

  it("displaces the live logins instead of silently overwriting them, and says so", async () => {
    // `occupiedPaths` scanned only BACKED_UP_STORE_DIRS, so `runtimes/` was
    // never "occupied": the refusal never mentioned it, the displacement never
    // moved it aside, and the restore copied over every live auth.json with no
    // undo — while the report said "runtimes/ was left exactly as it was".
    // Canary: drop the OPTIONAL_STORE_DIRS filter from the occupiedPaths call
    // and the live token below is gone with no displaced copy.
    const { backup } = withRuntimes();

    // A DIFFERENT live root, already holding somebody's current session.
    const live = ctx.makeTempDir();
    const liveHome = path.join(live, "runtimes", "users", "u_arda", "codex-home");
    mkdirSync(liveHome, { recursive: true });
    writeFileSync(path.join(liveHome, "auth.json"), '{"token":"LIVE-RIGHT-NOW"}');

    const result = restoreBackup({
      artefact: backup.dir,
      dataRoot: live,
      force: true,
    });

    // The artefact's copy is what is live now…
    expect(readFileSync(path.join(liveHome, "auth.json"), "utf8")).toContain(
      "FROM-THE-BACKUP",
    );
    // …but the session it replaced was moved aside, not destroyed.
    expect(result.displacedTo).not.toBeNull();
    const displaced = path.join(
      result.displacedTo!,
      "runtimes",
      "users",
      "u_arda",
      "codex-home",
      "auth.json",
    );
    expect(existsSync(displaced), "the live login must be recoverable").toBe(true);
    expect(readFileSync(displaced, "utf8")).toContain("LIVE-RIGHT-NOW");
    // And the report says what happened, rather than the opposite.
    expect(result.text).toContain("runtimes/ WAS REPLACED");
  });

  it("a restore that carries no runtimes leaves the live logins alone", async () => {
    // The other half: displacing unconditionally would sign everyone out for
    // nothing on an ordinary restore.
    const f = fixture();
    const backup = createBackup({ dataRoot: f.dataRoot, destination: f.out });

    const live = ctx.makeTempDir();
    const liveHome = path.join(live, "runtimes", "users", "u_arda", "codex-home");
    mkdirSync(liveHome, { recursive: true });
    writeFileSync(path.join(liveHome, "auth.json"), '{"token":"UNTOUCHED"}');

    const result = restoreBackup({
      artefact: backup.dir,
      dataRoot: live,
      force: true,
    });

    expect(readFileSync(path.join(liveHome, "auth.json"), "utf8")).toContain(
      "UNTOUCHED",
    );
    expect(result.text).toContain("runtimes/ was left exactly as it was");
  });
});
