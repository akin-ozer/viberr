import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { getEnv, type Env } from "../config/env.server";
import { getDataRoot } from "../files/file-store-root.server";
import { logger, writeFatalSync } from "../logging/logger.server";

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

/** A type alias, not an interface, so the takeover/steal log lines can carry the
 *  holder as a structured field (only a type alias gets the implicit index
 *  signature). */
export type LockHolder = {
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
  /**
   * The holder pid's real start time (clock ticks since system boot, from
   * `/proc/<pid>/stat`), recorded at acquisition. It exists to break the ONE tie
   * the liveness probe cannot: when a lock names THIS process's own pid, asking
   * `isAlive(self.pid)` is a self-probe that always answers "alive" (F20-8b). The
   * app runs as pid 1 and compose pins the hostname, so a CRASHED predecessor
   * leaves writer.lock naming pid 1 on this exact host, and the old code refused
   * to boot forever. If the process now occupying that pid started at a different
   * time than the lock recorded, the pid was recycled by a since-gone writer →
   * reclaim. Absent off-Linux (no `/proc`) and on pre-F20-8 locks — both fall
   * through to the liveness probe, unchanged.
   */
  procStartedAt?: number;
};

/** Why an existing lock could not simply be taken. */
export type LockVerdict = "stale" | "held" | "unknown-holder";

/**
 * Result of re-verifying that THIS process still owns the file at the lock path
 * (F18-5). `stolen` = the file was deleted or replaced while we held it (a second
 * writer is now possible → fail closed). `unverifiable` = a transient/torn read
 * this tick, not proof of a steal (the guard retries).
 */
export type LockOwnership = "held" | "stolen" | "unverifiable";

/** Injected fs probes for {@link verifyLockOwnership}; tests substitute these to
 *  simulate a steal without touching a real descriptor (mirrors the `isAlive`
 *  injection used by `acquireDataRootLock`). */
export interface LockOwnershipProbes {
  fstat: (fd: number) => { ino: bigint; dev: bigint };
  stat: (path: string) => { ino: bigint; dev: bigint };
  readHolder: (path: string) => LockHolder | null;
}

export interface DataRootLock {
  /** Absolute path of the lock file. */
  path: string;
  holder: LockHolder;
  /** The OS descriptor of the open lock file. The ownership re-check fstats THIS
   *  to compare against the inode currently living at `path`. */
  fd: number;
  /** Idempotent: closes the descriptor and removes the file. */
  release(): void;
  /**
   * Fail-closed teardown for a STOLEN lock (F18-5): drop tracking + close our
   * (stale) descriptor, but DO NOT unlink `path` — the file there now belongs to
   * whatever replaced it, and removing it would re-open the two-writer window.
   */
  abandon(): void;
  /** Re-verify this process still owns the file at `path`. See {@link verifyLockOwnership}. */
  verifyOwnership(probes?: LockOwnershipProbes): LockOwnership;
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

interface HeldLockSlot {
  [HELD_LOCK_KEY]?: DataRootLock | null;
}

function heldLockSlot(): HeldLockSlot {
  // SAFETY: `globalThis` carries no static type for a symbol-keyed slot. The key
  // is module-private, and the only writes to it anywhere in the process are the
  // two in `acquireDataRootLock`/`release` below — both storing a DataRootLock or
  // null — so nothing else can put another shape there.
  return globalThis as HeldLockSlot;
}

/** The lock this process holds, or null. */
export function heldDataRootLock(): DataRootLock | null {
  return heldLockSlot()[HELD_LOCK_KEY] ?? null;
}

/** Same global-slot trick, for the per-process identity in the lock file: one
 *  id per OS process, preserved across an HMR module reload. */
const BOOT_ID_KEY = Symbol.for("viberr.processBootId");

interface BootIdSlot {
  [BOOT_ID_KEY]?: string;
}

export function processBootId(): string {
  // SAFETY: as above — the key is module-private and this function is the only
  // writer of it, storing the `randomUUID()` string on the line below.
  const slot = globalThis as BootIdSlot;
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
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * The start time (field 22 of `/proc/<pid>/stat`, clock ticks since system boot)
 * of the process occupying `pid`, or null off-Linux / when it cannot be read.
 * Used by {@link classifyLock} to tell a live holder from a recycled pid (F20-8b).
 * The `comm` field can itself contain spaces and parentheses, so the parse starts
 * after the LAST ')' — everything after it is space-separated and offset-stable.
 */
function readProcessStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.lastIndexOf(") ");
    if (afterComm < 0) return null;
    // Fields after `comm` begin at field 3 (state); starttime is field 22, so
    // index 22 - 3 = 19 in this tail.
    const fields = stat.slice(afterComm + 2).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/**
 * The lock file as it is found on disk — an unknown process's JSON, possibly
 * hand-edited, possibly written by an older build.
 *
 * A verdict cannot be reached without a real pid and a hostname, so those two
 * reject the file outright (`unknown-holder` → refuse, which is the safe answer).
 * Everything else is tolerated FIELD BY FIELD, because a lock that only lost its
 * timestamp still names its holder: `startedAt` falls back to "" (the refusal
 * message reads it as "unknown since"), and the two evidence fields stay ABSENT
 * rather than becoming `undefined` values — `classifyLock` and
 * `verifyLockOwnership` both read them as "was this recorded at all?".
 * `z.number()` rejects NaN/Infinity, which is the old `Number.isFinite` guard.
 */
const lockFileSchema = z
  .object({
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    startedAt: z.string().catch(""),
    bootId: z.string().min(1).optional().catch(undefined),
    procStartedAt: z.number().optional().catch(undefined),
  })
  .transform((file) => {
    const holder: LockHolder = {
      pid: file.pid,
      hostname: file.hostname,
      startedAt: file.startedAt,
    };
    if (file.bootId !== undefined) holder.bootId = file.bootId;
    if (file.procStartedAt !== undefined) holder.procStartedAt = file.procStartedAt;
    return holder;
  });

function readHolder(lockPath: string): LockHolder | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const parsed = lockFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function classifyLock(
  holder: LockHolder | null,
  self: LockHolder,
  isAlive: (pid: number) => boolean,
  readProcStartTicks: (pid: number) => number | null = readProcessStartTicks,
): LockVerdict {
  if (!holder) return "unknown-holder";
  // A lock left behind by THIS very process (a re-entrant boot after an HMR
  // reload that dropped the module state) is ours to reclaim — proven by the
  // per-process boot id, never by pid+hostname alone (see LockHolder.bootId).
  if (holder.bootId && holder.bootId === self.bootId) return "stale";
  if (holder.hostname !== self.hostname) return "held";
  // F20-8(b): the container self-lockout. The app runs as pid 1 and compose pins
  // the hostname, so a CRASHED predecessor leaves writer.lock naming pid 1 on this
  // exact host. `isAlive(self.pid)` is then a self-probe — it always answers
  // "alive" — so the old code refused to boot FOREVER (observed live: nine
  // consecutive boot refusals, RestartCount 11, until the file was deleted by
  // hand). When the holder names THIS process's own pid the liveness probe is
  // worthless; decide by the pid's real start time instead. A process now sitting
  // on our pid that started at a DIFFERENT time than the lock recorded means the
  // pid was recycled by a since-gone writer → reclaim; a matching start time means
  // the same instance genuinely still holds it → refuse. Only override with real
  // evidence (a recorded + readable start time); with none — a pre-F20-8 lock or a
  // platform without `/proc` — fall through to the liveness probe, unchanged, so
  // every existing verdict is preserved.
  //
  // The realistic dual-writer shape the lock exists to stop is a host process vs a
  // container: a DIFFERENT hostname, already refused above. A second LIVE writer
  // that also happens to sit on our exact pid+hostname cannot be told apart from a
  // crashed predecessor from inside one pid namespace, so this errs toward
  // reclaiming rather than bricking — and that residual window is caught within one
  // tick by the F18-5 ownership guard, which fails the loser closed.
  if (holder.pid === self.pid && holder.procStartedAt !== undefined) {
    const current = readProcStartTicks(self.pid);
    if (current !== null) {
      return current === holder.procStartedAt ? "held" : "stale";
    }
  }
  return isAlive(holder.pid) ? "held" : "stale";
}

const DEFAULT_OWNERSHIP_PROBES: LockOwnershipProbes = {
  fstat: (fd) => {
    const s = fstatSync(fd, { bigint: true });
    return { ino: s.ino, dev: s.dev };
  },
  stat: (p) => {
    const s = statSync(p, { bigint: true });
    return { ino: s.ino, dev: s.dev };
  },
  readHolder,
};

/**
 * Re-verify that the file at `lock.path` is STILL the one this process opened
 * (F18-5). The B-FD1 lock keeps an fd open for the process lifetime; if a store
 * reset deletes `state/` (or a second boot replaces the file), that fd becomes an
 * unlinked ghost while a NEW inode sits at the path — two live writers, silent
 * SQLite loss. This is how the holder catches it.
 *
 *  1. `fstat` our held fd — if the descriptor itself is unusable, we cannot prove
 *     we own anything → `stolen`.
 *  2. `stat` the path — ENOENT (deleted out from under us) → `stolen`.
 *  3. inode/device differ → the path was deleted+recreated → `stolen`.
 *  4. inode matches: corroborate identity for filesystems with synthesized inode
 *     numbers (VirtioFS bind mounts) — the file must still NAME our `bootId`.
 *     Only enforced when our own identity carries a bootId (production always
 *     does; a bootId-less injected/legacy self trusts the inode match). A null
 *     read is a torn/racing read, not proof → `unverifiable`.
 *
 * Pure + injectable so a test can simulate every branch (mirrors `classifyLock`).
 */
export function verifyLockOwnership(
  lock: Pick<DataRootLock, "fd" | "path" | "holder">,
  probes: LockOwnershipProbes = DEFAULT_OWNERSHIP_PROBES,
): LockOwnership {
  let held: { ino: bigint; dev: bigint };
  try {
    held = probes.fstat(lock.fd);
  } catch {
    return "stolen";
  }
  let onDisk: { ino: bigint; dev: bigint };
  try {
    onDisk = probes.stat(lock.path);
  } catch {
    return "stolen"; // ENOENT — the lock file was deleted while we held it.
  }
  if (held.ino !== onDisk.ino || held.dev !== onDisk.dev) return "stolen";
  if (lock.holder.bootId) {
    const onDiskHolder = probes.readHolder(lock.path);
    if (!onDiskHolder) return "unverifiable";
    if (onDiskHolder.bootId !== lock.holder.bootId) return "stolen";
  }
  return "held";
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

/** This process's own identity for the lock file. */
function bootingHolder(ownStartTicks: number | null): LockHolder {
  const self: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    bootId: processBootId(),
  };
  // F20-8(b): so a restart can tell our crashed predecessor's recycled pid from
  // a genuinely live holder. Omitted off-Linux (null), where pid 1 self-lockout
  // does not arise.
  if (ownStartTicks !== null) self.procStartedAt = ownStartTicks;
  return self;
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

  const ownStartTicks = readProcessStartTicks(process.pid);
  const self: LockHolder = options.self ?? bootingHolder(ownStartTicks);
  const isAlive = options.isAlive ?? isProcessAlive;
  const force = options.force ?? false;

  // Three attempts: each takeover removes the file and retries, so a competing
  // process that wins the re-create is refused rather than silently ignored.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number;
    try {
      fd = writeLockFile(lockPath, self);
    } catch (error) {
      const collision =
        error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!collision) throw error;
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
    // Normal release unlinks; the fail-closed `abandon()` (F18-5) sets this false
    // so a STOLEN lock's teardown closes our stale fd WITHOUT deleting the file
    // that now belongs to the process which replaced us.
    let unlinkOnRelease = true;
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
      if (unlinkOnRelease) rmSync(lockPath, { force: true });
    };
    const abandon = () => {
      unlinkOnRelease = false;
      release();
    };
    const verifyOwnership = (probes?: LockOwnershipProbes): LockOwnership =>
      verifyLockOwnership({ fd, path: lockPath, holder: self }, probes);
    const lock: DataRootLock = {
      path: lockPath,
      holder: self,
      fd,
      release,
      abandon,
      verifyOwnership,
    };
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

/** Ownership re-check cadence. Cheap (one fstat + one stat + one small read),
 *  unref'd, so 20 s is comfortable while still catching a steal within a tick. */
export const DATA_ROOT_LOCK_GUARD_INTERVAL_MS = 20_000;

/** HMR-safe singleton handle — same global-symbol pattern as the reconcile
 *  poller / file watcher, so a dev reload never stacks a second interval. */
const GUARD_KEY = Symbol.for("viberr.dataRootLockGuard");

interface LockGuardSlot {
  [GUARD_KEY]?: ReturnType<typeof setInterval>;
}

function guardSlot(): LockGuardSlot {
  // SAFETY: as with the held-lock slot — the key is module-private, and the only
  // writes to it are `startDataRootLockGuard`/`stopDataRootLockGuard` below,
  // storing the interval handle they created or clearing it.
  return globalThis as LockGuardSlot;
}

export interface DataRootLockGuardOptions {
  intervalMs?: number;
  /** Lock to watch. Defaults to the process-held lock (read every tick, so an
   *  HMR re-acquire is picked up). Injected by tests. */
  lock?: DataRootLock;
  /** Ownership probe. Defaults to `lock.verifyOwnership()`. Injected by tests. */
  verify?: (lock: DataRootLock) => LockOwnership;
  /** Reaction to a lost lock. Default: loud log + `process.exit(1)`. Injected by
   *  tests so the worker is not taken down. */
  onStolen?: (lock: DataRootLock, verdict: LockOwnership) => void;
}

function loudlyShutDownOnStolenLock(
  lock: DataRootLock,
  verdict: LockOwnership,
): void {
  // No `logger.fatal` exists (levels: debug/info/warn/error); this is the app's
  // fatal channel — a loud `error` line + a non-zero exit, mirroring the boot
  // refusal's who/what/why so an operator reading the logs has the whole diagnosis.
  // F20-8(a): `logger.error` is an async `process.stdout.write` and `process.exit`
  // is on the next line, which truncates it — a silent death. `writeFatalSync`
  // flushes the same line SYNCHRONOUSLY to stderr first, so the diagnosis always
  // survives the exit.
  writeFatalSync(
    `FATAL: this Viberr process no longer owns the data-root writer lock at ${lock.path} (${verdict}). ` +
      `The lock file was deleted or replaced while this process held it — another process may now be ` +
      `writing the same data root concurrently, which clobbers the SQLite WAL and silently loses ` +
      `transactions (B-FD1/F18-5). Shutting down NOW rather than continuing to write lock-less. ` +
      `Do not wipe <dataRoot>/state while a Viberr process is running.`,
    { lockPath: lock.path, holder: lock.holder, verdict },
  );
  // Detach WITHOUT unlinking: the file at lock.path is no longer ours to remove.
  lock.abandon();
  process.exit(1);
}

/**
 * Start the fail-closed ownership guard (F18-5): every {@link DATA_ROOT_LOCK_GUARD_INTERVAL_MS}
 * re-verify the process still owns its writer-lock file; on a `stolen` verdict,
 * loudly shut the process down instead of writing lock-less. Idempotent + HMR-safe
 * + unref'd (never blocks exit). No-op when nothing is held.
 */
export function startDataRootLockGuard(options: DataRootLockGuardOptions = {}): void {
  const slot = guardSlot();
  if (slot[GUARD_KEY]) return;
  const intervalMs = options.intervalMs ?? DATA_ROOT_LOCK_GUARD_INTERVAL_MS;
  const verify = options.verify ?? ((l: DataRootLock) => l.verifyOwnership());
  const onStolen = options.onStolen ?? loudlyShutDownOnStolenLock;
  const handle = setInterval(() => {
    const lock = options.lock ?? heldDataRootLock();
    if (!lock) return; // released (or never taken) — nothing to guard this tick.
    let verdict: LockOwnership;
    try {
      verdict = verify(lock);
    } catch (error) {
      // A single probe hiccup is not proof of a steal — log and retry next tick.
      logger.warn("data-root lock guard check failed (transient)", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    if (verdict === "stolen") {
      stopDataRootLockGuard();
      onStolen(lock, verdict);
    }
    // "held" → fine; "unverifiable" → torn read, retry next tick.
  }, intervalMs);
  handle.unref?.();
  slot[GUARD_KEY] = handle;
}

/** Stop the guard (graceful shutdown + tests). */
export function stopDataRootLockGuard(): void {
  const slot = guardSlot();
  const handle = slot[GUARD_KEY];
  if (handle) {
    clearInterval(handle);
    slot[GUARD_KEY] = undefined;
  }
}
