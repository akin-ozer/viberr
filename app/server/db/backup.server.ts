import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  INSTANCE_SECRETS_FILE,
  instanceSecretsPath,
} from "~/server/config/instance-secrets.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { TASK_CAPTURE_INPUT_DIR, TASK_CAPTURE_SCRATCH_DIR } from "~/server/runtimes/agent-isolation.server";
import { DATA_ROOT_LOCK_FILENAME } from "./data-root-lock.server";
import { openDatabase, openDatabaseReadOnly } from "./sqlite.server";

/**
 * Backup and restore for the data root (gap 14).
 *
 * `state/projection.sqlite` is not a cache. It is the ONLY home of users,
 * better-auth credentials and sessions, AES-sealed PATs and personal
 * agent-backend API keys (ruling 127), audit events and notifications — none of it rebuildable from the canonical markdown. The
 * product's own answer to FR33's 90-day audit hard-delete is "snapshot the
 * data root on a schedule", and to a bad hand-edit it is "restore the backup".
 * Both rested on a paragraph of prose: there was no backup command, and the
 * documented procedure conceded its own flaw — *"a hot backup of a running
 * container captures live -wal data by definition"*, with "stop the container
 * first" as the only correct-by-construction alternative. A small team either
 * does not back up, or takes an unsafe hot copy and discovers on restore that
 * committed rows were in the `-wal` it skipped.
 *
 * ## What makes this consistent WITHOUT stopping the app
 *
 * `VACUUM INTO` is SQLite's own online snapshot: it runs inside a read
 * transaction, so the artefact is the database as of one instant — WAL content
 * included — written to a single file with no sidecars. The source is opened
 * through `openDatabaseReadOnly`, so this is never the second connection to a
 * live root (ruling 158): while a writer lock is there at all the reader copies
 * `projection.sqlite` and its `-wal` next to the store and the VACUUM runs on
 * the copy; on a root with no lock it runs on the file itself.
 * Either way it takes no data-root lock (a backup that refused to run while the
 * app was up would defeat the point). Proven by test: a row committed but not
 * yet checkpointed is present in the artefact and absent from a raw `cp` of the
 * main file taken at the same moment, and under a live lock the artefact is
 * produced without the live file being opened at all.
 *
 * The markdown side is copied file by file. Every store write is atomic
 * (tmp + rename), so no individual file is ever captured half-written; the
 * tree as a whole is a short window rather than a single instant, which is the
 * honest thing to say about it and is why the manifest says it.
 *
 * ## Restore
 *
 * `restoreBackup` is a WRITER and its CLI holds the data-root lock. It also
 * removes any `-wal`/`-shm` left beside the old projection: those belong to
 * the database being replaced, and SQLite would try to replay them over the
 * restored file. That trap is not in the prose procedure.
 *
 * `restoreStoreFile` puts back ONE canonical markdown file. It touches no
 * SQLite at all, which is the difference between recovering a botched
 * hand-edit and rolling every user, session and audit row back with it
 * (gap 22).
 */

const BACKUP_FORMAT = "viberr-backup/1";
const MANIFEST_NAME = "MANIFEST.json";
const README_NAME = "README.txt";
const PROJECTION_NAME = "projection.sqlite";
const STORE_DIR = "store";

/** The file-native store directories a backup carries by default.
 *  C01-A3 (pass 32): `audit-exports/` joined the list — ruling 102's purge
 *  writes the expiring audit rows there as the DURABLE record, and `npm run
 *  backup` silently dropped it. A directory that does not exist yet (a root
 *  that never purged) is skipped, as every entry here is. */
/** Ruling 691: the two folders of a task a page render works in. */
const RENDER_WORK_DIRS: ReadonlySet<string> = new Set([TASK_CAPTURE_SCRATCH_DIR, TASK_CAPTURE_INPUT_DIR]);

const BACKED_UP_STORE_DIRS = [
  "projects",
  "agents",
  "kb",
  "skills",
  "audit-exports",
] as const;

/**
 * `runtimes/` holds LIVE agent credentials — since ruling 127 each person's own
 * (`users/<userId>/codex-home/accounts/<accountId>/auth.json`, one per account
 * since ruling 507) — and run transcripts. Opt in with `includeRuntimes` when you want them; the default
 * is out, and the manifest says so rather than leaving an operator to guess
 * whether their artefact contains a credential.
 */
const OPTIONAL_STORE_DIRS = ["runtimes"] as const;

/** Row counts recorded in the manifest — the tables no rescan can rebuild. */
const COUNTED_TABLES = [
  "users",
  "session",
  "account",
  "github_pats",
  "audit_events",
  "notifications",
  "org_mcp_servers",
] as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  hostname: string;
  /** The data root this artefact was taken from. */
  dataRoot: string;
  projection: {
    file: string;
    bytes: number;
    sha256: string;
    /** Row counts, read back OUT of the artefact. */
    rows: Record<string, number>;
  } | null;
  store: {
    dirs: string[];
    files: number;
    bytes: number;
  };
  /** True when the artefact carries the secrets the instance generated for
   *  itself (`instance-secrets.json`, ruling 504). Absent on older artefacts. */
  instanceSecrets?: boolean;
  /** Plain-English inventory — what a restore of this artefact brings back. */
  contains: string[];
  /** …and what it does not. */
  excludes: string[];
}

export interface BackupResult {
  /** Absolute path of the artefact directory. */
  dir: string;
  manifest: BackupManifest;
  /** Operator-facing summary, ready for stdout. */
  text: string;
}

/** What a copied tree contributes to the manifest's store totals. */
interface StoreFileTotals {
  files: number;
  bytes: number;
}

function walkFiles(dir: string): StoreFileTotals {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  }
  return { files, bytes };
}

function projectionPathIn(dataRoot: string): string {
  return path.join(dataRoot, "state", PROJECTION_NAME);
}

export interface CreateBackupOptions {
  dataRoot?: string;
  /** Directory the artefact is created INSIDE. */
  destination: string;
  includeRuntimes?: boolean;
}

/**
 * Take a consistent snapshot of the data root. Read-only with respect to the
 * live store: no writer lock, no mutation, safe while the app serves traffic.
 */
export function createBackup(options: CreateBackupOptions): BackupResult {
  const dataRoot = getDataRoot(options.dataRoot);
  // The artefact's name: sortable, and unambiguous about which instant.
  const dir = path.resolve(
    options.destination,
    `viberr-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  if (existsSync(dir)) {
    throw new Error(`refusing to overwrite an existing backup at ${dir}`);
  }
  if (dir.startsWith(`${dataRoot}${path.sep}`) || dir === dataRoot) {
    throw new Error(
      `refusing to write the backup inside the data root it is backing up (${dir})`,
    );
  }
  mkdirSync(dir, { recursive: true });

  // ---------------------------------------------------------- the database
  const source = projectionPathIn(dataRoot);
  let projection: BackupManifest["projection"] = null;
  let readFrom: ProjectionSource = "live";
  if (existsSync(source)) {
    const target = path.join(dir, PROJECTION_NAME);
    // A reader, never the second writer that B-FD1 exists to prevent, and
    // never the second CONNECTION to a live root either (ruling 158): with a
    // writer lock present this opens a copy taken next to the store, and the
    // VACUUM INTO runs on that copy. It runs in a read transaction, so the
    // artefact includes everything committed to the WAL at that instant.
    const reader = openDatabaseReadOnly(source);
    try {
      readFrom = reader.snapshot ? "snapshot" : "live";
      reader.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      reader.close();
    }
    projection = {
      file: PROJECTION_NAME,
      bytes: statSync(target).size,
      sha256: sha256Hex(readFileSync(target)),
      rows: countRows(target),
    };
  }

  // ------------------------------------------------------ the file store
  const dirs = [
    ...BACKED_UP_STORE_DIRS,
    ...(options.includeRuntimes ? OPTIONAL_STORE_DIRS : []),
  ];
  const storeRoot = path.join(dir, STORE_DIR);
  mkdirSync(storeRoot, { recursive: true });
  const copied: string[] = [];
  for (const name of dirs) {
    const from = path.join(dataRoot, name);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(storeRoot, name), {
      recursive: true,
      filter: (src) => {
        // `*.tmp` is a half-written atomic write in flight; it is never content.
        if (src.endsWith(".tmp")) return false;
        if (name !== "projects") return true;
        // Neither a task's git CHECKOUT nor a project's bare MIRROR is
        // canonical state: both are re-derivable from the remote, both can be
        // mid-write by a live agent run (so the copy is torn), and together
        // they dwarf the files that are truth — on this tree, 17M of workspace
        // against 168K of project/task markdown. Copying them also silently
        // put a task's whole source checkout inside an artefact whose manifest
        // never mentioned it.
        const parts = path.relative(from, src).split(path.sep);
        if (parts[1] === ".repo-mirror") return false;
        if (parts[1] === "tasks" && parts[3] === "workspace") return false;
        // Ruling 691: nor is what a page render works in. The scratch holds a
        // browser profile only its uid can enter, so a copy of it stops the
        // whole backup, and the input folder is a copy of a kept delivery.
        if (parts[1] === "tasks" && parts[3] !== undefined && RENDER_WORK_DIRS.has(parts[3])) return false;
        return true;
      },
    });
    copied.push(name);
  }
  const store = { dirs: copied, ...walkFiles(storeRoot) };

  // ------------------------------------------------- the generated secrets
  // Ruling 504: an instance whose environment sets no secrets generated its
  // own into state/. They sealed every secret in the database above, so they
  // travel with it, or a restore could never open those credentials again.
  const secrets = instanceSecretsPath(dataRoot);
  const instanceSecrets = existsSync(secrets);
  if (instanceSecrets) {
    const target = path.join(dir, INSTANCE_SECRETS_FILE);
    copyFileSync(secrets, target);
    chmodSync(target, 0o600);
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    dataRoot,
    projection,
    store,
    instanceSecrets,
    contains: contains(projection !== null ? readFrom : null, copied, instanceSecrets),
    excludes: excludes(options.includeRuntimes ?? false, instanceSecrets),
  };
  writeFileAtomic(
    path.join(dir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileAtomic(path.join(dir, README_NAME), readmeText(manifest));
  logger.info("data-root backup written", {
    dir,
    files: store.files,
    projectionBytes: projection?.bytes ?? 0,
  });
  return { dir, manifest, text: renderBackup(dir, manifest) };
}

/** Row counts by table name, as the manifest records them. */
interface TableRowCounts {
  [table: string]: number;
}

function countRows(dbPath: string): TableRowCounts {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const present = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => String(row.name)),
    );
    const rows: TableRowCounts = {};
    for (const table of COUNTED_TABLES) {
      if (!present.has(table)) continue;
      // `count(*)` over a table that exists always yields exactly one integer row.
      const counted = db.prepare(`SELECT count(*) AS c FROM ${table}`).get()!;
      rows[table] = Number(counted.c);
    }
    return rows;
  } finally {
    db.close();
  }
}

/** How the projection was read: the live file on a root carrying no writer lock,
 *  or a copy taken beside the store because one was there (ruling 158). */
type ProjectionSource = "live" | "snapshot";

function projectionProvenance(source: ProjectionSource): string {
  return source === "snapshot"
    ? "read from a copy of the file and its WAL taken while state/writer.lock named a holder, so the live database was never opened"
    : "read from the file itself; the root carried no writer lock";
}

function contains(
  projection: ProjectionSource | null,
  dirs: string[],
  instanceSecrets: boolean,
): string[] {
  const list = [
    ...(projection !== null
      ? [
          `state/projection.sqlite: users, better-auth credentials and sessions, AES-sealed GitHub PATs, MCP credentials and personal agent-backend API keys (ruling 127), audit events, notifications, and every projection (a consistent point-in-time copy, WAL included; ${projectionProvenance(projection)})`,
        ]
      : []),
    ...(instanceSecrets
      ? [
          "state/instance-secrets.json: the VIBERR_SESSION_SECRET and VIBERR_SECRET_ENCRYPTION_KEY this instance generated for itself (ruling 504). They open every sealed secret in the database, so treat this artefact as a secret. A value the environment sets overrides the file and is not in here.",
        ]
      : []),
    ...dirs.map((dir) => `${dir}/: the canonical files, copied verbatim`),
  ];
  return list;
}

function excludes(includeRuntimes: boolean, instanceSecrets: boolean): string[] {
  return [
    ...(includeRuntimes
      ? []
      : [
          "runtimes/: each person's agent CLI logins (every users/<id>/codex-home/accounts/<account>/auth.json is a LIVE credential) and run transcripts. Everyone re-authenticates after a restore, or pass --include-runtimes to carry them (and then treat the artefact as a secret).",
        ]),
    "state/writer.lock: the running process's lock; restoring one would refuse the next boot.",
    ...(instanceSecrets
      ? []
      : [
          "The encryption key itself. VIBERR_SECRET_ENCRYPTION_KEY lives in the environment, NOT in this artefact: without it every sealed secret in the database is unreadable (GitHub PATs, MCP credentials, sign-in provider secrets, the S3 audit-export key, and each person's agent-backend API keys). Back the key up separately.",
        ]),
    "*.tmp: atomic writes in flight, never content.",
    "projects/*/tasks/*/workspace/ and projects/*/.repo-mirror/: each task's git checkout and each project's bare mirror. Re-derivable from the remote (the next run re-clones and re-fetches), and a live run may be mid-write, so a copy would be torn as well as large.",
    "projects/*/tasks/*/.captures/ and projects/*/tasks/*/.capture-input/: what a page render works in (a browser's profile, a copy of a kept delivery). The pictures it keeps are among the task's attachments and in its kept deliveries, which are backed up.",
  ];
}

function readmeText(manifest: BackupManifest): string {
  return [
    `Viberr data-root backup (${manifest.format})`,
    `Taken ${manifest.createdAt} from ${manifest.dataRoot} on ${manifest.hostname}`,
    "",
    "CONTAINS",
    ...manifest.contains.map((line) => `  - ${line}`),
    "",
    "DOES NOT CONTAIN",
    ...manifest.excludes.map((line) => `  - ${line}`),
    "",
    "RESTORE",
    "  Whole data root (stop the app first; the restore takes the writer lock):",
    "    npm run restore -- --from <this directory>",
    "  One canonical file, without rolling back users/sessions/audit:",
    "    npm run restore -- --from <this directory> --file projects/<slug>/tasks/<KEY>/task.md",
    "",
  ].join("\n");
}

function renderBackup(dir: string, manifest: BackupManifest): string {
  const lines = [
    `viberr backup written to ${dir}`,
    "",
    "CONTAINS",
    ...manifest.contains.map((line) => `  - ${line}`),
  ];
  if (manifest.projection) {
    lines.push(
      "",
      `  projection.sqlite: ${manifest.projection.bytes} bytes, sha256 ${manifest.projection.sha256.slice(0, 16)}…`,
      ...Object.entries(manifest.projection.rows).map(
        ([table, count]) => `    ${table}: ${count} rows`,
      ),
    );
  }
  lines.push(
    "",
    `  ${manifest.store.files} store files (${manifest.store.bytes} bytes) from ${manifest.store.dirs.join(", ") || "nothing"}`,
    "",
    "DOES NOT CONTAIN",
    ...manifest.excludes.map((line) => `  - ${line}`),
    "",
    `Restore with: npm run restore -- --from ${dir}`,
  );
  return lines.join("\n");
}

// ----------------------------------------------------------------- restore

/**
 * The artefact's own claim about which format it is, read on its own so a
 * foreign or future artefact can be refused BY NAME before the shape is judged.
 */
const manifestFormatSchema = z.object({ format: z.unknown() });

/**
 * The manifest as it comes back off disk. `.loose()` keeps whatever a newer
 * build wrote alongside these fields; the fields themselves are strict, because
 * `restoreBackup` drives a destructive replace off `store.dirs` and
 * `projection.file` and a half-populated manifest must not reach it.
 */
const backupManifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    createdAt: z.string(),
    hostname: z.string(),
    dataRoot: z.string(),
    projection: z
      .object({
        file: z.string(),
        bytes: z.number(),
        sha256: z.string(),
        rows: z.record(z.string(), z.number()),
      })
      .loose()
      .nullable(),
    store: z
      .object({
        dirs: z.array(z.string()),
        files: z.number(),
        bytes: z.number(),
      })
      .loose(),
    instanceSecrets: z.boolean().optional(),
    contains: z.array(z.string()),
    excludes: z.array(z.string()),
  })
  .loose();

function readManifest(artefact: string): BackupManifest {
  const file = path.join(artefact, MANIFEST_NAME);
  if (!existsSync(file)) {
    throw new Error(
      `${artefact} is not a viberr backup (no ${MANIFEST_NAME}). Point --from at the artefact directory itself.`,
    );
  }
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const declared = manifestFormatSchema.safeParse(raw);
  const format = declared.success ? declared.data.format : undefined;
  if (format !== BACKUP_FORMAT) {
    throw new Error(
      `unsupported backup format "${String(format)}" (this build reads ${BACKUP_FORMAT})`,
    );
  }
  return backupManifestSchema.parse(raw);
}

export interface RestoreResult {
  dataRoot: string;
  manifest: BackupManifest;
  /** Directories replaced in the data root. */
  restoredDirs: string[];
  projectionRestored: boolean;
  /** The artefact's generated secrets were put back (ruling 504). */
  instanceSecretsRestored: boolean;
  /** Stale `-wal` / `-shm` removed beside the replaced projection. */
  removedSidecars: string[];
  /** Where the replaced data root was moved, when anything was displaced. */
  displacedTo: string | null;
  text: string;
}

export interface RestoreBackupOptions {
  artefact: string;
  dataRoot?: string;
  /**
   * Required when the target data root already holds a projection or store
   * files — a restore replaces them, and that must be a decision.
   */
  force?: boolean;
}

/**
 * Restore a whole data root from an artefact. WRITES — the caller must hold
 * the data-root writer lock (`npm run restore` takes it, so restoring into a
 * live instance is refused rather than silently racing it).
 */
export function restoreBackup(options: RestoreBackupOptions): RestoreResult {
  const manifest = readManifest(options.artefact);
  const dataRoot = getDataRoot(options.dataRoot);
  // Only the optional dirs this artefact will actually overwrite (see below):
  // a restore that carries no `runtimes/` must not displace the live one, or
  // it would sign every person out of their agent backends for nothing.
  const occupied = occupiedPaths(
    dataRoot,
    OPTIONAL_STORE_DIRS.filter((d) => manifest.store.dirs.includes(d)),
  );
  if (occupied.length > 0 && !options.force) {
    throw new Error(
      `${dataRoot} already holds data (${occupied.join(", ")}). A restore REPLACES it. ` +
        `Re-run with --force once you are sure; the replaced copy is moved aside, not deleted.`,
    );
  }

  // Displace rather than delete: a restore onto the wrong root must be undoable.
  const removedSidecars: string[] = [];
  let displacedTo: string | null = null;
  if (occupied.length > 0) {
    displacedTo = `${dataRoot}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const name of occupied) {
      const to = path.join(displacedTo, name);
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(dataRoot, name), to);
      if (/projection\.sqlite-(wal|shm)$/.test(name)) {
        removedSidecars.push(path.basename(name));
      }
    }
  }

  const restoredDirs: string[] = [];
  for (const name of manifest.store.dirs) {
    const from = path.join(options.artefact, STORE_DIR, name);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(dataRoot, name), { recursive: true });
    restoredDirs.push(name);
  }

  let projectionRestored = false;
  if (manifest.projection) {
    const target = projectionPathIn(dataRoot);
    mkdirSync(path.dirname(target), { recursive: true });
    // A `-wal`/`-shm` left from the database we just replaced belongs to a
    // DIFFERENT file. SQLite would try to replay it over the restored one.
    // Displacement above normally carries them off; this is the backstop.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${target}${suffix}`;
      if (existsSync(sidecar)) {
        rmSync(sidecar, { force: true });
        removedSidecars.push(path.basename(sidecar));
      }
    }
    cpSync(path.join(options.artefact, manifest.projection.file), target);
    projectionRestored = true;

    // Record the restore INTO the restored database, then leave it checkpointed
    // and closed so the data root is quiet again.
    const db = openDatabase(target);
    try {
      recordAudit(db, {
        action: "store.restored",
        actor: SYSTEM_ACTOR,
        details: {
          artefact: options.artefact,
          takenAt: manifest.createdAt,
          dirs: restoredDirs,
        },
      });
      db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
    } finally {
      db.close();
    }
  }

  // Ruling 504: generated secrets come back with the database they sealed.
  // The root's own go aside with its displaced database, so that copy still
  // opens; on a root with no database they sealed nothing, and are replaced.
  let instanceSecretsRestored = false;
  if (manifest.instanceSecrets) {
    const target = instanceSecretsPath(dataRoot);
    if (displacedTo && existsSync(target)) {
      const aside = path.join(displacedTo, "state", INSTANCE_SECRETS_FILE);
      mkdirSync(path.dirname(aside), { recursive: true });
      renameSync(target, aside);
    }
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(path.join(options.artefact, INSTANCE_SECRETS_FILE), target);
    chmodSync(target, 0o600);
    instanceSecretsRestored = true;
  }

  logger.info("data root restored from backup", {
    dataRoot,
    artefact: options.artefact,
    dirs: restoredDirs,
  });
  const result: Omit<RestoreResult, "text"> = {
    dataRoot,
    manifest,
    restoredDirs,
    projectionRestored,
    instanceSecretsRestored,
    removedSidecars,
    displacedTo,
  };
  return { ...result, text: renderRestore(result) };
}

/**
 * What a restore would replace, as data-root-relative paths.
 *
 * `state/` is enumerated ENTRY BY ENTRY so `state/writer.lock` can be left
 * exactly where it is: this process is holding it, and moving it aside would
 * drop the single-writer guard mid-restore (and trip the F18-5 ownership guard
 * of any process still watching it). `runtimes/` is never listed — a restore
 * must not wipe the agent CLI logins it deliberately does not carry. Nor is
 * `state/instance-secrets.json` (ruling 504): the restore CLI's own env read
 * generates one on a fresh root, and it moves with the database it sealed
 * rather than making a root "occupied".
 */
/** `alsoDirs` carries the OPTIONAL dirs this particular restore is going to
 *  write. `runtimes/` is not in the default list on purpose: a restore from an
 *  artefact that carries no runtimes must leave everyone's live agent logins
 *  exactly where they are. But when the artefact DOES carry them, the restore
 *  copies straight over the live ones — so they have to be counted as occupied
 *  here, or the "already holds data" refusal never mentions them and the
 *  displacement never moves them aside. */
function occupiedPaths(
  dataRoot: string,
  alsoDirs: readonly string[] = [],
): string[] {
  if (!existsSync(dataRoot)) return [];
  const names: string[] = [];
  for (const name of [...BACKED_UP_STORE_DIRS, ...alsoDirs]) {
    const full = path.join(dataRoot, name);
    if (!existsSync(full)) continue;
    if (readdirSync(full).length > 0) names.push(name);
  }
  const stateDir = path.join(dataRoot, "state");
  if (existsSync(stateDir)) {
    for (const entry of readdirSync(stateDir)) {
      if (entry === DATA_ROOT_LOCK_FILENAME || entry === INSTANCE_SECRETS_FILE) continue;
      names.push(path.join("state", entry));
    }
  }
  return names;
}

function renderRestore(result: Omit<RestoreResult, "text">): string {
  const lines = [
    `viberr restore complete: ${result.dataRoot} now holds the backup taken ${result.manifest.createdAt}`,
    `  projection.sqlite ${result.projectionRestored ? "restored" : "NOT in this artefact"}`,
    `  store directories: ${result.restoredDirs.join(", ") || "none"}`,
  ];
  if (result.removedSidecars.length > 0) {
    lines.push(
      `  removed stale ${result.removedSidecars.join(" and ")}; they belonged to the replaced database`,
    );
  }
  if (result.displacedTo) {
    lines.push(`  the replaced data was moved to ${result.displacedTo} (not deleted)`);
  }
  // This line used to be unconditional, and was simply false for an artefact
  // taken with --include-runtimes: that restore copies straight over every
  // person's live agent CLI logins. Say which of the two actually happened.
  lines.push(
    result.restoredDirs.includes("runtimes")
      ? "  runtimes/ WAS REPLACED from the artefact: everyone's agent CLI logins are now the ones this backup was taken with, and each person may need to reconnect on Profile → Agent accounts"
      : "  runtimes/ was left exactly as it was: this restore did not touch anyone's agent CLI logins",
    "",
    result.instanceSecretsRestored
      ? "state/instance-secrets.json came back from the artefact: the secrets this instance generated for itself, which open the restored credentials (ruling 504). A value the environment sets still overrides them."
      : "VIBERR_SECRET_ENCRYPTION_KEY is not part of the artefact: without the key this backup was taken under, every sealed secret is unreadable (GitHub PATs, MCP credentials, sign-in provider secrets, the S3 audit-export key, and each person's agent-backend API keys).",
    "Start the app; boot reconciles the projection against the restored files.",
  );
  return lines.join("\n");
}

// ------------------------------------------------------- single-file restore

/** Store directories a single-file restore may write into. `state/` is the
 *  database (whole-root restore only) and `runtimes/` is live credentials. */
const FILE_RESTORE_ROOTS = BACKED_UP_STORE_DIRS;

export interface RestoreFileResult {
  /** Store-relative path that was restored. */
  path: string;
  absPath: string;
  /** Where the file being replaced was moved, or null when there was none. */
  displacedTo: string | null;
  bytes: number;
  text: string;
}

/**
 * Put back ONE canonical file from an artefact (gap 22). Writes markdown and
 * nothing else — no SQLite, so recovering a botched `task.md` does not roll
 * users, sessions, PATs, audit and notifications back with it. The file the
 * restore displaces is moved aside, never deleted: a human's bytes are theirs.
 */
export function restoreStoreFile(options: {
  artefact: string;
  dataRoot?: string;
  relPath: string;
}): RestoreFileResult {
  readManifest(options.artefact); // format check
  const dataRoot = getDataRoot(options.dataRoot);
  const rel = normalizeStoreRelPath(options.relPath);
  const from = path.join(options.artefact, STORE_DIR, rel);
  if (!existsSync(from)) {
    throw new Error(`${rel} is not in this backup (looked for ${from}).`);
  }
  const target = path.join(dataRoot, rel);

  let displacedTo: string | null = null;
  if (existsSync(target)) {
    // `.broken-<ts>` deliberately does NOT end in `.md`: the watcher and the
    // rebuilder key off exact store paths, so the copy sits inert beside it.
    displacedTo = `${target}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(target, displacedTo);
  }
  const content = readFileSync(from, "utf8");
  writeFileAtomic(target, content);

  const text = [
    `viberr restored ${rel} from ${options.artefact}`,
    ...(displacedTo
      ? [`  the file it replaced was moved to ${displacedTo} (not deleted)`]
      : []),
    "  the database was NOT touched: users, sessions, PATs, audit and notifications are unchanged",
    "  the watcher re-projects it within ~1s while the app runs; otherwise `npm run rescan`",
  ].join("\n");
  // Ruling 466: a size in bytes is a UTF-8 byte count, never a string length.
  return { path: rel, absPath: target, displacedTo, bytes: Buffer.byteLength(content, "utf8"), text };
}

function normalizeStoreRelPath(relPath: string): string {
  const rel = path.normalize(relPath).replace(/^[/\\]+/, "");
  if (rel.split(/[/\\]/).includes("..")) {
    throw new Error(`refusing a path that escapes the store: ${relPath}`);
  }
  const root = rel.split(/[/\\]/)[0] ?? "";
  if (!FILE_RESTORE_ROOTS.some((allowed) => allowed === root)) {
    throw new Error(
      `single-file restore only writes into ${FILE_RESTORE_ROOTS.join("/, ")}/; ` +
        `got "${relPath}". The database (state/) is a whole-root restore: drop --file.`,
    );
  }
  return rel;
}
