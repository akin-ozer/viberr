import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  DATA_ROOT_LOCK_FILENAME,
  DataRootLockedError,
  acquireDataRootLock,
  classifyLock,
  forceDataRootTakeover,
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

describe("classifyLock", () => {
  it("re-entrant boot of the SAME pid reclaims its own lock", () => {
    expect(classifyLock(HOST_A, HOST_A, alive)).toBe("stale");
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
