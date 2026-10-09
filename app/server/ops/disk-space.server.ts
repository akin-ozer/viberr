import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { getEnv } from "~/server/config/env.server";
import { getDataRoot } from "~/server/files/file-store-root.server";

/**
 * Free-space awareness for the data root (gap 16).
 *
 * Canonical state in this product is FILES. `writeFileAtomic` stages a task.md
 * to a tmp path and renames it, and SQLite commits through a WAL on the same
 * volume — so a full disk does not present as "the disk is full", it presents
 * as scattered 500s, failed agent runs and a watcher that retries forever
 * (file-watch.service.server.ts treats ENOSPC as a transient watch error, which
 * is inode exhaustion semantics, not "the volume is full"). Nothing in the app
 * had ever asked how much room was left: no statfs, no threshold, no field on
 * the health payload. Growth was unbounded (gap 15) and unobserved at once.
 *
 * ## Why absolute byte thresholds, not percentages
 *
 * The quantities that consume this volume are absolute and known: a task
 * workspace clone is 11-16 MB, a run transcript is single-digit MB, a WAL
 * checkpoint is bounded by the DB size. A percentage threshold is wrong at both
 * ends — 10% of a 1 TB volume is 100 GB (permanently "low", so the signal is
 * ignored), and 10% of a 20 GB volume is 2 GB, which is roughly right by
 * accident. So the thresholds are byte counts sized against the writes this app
 * actually makes, and both are configurable:
 *
 *  - LOW (2 GiB free) — degraded, but the deployment still works. Enough room
 *    for many clone+run cycles; the operator has time to act. Surfaces on
 *    /resources/health and triggers an out-of-band maintenance pass.
 *  - CRITICAL (512 MiB free) — one clone-heavy run plus a WAL checkpoint can
 *    plausibly exhaust the volume from here. Logged at error level.
 *
 * `VIBERR_DISK_LOW_FREE_MB` / `VIBERR_DISK_CRITICAL_FREE_MB` override them,
 * read through `getEnv()`: the env schema holds the defaults and fails boot on
 * a value that is not a positive number (ruling 39).
 *
 * An unmeasurable volume returns `null`, NEVER a fabricated zero: "we could not
 * measure" and "there is no space" must not render the same (R17-5 — a
 * never-checked thing is not a failed thing).
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type DiskStatus = "ok" | "low" | "critical";

/** Which filesystem a reading measured (ruling 40). */
export type DiskSource = "data-root" | "host";

export interface DiskSpace {
  /** Bytes available to this (non-root) process on the measured filesystem. */
  freeBytes: number;
  /** Total size of that filesystem. */
  totalBytes: number;
  /** 0-100, rounded to one decimal. */
  usedPercent: number;
  status: DiskStatus;
  /**
   * `data-root` is the data root's own filesystem. `host` is the host disk
   * under it (`VIBERR_HOST_DISK_PATH`), reported when it has less room.
   */
  source: DiskSource;
  /** The thresholds in force, so a reader never has to guess why it is "low". */
  lowThresholdBytes: number;
  criticalThresholdBytes: number;
}

/** The free-space thresholds in force, in bytes (`critical` <= `low`). */
export interface DiskThresholds {
  low: number;
  critical: number;
}

function diskThresholds(): DiskThresholds {
  const env = getEnv();
  const low = Math.floor(env.VIBERR_DISK_LOW_FREE_MB * MB);
  const critical = Math.floor(env.VIBERR_DISK_CRITICAL_FREE_MB * MB);
  // A critical threshold above the low one would make "low" unreachable; the
  // configured pair is clamped rather than trusted blindly.
  return { low: Math.max(low, critical), critical };
}

function classifyFreeBytes(freeBytes: number, thresholds: DiskThresholds): DiskStatus {
  if (freeBytes < thresholds.critical) return "critical";
  if (freeBytes < thresholds.low) return "low";
  return "ok";
}

/**
 * One `statfs` on the data root. Returns null when the filesystem cannot be
 * measured (path gone, platform without statfs) — the caller reports "not
 * measured", never "0 bytes free".
 */
/** Raw bytes from one measurement source, before thresholds are applied. */
export interface RawDiskReading {
  freeBytes: number;
  totalBytes: number;
}

/**
 * The two ways the volume can be measured, injectable so a test can hand in
 * the exact shape a virtiofs bind mount produces without owning one.
 */
export interface DiskProbes {
  /** POSIX `df -kP`: counts in 1024-byte blocks, fragment-size aware. */
  df: (path: string) => RawDiskReading | null;
  /** `statfs(2)` as Node exposes it: `bsize` only, no `frsize`. */
  statfs: (path: string) => RawDiskReading | null;
}

/**
 * `df -kP` is the PRIMARY source, not a fallback (F32-1, pass 32). Node's
 * `statfsSync` reports `bsize` — the "optimal transfer size" — and never
 * `frsize`, the unit `blocks`/`bavail` are actually counted in. On every
 * ordinary Linux filesystem the two are equal, so nobody noticed; on a Docker
 * Desktop virtiofs bind mount `bsize` is ~1 MiB while `frsize` is 4 KiB, and the
 * product told the owner "1 TiB free of 62 TiB" while the host disk had 3.7 GB
 * left. `df` reads `frsize` (that is what `-k` normalizes), so its answer is
 * the volume's, on Linux and macOS alike; `statfs` stays as the fallback for a
 * platform without `df` on PATH, where its arithmetic is at least the right
 * order of magnitude.
 */
export function dfReading(path: string): RawDiskReading | null {
  let out: string;
  try {
    out = execFileSync("df", ["-kP", "--", path], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const lines = out.trim().split("\n");
  const last = lines[lines.length - 1]?.trim();
  if (!last || lines.length < 2) return null;
  // `-P` pins the POSIX layout: Filesystem 1024-blocks Used Available Capacity Mounted-on.
  // Split from the RIGHT: a filesystem name can carry spaces, the numbers cannot.
  const cols = last.split(/\s+/);
  if (cols.length < 6) return null;
  const totalKb = Number(cols[cols.length - 5]);
  const availKb = Number(cols[cols.length - 3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availKb) || totalKb <= 0) return null;
  return { totalBytes: totalKb * 1024, freeBytes: Math.max(0, availKb) * 1024 };
}

function statfsReading(path: string): RawDiskReading | null {
  let stats;
  try {
    stats = statfsSync(path);
  } catch {
    return null;
  }
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return null;
  return { totalBytes, freeBytes };
}

const DEFAULT_PROBES: DiskProbes = { df: dfReading, statfs: statfsReading };

function readPath(path: string, probes: DiskProbes): RawDiskReading | null {
  // A path that does not exist measures as nothing, whichever source answers:
  // `df` would happily report the parent volume of a typo'd root.
  if (!existsSync(path)) return null;
  return probes.df(path) ?? probes.statfs(path);
}

/**
 * One measurement of the data root. Returns null when the filesystem cannot be
 * measured by either source (path gone, platform without statfs) — the caller
 * reports "not measured", never "0 bytes free".
 *
 * Ruling 40: the data root's own filesystem is not always the disk that fills.
 * On Docker Desktop the store's named volume (ruling 38) lives on the VM's
 * ext4, a sparse disk image on the host that reports its virtual size: live on
 * 2026-09-30 it read 940.8 GB free while the Mac had 19.9 GB, and a build
 * filled the Mac until the VM remounted read-only. Compose mounts an empty host
 * directory read-only and names it in `VIBERR_HOST_DISK_PATH`. When that disk
 * has less room, it is the reading.
 */
export function measureDataRootSpace(
  dataRoot?: string,
  probes: DiskProbes = DEFAULT_PROBES,
): DiskSpace | null {
  const hostDiskPath = getEnv().VIBERR_HOST_DISK_PATH;
  const root = readPath(getDataRoot(dataRoot), probes);
  if (!root) return null;
  const host = hostDiskPath ? readPath(hostDiskPath, probes) : null;
  const [raw, source]: [RawDiskReading, DiskSource] =
    host && host.freeBytes < root.freeBytes ? [host, "host"] : [root, "data-root"];
  const { freeBytes, totalBytes } = raw;
  const thresholds = diskThresholds();
  return {
    freeBytes,
    totalBytes,
    usedPercent:
      totalBytes > 0
        ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10
        : 0,
    status: classifyFreeBytes(freeBytes, thresholds),
    source,
    lowThresholdBytes: thresholds.low,
    criticalThresholdBytes: thresholds.critical,
  };
}

/** How long a measurement is reused (the health probe is unauthenticated). */
const DISK_MEASUREMENT_TTL_MS = 5_000;

let snapshot: { at: number; value: DiskSpace | null } | null = null;

/**
 * Cached measurement for request paths. `/resources/health` is unauthenticated
 * and container platforms poll it every few seconds; one syscall per probe is
 * cheap but not free, and nothing needs sub-5s resolution on a disk that fills
 * over days.
 */
export function cachedDataRootSpace(): DiskSpace | null {
  const now = Date.now();
  if (snapshot && now - snapshot.at < DISK_MEASUREMENT_TTL_MS) {
    return snapshot.value;
  }
  const value = measureDataRootSpace();
  snapshot = { at: now, value };
  return value;
}

/** Test-only: drop the cached measurement. */
export function resetDiskSpaceCacheForTests(): void {
  snapshot = null;
}

/** Human-sized bytes for log lines ("1.4 GB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round((bytes / MB) * 10) / 10} MB`;
  return `${bytes} B`;
}
