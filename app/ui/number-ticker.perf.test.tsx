// @vitest-environment jsdom
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { NumberTicker } from "./number-ticker";
import { expectWithinBudget } from "../../test-support/perf-ratchet";

/**
 * Ruling 457 (LIVE-7 / CSS-2): the console footer's event count is a
 * NumberTicker, and a streaming run retargets it by one on every line. The
 * frame loop set a new float on every animation frame for the whole two
 * seconds, so React committed about 125 times for a figure that changed once
 * on screen.
 *
 * Fixture: <NumberTicker end={200}> settled, then retargeted, and the fake
 * clock advanced 160 frames of 16 ms (2.56 s), one act() per frame, inside a
 * Profiler counting commits.
 */

const CLOCK = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "performance",
  "setTimeout",
  "clearTimeout",
  "Date",
] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...CLOCK] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Commits and distinct texts drawn while the ticker counts from 200 to `to`. */
function retarget(to: number) {
  let commits = 0;
  const onRender = () => {
    commits += 1;
  };
  const view = render(
    <Profiler id="ticker" onRender={onRender}>
      <NumberTicker end={200} duration={2} start={200} />
    </Profiler>,
  );
  const el = view.container.querySelector("[data-count]")!;
  commits = 0;
  const texts = new Set<string>();
  view.rerender(
    <Profiler id="ticker" onRender={onRender}>
      <NumberTicker end={to} duration={2} start={200} />
    </Profiler>,
  );
  for (let frame = 0; frame < 160; frame += 1) {
    act(() => {
      vi.advanceTimersByTime(16);
    });
    texts.add(el.textContent ?? "");
  }
  return { commits, texts: [...texts], final: el.textContent };
}

describe("NumberTicker commits (ruling 457)", () => {
  it("a +1 commits once for the retarget and once for the digit", () => {
    const { commits, texts, final } = retarget(201);
    // The same look: it still lands on the target, through every figure between.
    expect(final).toBe("201");
    expect(texts).toEqual(["200", "201"]);
    expectWithinBudget("render:number-ticker.commits-per-plus-one", commits);
  });

  it("a +10 commits once per figure drawn on the way", () => {
    const { commits, texts, final } = retarget(210);
    expect(final).toBe("210");
    expect(texts).toContain("205");
    expectWithinBudget("render:number-ticker.commits-per-plus-ten", commits);
  });
});
