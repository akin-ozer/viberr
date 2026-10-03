import { execFile, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { errorMessage, toError } from "~/shared/errors";
import { userRuntimeRoot } from "./user-homes.server";

/**
 * Ruling 460: every agent process runs as the OS user of the person it bills.
 *
 * The server runs as `node`. Before this ruling it spawned every Claude and
 * Codex CLI as `node` too, so a run's shell could read the server's
 * `/proc/<pid>/environ` (the secret-encryption key, the session secret), the
 * projection database (sealed PATs and keys, which that key opens) and every
 * other person's sign-in under `runtimes/users/`. Measured in the image on
 * 2026-09-24: a process as another uid is REFUSED `/proc/<server>/environ`, so
 * a separate uid protects the process; and the macOS bind mount the store
 * lived on does NOT enforce file permissions between uids, so protecting the
 * store also needs a named volume.
 *
 * The pieces, all here so each has one home:
 *
 *  - **The uid map.** A person's agent uid is allocated once, sequentially from
 *    {@link AGENT_UID_FLOOR}, in `agent_os_users` — never reused, because the
 *    row outlives the person (a removed account's transcripts stay on disk,
 *    owned by its uid, and a second person given that uid would own them).
 *  - **The launcher** (`tools/viberr-launch/viberr-launch.c`, installed setuid
 *    root:node 4750 in the image). The server never becomes root; it asks the
 *    launcher to exec a command as a uid, to give a path under
 *    `runtimes/users/` to a uid (`--prepare-home`), to signal agent processes
 *    by run marker (`--reap`), and to measure whether the store enforces
 *    permissions (`--probe`).
 *  - **The state** (`on | off | degraded`), measured once at boot and reported
 *    by `/resources/health` and `instance_health`. `off` means no launcher (the
 *    host dev server, the test harness): runs spawn as the server's own user,
 *    exactly as before. In the image there is no silent fallback: a launch that
 *    cannot be prepared refuses the run with a reason that names it.
 *  - **The store layout**, re-asserted by the server at boot
 *    ({@link enforceStoreLayout}) and at each shared directory's creation
 *    ({@link shareDirWithAgents}).
 */

/** Where the image installs the launcher (Dockerfile). */
export const AGENT_LAUNCHER_PATH = "/usr/local/libexec/viberr-launch";
/** The first agent uid, the last, and the agents' shared primary group. The
 *  Dockerfile ARGs `VIBERR_AGENT_UID_FLOOR` / `_MAX` / `VIBERR_AGENT_GID`
 *  compile the same numbers into the launcher (`agent-isolation.server.test.ts`
 *  pins the two against each other). */
export const AGENT_UID_FLOOR = 20001;
export const AGENT_UID_MAX = 59999;
export const AGENT_GID = 20000;

/** The directory under a person's runtime root that is their agents' `$HOME`:
 *  npm's and pnpm's caches, a `git config --global`, anything a tool writes
 *  under `~`. The server's own `/home/node` is not writable by an agent uid. */
const AGENT_HOME_DIR = "home";

export type AgentIsolationStatus = "on" | "off" | "degraded";

/** What `/resources/health` reports (key order is part of that contract). */
export interface AgentIsolation {
  status: AgentIsolationStatus;
  uidFloor: number;
  /** Why the status is not `on`; null when it is. */
  reason: string | null;
}

/** What a launched process needs: WHO it runs as and through what. */
export interface AgentLaunch {
  uid: number;
  launcher: string;
  /** The vendor home the launcher gives back to `uid` (and to the server's
   *  group) once the process exits: a vendor writes its sign-in 0600. */
  launchHome?: string;
  /** The agent's `$HOME` (`runtimes/users/<userId>/home`). */
  home?: string;
}

let measured: AgentIsolation | null = null;
/** The launcher this process uses: the image's, or a test's stand-in. */
let launcherPath = AGENT_LAUNCHER_PATH;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function offState(launcher: string): AgentIsolation {
  return {
    status: "off",
    uidFloor: AGENT_UID_FLOOR,
    reason:
      `There is no agent launcher at ${launcher} (the host dev server or the test harness), ` +
      "so agent processes run as the server's own user.",
  };
}

/** The measured state; before boot has measured it, `off` when there is no
 *  launcher, else `degraded` with the reason that it has not been measured. */
export function agentIsolation(): AgentIsolation {
  if (measured) return measured;
  if (!isExecutable(launcherPath)) return offState(launcherPath);
  return {
    status: "degraded",
    uidFloor: AGENT_UID_FLOOR,
    reason: "The store has not been probed yet: the server has not finished booting.",
  };
}

/** True when agent processes go through the launcher (`on` or `degraded`). */
export function launchesAgents(): boolean {
  return agentIsolation().status !== "off";
}

/** Tests: set (or clear) the measured state and point the launcher at a
 *  stand-in script; no argument restores the image's defaults. */
export function resetAgentIsolationForTests(
  state: AgentIsolation | null = null,
  opts: { launcher?: string } = {},
): void {
  measured = state;
  launcherPath = opts.launcher ?? AGENT_LAUNCHER_PATH;
}

/** The launcher's `--probe` exit codes (viberr-launch.c). */
const PROBE_REFUSED = 0;
const PROBE_READABLE = 3;

export interface MeasureDeps {
  launcher?: string;
  dataRoot?: string;
}

/**
 * Boot's measurement: is there a launcher, and does the store refuse a uid
 * that is not the server's? The probe reads `state/projection.sqlite` as the
 * reserved probe uid (the floor − 1), after {@link enforceStoreLayout} has
 * closed `state/`. Refused → `on`. Readable → `degraded`: the store sits on a
 * mount that does not enforce permissions (the macOS bind mount), so an agent
 * uid could read the database — runs still go through the launcher, which
 * still protects the server's process, and `degraded[]` names it.
 */
export function measureAgentIsolation(deps: MeasureDeps = {}): AgentIsolation {
  const launcher = deps.launcher ?? launcherPath;
  if (!isExecutable(launcher)) {
    measured = offState(launcher);
    return measured;
  }
  const target = path.join(getDataRoot(deps.dataRoot), "state", "projection.sqlite");
  const probe = spawnSync(launcher, ["--probe", target], { encoding: "utf8", timeout: 10_000 });
  if (probe.status === PROBE_REFUSED) {
    measured = { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null };
  } else if (probe.status === PROBE_READABLE) {
    measured = {
      status: "degraded",
      uidFloor: AGENT_UID_FLOOR,
      reason:
        "The data root does not enforce file permissions between users (a bind mount?): " +
        "an agent uid could read the projection database. Move the store to the named volume " +
        "(docs/operations/deployment.md, `npm run store:to-volume`).",
    };
  } else {
    const detail = (probe.stderr ?? "").trim() || (probe.error ? errorMessage(probe.error) : "");
    measured = {
      status: "degraded",
      uidFloor: AGENT_UID_FLOOR,
      reason:
        `The agent launcher's store probe failed (exit ${probe.status ?? "none"})` +
        (detail ? `: ${detail}` : "") +
        ". Agent runs may not start.",
    };
  }
  if (measured.status !== "on") {
    logger.warn("agent isolation is degraded", { reason: measured.reason });
  }
  return measured;
}

// ------------------------------------------------------------------ the uid map

const uidRowSchema = z.object({ os_uid: z.number().int() });

/**
 * The agent uid of one person, allocated on first use: one more than the
 * highest ever allocated (the floor for the first). Stable (the row is never
 * rewritten), unique (the column is UNIQUE) and never reused (rows are never
 * deleted, not even with the account).
 */
export function agentUidFor(db: DatabaseSync, userId: string): number {
  db.prepare(
    // `WHERE true`: SQLite reads an `ON` right after an INSERT's SELECT as a
    // join constraint, so an upsert behind one needs a WHERE to parse.
    `INSERT INTO agent_os_users (user_id, os_uid, created_at)
     SELECT ?, COALESCE(MAX(os_uid), ?) + 1, ? FROM agent_os_users WHERE true
     ON CONFLICT (user_id) DO NOTHING`,
  ).run(userId, AGENT_UID_FLOOR - 1, new Date().toISOString());
  const row = uidRowSchema.parse(
    db.prepare(`SELECT os_uid FROM agent_os_users WHERE user_id = ?`).get(userId),
  );
  if (row.os_uid < AGENT_UID_FLOOR || row.os_uid > AGENT_UID_MAX) {
    throw new AppError({
      code: ERROR_CODES.RUN_UNAVAILABLE,
      status: 409,
      userMessage:
        `This server has no agent user left for this person (uid ${row.os_uid} is outside ` +
        `${AGENT_UID_FLOOR}-${AGENT_UID_MAX}), so no agent can run for them.`,
    });
  }
  return row.os_uid;
}

// -------------------------------------------------------------- launcher calls

function launchRefusal(what: string, detail: string): AppError {
  return new AppError({
    code: ERROR_CODES.RUN_UNAVAILABLE,
    status: 409,
    userMessage:
      `The agent could not be started as its person's own user (ruling 460): ${what}` +
      (detail ? ` (${detail})` : "") +
      ". Nothing ran; nothing falls back to the server's own user.",
  });
}

/**
 * Give `target` (a path under `runtimes/users/`, created when missing) to
 * `uid`: owner `uid`, group the server's, directories 2770, files gaining
 * group read and write. Recursive; symlinks are never followed.
 */
export function prepareAgentPath(uid: number, target: string, launcher = launcherPath): void {
  const result = spawnSync(launcher, ["--prepare-home", String(uid), target], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw launchRefusal(
      `the launcher could not prepare ${target}`,
      (result.stderr ?? "").trim() || (result.error ? errorMessage(result.error) : ""),
    );
  }
}

/** True when `dir` is already `uid`'s 2770 directory in the server's group. */
function ownedBy(uid: number, dir: string): boolean {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch {
    return false;
  }
  return (
    st.isDirectory() &&
    st.uid === uid &&
    st.gid === process.getgid?.() &&
    (st.mode & 0o7777) === 0o2770
  );
}

/**
 * Everything one person's agent process needs to run as them, or null when
 * this server launches no agents (`off`). The person's runtime root, the
 * vendor home and their agent `$HOME` are handed to their uid when they are not
 * already theirs (a fresh home, or one the server just created) — the common
 * case is three `lstat`s. `alsoOwn` names the directories inside the vendor
 * home the server may have created since it was handed over — an account's own
 * home and the shared directories it links to (ruling 507) — which get the
 * same treatment; the vendor home stays the one the launcher hands back after
 * the process exits, so that walk covers every account in it. Throws a
 * `run_unavailable` AppError naming what failed; the caller refuses the run
 * with it.
 */
export function agentLaunchFor(
  db: DatabaseSync,
  userId: string,
  backendHome: string,
  dataRoot?: string,
  alsoOwn: readonly string[] = [],
): AgentLaunch | null {
  if (!launchesAgents()) return null;
  const uid = agentUidFor(db, userId);
  const root = userRuntimeRoot(userId, dataRoot);
  const home = path.join(root, AGENT_HOME_DIR);
  for (const dir of [root, backendHome, ...alsoOwn, home]) {
    if (!ownedBy(uid, dir)) prepareAgentPath(uid, dir);
  }
  return { uid, launcher: launcherPath, launchHome: backendHome, home };
}

/**
 * Pass 40 review (R-seams-1): what a git in a task workspace runs as — the
 * person the work bills, through the launcher, like their runs — or null when
 * this server launches no agents (`off`). A workspace is written by agent uids
 * (it is `node:viberr-agents` 2770), so its `.git` holds hooks and config an
 * agent planted; the server running git there as itself would run them with
 * the server's authority. Only the runtime root and the agent `$HOME` are
 * prepared (a git has no vendor home to hand back). Throws the same
 * `run_unavailable` AppError as {@link agentLaunchFor}.
 */
export function agentGitLaunchFor(
  db: DatabaseSync,
  userId: string,
  dataRoot?: string,
): AgentLaunch | null {
  if (!launchesAgents()) return null;
  const uid = agentUidFor(db, userId);
  const root = userRuntimeRoot(userId, dataRoot);
  const home = path.join(root, AGENT_HOME_DIR);
  for (const dir of [root, home]) {
    if (!ownedBy(uid, dir)) prepareAgentPath(uid, dir);
  }
  return { uid, launcher: launcherPath, home };
}

/** An absolute path for `command`: as given when it names a path, else the
 *  first executable of that name on `PATH`. The launcher execs only absolute
 *  paths, so a bare `node` must be resolved here. */
export function resolveExecutable(command: string, pathEnv = process.env.PATH ?? ""): string {
  if (command.includes("/")) return path.resolve(command);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  throw launchRefusal(`\`${command}\` is not on PATH`, "");
}

const LAUNCH_ENV_PREFIX = "VIBERR_LAUNCH_";

/**
 * `env` for a launched process: every inherited `VIBERR_LAUNCH_*` name dropped,
 * then the ones the launcher reads — the uid, the absolute binary and the home
 * it hands back afterwards. Only the launcher sees them: it removes every
 * `VIBERR_LAUNCH_*` variable before it execs anything.
 */
export function launchEnv<V extends string | undefined>(
  launch: AgentLaunch,
  exec: string,
  env: Record<string, V>,
) {
  const out: Record<string, V | string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LAUNCH_ENV_PREFIX)) out[key] = value;
  }
  out.VIBERR_LAUNCH_UID = String(launch.uid);
  out.VIBERR_LAUNCH_EXEC = exec;
  if (launch.launchHome) out.VIBERR_LAUNCH_HOME = launch.launchHome;
  return out;
}

/** What is spawned for a launched command. */
export interface LaunchedCommand {
  command: string;
  env: Record<string, string | undefined>;
}

/** A command as it is spawned for `launch`: the launcher, with the real
 *  binary (resolved absolute) and the uid in its environment. */
export function launchedCommand(
  launch: AgentLaunch,
  command: string,
  env: Record<string, string | undefined>,
): LaunchedCommand {
  return {
    command: launch.launcher,
    env: launchEnv(launch, resolveExecutable(command, env.PATH ?? process.env.PATH ?? ""), env),
  };
}

/**
 * The server's SIGKILL, for a launched process: SIGUSR2, which the launcher
 * turns into SIGKILL of the agent's whole group. A SIGKILL of the launcher
 * itself would leave the agent's processes to PDEATHSIG and orphan their
 * children under a uid the server cannot signal.
 */
export function launchedSignal(signal: NodeJS.Signals): NodeJS.Signals {
  return signal === "SIGKILL" ? "SIGUSR2" : signal;
}

/** `--reap` over the launcher: signal (or with `"0"`, only list) every agent
 *  process carrying one of `markers` as its `VIBERR_RUN_ID`. Resolves the pids
 *  it reached; an unavailable launcher reaches none. */
export function reapAgentProcesses(
  signal: "0" | "TERM" | "KILL",
  markers: readonly string[],
  launcher = launcherPath,
): Promise<number[]> {
  if (markers.length === 0 || !launchesAgents()) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(launcher, ["--reap", signal, ...markers], { timeout: 30_000 }, (error, stdout) => {
      if (error) {
        logger.warn("the agent launcher's reap failed", { signal, err: toError(error) });
      }
      resolve(
        String(stdout ?? "")
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 1),
      );
    });
  });
}

// ------------------------------------------------------------ the store layout

export interface LayoutDeps {
  /** The agents' group (tests pass their own gid). */
  gid?: number;
  /** Give each person's runtime root to their uid (boot passes the launcher's
   *  `--prepare-home` with the uid map; tests leave it out). */
  prepareHome?: (userId: string, dir: string) => void;
}

/** Directories a run WRITES: the server's, shared with the agent group,
 *  setgid so what either side creates stays in the group. */
const SHARED_DIR_MODE = 0o2770;

/**
 * Make `dir` (created when missing) a directory the agents write: the server's
 * own, in the agent group, 2770. A no-op when this server launches no agents.
 * Called where the server creates such a directory (a task's `workspace/` and
 * `attachments/`, the Codex operator scratch, the controller scratch); the
 * server's umask of 0002 (set at boot) then keeps what it writes inside
 * group-writable.
 */
export function shareDirWithAgents(dir: string, deps: { gid?: number } = {}): void {
  mkdirSync(dir, { recursive: true });
  if (deps.gid === undefined && !launchesAgents()) return;
  shareEntry(dir, deps.gid ?? AGENT_GID, () => SHARED_DIR_MODE);
}

/**
 * Ruling 636: make `dir` (created when missing) a directory the agents pass
 * THROUGH and never list: the server's own, in the agent group, 0710. An agent
 * reaches an entry under it by the path it is given and cannot read the names
 * beside it. Throws when `dir` is not the server's own directory (a symbolic
 * link, or one an agent made first), so nothing is made under a parent an
 * agent controls, and when the mode did not take. Beyond that check, a no-op
 * when this server launches no agents.
 */
export function passThroughDirForAgents(dir: string, deps: { gid?: number } = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) {
    throw new Error(`${dir} is not a directory of the server's own.`);
  }
  if (deps.gid === undefined && !launchesAgents()) return;
  const gid = deps.gid ?? AGENT_GID;
  shareEntry(dir, gid, () => 0o710);
  const after = lstatSync(dir);
  if (after.gid !== gid || (after.mode & 0o7777) !== 0o710) {
    throw new Error(`${dir} could not be put in the agent group as 0710.`);
  }
}

/**
 * Ruling 534: a file the server wrote into a private directory of its own,
 * made READABLE by the agent group: the directory traversable (0710), the file
 * readable (0640), both in the group, through the same no-follow descriptor
 * every share uses. The Codex SDK writes a turn's output schema into a
 * `mkdtemp` directory (0700, the server's) and hands its path to the CLI,
 * which the launcher runs as the person's own uid; without this, every Codex
 * run given an output schema failed before its first turn. Throws when the
 * share did not take, so the run fails saying so instead of on a bare EACCES.
 * A no-op when this server launches no agents.
 */
export function shareFileForAgentsToRead(file: string, deps: { gid?: number } = {}): void {
  if (deps.gid === undefined && !launchesAgents()) return;
  const gid = deps.gid ?? AGENT_GID;
  const dir = path.dirname(file);
  shareEntry(dir, gid, () => 0o710);
  shareEntry(file, gid, () => 0o640);
  const dirStat = lstatSync(dir);
  const fileStat = lstatSync(file);
  if (
    dirStat.gid !== gid ||
    (dirStat.mode & 0o7777) !== 0o710 ||
    fileStat.gid !== gid ||
    (fileStat.mode & 0o7777) !== 0o640
  ) {
    throw new Error(`${file} could not be shared with the agent group for reading.`);
  }
}

/**
 * {@link shareDirWithAgents}, best effort: a directory left unshared makes the
 * person's own step in it (a clone, a log write) fail in its own words, which
 * the caller reports, rather than failing here before anything says why. Only
 * the directory's creation still throws.
 */
export function shareDirWithAgentsOrWarn(dir: string): void {
  try {
    shareDirWithAgents(dir);
  } catch (error) {
    mkdirSync(dir, { recursive: true });
    logger.warn("a directory could not be shared with the agent group", { dir, err: toError(error) });
  }
}

/**
 * Put one of the server's own entries in the agent group with the mode `want`
 * computes, through a descriptor opened without following a symlink: an agent
 * can replace an entry inside a workspace between a look and a chmod, and a
 * path-based chgrp would then follow its link to, say, `state/`. Entries that
 * are not the server's, and symlinks, are left alone. True when it changed
 * something.
 */
function shareEntry(entry: string, gid: number, want: (st: Stats) => number): boolean {
  let fd: number;
  try {
    fd = openSync(entry, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const st = fstatSync(fd);
    if (st.uid !== process.getuid?.()) return false;
    const mode = want(st);
    let changed = false;
    if (st.gid !== gid) {
      fchownSync(fd, st.uid, gid);
      changed = true;
    }
    // A chgrp can clear the setgid bit, so the mode is set after it.
    if (changed || (st.mode & 0o7777) !== mode) {
      fchmodSync(fd, mode);
      changed = true;
    }
    return changed;
  } finally {
    closeSync(fd);
  }
}

/**
 * A tree the server created before ruling 460 (every file `node:node`, 0644):
 * hand it to the agent group once — group, setgid on directories, group write
 * on everything — so an agent can edit a checkout it did not clone. Only
 * entries the server owns are touched; symlinks are left alone. Returns how
 * many entries changed.
 */
function shareTreeWithAgents(dir: string, gid: number): number {
  let changed = 0;
  const serverUid = process.getuid?.() ?? -1;
  const visit = (entry: string, depth: number) => {
    let st: Stats;
    try {
      st = lstatSync(entry);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || st.uid !== serverUid) return;
    // Pass 40 review (R-seams-1): a file with another link is shared with
    // whatever holds that link — a checkout's objects are hardlinked from the
    // project's mirror — and group write on it would let any agent rewrite
    // the mirror's copy, which every later checkout is cut from. Git never
    // writes an object in place, so it stays as it is: readable, never ours
    // to widen.
    if (st.isFile() && st.nlink > 1) return;
    const shared = shareEntry(entry, gid, (seen) =>
      seen.isDirectory() ? (seen.mode & 0o777) | 0o2070 : (seen.mode & 0o777) | 0o060,
    );
    if (shared) changed += 1;
    if (!st.isDirectory() || depth > 64) return;
    let names: string[];
    try {
      names = readdirSync(entry);
    } catch {
      return;
    }
    for (const name of names) visit(path.join(entry, name), depth + 1);
  };
  visit(dir, 0);
  return changed;
}

/**
 * Pass 40 review (R-seams-1): hand a tree the server built in a place of its
 * own (a checkout staged in the project's `.repo-stage/`) to the agent group
 * before it is moved into a workspace: group, setgid on directories, group
 * read and write on files — except a file with another link (an object
 * hardlinked from the project mirror), which stays read-only. A no-op when
 * this server launches no agents. Returns how many entries changed.
 */
export function shareTreeBuiltForAgents(dir: string, deps: { gid?: number } = {}): number {
  if (deps.gid === undefined && !launchesAgents()) return 0;
  return shareTreeWithAgents(dir, deps.gid ?? AGENT_GID);
}

/**
 * Pass 40 review (R-seams-1): the project mirrors stay the server's alone. A
 * workspace cloned from a mirror shares its object files (hardlinks), and the
 * boot hand-over of a pre-460 workspace used to put them in the agent group
 * with group write, which reached the mirror's inode too. Every server-owned
 * file under `projects/<slug>/.repo-mirror/` loses group and other write (the
 * server, their owner, never needs them) and is back in the server's own
 * group, which no agent uid is in: ruling 495's removal step
 * (`chmod -R -P g+rwX`, `agent-trees.server.ts`) can reach a checkout's
 * object linked from here, and opens it to the group it is in. Agents read
 * the mirror through its other-read bits. Returns how many entries changed.
 */
function revokeMirrorWrites(root: string): number {
  let changed = 0;
  const serverUid = process.getuid?.() ?? -1;
  const serverGid = process.getgid?.() ?? -1;
  const visit = (entry: string, depth: number) => {
    let st: Stats;
    try {
      st = lstatSync(entry);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || st.uid !== serverUid) return;
    if (st.isFile()) {
      const widened = (st.mode & 0o022) !== 0 || st.gid !== serverGid;
      if (widened && shareEntry(entry, serverGid, (seen) => seen.mode & 0o755)) changed += 1;
      return;
    }
    if (!st.isDirectory() || depth > 64) return;
    let names: string[];
    try {
      names = readdirSync(entry);
    } catch {
      return;
    }
    for (const name of names) visit(path.join(entry, name), depth + 1);
  };
  let slugs: string[];
  try {
    slugs = readdirSync(path.join(root, "projects"));
  } catch {
    return 0;
  }
  for (const slug of slugs) {
    const mirrors = path.join(root, "projects", slug, ".repo-mirror");
    if (existsSync(mirrors)) visit(mirrors, 0);
  }
  return changed;
}

function isShared(dir: string, gid: number): boolean {
  try {
    const st = statSync(dir);
    return st.gid === gid && (st.mode & 0o7777) === SHARED_DIR_MODE;
  } catch {
    return false;
  }
}

function setMode(dir: string, mode: number, gid?: number): void {
  mkdirSync(dir, { recursive: true });
  if (gid !== undefined && statSync(dir).gid !== gid) chownSync(dir, -1, gid);
  chmodSync(dir, mode);
}

export interface LayoutReport {
  /** Pre-460 task directories handed to the agent group this boot. */
  sharedTrees: number;
  /** Entries changed inside them. */
  sharedEntries: number;
  /** Person runtime roots handed to their uid. */
  homes: number;
  /** Mirror files that had group or other write, or were in another group
   *  than the server's (pass 40 review, R-seams-1; ruling 495). */
  mirrorWritesRevoked: number;
  /** What could not be set, by path. */
  failures: string[];
}

/** The per-task directories a run writes: shared with the agent group here,
 *  and removed as the task's person wherever they are removed (ruling 485). */
export const TASK_SHARED_DIRS = ["workspace", "attachments", ".operator-scratch"] as const;

/**
 * Ruling 460's store layout, asserted at every boot. The server owns the tree,
 * so chmod and chgrp need no privilege; only the per-person homes need the
 * launcher (`prepareHome`).
 *
 *  - the root 0750 in the agent group: agents traverse it, nobody else does;
 *  - `state/` (projection database, writer lock, shipped assets) and
 *    `audit-exports/` 0700, the raw run logs `runtimes/claude|codex/` 0700;
 *  - `runtimes/` 0750 and `runtimes/users/` 0710 in the agent group: an agent
 *    reaches its own home and lists nobody's;
 *  - `agents/`, `kb/`, `skills/`, `projects/` 0755: readable, never writable,
 *    by an agent (their files are the server's, 0644/0664 in the server's
 *    group);
 *  - the directories runs write — `runtimes/controller-scratch`, `uv-cache`,
 *    `uv-python`, and each task's `workspace/`, `attachments/` and
 *    `.operator-scratch/` — 2770 in the agent group; a task directory created
 *    before this ruling is handed over once, recursively;
 *  - each person's runtime root `<uid>:<server group>` 2770 (the launcher).
 */
export function enforceStoreLayout(dataRoot?: string, deps: LayoutDeps = {}): LayoutReport {
  const root = getDataRoot(dataRoot);
  const gid = deps.gid ?? AGENT_GID;
  const report: LayoutReport = {
    sharedTrees: 0,
    sharedEntries: 0,
    homes: 0,
    mirrorWritesRevoked: 0,
    failures: [],
  };
  const attempt = (target: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      report.failures.push(`${path.relative(root, target) || "."}: ${errorMessage(error)}`);
    }
  };
  attempt(root, () => setMode(root, 0o750, gid));
  for (const dir of ["state", "audit-exports", "runtimes/claude", "runtimes/codex"]) {
    const target = path.join(root, dir);
    attempt(target, () => setMode(target, 0o700));
  }
  attempt(path.join(root, "runtimes"), () => setMode(path.join(root, "runtimes"), 0o750, gid));
  const usersRoot = path.join(root, "runtimes", "users");
  attempt(usersRoot, () => setMode(usersRoot, 0o710, gid));
  for (const dir of ["agents", "kb", "skills", "projects"]) {
    const target = path.join(root, dir);
    attempt(target, () => setMode(target, 0o755));
  }
  const shareOnce = (target: string) => {
    if (isShared(target, gid)) return;
    report.sharedTrees += 1;
    report.sharedEntries += shareTreeWithAgents(target, gid);
    setMode(target, SHARED_DIR_MODE, gid);
  };
  for (const dir of ["controller-scratch", "uv-cache", "uv-python"]) {
    const target = path.join(root, "runtimes", dir);
    attempt(target, () => {
      mkdirSync(target, { recursive: true });
      shareOnce(target);
    });
  }
  for (const taskDir of listTaskDirs(root)) {
    for (const name of TASK_SHARED_DIRS) {
      const target = path.join(taskDir, name);
      if (existsSync(target)) attempt(target, () => shareOnce(target));
    }
  }
  // After the hand-over above, which no longer widens a linked file but did
  // before pass 40's review: the mirrors a checkout's objects link to.
  attempt(path.join(root, "projects"), () => {
    report.mirrorWritesRevoked = revokeMirrorWrites(root);
  });
  if (deps.prepareHome) {
    let people: string[] = [];
    try {
      people = readdirSync(usersRoot);
    } catch {
      people = [];
    }
    for (const userId of people) {
      const target = path.join(usersRoot, userId);
      attempt(target, () => {
        deps.prepareHome?.(userId, target);
        report.homes += 1;
      });
    }
  }
  if (report.failures.length > 0) {
    logger.warn("the store layout could not be fully enforced", { failures: report.failures });
  }
  return report;
}

/** `projects/<slug>/tasks/<KEY>` for every task directory on disk. */
function listTaskDirs(root: string): string[] {
  const out: string[] = [];
  const projects = path.join(root, "projects");
  let slugs: string[];
  try {
    slugs = readdirSync(projects);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const tasks = path.join(projects, slug, "tasks");
    let keys: string[];
    try {
      keys = readdirSync(tasks);
    } catch {
      continue;
    }
    for (const key of keys) out.push(path.join(tasks, key));
  }
  return out;
}

/**
 * Boot, when the image carries the launcher: the server's umask becomes 0002
 * (what it writes inside a shared directory stays group-writable; nothing it
 * writes elsewhere is in the agent group), the layout is enforced, every
 * existing runtime home is handed to its person's uid, and the store is
 * probed. Returns the measured state. Without a launcher this only records
 * `off`.
 */
export function bootAgentIsolation(db: DatabaseSync, dataRoot?: string): AgentIsolation {
  if (!isExecutable(launcherPath)) return measureAgentIsolation({ dataRoot });
  process.umask(0o002);
  const report = enforceStoreLayout(dataRoot, {
    // A root that is not yet the person's (a store from before this ruling,
    // or a uid map rebuilt) is handed over whole. Otherwise only the two
    // vendor homes are walked — what the server reads and writes back — and
    // the agent `$HOME` with its package caches is left alone.
    prepareHome: (userId, dir) => {
      const uid = agentUidFor(db, userId);
      if (!ownedBy(uid, dir)) return prepareAgentPath(uid, dir);
      for (const name of ["claude-home", "codex-home"]) {
        const home = path.join(dir, name);
        if (existsSync(home)) prepareAgentPath(uid, home);
      }
    },
  });
  if (report.sharedTrees > 0 || report.homes > 0 || report.mirrorWritesRevoked > 0) {
    logger.info("store layout enforced for agent isolation", {
      sharedTrees: report.sharedTrees,
      sharedEntries: report.sharedEntries,
      homes: report.homes,
      mirrorWritesRevoked: report.mirrorWritesRevoked,
    });
  }
  return measureAgentIsolation({ dataRoot });
}
