import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Per-person runtime homes (ruling 127).
 *
 * Every agent run bills ONE person, so every vendor binary a run spawns reads
 * its credential and writes its transcripts inside THAT person's own home:
 *
 *   <dataRoot>/runtimes/users/<userId>/claude-home   → the child's CLAUDE_CONFIG_DIR
 *                                                      (transcripts under projects/)
 *   <dataRoot>/runtimes/users/<userId>/codex-home    → the child's CODEX_HOME
 *                                                      (sessions under sessions/)
 *
 * This is the ONE resolver for those paths. There must be one: the run service
 * tells the SDK where to write, `session-export` reads the transcript back, the
 * retention sweep prunes it and the sign-in driver writes the credential into
 * it. When two resolvers disagreed (the shared-home era's
 * `claude-config`/`codex-config` pair) every real run's transcript landed
 * somewhere the exporter never looked.
 *
 * The homes replace the deployment-wide `runtimes/claude-home` /
 * `runtimes/codex-home` and the host `~/.codex` mount: a credential in a shared
 * home is a credential every person's runs bill to whoever owns it, which is
 * exactly what ruling 127 forbids.
 *
 * The credential FILES here are vendor-owned — Viberr creates the directory and
 * never reads, copies or parses what the binary writes into it (Anthropic's
 * Claude Code legal page: a hosting platform may not collect or store
 * Claude.ai credentials). The only thing this module asserts about them is
 * whether they EXIST, which is what per-person availability is derived from.
 */

/** Re-exported so a consumer of the per-user homes needs one import, not two.
 *  The vocabulary itself stays owned by the runtime registry. */
export type { RealBackend };

/** The directory under `<dataRoot>/runtimes` that holds the per-person homes. */
export const USER_RUNTIMES_DIR = "users";

/** A user id — and, since ruling 181, a run id — may become a PATH SEGMENT
 *  here, so each is validated as one. Viberr mints ids as `u_<base64url>` /
 *  `run_<base64url>` (`newId`), which this matches; anything else — a
 *  hand-edited row, a traversal attempt, an empty string — is refused rather
 *  than resolved. */
const PATH_SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertPathSafeUserId(userId: string): string {
  if (!PATH_SAFE_SEGMENT_RE.test(userId)) {
    throw AppError.validation(
      "That user id cannot be used for a runtime home.",
      { userIdLength: userId.length },
    );
  }
  return userId;
}

function assertPathSafeRunId(runId: string): string {
  if (!PATH_SAFE_SEGMENT_RE.test(runId)) {
    throw AppError.validation(
      "That run id cannot be used for a runtime home.",
      { runIdLength: runId.length },
    );
  }
  return runId;
}

/** `<dataRoot>/runtimes/users/<userId>` — one person's runtime root. */
export function userRuntimeRoot(userId: string, dataRoot?: string): string {
  return path.join(
    getDataRoot(dataRoot),
    "runtimes",
    USER_RUNTIMES_DIR,
    assertPathSafeUserId(userId),
  );
}

/** The home the spawned vendor binary gets for one person and one backend. */
export function userBackendHome(
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): string {
  return path.join(
    userRuntimeRoot(userId, dataRoot),
    backend === "claude" ? "claude-home" : "codex-home",
  );
}

/**
 * Materialize the home (`mkdir -p`, mode 0o700) and return it.
 *
 * 0o700 because a login credential file the vendor binary writes lands in here:
 * on a multi-user host, one person's runs must not be able to read another's
 * sign-in. `recursive` applies the mode to every directory this call creates;
 * the process umask can only narrow it further, never widen it.
 */
export function ensureUserBackendHome(
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): string {
  const home = userBackendHome(userId, backend, dataRoot);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Where `claude auth login` keeps a file-based login (macOS uses the login
 *  Keychain instead, which is why availability has a `presence` verdict). */
export function claudeLoginCredentialPath(home: string): string {
  return path.join(home, ".credentials.json");
}

/** Where `codex login` writes its credential. */
export function codexLoginCredentialPath(home: string): string {
  return path.join(home, "auth.json");
}

/**
 * Every per-person runtime root that exists on disk, for the sweeps that must
 * visit all of them (transcript retention). Returns `[]` when nothing has been
 * created yet, and skips any entry whose name is not a path-safe user id — a
 * directory nothing in this module could have produced is not one a sweep may
 * delete inside.
 */
export function listUserRuntimeRoots(
  dataRoot?: string,
): { userId: string; root: string }[] {
  const base = path.join(getDataRoot(dataRoot), "runtimes", USER_RUNTIMES_DIR);
  if (!existsSync(base)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && PATH_SAFE_SEGMENT_RE.test(entry.name))
    .map((entry) => ({ userId: entry.name, root: path.join(base, entry.name) }));
}

// ------------------------------------------------------ per-run Codex homes

/**
 * Ruling 181: every Codex run gets a PRIVATE `CODEX_HOME`, forked from the
 * person's shared home.
 *
 * F36-3 (pass 36): the Codex CLI extracts its exec helpers
 * (`codex-linux-sandbox`, `codex-execve-wrapper`, `apply_patch`) into ONE
 * directory per home, `$CODEX_HOME/tmp/arg0/codex-arg0XXXXXX/`, and every new
 * process of the same home replaces it. Ruling 127 gave every run of one
 * person the same `codex-home`, so a reviewer, the operator and a developer
 * running at once deleted each other's sandbox helper mid-run ("launch
 * rejected … No such file or directory"). The binary offers no override for
 * that path; its env surface is `CODEX_HOME` and `CODEX_SQLITE_HOME`.
 *
 * So a run is handed `<codex-home>/runs/<runId>/` as its `CODEX_HOME`:
 *
 *  - `auth.json` and `config.toml` are COPIED in (when present). A copy, not a
 *    link: the CLI rewrites `auth.json` on a token refresh, and two runs
 *    writing one shared file through a link is the race this must not have.
 *    The refreshed file is carried back at the end, under a per-person lock,
 *    only when its bytes changed — and only while the shared file still
 *    exists, so a run cannot resurrect a sign-in the person removed meanwhile.
 *  - `sessions/`, `skills/` and `memories/` are SYMLINKS to the shared home's
 *    directories (created first so the CLI writes through them), which is
 *    what keeps rollouts where `probeSessionContinuity` / the exporter look
 *    and where the retention sweep prunes.
 *  - `CODEX_SQLITE_HOME` is set to the SHARED home by the adapter, so the
 *    CLI's thread/state database stays the person's across runs.
 *  - `tmp/` is whatever the CLI creates inside the run home: private by
 *    construction, gone with the run.
 *
 * The run directory is deleted when the run settles — finished, failed,
 * interrupted or crashed — by the one settle path in the Codex adapter.
 * Everything here is synchronous and throws only from `prepare`: a run whose
 * home cannot be built must not start, while a settle must never throw.
 */
export const CODEX_RUN_HOMES_DIR = "runs";

/** The state directories a run shares with the person's home, by link. */
export const CODEX_HOME_SHARED_DIRS = ["sessions", "skills", "memories"] as const;

/** The vendor-owned files a run gets a private copy of. */
const CODEX_HOME_SEEDED_FILES = ["auth.json", "config.toml"] as const;

const AUTH_WRITE_BACK_LOCK = ".auth.json.lock";
/** How long a settle waits for another run's write-back before breaking the
 *  lock: the write itself is one small file, so a holder older than this is a
 *  process that died holding it. */
const AUTH_LOCK_WAIT_MS = 3_000;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_POLL_MS = 25;

export interface CodexRunHome {
  /** The run's private `CODEX_HOME`. */
  dir: string;
  /** The person's shared codex-home it was forked from. */
  sharedHome: string;
  runId: string;
}

/** `<sharedHome>/runs/<runId>` — where one run's private home lives. */
export function codexRunHomeDir(sharedHome: string, runId: string): string {
  return path.join(sharedHome, CODEX_RUN_HOMES_DIR, assertPathSafeRunId(runId));
}

/** Build the run home (see the module note above) and return it. */
export function prepareCodexRunHome(sharedHome: string, runId: string): CodexRunHome {
  const dir = codexRunHomeDir(sharedHome, runId);
  // Whatever a crashed predecessor of this id left: start clean, never merge.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of CODEX_HOME_SEEDED_FILES) {
    const source = path.join(sharedHome, name);
    if (!existsSync(source)) continue;
    const target = path.join(dir, name);
    copyFileSync(source, target);
    // A credential copy is private to the server user whatever the source
    // mode was; the config keeps its own.
    if (name === "auth.json") chmodSync(target, 0o600);
  }
  for (const name of CODEX_HOME_SHARED_DIRS) {
    mkdirSync(path.join(sharedHome, name), { recursive: true, mode: 0o700 });
    // Relative, so a restored or moved data root still resolves.
    symlinkSync(path.join("..", "..", name), path.join(dir, name), "dir");
  }
  return { dir, sharedHome, runId };
}

/**
 * The settle half: carry a refreshed `auth.json` back to the shared home when
 * its bytes changed (under the per-person lock), then remove the run home.
 * Never throws — a settle that cannot clean up is logged, not propagated.
 */
export function finishCodexRunHome(home: CodexRunHome): void {
  try {
    writeBackAuth(home);
  } catch (error) {
    logger.warn("codex run home: the refreshed sign-in could not be written back", {
      runId: home.runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  // Ruling 199: BEFORE the directory goes, re-point the CLI's own index at the
  // path the transcript actually occupies. The rollout is written THROUGH the
  // `sessions` symlink, so the bytes land in the shared home and survive — but
  // the CLI recorded the path it saw, `…/runs/<runId>/sessions/…`, and this
  // removal invalidates it. See `repointRunRollouts`.
  repointRunRollouts(home);
  try {
    // `rm` unlinks the links; it never descends into the shared directories.
    rmSync(home.dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn("codex run home could not be removed", {
      runId: home.runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Ruling 199: the run home's removal leaves the CLI's thread index pointing at
 * a path that no longer exists, so every later `thread/resume` fails with
 * "no rollout found for thread id" — and Viberr reported that as "the agent's
 * stored Codex session no longer exists" while the transcript sat in the shared
 * `sessions/` directory, one path segment away.
 *
 * Measured live before the fix: **137 of 137** threads on the instance had a
 * `rollout_path` under a per-run home, **135** of those paths were gone, and
 * **135 of 135** of their files were present at the shared path. Every Codex
 * conversation the instance had ever recorded was unresumable, and all three of
 * the pass's run errors were resume attempts.
 *
 * The repair is one UPDATE against the CLI's own state database, which
 * `CODEX_SQLITE_HOME` already pins to the SHARED home so it outlives the run.
 * Everything here is fail-soft and best-effort by construction: the database is
 * a vendor artefact whose name carries a schema version (`state_5.sqlite`), so
 * a shape this does not recognise is skipped with a log line rather than
 * guessed at, and a settle must never throw.
 */
function repointRunRollouts(home: CodexRunHome): void {
  const marker = `${path.sep}${CODEX_RUN_HOMES_DIR}${path.sep}${home.runId}${path.sep}`;
  for (const dbFile of codexStateDatabases(home.sharedHome)) {
    try {
      const db = new DatabaseSync(dbFile);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        // The vendor's schema is parsed, never asserted: an unrecognised shape
        // is skipped whole rather than half-read.
        const columns = columnNamesSchema.safeParse(db.prepare(`PRAGMA table_info(threads)`).all());
        if (!columns.success || !columns.data.some((c) => c.name === "rollout_path")) continue;
        const parsed = threadRowsSchema.safeParse(
          db.prepare(`SELECT id, rollout_path FROM threads WHERE rollout_path LIKE ?`).all(`%${marker}%`),
        );
        if (!parsed.success) continue;
        const update = db.prepare(`UPDATE threads SET rollout_path = ? WHERE id = ?`);
        let repointed = 0;
        for (const row of parsed.data) {
          const shared = row.rollout_path.replace(marker, path.sep);
          // Only ever point at a file that is really there: a rollout the
          // symlink did not carry over stays recorded where it was, because a
          // wrong path is worse than a stale one.
          if (!existsSync(shared)) continue;
          update.run(shared, row.id);
          repointed += 1;
        }
        if (repointed > 0) {
          logger.info("codex rollout paths re-pointed at the shared home", {
            runId: home.runId,
            threads: repointed,
          });
        }
      } finally {
        db.close();
      }
    } catch (error) {
      logger.warn("codex rollout paths could not be re-pointed", {
        runId: home.runId,
        dbFile,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

/**
 * Ruling 199, the retroactive half: every thread recorded BEFORE the settle
 * learned to re-point is still aimed at a run home that is long gone. Live,
 * that was 135 of 137 threads — every Codex conversation the instance had —
 * and each one's transcript was sitting at the shared path all along. One
 * boot-time pass restores them; it is idempotent, it only ever moves a path to
 * a file that exists, and like the settle it never throws.
 *
 * Returns how many threads it re-pointed, for the boot line.
 */
export function repairCodexRolloutPaths(dataRoot?: string): number {
  const runMarker = new RegExp(
    `${path.sep}${CODEX_RUN_HOMES_DIR}${path.sep}[^${path.sep === "\\" ? "\\\\" : path.sep}]+${path.sep}`,
  );
  let repaired = 0;
  for (const { userId } of listUserRuntimeRoots(dataRoot)) {
    const sharedHome = userBackendHome(userId, "codex", dataRoot);
    if (!existsSync(sharedHome)) continue;
    for (const dbFile of codexStateDatabases(sharedHome)) {
      try {
        const db = new DatabaseSync(dbFile);
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          const columns = columnNamesSchema.safeParse(
            db.prepare(`PRAGMA table_info(threads)`).all(),
          );
          if (!columns.success || !columns.data.some((c) => c.name === "rollout_path")) continue;
          const parsed = threadRowsSchema.safeParse(
            db.prepare(`SELECT id, rollout_path FROM threads`).all(),
          );
          if (!parsed.success) continue;
          const update = db.prepare(`UPDATE threads SET rollout_path = ? WHERE id = ?`);
          for (const row of parsed.data) {
            if (!runMarker.test(row.rollout_path)) continue;
            // A run still in flight owns its path: leave it until its settle.
            if (existsSync(row.rollout_path)) continue;
            const shared = row.rollout_path.replace(runMarker, path.sep);
            if (!existsSync(shared)) continue;
            update.run(shared, row.id);
            repaired += 1;
          }
        } finally {
          db.close();
        }
      } catch (error) {
        logger.warn("codex rollout paths could not be repaired at boot", {
          dbFile,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }
  return repaired;
}

/** The two vendor shapes ruling 199 reads, parsed at the boundary. A row that
 *  does not match is not this schema's business — the whole read is skipped. */
const columnNamesSchema = z.array(z.object({ name: z.string() }).loose());
const threadRowsSchema = z.array(
  z.object({ id: z.string(), rollout_path: z.string() }).loose(),
);

/** The CLI's state databases in one person's home. The file name carries a
 *  schema version the vendor bumps (`state_5.sqlite`), so this matches the
 *  family rather than pinning one. */
function codexStateDatabases(sharedHome: string): string[] {
  try {
    return readdirSync(sharedHome)
      .filter((name) => /^state(_\d+)?\.sqlite$/.test(name))
      .map((name) => path.join(sharedHome, name));
  } catch {
    return [];
  }
}

function writeBackAuth(home: CodexRunHome): void {
  const refreshed = readIfPresent(path.join(home.dir, "auth.json"));
  if (!refreshed) return;
  const sharedAuth = path.join(home.sharedHome, "auth.json");
  withAuthLock(home.sharedHome, home.runId, () => {
    const current = readIfPresent(sharedAuth);
    // The person disconnected while the run was live: the shared file is gone
    // on purpose, and a token the run refreshed must not bring it back.
    if (!current) return;
    if (current.equals(refreshed)) return;
    const staging = `${sharedAuth}.${home.runId}.tmp`;
    writeFileSync(staging, refreshed, { mode: 0o600 });
    renameSync(staging, sharedAuth);
  });
}

function readIfPresent(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** What `openSync(..., "wx")` throws when the lock is held: the one field the
 *  retry reads, decoded rather than asserted. */
const fsErrorSchema = z.object({ code: z.string().optional() }).catch({});

/** A lockfile with retry: `O_EXCL` create, poll while held, break a holder
 *  that is older than a settle could possibly be. Serializes the write-back
 *  between concurrent runs of one person; last writer wins by design. */
function withAuthLock(sharedHome: string, runId: string, action: () => void): void {
  const lock = path.join(sharedHome, AUTH_WRITE_BACK_LOCK);
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if (fsErrorSchema.parse(error).code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline || lockIsStale(lock)) {
      logger.warn("codex run home: breaking a stale sign-in write-back lock", { runId });
      rmSync(lock, { force: true });
      continue;
    }
    sleepMs(AUTH_LOCK_POLL_MS);
  }
  try {
    action();
  } finally {
    rmSync(lock, { force: true });
  }
}

function lockIsStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > AUTH_LOCK_STALE_MS;
  } catch {
    // Gone between the failed create and the stat: not held any more.
    return true;
  }
}

/** A synchronous pause, for the settle path (which is synchronous by
 *  contract): `Atomics.wait` is permitted on Node's main thread. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
