import { existsSync } from "node:fs";
import { dfReading, formatBytes, type RawDiskReading } from "./disk-space.server";

/**
 * Ruling 603: `npm run deploy` measures the host before it builds.
 *
 * An image build writes into Docker's disk, and on Docker Desktop that disk is
 * a sparse image file that grows on the host. Live on 2026-09-30 a cold build
 * (BuildKit had lost its cache) wrote about 5-6 GB, filled the Mac, and the
 * Docker VM remounted its disk read-only under the running instance. Nothing
 * inside the VM could have warned: the data volume there reported 940.8 GB free.
 * The host can see its own disk, so the deploy script asks before it builds.
 */

/** A cold build measured 5-6 GB; the rest is room for the running instance. */
export const MIN_FREE_FOR_BUILD_BYTES = 8 * 1024 ** 3;

export interface HostDiskReading extends RawDiskReading {
  path: string;
}

/**
 * The tightest of the host paths a build writes through, measured. Paths that
 * do not exist here are skipped (Docker Desktop's directory on a Linux host,
 * Docker's root directory on a Mac). Null when nothing could be measured.
 */
export function tightestHostDisk(
  paths: readonly string[],
  measure: (path: string) => RawDiskReading | null = dfReading,
): HostDiskReading | null {
  let tightest: HostDiskReading | null = null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const reading = measure(path);
    if (reading && (!tightest || reading.freeBytes < tightest.freeBytes)) {
      tightest = { path, ...reading };
    }
  }
  return tightest;
}

/** Why the build must not start, or null when the host has room for it. */
export function buildRoomRefusal(
  disk: HostDiskReading,
  minFreeBytes: number = MIN_FREE_FOR_BUILD_BYTES,
): string | null {
  if (disk.freeBytes >= minFreeBytes) return null;
  return (
    `x ${formatBytes(disk.freeBytes)} free on the host disk under ${disk.path}, and an image ` +
    `build needs ${formatBytes(minFreeBytes)}: a full host sends Docker's disk read-only under ` +
    `the running instance. Free space there (\`docker system df\` shows what Docker holds) ` +
    `and deploy again, or pass --skip-disk-check to build anyway.`
  );
}

/** An image a build left untagged: its id and when it was built (RFC 3339). */
export interface SupersededImage {
  id: string;
  created: string;
}

/**
 * Ruling 605: the images a verified deploy removes. Every build moves the tag
 * to the new image and leaves the one it replaced untagged, about 0.9 GB of
 * its own layers each: three deploys on 2026-09-30 left 2.6 GB on a host with
 * 20 GB free. The newest of them is the build this deploy replaced, kept so a
 * one-step rollback needs no rebuild; the older ones go.
 */
export function supersededImagesToRemove(images: readonly SupersededImage[]): string[] {
  return [...images]
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    .slice(1)
    .map((image) => image.id);
}
