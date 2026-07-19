// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useElapsed } from "./runs-helpers";

/**
 * F10-37 — `useElapsed` used to read `Date.now()` during render, so the server
 * and the first client render disagreed by however long the response spent in
 * flight: React reported a hydration mismatch and the elapsed clock flickered.
 * The fix seeds `now` to `null` and installs the real clock only after mount,
 * which makes SSR and first-paint markup byte-identical by construction.
 *
 * These pin that determinism directly (server string vs. first client render)
 * rather than just checking that a number eventually appears.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Elapsed({
  startedAt,
  active,
}: {
  startedAt: string | null;
  active: boolean;
}) {
  return <span data-testid="v">{useElapsed(startedAt, active)}</span>;
}

/** A start time far in the past — any Date.now() leak would show up loudly. */
const LONG_AGO = "2020-01-01T00:00:00.000Z";

describe("useElapsed determinism (F10-37)", () => {
  it("renders 0 on the server no matter how old startedAt is", () => {
    const html = renderToString(<Elapsed startedAt={LONG_AGO} active />);
    expect(html).toContain(">0<");
  });

  it("the FIRST client render matches the server render exactly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));

    const server = renderToString(<Elapsed startedAt={LONG_AGO} active />);

    // Advance the clock between the two renders, as a real response in flight
    // would. The first client render must still agree with the server — that
    // is the hydration contract. (Testing-library flushes effects on render,
    // so record the render-phase values rather than reading the settled DOM.)
    vi.setSystemTime(new Date("2026-07-20T12:00:09.000Z"));
    const seen: number[] = [];
    function Probe() {
      const v = useElapsed(LONG_AGO, true);
      seen.push(v);
      return <span>{v}</span>;
    }
    render(<Probe />);

    expect(server).toContain(">0<");
    expect(seen[0]).toBe(0);
    // ...and only afterwards does the real clock take over.
    expect(seen.at(-1)).toBeGreaterThan(0);
  });

  it("after mount it reports real elapsed seconds and ticks while active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:30.000Z"));

    const view = render(
      <Elapsed startedAt="2026-07-20T12:00:00.000Z" active />,
    );

    // The post-mount effect installs the real clock.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(view.getByTestId("v").textContent).toBe("30");

    // A running run keeps counting on the 1s interval.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.getByTestId("v").textContent).toBe("32");
  });

  it("an inactive run settles once and then stops ticking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:30.000Z"));

    const view = render(
      <Elapsed startedAt="2026-07-20T12:00:00.000Z" active={false} />,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(view.getByTestId("v").textContent).toBe("30");

    // No interval is installed for a finished run, so the value is frozen.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(view.getByTestId("v").textContent).toBe("30");
  });

  it("returns 0 for a missing or unparseable start time", () => {
    const none = render(<Elapsed startedAt={null} active />);
    expect(none.getByTestId("v").textContent).toBe("0");
    cleanup();

    const junk = render(<Elapsed startedAt="not-a-date" active />);
    expect(junk.getByTestId("v").textContent).toBe("0");
  });
});
