import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDayBucket,
  formatDayDotTime,
  formatDayTime,
  formatRelative,
} from "./format";

// Fixed "now": July 4 of the current-ish year, 10:45 local.
const NOW = new Date(2026, 6, 4, 10, 45, 0);

const at = (
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): string => new Date(y, m, d, hh, mm, 0).toISOString();

describe("formatClock", () => {
  it("renders 24h with no leading hour zero", () => {
    expect(formatClock(at(2026, 6, 4, 9, 41))).toBe("9:41");
    expect(formatClock(at(2026, 6, 3, 16, 4))).toBe("16:04");
    expect(formatClock(at(2026, 6, 4, 0, 5))).toBe("0:05");
  });
  it("returns empty string for garbage", () => {
    expect(formatClock("not-a-date")).toBe("");
  });
});

describe("formatDayBucket", () => {
  it("buckets today / yesterday / dated", () => {
    expect(formatDayBucket(at(2026, 6, 4, 9, 41), NOW)).toBe("Today");
    expect(formatDayBucket(at(2026, 6, 3, 16, 4), NOW)).toBe("Yesterday");
    expect(formatDayBucket(at(2026, 2, 30, 17, 26), NOW)).toBe("Mar 30");
  });
});

describe("formatDayTime (notification meta form)", () => {
  it("today shows the bare clock", () => {
    expect(formatDayTime(at(2026, 6, 4, 9, 41), NOW)).toBe("9:41");
  });
  it("other days prefix the bucket", () => {
    expect(formatDayTime(at(2026, 6, 3, 16, 4), NOW)).toBe("Yesterday 16:04");
    expect(formatDayTime(at(2026, 2, 30, 17, 26), NOW)).toBe("Mar 30 17:26");
  });
});

describe("formatDayDotTime (timeline form)", () => {
  it("uses the dot separator off-today", () => {
    expect(formatDayDotTime(at(2026, 6, 4, 9, 41), NOW)).toBe("9:41");
    expect(formatDayDotTime(at(2026, 6, 3, 16, 4), NOW)).toBe(
      "Yesterday · 16:04",
    );
  });
});

describe("formatRelative (home cards)", () => {
  it("covers the mock's forms", () => {
    expect(
      formatRelative(new Date(2026, 6, 4, 10, 44, 30).toISOString(), NOW),
    ).toBe("just now");
    expect(formatRelative(at(2026, 6, 4, 10, 43), NOW)).toBe("2m ago");
    expect(formatRelative(at(2026, 6, 4, 7, 45), NOW)).toBe("3h ago");
    expect(formatRelative(at(2026, 6, 3, 20, 0), NOW)).toBe("yesterday");
    expect(formatRelative(at(2026, 6, 1, 10, 0), NOW)).toBe("3d ago");
    expect(formatRelative(at(2026, 2, 30, 12, 0), NOW)).toBe("Mar 30");
  });
});
