// @vitest-environment jsdom
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { formatDayDotTime, formatDayDotTimeUTC } from "~/shared/dates/format";
import { LocalDayDotTime } from "./local-time";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { observeMutations } from "../../test-support/render-counter";

/**
 * Ruling 454 (CSS-3): a timestamp list mounted on the client after the page
 * has hydrated (a navigation to a task, a new timeline row, a console opened
 * later) renders its viewer-local text in one commit. `useHydrated` used to
 * start false on every mount, so each such mount committed twice and rewrote
 * every stamp, which also shrank on screen ("Sep 24 · 11:02" to "14:02").
 *
 * Fixture: thirty `LocalDayDotTime` stamps mounted with testing-library's
 * client `render` (no hydration) in Pacific/Auckland, so the local and UTC
 * forms differ.
 */

const originalTz = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "Pacific/Auckland";
});
afterEach(() => {
  cleanup();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const STAMPS = Array.from(
  { length: 30 },
  (_, i) => `2026-07-${String(1 + i).padStart(2, "0")}T20:${String(i).padStart(2, "0")}:00.000Z`,
);

describe("timestamps mounted after hydration (ruling 454)", () => {
  it("render the viewer-local text in one commit, with no rewrite", () => {
    let commits = 0;
    const container = document.body.appendChild(document.createElement("div"));
    const dom = observeMutations(container);
    render(
      <Profiler id="stamps" onRender={() => commits++}>
        <ul>
          {STAMPS.map((iso) => (
            <li key={iso}>
              <LocalDayDotTime iso={iso} />
            </li>
          ))}
        </ul>
      </Profiler>,
      { container },
    );
    // The local form, which in Auckland is not the UTC one.
    const first = container.querySelector("li")!.textContent;
    expect(first).toBe(formatDayDotTime(STAMPS[0]!));
    expect(first).not.toBe(formatDayDotTimeUTC(STAMPS[0]!));
    expectWithinBudget("render:local-time.commits-per-client-mount", commits);
    expectWithinBudget(
      "render:local-time.text-rewrites-per-client-mount",
      dom.take().filter((r) => r.type === "characterData").length,
    );
  });
});
