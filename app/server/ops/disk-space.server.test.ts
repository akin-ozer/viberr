import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  classifyFreeBytes,
  DEFAULT_DISK_CRITICAL_FREE_BYTES,
  DEFAULT_DISK_LOW_FREE_BYTES,
  diskThresholds,
  formatBytes,
  measureDataRootSpace,
  resetDiskSpaceCacheForTests,
} from "./disk-space.server";

/**
 * Gap 16 — nothing in the app had ever measured free space on the data root.
 * These pin the measurement, the thresholds (and their env overrides), and the
 * one distinction that keeps the signal honest: an UNMEASURABLE volume is null,
 * not "0 bytes free".
 */

const ctx = createTestDbContext();

afterEach(() => {
  delete process.env.VIBERR_DISK_LOW_FREE_MB;
  delete process.env.VIBERR_DISK_CRITICAL_FREE_MB;
  resetDiskSpaceCacheForTests();
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
    process.env.VIBERR_DISK_LOW_FREE_MB = "10";
    process.env.VIBERR_DISK_CRITICAL_FREE_MB = "2";
    expect(diskThresholds()).toEqual({
      low: 10 * 1024 * 1024,
      critical: 2 * 1024 * 1024,
    });
    expect(classifyFreeBytes(5 * 1024 * 1024)).toBe("low");
    expect(classifyFreeBytes(1024 * 1024)).toBe("critical");
  });

  it("clamps a critical threshold configured above the low one", () => {
    process.env.VIBERR_DISK_LOW_FREE_MB = "1";
    process.env.VIBERR_DISK_CRITICAL_FREE_MB = "50";
    // Otherwise "low" would be unreachable and the warning tier would silently
    // never fire — the exact failure this whole gap is about.
    expect(diskThresholds()).toEqual({
      low: 50 * 1024 * 1024,
      critical: 50 * 1024 * 1024,
    });
  });

  it("ignores a nonsense override rather than disabling the signal", () => {
    process.env.VIBERR_DISK_LOW_FREE_MB = "not-a-number";
    expect(diskThresholds().low).toBe(DEFAULT_DISK_LOW_FREE_BYTES);
  });
});

describe("formatBytes", () => {
  it("renders operator-readable sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(16 * 1024 * 1024)).toBe("16 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });
});
