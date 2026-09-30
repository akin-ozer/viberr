import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRoomRefusal,
  MIN_FREE_FOR_BUILD_BYTES,
  tightestHostDisk,
} from "./host-disk.server";

/**
 * Ruling 603: `npm run deploy` measures the host before it builds. Live on
 * 2026-09-30 a cold build filled the Mac and Docker's disk went read-only under
 * the running instance; the deploy script now refuses a build the host has no
 * room for.
 */

const GB = 1024 ** 3;
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-host-disk-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tightestHostDisk", () => {
  it("measures every host path that exists and keeps the tightest", () => {
    const checkout = tempDir();
    const dockerDesktop = tempDir();
    const free = new Map([
      [checkout, 40 * GB],
      [dockerDesktop, 6 * GB],
    ]);
    const disk = tightestHostDisk(
      [checkout, dockerDesktop, path.join(checkout, "no-docker-root-here")],
      (p) => {
        const freeBytes = free.get(p);
        return freeBytes === undefined ? null : { freeBytes, totalBytes: 239 * GB };
      },
    );
    expect(disk).toEqual({ path: dockerDesktop, freeBytes: 6 * GB, totalBytes: 239 * GB });
  });

  it("is null when nothing could be measured", () => {
    expect(tightestHostDisk([tempDir()], () => null)).toBeNull();
  });
});

describe("buildRoomRefusal", () => {
  it("refuses a build the host has no room for, naming the disk and the way on", () => {
    const refusal = buildRoomRefusal({ path: "/Users/a/viberr", freeBytes: 5 * GB, totalBytes: 239 * GB });
    // CANARY: return null unconditionally and the build fills the host again.
    expect(refusal).toContain("5 GB free on the host disk under /Users/a/viberr");
    expect(refusal).toContain("--skip-disk-check");
  });

  it("lets a build start when the host has the room", () => {
    expect(
      buildRoomRefusal({ path: "/x", freeBytes: MIN_FREE_FOR_BUILD_BYTES, totalBytes: 239 * GB }),
    ).toBeNull();
  });
});
