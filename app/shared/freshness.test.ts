import { describe, expect, it } from "vitest";
import { observedAfter } from "./freshness";

describe("observedAfter", () => {
  const RECORDED = "2026-09-03T11:50:00.000Z";

  it("is true only for a strictly later instant", () => {
    expect(observedAfter("2026-09-03T11:50:00.001Z", RECORDED)).toBe(true);
    expect(observedAfter(RECORDED, RECORDED)).toBe(false);
    expect(observedAfter("2026-09-03T11:49:59.999Z", RECORDED)).toBe(false);
  });

  it("compares instants, not strings", () => {
    // 13:50 at +02:00 is the recorded instant itself; 14:00 at +02:00 is later.
    expect(observedAfter("2026-09-03T13:50:00+02:00", RECORDED)).toBe(false);
    expect(observedAfter("2026-09-03T14:00:00+02:00", RECORDED)).toBe(true);
  });

  it("never lets a missing or unreadable stamp displace a recorded claim", () => {
    expect(observedAfter(undefined, RECORDED)).toBe(false);
    expect(observedAfter("", RECORDED)).toBe(false);
    expect(observedAfter("not-a-date", RECORDED)).toBe(false);
    expect(observedAfter("2026-09-03T12:00:00.000Z", "not-a-date")).toBe(false);
  });
});
