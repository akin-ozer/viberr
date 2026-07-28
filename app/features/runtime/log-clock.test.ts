import { describe, expect, it } from "vitest";
import { localLogClock } from "./log-clock";

/**
 * F15-08: the agent console printed the server's UTC wall clock while the
 * timeline right below it printed local time — the same event, hours apart.
 */

/** Minutes the test machine is offset from UTC on the anchor day. */
function offsetMinutes(iso: string): number {
  return -new Date(iso).getTimezoneOffset();
}

function shift(clock: string, minutes: number): string {
  const [h, m, s] = clock.split(":").map(Number) as [number, number, number];
  const total = ((h * 60 + m + minutes) % 1440 + 1440) % 1440;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}:${pad(s)}`;
}

describe("localLogClock", () => {
  it("reprojects a UTC wall clock into the viewer's zone", () => {
    const anchor = "2026-07-28T17:40:00.000Z";
    // Before the fix the console rendered "17:46:46" verbatim, whatever the
    // viewer's zone; it now agrees with formatClock on the same instant.
    expect(localLogClock("17:46:46", anchor)).toBe(
      shift("17:46:46", offsetMinutes(anchor)),
    );
    const asDate = new Date("2026-07-28T17:46:46.000Z");
    expect(localLogClock("17:46:46", anchor)).toBe(
      `${String(asDate.getHours()).padStart(2, "0")}:46:46`,
    );
  });

  it("keeps a line logged after UTC midnight on the run's NEXT day", () => {
    const anchor = "2026-07-28T23:50:00.000Z";
    const expected = new Date("2026-07-29T00:05:12.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(localLogClock("00:05:12", anchor)).toBe(
      `${pad(expected.getHours())}:${pad(expected.getMinutes())}:${pad(expected.getSeconds())}`,
    );
  });

  it("passes non-clock values through untouched", () => {
    // The synthetic `── resumed ──` boundary row carries an empty `t`.
    expect(localLogClock("", "2026-07-28T17:40:00.000Z")).toBe("");
    expect(localLogClock("17:46", "2026-07-28T17:40:00.000Z")).toBe("17:46");
  });

  it("falls back to `now` when the run has no startedAt yet", () => {
    const now = new Date("2026-07-28T17:40:00.000Z");
    const expected = new Date("2026-07-28T17:41:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(localLogClock("17:41:00", null, now)).toBe(
      `${pad(expected.getHours())}:${pad(expected.getMinutes())}:00`,
    );
  });
});
