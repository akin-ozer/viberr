// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { NumberTicker } from "./number-ticker";

/** Ruling 366(f): the frame loop runs on the fake clock, sixteen ms a frame. */
const CLOCK = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "performance",
  "setTimeout",
  "clearTimeout",
  "Date",
] as const;

function figure(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-count]");
  if (!el) throw new Error("no ticker rendered");
  return el;
}

describe("NumberTicker", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...CLOCK] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("counts from the start figure to the end over the duration, easing out", () => {
    const { container } = render(<NumberTicker end={100} duration={2} />);
    const el = figure(container);
    // The first paint is the start; the target is readable at once.
    expect(el.textContent).toBe("0");
    expect(el.getAttribute("data-count")).toBe("100");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Ease-out cubic: half the time covers 87.5 % of the distance.
    const mid = Number(el.textContent);
    expect(mid).toBeGreaterThan(80);
    expect(mid).toBeLessThan(95);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(el.textContent).toBe("100");
  });

  it("a retarget counts on from the figure drawn, never back from the start", () => {
    const { container, rerender } = render(<NumberTicker end={100} duration={2} />);
    const el = figure(container);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(el.textContent).toBe("100");
    rerender(<NumberTicker end={140} duration={2} />);
    expect(el.getAttribute("data-count")).toBe("140");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const early = Number(el.textContent);
    expect(early).toBeGreaterThanOrEqual(100);
    expect(early).toBeLessThan(140);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(el.textContent).toBe("140");
  });

  it("a retarget mid-count carries on from the figure the count had reached", () => {
    const { container, rerender } = render(<NumberTicker end={100} duration={2} />);
    const el = figure(container);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const reached = Number(el.textContent);
    expect(reached).toBeGreaterThan(30);
    rerender(<NumberTicker end={200} duration={2} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(Number(el.textContent)).toBeGreaterThanOrEqual(reached);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(el.textContent).toBe("200");
  });

  it("counts down when the figure falls", () => {
    const { container, rerender } = render(<NumberTicker end={140} duration={2} />);
    const el = figure(container);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    rerender(<NumberTicker end={60} duration={2} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const early = Number(el.textContent);
    expect(early).toBeLessThanOrEqual(140);
    expect(early).toBeGreaterThan(60);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(el.textContent).toBe("60");
  });

  it("prefix, suffix and decimals dress the figure, on the target too", () => {
    const { container } = render(
      <NumberTicker end={12.5} decimals={1} prefix="~" suffix="k" duration={1} className="mono" />,
    );
    const el = figure(container);
    expect(el.textContent).toBe("~0.0k");
    expect(el.getAttribute("data-count")).toBe("12.5");
    expect(el.className).toBe("mono");
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(el.textContent).toBe("~12.5k");
  });

  it("a child writes the copy around the figure drawn, right at every frame", () => {
    const { container } = render(
      <NumberTicker end={3} duration={2}>
        {(n, text) => `${text} event${n === 1 ? "" : "s"}`}
      </NumberTicker>,
    );
    const el = figure(container);
    expect(el.textContent).toBe("0 events");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // Between 118 ms and 412 ms the eased figure rounds to one: the noun follows it.
    expect(el.textContent).toBe("1 event");
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(el.textContent).toBe("3 events");
  });

  it("stands still under reduced motion", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("reduce") }),
    });
    const { container } = render(<NumberTicker end={100} duration={2} />);
    // The mount effect already put the target on screen: no frame was asked for.
    expect(figure(container).textContent).toBe("100");
  });

  it("unmounting cancels the frame it was waiting on", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(<NumberTicker end={100} duration={2} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    unmount();
    expect(cancel).toHaveBeenCalled();
    // Nothing left on the clock touches an unmounted figure.
    expect(() => vi.advanceTimersByTime(2100)).not.toThrow();
  });
});
