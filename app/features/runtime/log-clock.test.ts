import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localLogClock } from "./log-clock";

/**
 * F15-08: the agent console printed the server's UTC wall clock while the
 * timeline right below it printed local time — the same event, hours apart.
 *
 * The zone is PINNED here and every expectation is a literal local clock: CI
 * runners are UTC and the repo sets no `TZ`, so an offset-derived expectation
 * held for a no-op helper and green-lit the bug forever. Europe/Berlin also
 * observes DST, which is what makes the day-anchoring assertions meaningful —
 * the same wall clock on two calendar days is two different local times across
 * the October edge.
 */

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("localLogClock", () => {
  it("reprojects a UTC wall clock into the viewer's zone", () => {
    // Before the fix the console rendered "17:46:46" verbatim, whatever the
    // viewer's zone; it now agrees with formatClock on the same instant.
    expect(localLogClock("17:46:46", "2026-07-28T17:40:00.000Z")).toBe(
      "19:46:46",
    );
  });

  it("keeps a line logged after UTC midnight on the run's NEXT day", () => {
    expect(localLogClock("00:05:12", "2026-07-28T23:50:00.000Z")).toBe(
      "02:05:12",
    );
  });

  it("anchors a long run's line FORWARD, not to the previous day", () => {
    // 15 h after startedAt: the nearest-day rule snapped this to 2026-10-24,
    // which is still CEST — an hour off the truth on the changeover day.
    expect(localLogClock("17:00:00", "2026-10-25T02:00:00.000Z")).toBe(
      "18:00:00",
    );
    // A clock reading slightly BEFORE startedAt (the run row lands after the
    // provider's first envelopes) stays on the anchor's day.
    expect(localLogClock("01:58:00", "2026-10-25T02:00:00.000Z")).toBe(
      "02:58:00",
    );
  });

  it("passes non-clock values through untouched", () => {
    // The synthetic `── resumed ──` boundary row carries an empty `t`.
    expect(localLogClock("", "2026-07-28T17:40:00.000Z")).toBe("");
    expect(localLogClock("17:46", "2026-07-28T17:40:00.000Z")).toBe("17:46");
  });

  it("falls back to `now` when the run has no startedAt yet", () => {
    const now = new Date("2026-07-28T17:40:00.000Z");
    expect(localLogClock("17:41:00", null, now)).toBe("19:41:00");
    // Around `now` a line sits on EITHER side, so the nearest day wins there: a
    // line stamped just before midnight belongs to the previous day.
    expect(
      localLogClock("23:58:00", null, new Date("2026-07-29T00:03:00.000Z")),
    ).toBe("01:58:00");
  });
});
