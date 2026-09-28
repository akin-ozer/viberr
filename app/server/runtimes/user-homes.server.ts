import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { errnoSchema } from "~/server/files/atomic-file.server";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import type { RealBackend } from "./runtime-registry.server";
import { toError } from "~/shared/errors";

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
 * (Codex's `auth.json` is the one exception, and only inside the person's own
 * home: ruling 181's per-run fork copies it in and back.)
 *
 * Ruling 507: a person may keep several accounts per backend, so each account
 * connected since that ruling has a home of its OWN inside the backend home,
 * where its vendor sign-in was written and stays:
 *
 *   <backend home>/accounts/<accountId>   → that account's CLAUDE_CONFIG_DIR, or
 *                                           the home its `codex login` wrote to
 *
 * Switching accounts moves no file: it changes which home the next run is
 * pointed at, so a sign-in never has to be repeated and a run already going on
 * one account is never handed another's credential halfway through (Claude
 * rotates its refresh token on every refresh, so two accounts sharing one
 * credential file would spend each other's). What must stay ONE per person is
 * shared by link: a Claude account home's `projects/` points at the backend
 * home's, so every transcript lands where resume, the exporter and the
 * retention sweep look, whichever account wrote it. An account connected
 * before ruling 507 keeps its sign-in in the backend home itself
 * (`legacyHome`).
 */

/** Re-exported so a consumer of the per-user homes needs one import, not two.
 *  The vocabulary itself stays owned by the runtime registry. */
export type { RealBackend };

/** The directory under `<dataRoot>/runtimes` that holds the per-person homes. */
const USER_RUNTIMES_DIR = "users";

/** A user id — and, since ruling 181, a run id — may become a PATH SEGMENT
 *  here, so each is validated as one. Viberr mints ids as `u_<base64url>` /
 *  `run_<base64url>` (`newId`), which this matches; anything else — a
 *  hand-edited row, a traversal attempt, an empty string — is refused rather
 *  than resolved. */
const PATH_SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertPathSafeUserId(userId: string): string {
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
 * the process umask can only narrow it further, never widen it. In the image
 * the server creates it as itself and `agentLaunchFor` then hands it to the
 * person's agent uid (`<uid>:node`, 2770, ruling 460) before anything runs in
 * it: the person's agents own it, the server reaches it through its group,
 * and nobody else's agents reach it at all.
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

// ------------------------------------------------ per-account homes (507)

/** The directory under a backend home that holds its accounts' own homes. */
export const ACCOUNT_HOMES_DIR = "accounts";

/** What locates one account's vendor home (ruling 507): its id, and whether it
 *  was connected before the ruling and so lives in the backend home itself. */
export interface BackendAccountRef {
  id: string;
  legacyHome: boolean;
}

/**
 * The directories an account home shares with its backend home, by link, per
 * backend. Claude writes its transcripts under `projects/` and every reader of
 * them (`probeSessionContinuity`, the exporter, the retention sweep, a resume on
 * another account) looks in the backend home's. Codex needs none: its runs fork
 * a private home from the backend home anyway (ruling 181) and only take the
 * account's `auth.json` from here.
 */
const ACCOUNT_HOME_SHARED_DIRS = {
  claude: ["projects"],
  codex: [],
} as const satisfies Record<RealBackend, readonly string[]>;

/** An account id becomes a path segment, so it is validated as one: Viberr
 *  mints them as `ubc_<base64url>` (`newId`). */
function assertPathSafeAccountId(accountId: string): string {
  if (!PATH_SAFE_SEGMENT_RE.test(accountId)) {
    throw AppError.validation(
      "That account id cannot be used for a runtime home.",
      { accountIdLength: accountId.length },
    );
  }
  return accountId;
}

/**
 * The vendor home of ONE account (ruling 507): where its sign-in was written,
 * what a Claude run on it gets as `CLAUDE_CONFIG_DIR`, and where a Codex run on
 * it takes its `auth.json` from (and hands the refreshed one back to).
 */
export function backendAccountHome(
  userId: string,
  backend: RealBackend,
  account: BackendAccountRef,
  dataRoot?: string,
): string {
  const home = userBackendHome(userId, backend, dataRoot);
  return account.legacyHome
    ? home
    : path.join(home, ACCOUNT_HOMES_DIR, assertPathSafeAccountId(account.id));
}

export interface EnsuredAccountHome {
  home: string;
  /**
   * Ruling 460: the directories an agent process on this account writes that
   * the server may have just created as itself — the account home and the
   * shared directories it links to. `agentLaunchFor` hands each one that is not
   * already the person's to their uid (the launcher also takes over the
   * `accounts/` directory on the way). Empty for a legacy account, whose home
   * is the backend home the launch already prepares.
   */
  ownDirs: string[];
}

/**
 * Materialize an account's home (mode 0o700, like the backend home) with its
 * links to the backend home, and return it. The links are made before any
 * vendor process runs in the home, so the CLI writes through them from its
 * first transcript; a real directory already standing where a link belongs is
 * left alone (its transcripts are not ours to move) and said in the log.
 */
export function ensureBackendAccountHome(
  userId: string,
  backend: RealBackend,
  account: BackendAccountRef,
  dataRoot?: string,
): EnsuredAccountHome {
  const backendHome = ensureUserBackendHome(userId, backend, dataRoot);
  const home = backendAccountHome(userId, backend, account, dataRoot);
  if (account.legacyHome) return { home, ownDirs: [] };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const ownDirs = [home];
  for (const name of ACCOUNT_HOME_SHARED_DIRS[backend]) {
    const shared = path.join(backendHome, name);
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    ownDirs.push(shared);
    const link = path.join(home, name);
    let standing: Stats | null = null;
    try {
      standing = lstatSync(link);
    } catch {
      standing = null;
    }
    if (!standing) {
      // Relative, like the Codex run home's links, so a restored or moved data
      // root still resolves: `<backend home>/accounts/<id>/<name>` → `../../<name>`.
      symlinkSync(path.join("..", "..", name), link, "dir");
    } else if (!standing.isSymbolicLink()) {
      logger.warn("an account home holds its own copy of a directory it should share", {
        backend,
        accountId: account.id,
        name,
      });
    }
  }
  return { home, ownDirs };
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

/** The vendor's own sign-in file in `home`, for either backend. */
export function vendorLoginCredentialPath(backend: RealBackend, home: string): string {
  return backend === "claude"
    ? claudeLoginCredentialPath(home)
    : codexLoginCredentialPath(home);
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
 *  - `auth.json` and `config.toml` are COPIED in (when present): the sign-in
 *    from the home of the account the run bills (ruling 507; the shared home
 *    for an account connected before it), the config from the shared home. A
 *    copy, not a link: the CLI rewrites `auth.json` on a token refresh, and two
 *    runs writing one shared file through a link is the race this must not
 *    have. The refreshed file is carried back at the end to that same
 *    account's home, under that home's lock, only when its bytes changed — and
 *    only while the account's file still exists, so a run cannot resurrect a
 *    sign-in the person removed meanwhile.
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
const CODEX_RUN_HOMES_DIR = "runs";

/** The state directories a run shares with the person's home, by link. */
const CODEX_HOME_SHARED_DIRS = ["sessions", "skills", "memories"] as const;

/** The vendor-owned files a run gets a private copy of. */
const CODEX_HOME_SEEDED_FILES = ["auth.json", "config.toml"] as const;

const AUTH_WRITE_BACK_LOCK = ".auth.json.lock";
/** Ruling 507: beside a run home's seeded `auth.json`, the digest of what it
 *  was seeded with, so the settle can tell a token the CLI refreshed from a
 *  copy that merely went stale while another run refreshed the account. */
const AUTH_SEED_DIGEST = ".auth.json.seed";

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
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
  /**
   * Ruling 507: the home of the account the run bills, which its `auth.json`
   * is copied from and the refreshed one is written back to (under that home's
   * own lock). The shared home itself for an account connected before the
   * ruling. Never another account's: a run that started on one account and
   * settles after a switch hands its refreshed token back to the account it
   * refreshed, and the account now active is left exactly as it was.
   */
  authHome: string;
  runId: string;
}

/** `<sharedHome>/runs/<runId>` — where one run's private home lives. */
export function codexRunHomeDir(sharedHome: string, runId: string): string {
  return path.join(sharedHome, CODEX_RUN_HOMES_DIR, assertPathSafeRunId(runId));
}

/** Ruling 507: the id a run's completion compaction forks its own private home
 *  under (`runs/<runId>-compaction`), beside the run's. Path-safe, unlike the
 *  compaction's process marker (`compactionRunId`, which carries a colon). */
export function codexCompactionHomeId(runId: string): string {
  return `${runId}-compaction`;
}

/**
 * Ruling 460: what hands a path in a person's home to their agent uid (the
 * launcher's `--prepare-home`, supplied by the caller that knows the uid). The
 * server writes the run home's copies and the written-back sign-in as itself;
 * the CLI that reads them runs as the person.
 */
export type HomeOwner = (target: string) => void;

/**
 * Ruling 485: what removes a tree in a person's home — as them, through the
 * launcher (`removeAgentTreeSync` with their launch), never the server's own
 * recursive remove: their CLI writes the run home, and a tool it runs can
 * leave a directory only its uid can enter. Supplied by the caller that knows
 * the person, like {@link HomeOwner}; absent, the server removes it itself
 * (no agent is launched: the host dev server, the test harness).
 */
export type HomeRemover = (target: string) => void;

/** The person a run home belongs to, when this server launches agents. */
export interface RunHomePerson {
  own: HomeOwner;
  remove: HomeRemover;
}

function removeRunHomeTree(target: string, person: RunHomePerson | undefined): void {
  if (person) person.remove(target);
  else rmSync(target, { recursive: true, force: true });
}

/** Build the run home (see the module note above) and return it. With a
 *  `person`, the shared directories it had to create and the run home itself
 *  are handed to the person's uid before the CLI starts (it throws when that
 *  fails: a run whose home it cannot use must not start), and a predecessor's
 *  tree is removed as them. `authHome` is the billed account's home (ruling
 *  507); the sign-in is taken from there and from nowhere else, so a pasted-key
 *  account's run never inherits another account's `auth.json`. */
export function prepareCodexRunHome(
  sharedHome: string,
  runId: string,
  person?: RunHomePerson,
  authHome: string = sharedHome,
): CodexRunHome {
  const own = person?.own;
  const dir = codexRunHomeDir(sharedHome, runId);
  // Whatever a crashed predecessor of this id left: start clean, never merge.
  removeRunHomeTree(dir, person);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of CODEX_HOME_SEEDED_FILES) {
    const source = path.join(name === "auth.json" ? authHome : sharedHome, name);
    if (!existsSync(source)) continue;
    const target = path.join(dir, name);
    copyFileSync(source, target);
    // A credential copy is private whatever the source mode was (to its
    // owner and, once `own` has run, the server's group); the config keeps
    // its own.
    if (name === "auth.json") {
      chmodSync(target, 0o600);
      writeFileSync(path.join(dir, AUTH_SEED_DIGEST), digestOf(readFileSync(target)), { mode: 0o600 });
    }
  }
  for (const name of CODEX_HOME_SHARED_DIRS) {
    const shared = path.join(sharedHome, name);
    if (!existsSync(shared)) {
      mkdirSync(shared, { recursive: true, mode: 0o700 });
      own?.(shared);
    }
    // Relative, so a restored or moved data root still resolves.
    symlinkSync(path.join("..", "..", name), path.join(dir, name), "dir");
  }
  own?.(dir);
  return { dir, sharedHome, authHome, runId };
}

/** `own`, never throwing: the settle half must not. */
function ownQuietly(own: HomeOwner | undefined, target: string, runId: string): void {
  if (!own || !existsSync(target)) return;
  try {
    own(target);
  } catch (error) {
    logger.warn("codex run home: a path could not be handed to the person's agent user", {
      runId,
      err: toError(error),
    });
  }
}

/**
 * The settle half: carry a refreshed `auth.json` back to the billed account's
 * home (`authHome`, ruling 507) when the CLI refreshed it (under that home's
 * lock), then remove the run home. Never throws — a settle that cannot clean
 * up is logged, not propagated.
 *
 * With a `person` (ruling 460): the run home is first handed to the person's
 * uid and the server's group as a whole, so the server can read what the CLI
 * wrote there 0600; the written-back `auth.json` is the server's file, so it
 * is handed back too, or the vendor's own `login status` and `logout`, which
 * run as the person in that home, could not read their own sign-in. The run
 * home is then removed as the person (ruling 485).
 */
export function finishCodexRunHome(home: CodexRunHome, person?: RunHomePerson): void {
  const own = person?.own;
  ownQuietly(own, home.dir, home.runId);
  for (const dbFile of codexStateDatabases(home.sharedHome)) ownQuietly(own, dbFile, home.runId);
  try {
    if (writeBackAuth(home)) ownQuietly(own, path.join(home.authHome, "auth.json"), home.runId);
  } catch (error) {
    logger.warn("codex run home: the refreshed sign-in could not be written back", {
      runId: home.runId,
      err: toError(error),
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
    removeRunHomeTree(home.dir, person);
  } catch (error) {
    logger.warn("codex run home could not be removed", {
      runId: home.runId,
      err: toError(error),
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
        // is skipped whole rather than half-read — and SAID, because a silent
        // skip is a repair that quietly stopped happening. The comment above
        // this function promised a log line and the first draft emitted none.
        const columns = columnNamesSchema.safeParse(db.prepare(`PRAGMA table_info(threads)`).all());
        if (!columns.success || !columns.data.some((c) => c.name === "rollout_path")) {
          logger.warn(
            "codex rollout paths NOT re-pointed: this state database has no `threads.rollout_path`; " +
              "the vendor schema changed and thread resume will break again until ruling 199 is updated",
            { runId: home.runId, dbFile },
          );
          continue;
        }
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
        err: toError(error),
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
          if (!columns.success || !columns.data.some((c) => c.name === "rollout_path")) {
            logger.warn(
              "codex rollout paths NOT repaired at boot: this state database has no " +
                "`threads.rollout_path`; the vendor schema changed and ruling 199 needs updating",
              { dbFile },
            );
            continue;
          }
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
          err: toError(error),
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

/** True when the account's `auth.json` was replaced. */
function writeBackAuth(home: CodexRunHome): boolean {
  const refreshed = readIfPresent(path.join(home.dir, "auth.json"));
  if (!refreshed) return false;
  // Ruling 507: a copy the CLI never refreshed is not news — handing it back
  // would put the seed over a token another run of the same account refreshed
  // meanwhile (and a refresh token that was rotated away with it). A run home
  // from before the digest existed has none, and keeps the old comparison.
  const seed = readIfPresent(path.join(home.dir, AUTH_SEED_DIGEST));
  if (seed && seed.toString("utf8") === digestOf(refreshed)) return false;
  const sharedAuth = path.join(home.authHome, "auth.json");
  // Checked again under the lock below; this early answer is for an account
  // whose whole home went while the run was live (ruling 507), where there is
  // no directory to put a lock in and nothing to hand a token back to.
  if (!existsSync(sharedAuth)) return false;
  let written = false;
  withAuthLock(home.authHome, home.runId, () => {
    const current = readIfPresent(sharedAuth);
    // The person disconnected (or removed this account) while the run was
    // live: the file is gone on purpose, and a token the run refreshed must
    // not bring it back.
    if (!current) return;
    if (current.equals(refreshed)) return;
    const staging = `${sharedAuth}.${home.runId}.tmp`;
    writeFileSync(staging, refreshed, { mode: 0o600 });
    renameSync(staging, sharedAuth);
    written = true;
  });
  return written;
}

function readIfPresent(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** A lockfile with retry: `O_EXCL` create, poll while held, break a holder
 *  that is older than a settle could possibly be. Serializes the write-back
 *  between concurrent runs of one account (the lock sits in its home, ruling
 *  507); last writer wins by design. */
function withAuthLock(authHome: string, runId: string, action: () => void): void {
  const lock = path.join(authHome, AUTH_WRITE_BACK_LOCK);
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      // What `openSync(..., "wx")` throws when the lock is held: the one
      // field the retry reads, decoded rather than asserted.
      if (errnoSchema.safeParse(error).data?.code !== "EEXIST") throw error;
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
