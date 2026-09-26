import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { lockPath } from "../../../test-support/data-root-lock";
import {
  runWithDataRootWriterLock,
  type CliRefusalIo,
} from "./cli-lock.server";
import {
  acquireDataRootLock,
  type LockHolder,
} from "./data-root-lock.server";

/**
 * Gap 19: the maintenance CLIs used to open the data root with no lock at all.
 * Two writers on one root is the incident that ate this project's WAL, so
 * these assert the CLI half of B-FD1: take the lock, fail CLOSED naming the
 * holder, and never leave the lock behind.
 */

const ctx = createTestDbContext();
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  ctx.cleanup();
});

/** Sets `VIBERR_FORCE_DATA_ROOT_LOCK` the way an operator does: in the env
 *  that the CLI reads, not as an argument. */
function forceLockEnv(value: string): void {
  vi.stubEnv("VIBERR_FORCE_DATA_ROOT_LOCK", value);
  resetEnvCacheForTests();
}

const SERVER: LockHolder = {
  pid: 4242,
  hostname: "viberr-app-1",
  startedAt: "2026-08-08T09:00:00.000Z",
  bootId: "boot-server",
};

function collectingIo(): CliRefusalIo & { output: string[]; exitCode: number | null } {
  const output: string[] = [];
  return {
    output,
    exitCode: null,
    write(message: string) {
      output.push(message);
    },
    exit(code: number) {
      this.exitCode = code;
      throw new Error(`__exit:${code}`);
    },
  };
}

describe("runWithDataRootWriterLock", () => {
  it("holds the writer lock for the duration of the command and releases it after", async () => {
    const dataRoot = ctx.makeTempDir();
    let heldDuringBody = false;
    let holderDuringBody: LockHolder | null = null;

    const result = await runWithDataRootWriterLock(
      "`npm run rescan`",
      () => {
        heldDuringBody = existsSync(lockPath(dataRoot));
        // SAFETY: the body runs while the lock is held, so this reads back the
        // holder record `acquireDataRootLock` serialized from a `LockHolder`
        // moments earlier — the JSON round-trip is the only step in between.
        holderDuringBody = JSON.parse(
          readFileSync(lockPath(dataRoot), "utf8"),
        ) as LockHolder;
        return "done";
      },
      { dataRoot },
    );

    expect(result).toBe("done");
    expect(heldDuringBody).toBe(true);
    expect(holderDuringBody!.pid).toBe(process.pid);
    // Released — the next boot must not have to refuse a CLI's leftovers.
    expect(existsSync(lockPath(dataRoot))).toBe(false);
  });

  it("refuses to run — and does NOT run the body — while a live server holds the root", async () => {
    const dataRoot = ctx.makeTempDir();
    const server = acquireDataRootLock({
      dataRoot,
      self: SERVER,
      isAlive: () => true,
      releaseOnExit: false,
    });
    const io = collectingIo();
    let bodyRan = false;
    // Off, so a takeover left in the shell cannot let this one through.
    forceLockEnv("");

    await expect(
      runWithDataRootWriterLock(
        "`npm run seed`",
        () => {
          bodyRan = true;
        },
        {
          dataRoot,
          io,
          alternative: "Stop the app first (`docker compose stop app`).",
        },
      ),
    ).rejects.toThrow("__exit:1");

    expect(bodyRan).toBe(false);
    expect(io.exitCode).toBe(1);
    const message = io.output.join("");
    // Leads with the command (the lock's own message says "boot"), then names
    // the holder and both remedies.
    expect(message.startsWith("`npm run seed` refused to run")).toBe(true);
    expect(message).toContain("SECOND writer");
    expect(message).toContain("pid 4242");
    expect(message).toContain("viberr-app-1");
    expect(message).toContain("VIBERR_FORCE_DATA_ROOT_LOCK=1");
    expect(message).toContain("Stop the app first");
    // The live holder's lock is untouched by the refusal.
    expect(JSON.parse(readFileSync(server.path, "utf8"))).toEqual(SERVER);
    server.release();
  });

  it("honours VIBERR_FORCE_DATA_ROOT_LOCK the same way boot does", async () => {
    const dataRoot = ctx.makeTempDir();
    const server = acquireDataRootLock({
      dataRoot,
      self: SERVER,
      isAlive: () => true,
      releaseOnExit: false,
    });
    let bodyRan = false;
    forceLockEnv("1");

    await runWithDataRootWriterLock(
      "`npm run rescan`",
      () => {
        bodyRan = true;
      },
      { dataRoot },
    );

    expect(bodyRan).toBe(true);
    server.release();
  });

  it("releases the lock even when the command throws", async () => {
    const dataRoot = ctx.makeTempDir();
    await expect(
      runWithDataRootWriterLock(
        "`npm run seed`",
        () => {
          throw new Error("seed blew up");
        },
        { dataRoot },
      ),
    ).rejects.toThrow("seed blew up");
    expect(existsSync(lockPath(dataRoot))).toBe(false);
  });
});
