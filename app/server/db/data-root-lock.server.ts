import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { getEnv, type Env } from "../config/env.server";
import { getDataRoot } from "../files/file-store-root.server";
import { logger } from "../logging/logger.server";

/**
 * ONE app process per data root, EVER (B-FD1).
 *
 * The store is file-canonical with a SQLite projection whose WAL lives on the
 * same volume. Two processes pointed at one root is not a slow path, it is
 * corruption: it has bitten this project twice — a host dev server and a compose
 * container sharing `docker-data` over VirtioFS clobbered the WAL and ate PATs
 * and run logs, and the run pipeline's handles/completion callbacks are
 * per-process globals, so process B "interrupts" a run that process A is still
 * driving and A overwrites the state at finalize.
 *
 * Nothing enforced that; the only defence was remembering. This does: boot takes
 * an exclusive lock file under `<dataRoot>/state/` naming the holder (pid, host,
 * start time), and a second process REFUSES to boot with a message that names
 * who holds it and how to take it over. The lock is a real O_EXCL file create —
 * atomic on both local filesystems and the bind mounts this app runs on.
 *
 * Staleness is decided by evidence, never by a timeout:
 *  - same host + the pid is gone → stale, taken over automatically (the normal
 *    "container was SIGKILLed" case);
 *  - same host + the pid is alive → held, refuse;
 *  - a DIFFERENT host → we cannot probe that pid, so we refuse. This is exactly
 *    the docker-data incident shape (host process vs container), and a wrong
 *    "it's probably dead" guess there is the failure this file exists to stop;
 *  - unreadable/garbled lock → unknown holder, refuse and say how to clear it.
 *
 * `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a takeover for the case the operator
 * genuinely knows better (a wiped host, an orphaned lock on a shared mount).
 */

/** Lock file name under `<dataRoot>/state/`. */
export const DATA_ROOT_LOCK_FILENAME = "writer.lock";

/** The env var that forces a takeover of a live-looking lock. */
export const FORCE_LOCK_ENV = "VIBERR_FORCE_DATA_ROOT_LOCK";

export interface LockHolder {
  pid: number;
  hostname: string;
  /** ISO timestamp of when the holder acquired the lock. */
  startedAt: string;
  /**
   * Per-PROCESS identity, stable across an HMR module reload (it lives on
   * `globalThis`) and unique to every new process. `pid` + `hostname` cannot
   * play this role: `compose.yml` pins the hostname so a recreated container
   * can probe its predecessor, which makes "same host" trivially true for
   * every container from that file — and two containers over one data root
   * routinely land on the same low pid. Without this discriminator the
   * self-reclaim branch would hand a LIVE holder's lock to a second writer:
   * the exact corruption the lock exists to prevent.
   * Absent on locks written before this field existed — those fall through to
   * the liveness probe, which is the correct answer for them.
   */
  bootId?: string;
}

/** Why an existing lock could not simply be taken. */
export type LockVerdict = "stale" | "held" | "unknown-holder";

export interface DataRootLock {
  /** Absolute path of the lock file. */
  path: string;
  holder: LockHolder;
  /** Idempotent: closes the descriptor and removes the file. */
  release(): void;
}

export interface AcquireDataRootLockOptions {
  /** Defaults to the configured data root. */
  dataRoot?: string;
  /** Take the lock even when the holder looks alive (env override at boot). */
  force?: boolean;
  /** Identity written into the lock file. Injected by tests. */
  self?: LockHolder;
  /** Liveness probe for a same-host pid. Injected by tests. */
  isAlive?: (pid: number) => boolean;
  /** Publish this as the lock THIS PROCESS holds: released by the `exit` hook
   *  and by the signal shutdown ({@link releaseDataRootLock}). Off in tests,
   *  which take many temp-root locks and release them explicitly. */
  releaseOnExit?: boolean;
}

/**
 * Refusal to boot: a live (or unidentifiable) writer already holds the root.
 * Its `message` is what the operator reads on stdout, so it names the holder
 * and both remedies.
 */
export class DataRootLockedError extends Error {
  readonly verdict: LockVerdict;
  readonly holder: LockHolder | null;
  readonly lockPath: string;

  constructor(args: {
    message: string;
    verdict: LockVerdict;
    holder: LockHolder | null;
    lockPath: string;
  }) {
    super(args.message);
    this.name = "DataRootLockedError";
    this.verdict = args.verdict;
    this.holder = args.holder;
    this.lockPath = args.lockPath;
  }
}

/** The lock THIS process holds. A global symbol so an HMR module reload — and
 *  the shutdown handler, which lives in another module — sees the same one. */
const HELD_LOCK_KEY = Symbol.for("viberr.dataRootLock");

function heldLockSlot(): Record<symbol, DataRootLock | null | undefined> {
  return globalThis as unknown as Record<symbol, DataRootLock | null | undefined>;
}

/** The lock this process holds, or null. */
export function heldDataRootLock(): DataRootLock | null {
  return heldLockSlot()[HELD_LOCK_KEY] ?? null;
}

/** Same global-slot trick, for the per-process identity in the lock file: one
 *  id per OS process, preserved across an HMR module reload. */
const BOOT_ID_KEY = Symbol.for("viberr.processBootId");

export function processBootId(): string {
  const slot = globalThis as unknown as Record<symbol, string | undefined>;
  const existing = slot[BOOT_ID_KEY];
  if (existing) return existing;
  const created = randomUUID();
  slot[BOOT_ID_KEY] = created;
  return created;
}

/**
 * Release the writer lock this process holds, if any. Idempotent, and safe on a
 * process that never took one.
 *
 * The `exit` hook alone is not enough: the app's signal handler re-raises
 * SIGINT/SIGTERM (sse-broker.server.ts), whose default action terminates the
 * process, so Node's `exit` event never fires on a `docker compose stop` or a
 * Ctrl-C. The lock file then outlives its holder, and because a recreated
 * container comes up under a NEW hostname, `classifyLock` refuses a foreign-host
 * lock it cannot probe — the app never boots again until someone deletes the
 * file inside the volume. So the shutdown path releases explicitly, BEFORE the
 * re-raise.
 */
export function releaseDataRootLock(): void {
  heldDataRootLock()?.release();
}

/** Is a takeover forced by the environment? Read by boot, not by `acquire`. */
export function forceDataRootTakeover(env: Pick<Env, "VIBERR_FORCE_DATA_ROOT_LOCK"> = getEnv()): boolean {
  const raw = env.VIBERR_FORCE_DATA_ROOT_LOCK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Signal 0 probes existence without delivering anything. EPERM = alive but
 *  owned by another user, which still means "do not touch this root". */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { pid, hostname: host, startedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof host !== "string" || host.length === 0) return null;
    const { bootId } = parsed as Record<string, unknown>;
    return {
      pid,
      hostname: host,
      startedAt: typeof startedAt === "string" ? startedAt : "",
      ...(typeof bootId === "string" && bootId ? { bootId } : {}),
    };
  } catch {
    return null;
  }
}

export function classifyLock(
  holder: LockHolder | null,
  self: LockHolder,
  isAlive: (pid: number) => boolean,
): LockVerdict {
  if (!holder) return "unknown-holder";
  // A lock left behind by THIS very process (a re-entrant boot after an HMR
  // reload that dropped the module state) is ours to reclaim — proven by the
  // per-process boot id, never by pid+hostname alone (see LockHolder.bootId).
  if (holder.bootId && holder.bootId === self.bootId) return "stale";
  if (holder.hostname !== self.hostname) return "held";
  return isAlive(holder.pid) ? "held" : "stale";
}

function refusalMessage(
  holder: LockHolder | null,
  self: LockHolder,
  dataRoot: string,
  lockPath: string,
): string {
  const who =
    holder === null
      ? `The lock file could not be read, so the holder is unknown.`
      : `Held by pid ${holder.pid} on host “${holder.hostname}”${
          holder.startedAt ? ` since ${holder.startedAt}` : ""
        }.`;
  const remedy =
    holder !== null && holder.hostname !== self.hostname
      ? `That is a different host from this one (“${self.hostname}”) — typically a container and a host process sharing one volume — so this process cannot check whether it is still running.`
      : `Stop that process first.`;
  return [
    `Refusing to boot: another Viberr process is already writing ${dataRoot}.`,
    who,
    remedy,
    `One app process per data root, ever — a second writer corrupts the SQLite WAL and the run pipeline's per-process run handles.`,
    `If you are certain nothing else is running, delete ${lockPath} or boot once with ${FORCE_LOCK_ENV}=1 to take the lock over.`,
  ].join(" ");
}

function writeLockFile(lockPath: string, self: LockHolder): number {
  // "wx" = O_CREAT|O_EXCL: the create itself is the mutual exclusion.
  const fd = openSync(lockPath, "wx");
  // Write the identity immediately so a crash can never leave an anonymous
  // lock that the next boot has to refuse.
  writeSync(fd, JSON.stringify(self));
  return fd;
}

/**
 * Acquire the data root's single-writer lock, or throw {@link DataRootLockedError}.
 * Stale locks are taken over automatically; the file is removed on release and
 * on process exit.
 */
export function acquireDataRootLock(
  options: AcquireDataRootLockOptions = {},
): DataRootLock {
  const dataRoot = getDataRoot(options.dataRoot);
  const stateDir = path.join(dataRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, DATA_ROOT_LOCK_FILENAME);

  const self: LockHolder = options.self ?? {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    bootId: processBootId(),
  };
  const isAlive = options.isAlive ?? isProcessAlive;
  const force = options.force ?? false;

  // Three attempts: each takeover removes the file and retries, so a competing
  // process that wins the re-create is refused rather than silently ignored.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number;
    try {
      fd = writeLockFile(lockPath, self);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(lockPath);
      const verdict = classifyLock(holder, self, isAlive);
      if (!force && verdict !== "stale") {
        throw new DataRootLockedError({
          message: refusalMessage(holder, self, dataRoot, lockPath),
          verdict,
          holder,
          lockPath,
        });
      }
      logger.warn(
        force
          ? "forcing takeover of the data-root writer lock"
          : "taking over a stale data-root writer lock",
        { lockPath, holder, force },
      );
      rmSync(lockPath, { force: true });
      continue;
    }

    const tracked = options.releaseOnExit !== false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (tracked) {
        process.off("exit", release);
        if (heldDataRootLock() === lock) heldLockSlot()[HELD_LOCK_KEY] = null;
      }
      try {
        closeSync(fd);
      } catch {
        // A descriptor already closed by shutdown is not a failure.
      }
      rmSync(lockPath, { force: true });
    };
    const lock: DataRootLock = { path: lockPath, holder: self, release };
    if (tracked) {
      // Both ends of the process's life: `exit` covers a normal return, and the
      // signal handler calls releaseDataRootLock() before it re-raises.
      process.once("exit", release);
      heldLockSlot()[HELD_LOCK_KEY] = lock;
    }
    logger.info("data-root writer lock acquired", { lockPath, ...self });
    return lock;
  }

  throw new DataRootLockedError({
    message: `Refusing to boot: lost the race for ${lockPath} — another Viberr process took the data-root lock while this one was clearing a stale entry.`,
    verdict: "held",
    holder: readHolder(lockPath),
    lockPath,
  });
}
