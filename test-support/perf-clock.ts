import { vi } from "vitest";

/**
 * Ruling 454: the wall clock a perf fixture reads. A figure must not move
 * with the time of day or the zone the suite runs in, and the demo seed dates
 * its events from `new Date()` in LOCAL time (`todayAt(9, 58)`), while loaders
 * derive from the hour too. Measured on the real clock:
 *
 * - a comment on VIB-142 before 09:58 was stamped above a "newer" demo entry,
 *   so the re-projection raised `timeline.out_of_order` and ran one more
 *   statement (`writes:comment.sql` read 16 in the morning, 15 after);
 * - Home's greeting is two bytes longer from 12:00 to 17:59
 *   (`payload:home.loader-bytes`);
 * - a board card's `quiet` flag turns with the hours since its last activity
 *   (`payload:board-40.*`, twelve bytes).
 *
 * So every perf file that seeds or loads through the clock calls this first,
 * before the demo data is imported (its "today" is read once, at import), and
 * `vi.useRealTimers()` when it is done. The pin is a LOCAL time, so it is the
 * same hour of the same day in every zone, and late enough that every
 * `todayAt` event of the demo is in the past. Only `Date` is faked: timers,
 * `waitFor` and the fake runtime keep real time. The clock does not advance,
 * so two stamps taken in one fixture are equal, which the timeline accepts
 * (only a NEWER entry below an older one is out of order).
 */
export function pinPerfClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 24, 14, 0, 0, 0));
}
