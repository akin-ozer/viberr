import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  DEFAULT_DISK_CRITICAL_FREE_MB,
  DEFAULT_DISK_LOW_FREE_MB,
  resetEnvCacheForTests,
} from "~/server/config/env.server";
import {
  classifyFreeBytes,
  dfReading,
  diskThresholds,
  formatBytes,
  measureDataRootSpace,
} from "./disk-space.server";

/**
 * Gap 16 — nothing in the app had ever measured free space on the data root.
 * These pin the measurement, the thresholds (and their env overrides), and the
 * one distinction that keeps the signal honest: an UNMEASURABLE volume is null,
 * not "0 bytes free".
 */

const MB = 1024 * 1024;
const DEFAULT_DISK_LOW_FREE_BYTES = DEFAULT_DISK_LOW_FREE_MB * MB;
const DEFAULT_DISK_CRITICAL_FREE_BYTES = DEFAULT_DISK_CRITICAL_FREE_MB * MB;

/** The thresholds are read through `getEnv()`, which parses once per process:
 *  a case that sets them drops the cached parse (ruling 458(c)). */
function setThresholdsMb(env: {
  VIBERR_DISK_LOW_FREE_MB?: string;
  VIBERR_DISK_CRITICAL_FREE_MB?: string;
}): void {
  Object.assign(process.env, env);
  resetEnvCacheForTests();
}

const ctx = createTestDbContext();

afterEach(() => {
  delete process.env.VIBERR_DISK_LOW_FREE_MB;
  delete process.env.VIBERR_DISK_CRITICAL_FREE_MB;
  resetEnvCacheForTests();
  ctx.cleanup();
});

describe("measureDataRootSpace (gap 16)", () => {
  it("reports real free/total bytes for the data root", () => {
    const dataRoot = ctx.makeTempDir();
    const space = measureDataRootSpace(dataRoot);
    expect(space).not.toBeNull();
    expect(space!.totalBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
    expect(space!.usedPercent).toBeGreaterThanOrEqual(0);
    expect(space!.usedPercent).toBeLessThanOrEqual(100);
    // The thresholds travel with the reading so nobody has to guess why it is
    // "low" — the gap was that no reader existed at all.
    expect(space!.lowThresholdBytes).toBe(DEFAULT_DISK_LOW_FREE_BYTES);
    expect(space!.criticalThresholdBytes).toBe(DEFAULT_DISK_CRITICAL_FREE_BYTES);
  });

  it("returns null — not a fabricated zero — when the path cannot be measured", () => {
    const missing = `${ctx.makeTempDir()}/definitely/not/here`;
    expect(measureDataRootSpace(missing)).toBeNull();
  });

  // F32-1 (pass 32): on a Docker Desktop virtiofs bind mount `statfs` reports
  // `bsize` ≈ 1 MiB while the block counts are in 4 KiB fragments, so the
  // bsize arithmetic inflates the volume ~274× ("1 TiB free" on a host with
  // 3.7 GB left). `df -kP` reads the fragment size and is the primary source.
  const virtiofsStatfs = () => ({
    // 229 GB volume counted in 4 KiB fragments, multiplied by a 1 MiB bsize.
    totalBytes: 55_900_000 * 1_048_576,
    freeBytes: 903_000 * 1_048_576,
  });
  const dfTruth = () => ({
    totalBytes: 55_900_000 * 4096,
    freeBytes: 903_000 * 4096,
  });

  it("prefers df's fragment-aware reading over statfs's bsize arithmetic", () => {
    const dataRoot = ctx.makeTempDir();
    const space = measureDataRootSpace(dataRoot, {
      df: dfTruth,
      statfs: virtiofsStatfs,
    });
    expect(space).not.toBeNull();
    expect(space!.totalBytes).toBe(55_900_000 * 4096);
    expect(space!.freeBytes).toBe(903_000 * 4096);
    // 3.7 GB free is genuinely above the 2 GB "low" line — but the inflated
    // reading would have said ~925 GB and could never have gone red.
    expect(space!.status).toBe("ok");
    expect(space!.usedPercent).toBe(98.4);
  });

  it("falls back to statfs only when df cannot answer", () => {
    const dataRoot = ctx.makeTempDir();
    const space = measureDataRootSpace(dataRoot, {
      df: () => null,
      statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 1024 ** 3 }),
    });
    expect(space).toEqual(
      expect.objectContaining({
        totalBytes: 10 * 1024 ** 3,
        freeBytes: 1024 ** 3,
        status: "low",
      }),
    );
  });

  it("classifies the corrected reading, so a nearly full host can go critical", () => {
    const dataRoot = ctx.makeTempDir();
    const space = measureDataRootSpace(dataRoot, {
      df: () => ({ totalBytes: 229 * 1024 ** 3, freeBytes: 400 * 1024 ** 2 }),
      statfs: virtiofsStatfs,
    });
    expect(space!.status).toBe("critical");
  });

  it("reports null when neither source can measure the volume", () => {
    const dataRoot = ctx.makeTempDir();
    expect(
      measureDataRootSpace(dataRoot, { df: () => null, statfs: () => null }),
    ).toBeNull();
  });

  it("does not measure a missing root even though df would report its parent volume", () => {
    const missing = `${ctx.makeTempDir()}/gone`;
    expect(
      measureDataRootSpace(missing, { df: dfTruth, statfs: virtiofsStatfs }),
    ).toBeNull();
  });
});

describe("dfReading", () => {
  it("reads the host's df -kP output", () => {
    const dataRoot = ctx.makeTempDir();
    const reading = dfReading(dataRoot);
    // Real df on the test host: a positive total, free within it.
    expect(reading).not.toBeNull();
    expect(reading!.totalBytes).toBeGreaterThan(0);
    expect(reading!.freeBytes).toBeLessThanOrEqual(reading!.totalBytes);
  });
});

describe("thresholds", () => {
  it("classifies against the byte thresholds in force", () => {
    expect(classifyFreeBytes(DEFAULT_DISK_LOW_FREE_BYTES + 1)).toBe("ok");
    expect(classifyFreeBytes(DEFAULT_DISK_LOW_FREE_BYTES - 1)).toBe("low");
    expect(classifyFreeBytes(DEFAULT_DISK_CRITICAL_FREE_BYTES - 1)).toBe(
      "critical",
    );
  });

  it("is configurable in MB", () => {
    setThresholdsMb({
      VIBERR_DISK_LOW_FREE_MB: "10",
      VIBERR_DISK_CRITICAL_FREE_MB: "2",
    });
    expect(diskThresholds()).toEqual({
      low: 10 * 1024 * 1024,
      critical: 2 * 1024 * 1024,
    });
    expect(classifyFreeBytes(5 * 1024 * 1024)).toBe("low");
    expect(classifyFreeBytes(1024 * 1024)).toBe("critical");
  });

  it("clamps a critical threshold configured above the low one", () => {
    setThresholdsMb({
      VIBERR_DISK_LOW_FREE_MB: "1",
      VIBERR_DISK_CRITICAL_FREE_MB: "50",
    });
    // Otherwise "low" would be unreachable and the warning tier would silently
    // never fire — the exact failure this whole gap is about.
    expect(diskThresholds()).toEqual({
      low: 50 * 1024 * 1024,
      critical: 50 * 1024 * 1024,
    });
  });

  // Ruling 458(c): a nonsense override used to be ignored for the default. It
  // still cannot disable the signal, and it no longer passes in silence: the
  // env schema refuses it, which fails boot.
  it("refuses a nonsense override rather than disabling the signal", () => {
    setThresholdsMb({ VIBERR_DISK_LOW_FREE_MB: "not-a-number" });
    expect(() => diskThresholds()).toThrowError(
      /Invalid environment configuration:[\s\S]*VIBERR_DISK_LOW_FREE_MB/,
    );
  });
});

describe("formatBytes", () => {
  it("renders operator-readable sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(16 * 1024 * 1024)).toBe("16 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });
});
