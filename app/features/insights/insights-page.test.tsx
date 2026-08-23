// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { InsightsSummary } from "~/server/insights/insights-query.server";
import { InsightsPage } from "./insights-page";

afterEach(cleanup);

function renderPage(summary: InsightsSummary) {
  const Stub = createRoutesStub([
    { path: "/insights", Component: () => <InsightsPage summary={summary} /> },
  ]);
  return render(<Stub initialEntries={["/insights"]} />);
}

const FULL: InsightsSummary = {
  totals: {
    runs: 42,
    cost: 3.5,
    inputTokens: 120_000,
    cachedInputTokens: 40_000,
    outputTokens: 2_400_000,
    turns: 130,
  },
  outcomes: {
    finished: 30,
    error: 6,
    interrupted: 4,
    running: 2,
    queued: 0,
    successRate: 30 / 40,
  },
  byBackend: [
    { label: "claude", runs: 28, cost: 2.5 },
    { label: "codex", runs: 14, cost: 1.0 },
  ],
  byKind: [
    { label: "primary", runs: 20, cost: 2.0 },
    { label: "reviewer", runs: 15, cost: 1.0 },
    { label: "operator", runs: 7, cost: 0.5 },
  ],
  byProject: [{ label: "viberr-core", runs: 42, cost: 3.5 }],
  byModel: [{ label: "claude-sonnet-4-5", runs: 28, cost: 2.5 }],
  avgDurationMs: 185_000,
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    runs: i === 29 ? 5 : 0,
    cost: i === 29 ? 1.2 : 0,
  })),
  windowDays: 30,
  generatedAt: "2026-08-23T12:00:00.000Z",
};

describe("InsightsPage", () => {
  it("renders the headline stats", () => {
    const { getByText, container } = renderPage(FULL);
    expect(getByText("Insights")).toBeTruthy();
    // The stat cards carry the headline values (some also appear in a breakdown
    // row, so read them from the `.stat-val` column specifically).
    const statVals = [...container.querySelectorAll(".stat-val")].map(
      (el) => el.textContent,
    );
    expect(statVals).toContain("42"); // total runs
    expect(statVals).toContain("$3.50"); // total cost
    expect(getByText("2.4M")).toBeTruthy(); // output tokens (unique)
    expect(getByText("75%")).toBeTruthy(); // success rate 30/40
    expect(getByText("3m 5s")).toBeTruthy(); // avg duration 185s
  });

  it("renders the breakdown bars and the daily chart", () => {
    const { container, getByText } = renderPage(FULL);
    expect(getByText("By backend")).toBeTruthy();
    expect(getByText("claude")).toBeTruthy();
    expect(getByText("codex")).toBeTruthy();
    // One daily column per window day.
    expect(container.querySelectorAll(".daily-col")).toHaveLength(30);
    // The busiest backend bar fills 100%, the other proportionally less.
    const fills = container.querySelectorAll<HTMLElement>(".bar-fill");
    expect(fills[0]?.style.width).toBe("100%"); // claude (28, the max)
  });

  it("shows an empty state when there are no runs", () => {
    const { getByText, container } = renderPage({
      ...FULL,
      totals: { runs: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, turns: 0 },
    });
    expect(getByText(/No agent runs yet/)).toBeTruthy();
    expect(container.querySelector(".stat-grid")).toBeNull();
  });

  it("renders with a null success rate and null duration", () => {
    const { getAllByText } = renderPage({
      ...FULL,
      outcomes: { ...FULL.outcomes, finished: 0, error: 0, interrupted: 0, successRate: null },
      avgDurationMs: null,
    });
    // Both the success-rate and avg-duration cards read the "n/a" placeholder.
    expect(getAllByText("n/a").length).toBeGreaterThanOrEqual(2);
  });
});
