import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { lockPath } from "../../../test-support/data-root-lock";
import { withEnv } from "../../../test-support/env";
import { runWithDataRootWriterLock } from "./cli-lock.server";
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
  vi.restoreAllMocks();
  ctx.cleanup();
});

const SERVER: LockHolder = {
  pid: 4242,
  hostname: "viberr-app-1",
  startedAt: "2026-08-08T09:00:00.000Z",
  bootId: "boot-server",
};

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
    // `process.exit` ends the worker, so the spy throws where the CLI would
    // have died: nothing after the call runs, and the test reads the code.
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit:${code}`);
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let bodyRan = false;

    // Off, so a takeover left in the shell cannot let this one through.
    await withEnv({ VIBERR_FORCE_DATA_ROOT_LOCK: "" }, () =>
      expect(
        runWithDataRootWriterLock(
          "`npm run seed`",
          () => {
            bodyRan = true;
          },
          {
            dataRoot,
            alternative: "Stop the app first (`docker compose stop app`).",
          },
        ),
      ).rejects.toThrow("__exit:1"),
    );

    expect(bodyRan).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    const message = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
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

    await withEnv({ VIBERR_FORCE_DATA_ROOT_LOCK: "1" }, () =>
      runWithDataRootWriterLock(
        "`npm run rescan`",
        () => {
          bodyRan = true;
        },
        { dataRoot },
      ),
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
