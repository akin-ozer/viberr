import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_CACHE_KEEP_BYTES,
  buildRoomRefusal,
  supersededImagesToRemove,
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
    // Ruling 603(b): the refusal is below 8 GB, and none at it.
    expect(buildRoomRefusal({ path: "/x", freeBytes: 8 * GB, totalBytes: 239 * GB })).toBeNull();
  });
});

describe("supersededImagesToRemove (ruling 605)", () => {
  // The three untagged builds deploys 37 to 39 left on 2026-09-30.
  const left = [
    { id: "c0b73aaaece8", created: "2026-09-30T14:03:54.097576918Z" },
    { id: "09daab8b7d2c", created: "2026-09-30T14:19:38.504847633Z" },
    { id: "74a5bd442e3d", created: "2026-09-30T13:33:29.42972417Z" },
  ];

  it("keeps the build the deploy replaced and removes the older ones", () => {
    // CANARY: keep none (drop the slice) and the rollback image goes too.
    // CANARY: sort oldest first and the rollback image is the one removed.
    expect(supersededImagesToRemove(left)).toEqual(["c0b73aaaece8", "74a5bd442e3d"]);
  });

  it("removes nothing when the replaced build is the only one left", () => {
    expect(supersededImagesToRemove(left.slice(0, 1))).toEqual([]);
    expect(supersededImagesToRemove([])).toEqual([]);
  });
});

describe("BUILD_CACHE_KEEP_BYTES (ruling 628)", () => {
  it("keeps a whole build's layers, and every deploy trims the cache to it", () => {
    // Deploy 48's build used 2.17 GB of BuildKit's cache (`docker buildx du`,
    // 2026-10-01). A cap below that makes every deploy a cold build, the 5-6 GB
    // write ruling 603 measures the host for. CANARY: cap at 2 GiB, or drop the
    // prune from scripts/deploy.ts, and this fails.
    expect(BUILD_CACHE_KEEP_BYTES).toBeGreaterThan(2.17e9);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const deploy = readFileSync(path.join(root, "scripts/deploy.ts"), "utf8");
    expect(deploy).toContain('dockerOut("builder", "prune", "-f", "--max-used-space", String(BUILD_CACHE_KEEP_BYTES))');
  });
});
