import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  cliLockRefusalMessage,
  runWithDataRootWriterLock,
  type CliRefusalIo,
} from "./cli-lock.server";
import {
  DATA_ROOT_LOCK_FILENAME,
  DataRootLockedError,
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
afterEach(ctx.cleanup);

const SERVER: LockHolder = {
  pid: 4242,
  hostname: "viberr-app-1",
  startedAt: "2026-08-08T09:00:00.000Z",
  bootId: "boot-server",
};

function lockPath(dataRoot: string): string {
  return path.join(dataRoot, "state", DATA_ROOT_LOCK_FILENAME);
}

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

    await expect(
      runWithDataRootWriterLock(
        "`npm run seed`",
        () => {
          bodyRan = true;
        },
        {
          dataRoot,
          io,
          force: false,
          alternative: "Stop the app first (`docker compose stop app`).",
        },
      ),
    ).rejects.toThrow("__exit:1");

    expect(bodyRan).toBe(false);
    expect(io.exitCode).toBe(1);
    const message = io.output.join("");
    // Names the command, the holder, and both remedies.
    expect(message).toContain("`npm run seed` refused to run");
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

    await runWithDataRootWriterLock(
      "`npm run rescan`",
      () => {
        bodyRan = true;
      },
      { dataRoot, force: true },
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

describe("cliLockRefusalMessage", () => {
  it("leads with the refused command, because the lock's own message says 'boot'", () => {
    const error = new DataRootLockedError({
      message: "Refusing to boot: another Viberr process is already writing /data.",
      verdict: "held",
      holder: SERVER,
      lockPath: "/data/state/writer.lock",
    });
    const message = cliLockRefusalMessage("`npm run rescan`", error);
    expect(message.startsWith("`npm run rescan` refused to run")).toBe(true);
    expect(message).toContain("Refusing to boot: another Viberr process");
  });
});
