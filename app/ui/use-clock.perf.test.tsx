// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useElapsed } from "~/features/runtime/runs-helpers";
import { useRelativeTime } from "./use-relative-time";
import { expectWithinBudget } from "../../test-support/perf-ratchet";

/**
 * Ruling 454 (RF-9): the page's clocks. Every relative stamp and every
 * elapsed counter ran its own interval, so a KB browser's file rows, Home's
 * project cards and a console's waiting rows each added one, and each tick
 * re-rendered its one row in a commit of its own.
 *
 * Fixture: twenty relative stamps (a KB browser's file rows) and three live
 * elapsed counters (a Live run strip and two waiting console rows), mounted by
 * a client render on a fake clock. (Under act() the ticks of separate
 * intervals batch into one commit anyway, so the figure pinned is the
 * intervals alive, not commits.)
 */

const START = Date.UTC(2026, 8, 24, 9, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Stamp({ iso }: { iso: string }) {
  const rel = useRelativeTime(iso);
  return <span className="stamp">{rel}</span>;
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const s = useElapsed(startedAt, true);
  return <span className="elapsed">{s}</span>;
}

function Page() {
  return (
    <div>
      {Array.from({ length: 20 }, (_, i) => (
        <Stamp key={i} iso={new Date(START - (i + 1) * 60_000).toISOString()} />
      ))}
      {Array.from({ length: 3 }, (_, i) => (
        <Elapsed key={i} startedAt={new Date(START - (i + 1) * 10_000).toISOString()} />
      ))}
    </div>
  );
}

describe("shared clocks (ruling 454)", () => {
  it("one interval per cadence, whatever the number of readers", () => {
    const view = render(<Page />);
    const stamps = () =>
      [...view.container.querySelectorAll(".stamp")].map((el) => el.textContent);
    const elapsed = () =>
      [...view.container.querySelectorAll(".elapsed")].map((el) => el.textContent);

    // The viewer's clock, from the first client render on.
    expect(stamps()[0]).toBe("1m ago");
    expect(stamps()[19]).toBe("20m ago");
    expect(elapsed()).toEqual(["10", "20", "30"]);
    expectWithinBudget("render:clock.intervals-per-page", vi.getTimerCount());

    // Thirty seconds on: every counter moved thirty times, every stamp aged.
    for (let s = 0; s < 30; s += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(elapsed()).toEqual(["40", "50", "60"]);
    expect(stamps()[0]).toBe("1m ago");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(stamps()[0]).toBe("2m ago");
    expect(stamps()[19]).toBe("21m ago");

    // Nothing is left ticking once the page goes.
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
