import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAbsoluteUTC,
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
  // Fixed UTC instants — output must not depend on the host timezone, and
  // (since pass 34, C6) not on the wall clock either: no variant takes `now`.
  it("formatClockUTC renders the UTC wall clock", () => {
    expect(formatClockUTC("2026-07-04T09:41:00.000Z")).toBe("09:41");
    expect(formatClockUTC("2026-07-04T00:18:00.000Z")).toBe("00:18");
    expect(formatClockUTC("2026-07-04T16:04:00.000Z")).toBe("16:04");
    expect(formatClockUTC("not-a-date")).toBe("");
  });
  it("formatDayBucketUTC is the absolute UTC day — never Today/Yesterday", () => {
    // Whatever day "today" is, every stamp renders absolute: the activity page
    // groups by this value, where a now-relative bucket would mismatch between
    // the server render and hydration.
    expect(formatDayBucketUTC("2026-07-04T09:41:00.000Z")).toBe("Jul 4");
    expect(formatDayBucketUTC("2026-07-03T23:59:00.000Z")).toBe("Jul 3");
    expect(formatDayBucketUTC("not-a-date")).toBe("");
  });
  it("formatDayDotTimeUTC depends on the timestamp alone: absolute UTC day + UTC clock, never Today/Yesterday", () => {
    // It used to take `now` and branch on it (today → bare clock, yesterday →
    // "Yesterday · …"), so a server at 23:59:59Z and a viewer at 00:00:01Z
    // disagreed on every stamp at once (pass 34, C6). The LOCAL siblings above
    // keep their `now`.
    expect(formatDayDotTimeUTC("2026-07-04T09:41:00.000Z")).toBe("Jul 4 · 09:41");
    expect(formatDayDotTimeUTC("2026-07-03T16:04:00.000Z")).toBe("Jul 3 · 16:04");
    expect(formatDayDotTimeUTC("2026-03-30T17:26:00.000Z")).toBe("Mar 30 · 17:26");
    expect(formatDayDotTimeUTC("not-a-date")).toBe("");
    // The stamps a now-relative branch would rewrite: the real "today" and
    // "yesterday" still print the absolute form. A fixed instant could not
    // prove this against a function that reads the wall clock itself.
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const ABSOLUTE = /^[A-Z][a-z]{2} \d{1,2} · \d{2}:\d{2}$/;
    expect(formatDayDotTimeUTC(today)).toMatch(ABSOLUTE);
    expect(formatDayDotTimeUTC(today)).toBe(
      `${formatDayBucketUTC(today)} · ${formatClockUTC(today)}`,
    );
    expect(formatDayDotTimeUTC(yesterday)).toMatch(ABSOLUTE);
    expect(formatDayDotTimeUTC(yesterday)).not.toContain("Yesterday");
  });
});

describe("formatAbsoluteUTC (quota reset copy)", () => {
  it("renders the UTC date and minute, whatever the host zone", () => {
    expect(formatAbsoluteUTC("2026-09-03T11:50:42.000Z")).toBe("2026-09-03 11:50 UTC");
    // An offset input is the same instant, printed in UTC: 23:50 at +12:00 is
    // 11:50Z the same day, and 01:05 at +02:00 is the previous UTC day.
    expect(formatAbsoluteUTC("2026-09-03T23:50:00+12:00")).toBe("2026-09-03 11:50 UTC");
    expect(formatAbsoluteUTC("2026-09-04T01:05:00+02:00")).toBe("2026-09-03 23:05 UTC");
  });

  it("hands an unparseable input back unchanged rather than an empty label", () => {
    expect(formatAbsoluteUTC("next Tuesday")).toBe("next Tuesday");
    expect(formatAbsoluteUTC("")).toBe("");
  });
});

describe("formatCalendarDate is host-zone BY CONSTRUCTION (pass 34, C6)", () => {
  // The module-level `Intl.DateTimeFormat` resolves its zone at IMPORT, so a
  // `process.env.TZ` flip only reaches a freshly imported copy of the module.
  const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function importedIn(tz: string) {
    process.env.TZ = tz;
    vi.resetModules();
    return import("./format");
  }
  afterEach(() => {
    process.env.TZ = SYSTEM_ZONE;
    vi.resetModules();
  });

  it("renders the process zone's calendar day, so the browser shows the viewer's own", async () => {
    // 23:30Z on Jul 3 is already Jul 4 in Auckland (UTC+12).
    const iso = "2026-07-03T23:30:00.000Z";
    const auckland = await importedIn("Pacific/Auckland");
    expect(auckland.formatCalendarDate(iso)).toBe("Jul 4, 2026");
    const utc = await importedIn("UTC");
    expect(utc.formatCalendarDate(iso)).toBe("Jul 3, 2026");
    // Nobody "fixes" the hydration mismatch by pinning UTC in the formatter:
    // that would silently re-word every rendered date. The zone-neutral first
    // pass surfaces render instead is `utcDayKey`, which never moves.
    expect(auckland.utcDayKey(iso)).toBe("2026-07-03");
    expect(utc.utcDayKey(iso)).toBe("2026-07-03");
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
