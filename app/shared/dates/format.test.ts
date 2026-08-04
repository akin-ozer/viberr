import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatClockUTC,
  formatDayBucket,
  formatDayBucketUTC,
  formatDayDotTime,
  formatDayDotTimeUTC,
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
  it("renders a zero-padded 24h clock", () => {
    expect(formatClock(at(2026, 6, 4, 9, 41))).toBe("09:41");
    expect(formatClock(at(2026, 6, 3, 16, 4))).toBe("16:04");
    // F19 — the case the design mock never contained, and the one the running
    // app hits constantly: store timestamps are UTC, so an evening event in a
    // UTC+3 viewer renders past local midnight on the 0 hour. Unpadded this
    // printed "0:05", which the audit panel stamped "today 0:05".
    expect(formatClock(at(2026, 6, 4, 0, 5))).toBe("00:05");
    expect(formatClock(at(2026, 6, 4, 0, 0))).toBe("00:00");
    expect(formatClock(at(2026, 6, 4, 0, 27))).toBe("00:27");
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
    expect(formatDayTime(at(2026, 6, 4, 9, 41), NOW)).toBe("09:41");
  });
  it("other days prefix the bucket", () => {
    expect(formatDayTime(at(2026, 6, 3, 16, 4), NOW)).toBe("Yesterday 16:04");
    expect(formatDayTime(at(2026, 2, 30, 17, 26), NOW)).toBe("Mar 30 17:26");
  });
});

describe("formatDayDotTime (timeline form)", () => {
  it("uses the dot separator off-today", () => {
    expect(formatDayDotTime(at(2026, 6, 4, 9, 41), NOW)).toBe("09:41");
    expect(formatDayDotTime(at(2026, 6, 3, 16, 4), NOW)).toBe(
      "Yesterday · 16:04",
    );
  });
});

describe("UTC variants (hydration-deterministic first pass)", () => {
  // Fixed UTC instants — output must not depend on the host timezone.
  const NOW_UTC = new Date("2026-07-04T10:45:00.000Z");
  it("formatClockUTC renders the UTC wall clock", () => {
    expect(formatClockUTC("2026-07-04T09:41:00.000Z")).toBe("09:41");
    expect(formatClockUTC("2026-07-04T00:18:00.000Z")).toBe("00:18");
    expect(formatClockUTC("2026-07-04T16:04:00.000Z")).toBe("16:04");
    expect(formatClockUTC("not-a-date")).toBe("");
  });
  it("formatDayBucketUTC is the absolute UTC day — never Today/Yesterday", () => {
    // 2026-07-04 IS NOW_UTC's own day, and still renders absolute: the
    // activity page groups by this value, where a now-relative bucket would
    // mismatch between the server render and hydration.
    expect(formatDayBucketUTC("2026-07-04T09:41:00.000Z")).toBe("Jul 4");
    expect(formatDayBucketUTC("2026-07-03T23:59:00.000Z")).toBe("Jul 3");
    expect(formatDayBucketUTC("not-a-date")).toBe("");
  });
  it("formatDayDotTimeUTC buckets by UTC day", () => {
    expect(formatDayDotTimeUTC("2026-07-04T09:41:00.000Z", NOW_UTC)).toBe(
      "09:41",
    );
    expect(formatDayDotTimeUTC("2026-07-03T16:04:00.000Z", NOW_UTC)).toBe(
      "Yesterday · 16:04",
    );
    expect(formatDayDotTimeUTC("2026-03-30T17:26:00.000Z", NOW_UTC)).toBe(
      "Mar 30 · 17:26",
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
