// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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
    costedRuns: 42,
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
    interruptedNeverStarted: 0,
    interruptedByRestart: 0,
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
  oversight: {
    coordination: { coordinationCostUsd: 0.6, totalCostUsd: 1.2, share: 0.5 },
    clarity: { activeTasks: 8, clearTasks: 7, pct: 7 / 8 },
    traceability: { deliveredTasks: 5, tracedTasks: 5, pct: 1 },
    packetResolution: {
      resolved: 3,
      avgMs: 400_000,
      medianMs: 300_000,
      openNow: 1,
    },
    timeToReview: { tasks: 4, avgMs: 3_600_000, medianMs: 1_800_000 },
    longTimelines: 2,
  },
  backendQuota: [
    {
      backend: "claude",
      reading: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.91,
        resetsAt: 1_787_832_000,
        isUsingOverage: false,
        observedAt: "2026-08-23T11:59:00.000Z",
        credentialUserId: null,
        credentialLabel: null,
      },
      credentialRefused: null,
      exhausted: null,
    },
    { backend: "codex", reading: null, credentialRefused: null, exhausted: null },
  ],
  windowDays: 30,
  generatedAt: "2026-08-23T12:00:00.000Z",
};

describe("InsightsPage", () => {
  // D33-3: every top-level surface is addressable by name (surfaces.md §4);
  // Insights was the only one that was not, on the page AND in the empty state.
  it("carries the Insights screen label", () => {
    const noRuns: InsightsSummary = {
      ...FULL,
      totals: { runs: 0, costedRuns: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, turns: 0 },
    };
    for (const summary of [FULL, noRuns]) {
      const { container } = renderPage(summary);
      expect(
        container.querySelector('main[data-screen-label="Insights"]'),
      ).toBeTruthy();
      cleanup();
    }
  });

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

  // F35-1: the token sums cover provider totals only, and the card says so
  // while a run is running (FULL has two). Canary: drop the `outcomes.running`
  // clause on the card and the sentence is gone.
  it("F35-1: the token card says running runs are not counted while one is running", () => {
    const { container } = renderPage(FULL);
    const note = "Running runs are not counted until their provider total lands.";
    expect(container.textContent).toContain(note);
    cleanup();
    const quiet = renderPage(structuredClone(FULL));
    expect(quiet.container.textContent).toContain(note);
    cleanup();
    const idle = structuredClone(FULL);
    idle.outcomes.running = 0;
    expect(renderPage(idle).container.textContent).not.toContain(note);
  });

  it("renders the breakdown bars and the daily chart", () => {
    const { container, getByText, getAllByText } = renderPage(FULL);
    expect(getByText("By backend")).toBeTruthy();
    // Backend names appear in BOTH the by-backend breakdown and the quota panel.
    expect(getAllByText("claude").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("codex").length).toBeGreaterThanOrEqual(1);
    // One daily column per window day.
    expect(container.querySelectorAll(".daily-col")).toHaveLength(30);
    // The busiest backend bar fills 100%, the other proportionally less.
    const fills = container.querySelectorAll<HTMLElement>(".bar-fill");
    expect(fills[0]?.style.width).toBe("100%"); // claude (28, the max)
  });

  it("renders the oversight outcomes (pass 29)", () => {
    const { getByText } = renderPage(FULL);
    expect(getByText("Owner & state clarity")).toBeTruthy();
    // 7/8 active tasks clear → 88% (fmtPercent rounds).
    expect(getByText("88%")).toBeTruthy();
    expect(getByText("Branch & PR traceability")).toBeTruthy();
    expect(getByText("100%")).toBeTruthy();
    expect(getByText("Blocked-decision wait")).toBeTruthy();
    expect(getByText("Time to review-ready")).toBeTruthy();
    expect(getByText("Long timelines")).toBeTruthy();
  });

  // V3: the numerator is every coordination run, so the sub-text names both
  // kinds. Saying "operator runs" while the number also counts the controller
  // would send a reader looking for spend that is not there.
  it("attributes coordination spend to the operator AND the controller", () => {
    const { getByText } = renderPage(FULL);
    expect(getByText("Coordination overhead")).toBeTruthy();
    // CANARY: put "operator runs spent" back and the card credits the whole
    // coordination figure to one of the two kinds that produced it.
    // D04-U12: the denominator is named — cost-reporting runs only.
    expect(
      getByText("operator and controller runs spent $0.60 of $1.20 reported by cost-reporting runs"),
    ).toBeTruthy();
  });

  it("renders the backend quota readings — and a neutral 'no reading yet' for a silent backend", () => {
    const { getByText } = renderPage(FULL);
    expect(getByText("Backend quota")).toBeTruthy();
    // claude carries a 91% seven_day reading; codex has never reported one.
    expect(getByText(/91% of seven day/)).toBeTruthy();
    expect(getByText("no reading yet")).toBeTruthy();
  });

  it("a reading WITHOUT a utilization number says so — never 'no reading yet' beside a reset date", () => {
    // Live-caught (pass 29): the provider's five_hour envelopes often omit
    // `utilization`; the row used to render the contradiction
    // "no reading yet · resets 8/27/2026".
    const { getByText, queryByText } = renderPage({
      ...FULL,
      backendQuota: [
        {
          backend: "claude",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: null,
            resetsAt: 1_787_848_800,
            isUsingOverage: false,
            observedAt: "2026-08-27T12:59:20.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: null,
        },
        { backend: "codex", reading: null, credentialRefused: null, exhausted: null },
      ],
    });
    expect(getByText(/five hour · utilization not reported/)).toBeTruthy();
    // "no reading yet" belongs ONLY to codex (truly silent), not to claude.
    expect(queryByText("no reading yet")).toBeTruthy();
  });

  /**
   * D5 (pass 31): live-caught. Codex had been quota-blocked for days — every
   * run refused with the limit and its reset date in the provider's own words —
   * and this card read "no reading yet", because the live rate-limit channel it
   * was built on is Claude-only. A refused run is evidence, so it renders; but
   * it is WEAKER evidence than a reported utilization figure, so it says where
   * it came from and never borrows the percentage's voice.
   */
  const REFUSED = {
    resetsAt: Date.UTC(2026, 8, 18, 17, 20) / 1000, // 2026-09-18 17:20 UTC
    resetsAtPrecision: "prose" as const,
    providerText:
      "You've hit your usage limit. To continue using Codex, start a " +
      "free trial of Plus today, or try again at Sep 18th, 2026 5:20 PM.",
    runId: "run_abc",
    observedAt: "2026-08-31T09:00:00.000Z",
    credentialUserId: null,
    credentialLabel: null,
  };

  it("says the window is exhausted when a run was refused, and names that as its source", async () => {
    const { getByText, queryByText, container } = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        { backend: "codex", reading: null, credentialRefused: null, exhausted: REFUSED },
      ],
    });
    expect(getByText("usage limit reached")).toBeTruthy();
    // Honest about its provenance: this is not a utilization reading.
    expect(getByText(/from a refused run/)).toBeTruthy();
    // D32-2 (ruling 4): the refusal's hover title dates the run with the app's
    // ONE formatter ("<day> · <clock>"), never the server locale's
    // toLocaleString ("9/1/2026, 9:00:00 AM") — and with no stray "$" before
    // the date (a template-literal slip the first D32-2 edit shipped).
    await waitFor(() => {
      const bar = container.querySelector(".bar-cost[title^='run run_abc was refused ']")!;
      expect(bar).toBeTruthy();
      // formatDayDotTime: "HH:MM" today, else "<Yesterday | Mar 30> · HH:MM".
      expect(bar.getAttribute("title")).toMatch(
        /^run run_abc was refused (?:\d\d:\d\d|(?:Yesterday|[A-Z][a-z]{2} \d{1,2}) · \d\d:\d\d): You've hit your usage limit/,
      );
      expect(bar.getAttribute("title")).not.toContain("refused $");
    });
    expect(getByText(/retry after/)).toBeTruthy();
    // …and the contradiction this replaced is gone from the exhausted row
    // ("no reading yet" now belongs only to the genuinely silent claude row).
    expect(queryByText("usage limit reached · no reading yet")).toBeNull();
  });

  /**
   * F32-4 (pass 32): a REJECTED credential is a different fact from a spent
   * window — the backend cannot run anything until a person fixes it — and it
   * outranks a utilization reading the same backend reported earlier. The row
   * names its provenance (a refused run) and what retires it (a completed run).
   */
  it("says the credential was refused, above any earlier reading, and names what clears it", () => {
    const { getByText, queryByText } = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        {
          backend: "codex",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.2,
            resetsAt: null,
            isUsingOverage: false,
            observedAt: "2026-08-31T08:00:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: {
            providerText:
              "Codex authentication failed. Review the configured subscription credential." +
              "\n\nThe provider reported: Your access token could not be refreshed because your refresh token was already used.",
            runId: "run_auth",
            observedAt: "2026-08-31T09:00:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          exhausted: null,
        },
      ],
    });
    expect(getByText("credential refused")).toBeTruthy();
    expect(getByText(/clears when a run on this backend completes/)).toBeTruthy();
    // The stale 20% reading does not get to reassure anyone.
    expect(queryByText(/20% of five hour/)).toBeNull();
  });

  /**
   * V9 (pass 31): the Codex sentence names a wall clock in the ACCOUNT's
   * timezone, which this app does not know, so the instant behind it is only
   * good to about a day. Rendering it as a local time would state a minute we
   * cannot stand behind; the calendar date the provider actually named is the
   * honest resolution. A provider-emitted epoch is a real instant and keeps its
   * time.
   */
  it("renders a prose-derived reset as a calendar date, and an exact one as an instant", () => {
    const prose = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        { backend: "codex", reading: null, credentialRefused: null, exhausted: REFUSED },
      ],
    });
    // CANARY: drop `refusal.resetsAtPrecision === "exact"` from the hydrated
    // branch and this renders a to-the-minute local time nobody can vouch for.
    expect(prose.getByText(/retry after 2026-09-18/)).toBeTruthy();
    cleanup();

    const exact = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        {
          backend: "codex",
          reading: null,
          credentialRefused: null,
          exhausted: { ...REFUSED, resetsAtPrecision: "exact" },
        },
      ],
    });
    // Locale-independent assertion: the date-only form is what an exact reset
    // must NOT collapse to (its own rendering is the viewer's locale string).
    expect(exact.getByText(/retry after /)).toBeTruthy();
    expect(exact.queryByText(/retry after 2026-09-18/)).toBeNull();
    cleanup();

    // Pass 34 review: a `clock` reset is a to-the-minute UTC instant too (a
    // provider's "resets 11:50am (UTC)"), so it keeps its hour like `exact`.
    // Canary: drop the `clock` arm from the hydrated branch — the hour is lost
    // and the row collapses to the bare UTC day.
    const clock = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        {
          backend: "codex",
          reading: null,
          credentialRefused: null,
          exhausted: { ...REFUSED, resetsAtPrecision: "clock" },
        },
      ],
    });
    expect(clock.getByText(/retry after /)).toBeTruthy();
    expect(clock.queryByText(/retry after 2026-09-18/)).toBeNull();
  });

  /**
   * V4 (pass 31): the exhausted branch was checked BEFORE any reading, so a
   * refusal record outranked every later measurement the backend reported —
   * one momentary refusal pinned the row at "usage limit reached" / 100% while
   * the provider was answering runs again. A reading observed after the
   * refusal is fresher evidence from the same provider and wins.
   */
  it("prefers a utilization reading observed AFTER the refusal over the refusal", () => {
    const { getByText, queryByText, container } = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        {
          backend: "codex",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.12,
            resetsAt: null,
            isUsingOverage: false,
            // An hour after the refusal: the window is demonstrably open.
            observedAt: "2026-08-31T10:00:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: REFUSED,
        },
      ],
    });
    // CANARY: collapse `refusal` back to `exhausted` and the row reads "usage
    // limit reached" at 100% over a backend that is answering runs.
    expect(getByText(/12% of five hour/)).toBeTruthy();
    expect(queryByText("usage limit reached")).toBeNull();
    expect(queryByText(/from a refused run/)).toBeNull();
    // …and the track shows the reading's 12%, not the refusal's full bar.
    const fills = [...container.querySelectorAll<HTMLElement>(".bar-fill")];
    expect(fills.at(-1)?.style.width).toBe("12%");
  });

  it("keeps the refusal when the only reading predates it", () => {
    const { getByText, queryByText } = renderPage({
      ...FULL,
      backendQuota: [
        { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
        {
          backend: "codex",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.12,
            resetsAt: null,
            isUsingOverage: false,
            // BEFORE the refusal — stale, and the refusal is what happened next.
            observedAt: "2026-08-31T08:00:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: REFUSED,
        },
      ],
    });
    expect(getByText("usage limit reached")).toBeTruthy();
    expect(queryByText(/12% of five hour/)).toBeNull();
  });

  it("shows an empty state when there are no runs", () => {
    const { getByText, container } = renderPage({
      ...FULL,
      totals: { runs: 0, costedRuns: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, turns: 0 },
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

/** Ruling 130(d): a refused or exhausted row says whose account, and the
 *  reading row names the hour. Canary: drop the label interpolation. */
describe("ruling 130(d): whose account, and the hour", () => {
  it("an exhausted row names the account it billed; a reading row names the hour", () => {
    const { getByText } = renderPage({
      ...FULL,
      backendQuota: [
        {
          backend: "claude",
          reading: null,
          credentialRefused: null,
          exhausted: {
            resetsAt: 1_788_781_800, resetsAtPrecision: "exact", providerText: "session limit", runId: "run_1",
            observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: "u_arda", credentialLabel: "Arda Kaya",
          },
        },
        {
          backend: "codex",
          reading: {
            status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1_788_781_800, isUsingOverage: false,
            observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: null, credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: null,
        },
      ],
    });
    expect(getByText(/from a refused run on Arda Kaya's account/)).toBeTruthy();
    // The reading row names the HOUR (local once hydrated, UTC on the first
    // paint), never a bare calendar date.
    expect(getByText(/resets .+ · \d{1,2}:\d{2}/)).toBeTruthy();
  });

  it("a refused credential row names the account", () => {
    const { getByText } = renderPage({
      ...FULL,
      backendQuota: [
        {
          backend: "claude",
          reading: null,
          credentialRefused: { providerText: "token revoked", runId: "run_2", observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: "u_arda", credentialLabel: "Arda Kaya" },
          exhausted: null,
        },
        { backend: "codex", reading: null, credentialRefused: null, exhausted: null },
      ],
    });
    expect(getByText(/credential refused · Arda Kaya's account/)).toBeTruthy();
  });
});

/**
 * Pass 35 U35-7: the stopped count says how many a restart stopped and how
 * many never started, so a boot's toll reads as what it was and the rate's
 * smaller denominator is explained on the card. Canary: return the bare
 * `${outcomes.interrupted} stopped` from `stoppedLabel` and this fails.
 */
describe("Completion rate names restart-stopped and never-started runs", () => {
  it("renders the detail when either count is non-zero", () => {
    const { getByText } = renderPage({
      ...FULL,
      outcomes: { ...FULL.outcomes, interrupted: 23, interruptedByRestart: 23, interruptedNeverStarted: 17 },
    });
    expect(
      getByText("30 finished · 6 error · 23 stopped (23 by a restart, 17 never started) · 2 running"),
    ).toBeTruthy();
  });

  it("stays the plain count when neither applies", () => {
    const { getByText } = renderPage(FULL);
    expect(getByText("30 finished · 6 error · 4 stopped · 2 running")).toBeTruthy();
  });
});
