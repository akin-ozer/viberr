import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  DATA_ROOT_LOCK_FILENAME,
  DataRootLockedError,
  acquireDataRootLock,
  classifyLock,
  forceDataRootTakeover,
  heldDataRootLock,
  releaseDataRootLock,
  startDataRootLockGuard,
  stopDataRootLockGuard,
  verifyLockOwnership,
  type DataRootLock,
  type LockHolder,
  type LockOwnership,
} from "./data-root-lock.server";

/**
 * B-FD1: the single-writer lock on the data root. Two processes on one root is
 * the incident that ate PATs and run logs twice on this project, so these are
 * the exact refusal/takeover rules, not a smoke test.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const HOST_A: LockHolder = { pid: 4242, hostname: "host-a", startedAt: "2026-07-28T10:00:00.000Z" };
const HOST_A_OTHER: LockHolder = { pid: 9999, hostname: "host-a", startedAt: "2026-07-28T11:00:00.000Z" };
const CONTAINER: LockHolder = { pid: 1, hostname: "viberr-app-1", startedAt: "2026-07-28T09:00:00.000Z" };

const alive = () => true;
const dead = () => false;

function lockPath(dataRoot: string): string {
  return path.join(dataRoot, "state", DATA_ROOT_LOCK_FILENAME);
}

function acquire(dataRoot: string, self: LockHolder, opts: { isAlive?: (pid: number) => boolean; force?: boolean } = {}) {
  return acquireDataRootLock({
    dataRoot,
    self,
    isAlive: opts.isAlive ?? alive,
    force: opts.force ?? false,
    releaseOnExit: false,
  });
}

describe("acquireDataRootLock", () => {
  it("writes a holder-identifying lock file and refuses a second live process", () => {
    const dataRoot = ctx.makeTempDir();
    const first = acquire(dataRoot, HOST_A);
    expect(first.path).toBe(lockPath(dataRoot));
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(HOST_A);

    let thrown: unknown;
    try {
      acquire(dataRoot, HOST_A_OTHER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataRootLockedError);
    const err = thrown as DataRootLockedError;
    expect(err.verdict).toBe("held");
    expect(err.holder).toEqual(HOST_A);
    // The refusal names the holder AND both remedies — an operator reading
    // stdout must not have to guess which process to stop.
    expect(err.message).toContain("pid 4242");
    expect(err.message).toContain("host-a");
    expect(err.message).toContain("VIBERR_FORCE_DATA_ROOT_LOCK=1");
    expect(err.message).toContain(first.path);
    // The live holder's lock is untouched by the refusal.
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(HOST_A);
  });

  it("refuses a holder on a DIFFERENT host — the container-vs-host incident shape", () => {
    const dataRoot = ctx.makeTempDir();
    acquire(dataRoot, CONTAINER);
    // pid 1 is trivially "alive" on this host; the point is that the probe is
    // meaningless across hosts, so the verdict must be `held` regardless.
    expect(() => acquire(dataRoot, HOST_A, { isAlive: dead })).toThrow(
      /different host/,
    );
  });

  it("takes over a stale lock whose same-host pid is gone", () => {
    const dataRoot = ctx.makeTempDir();
    acquire(dataRoot, HOST_A);
    const second = acquire(dataRoot, HOST_A_OTHER, { isAlive: dead });
    expect(second.holder).toEqual(HOST_A_OTHER);
    expect(JSON.parse(readFileSync(second.path, "utf8"))).toEqual(HOST_A_OTHER);
  });

  it("refuses an unreadable lock rather than guessing, and the force override takes it", () => {
    const dataRoot = ctx.makeTempDir();
    acquire(dataRoot, HOST_A);
    writeFileSync(lockPath(dataRoot), "{ not json");

    let thrown: unknown;
    try {
      acquire(dataRoot, HOST_A_OTHER);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DataRootLockedError).verdict).toBe("unknown-holder");
    expect((thrown as DataRootLockedError).message).toContain("holder is unknown");

    const forced = acquire(dataRoot, HOST_A_OTHER, { force: true });
    expect(forced.holder).toEqual(HOST_A_OTHER);
  });

  it("force takes over a lock held by a live process on another host", () => {
    const dataRoot = ctx.makeTempDir();
    acquire(dataRoot, CONTAINER);
    const forced = acquire(dataRoot, HOST_A, { force: true });
    expect(JSON.parse(readFileSync(forced.path, "utf8"))).toEqual(HOST_A);
  });

  it("release removes the file so the next boot acquires cleanly, and is idempotent", () => {
    const dataRoot = ctx.makeTempDir();
    const first = acquire(dataRoot, HOST_A);
    first.release();
    first.release();
    const second = acquire(dataRoot, HOST_A_OTHER);
    expect(second.holder).toEqual(HOST_A_OTHER);
  });
});

describe("releaseDataRootLock (G1)", () => {
  // The signal handler re-raises, so `process.once("exit")` never fires on a
  // SIGTERM: the shutdown path must be able to release the lock by itself, or a
  // `docker compose stop` strands the file and the next boot is refused.
  it("releases the lock THIS process holds, and is idempotent when it holds none", () => {
    const dataRoot = ctx.makeTempDir();
    releaseDataRootLock(); // nothing held — a no-op, never a throw
    const lock = acquireDataRootLock({ dataRoot, self: HOST_A, isAlive: alive });
    expect(heldDataRootLock()).toBe(lock);

    releaseDataRootLock();

    expect(existsSync(lock.path)).toBe(false);
    expect(heldDataRootLock()).toBeNull();
    // The root is genuinely free again: the next boot acquires without force.
    const next = acquireDataRootLock({ dataRoot, self: HOST_A_OTHER, isAlive: alive });
    next.release();
  });

  it("an explicitly-released tracked lock stops being the process's lock", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquireDataRootLock({ dataRoot, self: HOST_A, isAlive: alive });
    lock.release();
    expect(heldDataRootLock()).toBeNull();
  });

  it("a test-scoped lock (releaseOnExit: false) is never the process's lock", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, HOST_A);
    expect(heldDataRootLock()).toBeNull();
    lock.release();
  });
});

describe("classifyLock", () => {
  it("re-entrant boot of the SAME PROCESS reclaims its own lock — proven by bootId", () => {
    const self = { ...HOST_A, bootId: "boot-1" };
    expect(classifyLock({ ...HOST_A, bootId: "boot-1" }, self, alive)).toBe("stale");
  });

  it("a DIFFERENT process that happens to share pid+hostname does NOT reclaim a live lock", () => {
    // `compose.yml` pins the hostname so a recreated container can probe its
    // predecessor, which makes "same host" trivially true for every container
    // from that file — and two containers over one data root routinely land on
    // the same low pid. Without the bootId discriminator this handed a LIVE
    // holder's lock to a second writer: the corruption the lock exists to stop.
    const holder = { ...HOST_A, bootId: "boot-1" };
    const self = { ...HOST_A, bootId: "boot-2" };
    expect(classifyLock(holder, self, alive)).toBe("held");
    // …and it is still taken over once that pid is genuinely gone.
    expect(classifyLock(holder, self, dead)).toBe("stale");
  });

  it("a lock written before bootId existed falls through to the liveness probe", () => {
    expect(classifyLock(HOST_A, { ...HOST_A, bootId: "boot-2" }, alive)).toBe("held");
    expect(classifyLock(HOST_A, { ...HOST_A, bootId: "boot-2" }, dead)).toBe("stale");
  });

  it("an unreadable holder is never assumed dead", () => {
    expect(classifyLock(null, HOST_A, dead)).toBe("unknown-holder");
  });
});

describe("classifyLock — container self-lockout (F20-8b)", () => {
  // The app runs as pid 1 in the container and compose pins the hostname, so a
  // CRASHED predecessor leaves writer.lock naming pid 1 on this very host. Asking
  // isAlive(1) from the restarted process is a self-probe (always "alive"), which
  // refused every boot for 11 restarts until the file was deleted by hand. The
  // pid's real start time breaks the tie the liveness probe cannot.
  const CRASHED_PID1: LockHolder = {
    pid: 1,
    hostname: "viberr",
    startedAt: "2026-08-14T16:50:03.813Z",
    bootId: "boot-crashed",
    procStartedAt: 111,
  };
  const RESTART_SELF: LockHolder = {
    pid: 1,
    hostname: "viberr",
    startedAt: "2026-08-14T17:16:33.000Z",
    bootId: "boot-restart",
  };

  it("RECLAIMS a crashed predecessor's lock — the recycled pid started at a new time", () => {
    // isAlive says "alive" (it is exactly the self-probe that bricked the boot);
    // we ignore it and trust that /proc reports a DIFFERENT start time now.
    expect(classifyLock(CRASHED_PID1, RESTART_SELF, alive, () => 222)).toBe("stale");
  });

  it("still refuses while the pid's start time proves the original writer is there", () => {
    // Same start time the lock recorded → the same instance still holds pid 1.
    // Start-time evidence wins over the (here contradictory) liveness probe.
    expect(classifyLock(CRASHED_PID1, RESTART_SELF, dead, () => 111)).toBe("held");
  });

  it("falls back to the liveness probe when /proc cannot be read", () => {
    expect(classifyLock(CRASHED_PID1, RESTART_SELF, dead, () => null)).toBe("stale");
    expect(classifyLock(CRASHED_PID1, RESTART_SELF, alive, () => null)).toBe("held");
  });

  it("a lock written before procStartedAt existed keeps the old liveness behavior", () => {
    const legacy: LockHolder = {
      pid: 1,
      hostname: "viberr",
      startedAt: "x",
      bootId: "boot-old",
    };
    // No recorded start time → never overrides the probe, even though pids match.
    expect(classifyLock(legacy, RESTART_SELF, alive, () => 222)).toBe("held");
    expect(classifyLock(legacy, RESTART_SELF, dead, () => 222)).toBe("stale");
  });

  it("consults /proc only for THIS process's own pid, never across a pid mismatch", () => {
    const other: LockHolder = { ...RESTART_SELF, pid: 4242 };
    const throwingReader = () => {
      throw new Error("the /proc reader must not run for a foreign pid");
    };
    expect(classifyLock(CRASHED_PID1, other, dead, throwingReader)).toBe("stale");
    expect(classifyLock(CRASHED_PID1, other, alive, throwingReader)).toBe("held");
  });
});

describe("forceDataRootTakeover", () => {
  it("reads 1/true/yes as a takeover and everything else as off", () => {
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "1" })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "TRUE" })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: " yes " })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "0" })).toBe(false);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: undefined })).toBe(false);
  });
});

/* ------------------------------------------------ F18-5: fail-closed ownership */

const BOOT_A: LockHolder = { ...HOST_A, bootId: "boot-1" };

describe("verifyLockOwnership (F18-5 fail-closed)", () => {
  it("reports 'held' for a lock this process genuinely owns", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, BOOT_A);
    expect(lock.verifyOwnership()).toBe("held");
    expect(verifyLockOwnership(lock)).toBe("held");
    lock.release();
  });

  it("reports 'stolen' when the lock file is deleted out from under the holder", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, BOOT_A);
    rmSync(lock.path, { force: true }); // the store reset that started F18-5
    expect(lock.verifyOwnership()).toBe("stolen");
    lock.release();
  });

  it("reports 'stolen' when another process replaces the lock file, and abandon() keeps their file", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, BOOT_A);
    // Process B boots into the freed path and writes a fresh lock (new inode):
    rmSync(lock.path, { force: true });
    writeFileSync(lock.path, JSON.stringify({ ...HOST_A_OTHER, bootId: "boot-2" }));
    expect(lock.verifyOwnership()).toBe("stolen");
    lock.abandon(); // fail-closed teardown must NOT delete B's file
    expect(existsSync(lock.path)).toBe(true);
    rmSync(lock.path, { force: true });
  });
});

describe("verifyLockOwnership (injected probes)", () => {
  const owned = { fd: 7, path: "/x/writer.lock", holder: BOOT_A };

  it("'stolen' on an inode mismatch, before reading content", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 999n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("stolen");
  });

  it("'stolen' when our held descriptor is unusable (fstat throws)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => {
          throw new Error("EBADF");
        },
        stat: () => ({ ino: 1n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("stolen");
  });

  it("'stolen' when inode matches but the content names another boot (VirtioFS ino-reuse guard)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => ({ ...HOST_A_OTHER, bootId: "boot-2" }),
      }),
    ).toBe("stolen");
  });

  it("'unverifiable' on a torn read (inode matches, content unreadable)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => null,
      }),
    ).toBe("unverifiable");
  });

  it("'held' when inode + boot identity both agree (normal run does not false-positive)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("held");
  });
});

describe("startDataRootLockGuard (F18-5)", () => {
  afterEach(() => stopDataRootLockGuard());

  const fakeLock = (path = "/x/writer.lock") =>
    ({ path, holder: HOST_A }) as unknown as DataRootLock;

  it("loudly shuts down and stops itself when a tick sees a stolen lock", () => {
    vi.useFakeTimers();
    const stolen: Array<[string, LockOwnership]> = [];
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => "stolen",
      onStolen: (l, v) => stolen.push([l.path, v]),
    });
    vi.advanceTimersByTime(1000);
    expect(stolen).toEqual([["/x/writer.lock", "stolen"]]);
    // guard stopped itself → later ticks do not re-fire onStolen:
    vi.advanceTimersByTime(5000);
    expect(stolen).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not shut down on healthy or unverifiable ticks", () => {
    vi.useFakeTimers();
    const stolen: string[] = [];
    let verdict: LockOwnership = "held";
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => verdict,
      onStolen: () => stolen.push("x"),
    });
    vi.advanceTimersByTime(1000);
    verdict = "unverifiable";
    vi.advanceTimersByTime(1000);
    expect(stolen).toEqual([]);
    vi.useRealTimers();
  });

  it("is idempotent — a second start does not stack a second interval", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => {
        ticks.push(1);
        return "held";
      },
      onStolen: () => {},
    });
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => {
        ticks.push(2);
        return "held";
      },
      onStolen: () => {},
    });
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]); // only the first guard's verify ran
    vi.useRealTimers();
  });
});
