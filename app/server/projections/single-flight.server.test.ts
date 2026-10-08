import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REBUILD_MIN_INTERVAL_MS,
  RESCAN_MIN_INTERVAL_MS,
  runSingleFlight,
  throttledMessage,
} from "./single-flight.server";

/**
 * P13-D-33: `architecture.md` asks for targeted limits on expensive
 * sync/projection rebuilds; rescan/rebuild had no limiter, lock or
 * min-interval, so holding the button ran one full store sweep per click.
 */

describe("runSingleFlight", () => {
  // The cooldown reads the clock: each case sets it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first call and refuses the next one inside the interval", () => {
    let runs = 0;
    vi.setSystemTime(1_000);
    const call = () => runSingleFlight("k-first", () => ++runs, { minIntervalMs: 10_000 });

    expect(call()).toEqual({ status: "ran", result: 1 });
    expect(call()).toEqual({ status: "throttled", retryAfterMs: 10_000 });

    vi.setSystemTime(5_000);
    expect(call()).toEqual({ status: "throttled", retryAfterMs: 6_000 });
    expect(runs).toBe(1);
  });

  it("runs again once the interval has elapsed", () => {
    let runs = 0;
    vi.setSystemTime(0);
    const call = () => runSingleFlight("k-elapsed", () => ++runs, { minIntervalMs: 10_000 });

    call();
    vi.setSystemTime(10_000);
    expect(call()).toEqual({ status: "ran", result: 2 });
    expect(runs).toBe(2);
  });

  it("keys cooldowns independently — rescan never throttles rebuild", () => {
    vi.setSystemTime(0);
    const run = (key: string) => runSingleFlight(key, () => key, { minIntervalMs: 10_000 });

    expect(run("projections:rescan").status).toBe("ran");
    expect(run("projections:rebuild").status).toBe("ran");
    expect(run("projections:rescan").status).toBe("throttled");
  });

  it("holds the cooldown when the work THROWS — a failing sweep is the one not to hammer", () => {
    vi.setSystemTime(0);
    const boom = () =>
      runSingleFlight(
        "k-throws",
        () => {
          throw new Error("sweep failed");
        },
        { minIntervalMs: 10_000 },
      );

    expect(boom).toThrowError("sweep failed");
    expect(runSingleFlight("k-throws", () => "ok", { minIntervalMs: 10_000 }).status).toBe(
      "throttled",
    );
  });
});

describe("throttledMessage", () => {
  it("rounds up to whole seconds and never says 0s", () => {
    expect(throttledMessage("The store re-scan", 6_200)).toBe(
      "The store re-scan already ran a moment ago; try again in 7s.",
    );
    expect(throttledMessage("The projection rebuild", 40)).toContain("in 1s.");
  });
});

describe("intervals", () => {
  it("makes the heavier rebuild wait longer than the everyday re-scan", () => {
    expect(REBUILD_MIN_INTERVAL_MS).toBeGreaterThan(RESCAN_MIN_INTERVAL_MS);
  });
});
