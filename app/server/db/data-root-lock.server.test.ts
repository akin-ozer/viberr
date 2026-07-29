import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  DATA_ROOT_LOCK_FILENAME,
  DataRootLockedError,
  acquireDataRootLock,
  classifyLock,
  forceDataRootTakeover,
  heldDataRootLock,
  releaseDataRootLock,
  type LockHolder,
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

describe("forceDataRootTakeover", () => {
  it("reads 1/true/yes as a takeover and everything else as off", () => {
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "1" })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "TRUE" })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: " yes " })).toBe(true);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: "0" })).toBe(false);
    expect(forceDataRootTakeover({ VIBERR_FORCE_DATA_ROOT_LOCK: undefined })).toBe(false);
  });
});
