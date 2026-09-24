// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { InsightsSummary } from "~/server/insights/insights-query.server";
import { InsightsPage } from "./insights-page";

afterEach(cleanup);

/** What a sighted reader sees: the element's text without its `.vh` copy. */
function visibleText(el: Element | null): string {
  const copy = el?.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const vh of copy.querySelectorAll(".vh")) vh.remove();
  return copy.textContent ?? "";
}

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
    tokenlessRuns: 2,
    turns: 130,
  },
  // Ruling 369: the prompt-cache record.
  cache: {
    byKind: [
      {
        label: "primary",
        runs: 20,
        firstCalls: 18,
        warmStarts: 5,
        warmRate: 5 / 18,
        writeTokens: 1_900_000,
        writeReportingRuns: 20,
        readTokens: 95_000_000,
        writeReadRatio: 0.02,
        largeFirstWrites: 1,
        ttl: { fiveMinute: 0, oneHour: 18, mixed: 0 },
      },
      {
        label: "operator",
        runs: 7,
        firstCalls: 0,
        warmStarts: 0,
        warmRate: null,
        writeTokens: 0,
        writeReportingRuns: 7,
        readTokens: 0,
        writeReadRatio: null,
        largeFirstWrites: 0,
        ttl: { fiveMinute: 0, oneHour: 0, mixed: 0 },
      },
    ],
    byCredentialKind: [
      {
        label: "login",
        runs: 27,
        firstCalls: 18,
        warmStarts: 5,
        warmRate: 5 / 18,
        writeTokens: 1_900_000,
        writeReportingRuns: 20,
        readTokens: 95_000_000,
        writeReadRatio: 0.02,
        largeFirstWrites: 1,
        ttl: { fiveMinute: 0, oneHour: 18, mixed: 0 },
      },
    ],
    largeWriteTokens: 100_000,
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
  // Ruling 308: a breakdown is its rows PLUS what the window left out.
  byBackend: {
    rows: [
      { label: "claude", runs: 28, cost: 2.5 },
      { label: "codex", runs: 14, cost: 1.0 },
    ],
    hidden: 0,
    hiddenRuns: 0,
    hiddenCost: null,
  },
  byKind: {
    rows: [
      { label: "primary", runs: 20, cost: 2.0 },
      { label: "reviewer", runs: 15, cost: 1.0 },
      { label: "operator", runs: 7, cost: 0.5 },
    ],
    hidden: 0,
    hiddenRuns: 0,
    hiddenCost: null,
  },
  byProject: {
    rows: [{ label: "viberr-core", runs: 42, cost: 3.5 }],
    hidden: 0,
    hiddenRuns: 0,
    hiddenCost: null,
  },
  byModel: {
    rows: [{ label: "claude-sonnet-4-5", runs: 28, cost: 2.5 }],
    hidden: 0,
    hiddenRuns: 0,
    hiddenCost: null,
  },
  byProfile: {
    rows: [{ label: "code-reviewer", runs: 15, cost: 1.0 }],
    hidden: 0,
    hiddenRuns: 0,
    hiddenCost: null,
  },
  byTask: {
    rows: [{ label: "viberr-core/VIB-1", runs: 9, cost: 0.75 }],
    hidden: 3,
    hiddenRuns: 11,
    hiddenCost: 0.4,
  },
  avgDurationMs: 185_000,
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    runs: i === 29 ? 5 : 0,
    cost: i === 29 ? 1.2 : 0,
  })),
  oversight: {
    coordination: {
      coordinationCostUsd: 0.6,
      totalCostUsd: 1.2,
      share: 0.5,
      runs: { delivery: 3, coordination: 2 },
      uncosted: { delivery: 0, coordination: 0 },
      uncostedByBackend: [],
      tokenShare: 0.25,
      coordinationTokens: 1_000,
      totalTokens: 4_000,
      tokenless: { delivery: 0, coordination: 0 },
    },
    clarity: { activeTasks: 8, clearTasks: 7, pct: 7 / 8 , unclear: []},
    traceability: { deliveredTasks: 5, tracedTasks: 5, pct: 1 , untraced: []},
    packetResolution: {
      resolved: 3,
      avgMs: 400_000,
      medianMs: 300_000,
      openNow: 1,
    },
    timeToReview: { tasks: 4, avgMs: 3_600_000, medianMs: 1_800_000 },
    longTimelines: 2,
    longTimelineKeys: [],
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
      totals: { runs: 0, costedRuns: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokenlessRuns: 0, turns: 0 },
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

  /**
   * F35-1: the token sums cover provider totals only, so the card names the
   * runs they leave out, off the sums' OWN count and with nothing running.
   * The old note was gated on a run being in flight and spoke only of running
   * runs, so on the common screen (nothing running, some stopped or errored
   * rows outside the sums) the page showed an understated headline and said
   * nothing. Canary: gate the sub on `outcomes.running` again and the first
   * assertion fails.
   */
  it("F35-1: the token card names the runs outside its sums, with nothing running", () => {
    const idle = structuredClone(FULL);
    idle.outcomes.running = 0;
    idle.totals.tokenlessRuns = 3;
    expect(renderPage(idle).container.textContent).toContain(
      "3 of 42 runs report no provider token total",
    );
    cleanup();
    // Every run reported a provider total: no qualifier at all.
    const clean = structuredClone(FULL);
    clean.totals.tokenlessRuns = 0;
    expect(renderPage(clean).container.textContent).not.toContain(
      "report no provider token total",
    );
  });

  it("renders the breakdown bars and the daily chart", () => {
    const { container, getByText, getAllByText } = renderPage(FULL);
    expect(getByText("By backend")).toBeTruthy();
    // Backend names appear in BOTH the by-backend breakdown and the quota panel.
    expect(getAllByText("claude").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("codex").length).toBeGreaterThanOrEqual(1);
    // One daily column per window day.
    expect(container.querySelectorAll(".daily-col")).toHaveLength(30);
    // Interface review 2026-09-24 (acce-5): the chart is a list whose items
    // say their day, run count and cost; as role="img" its children were
    // presentational and the per-day figures lived only in hover titles.
    const chart = container.querySelector(".daily-chart")!;
    expect(chart.getAttribute("role")).toBe("list");
    expect(chart.querySelectorAll('[role="listitem"]')).toHaveLength(30);
    const last = chart.querySelectorAll(".daily-col")[29]!;
    expect(last.querySelector(".vh")?.textContent).toBe(last.getAttribute("title"));
    expect(last.querySelector(".vh")?.textContent).toMatch(/^2026-07-30: 5 runs, /);
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
    // D04-U12 named the denominator as "cost-reporting runs"; ruling 201 made
    // that phrase unnecessary here, because this branch is reached only when
    // the denominator IS every run.
    expect(
      getByText("operator and controller runs spent $0.60 of $1.20; every run reported a cost"),
    ).toBeTruthy();
  });

  // Ruling 190 (F37-12, live): on a Codex-only delivery fleet the controller's
  // turns were the ENTIRE denominator, and the card answered "100%" to a
  // question the data cannot answer. A null share must not read as a measured
  // extreme — it must read as the gap it is.
  it("ruling 190: a share with nothing but coordination in it reads as a gap, not as 100%", () => {
    const { getByText, queryByText } = renderPage({
      ...FULL,
      oversight: {
        ...FULL.oversight,
        // FULL's traceability is a real 100%; move it so the only card that
        // could print "100%" here is the one under test.
        traceability: { deliveredTasks: 4, tracedTasks: 2, pct: 0.5 , untraced: []},
        coordination: {
          ...FULL.oversight.coordination,
          coordinationCostUsd: 4.34,
          totalCostUsd: 4.34,
          share: null,
          runs: { delivery: 32, coordination: 5 },
          uncosted: { delivery: 32, coordination: 0 },
          uncostedByBackend: [{ backend: "codex", runs: 32 }],
        },
      },
    });
    // CANARY: hand `share: 1` back and "100%" appears on the card.
    expect(queryByText("100%")).toBeNull();
    expect(
      getByText(
        "operator and controller runs reported $4.34; no delivery run reported a cost (32 on Codex), so there is no share to take",
      ),
    ).toBeTruthy();
  });

  /**
   * Ruling 201 (F37-21): the partial case. Ruling 190's sentence covers a side
   * that reported NOTHING; the ordinary mixed-backend instance has a side that
   * reported a LITTLE, and the old rule printed a confident percentage off it.
   * The card must name the quantity — "209 of 215" is the fact that makes the
   * suppression legible — and must still carry a real number, in tokens.
   */
  it("ruling 201: a partly-costed instance names how many runs are outside the figure, and the token share stands", () => {
    const { getByText, queryByText } = renderPage({
      ...FULL,
      oversight: {
        ...FULL.oversight,
        traceability: { deliveredTasks: 4, tracedTasks: 2, pct: 0.5 , untraced: []},
        coordination: {
          coordinationCostUsd: 13.38,
          totalCostUsd: 49.38,
          // CANARY: hand back `share: 13.38 / 49.38` and "27%" appears — the
          // figure ruling 201 exists to keep off the screen.
          share: null,
          runs: { delivery: 72, coordination: 143 },
          uncosted: { delivery: 32, coordination: 137 },
          uncostedByBackend: [{ backend: "codex", runs: 169 }],
          tokenShare: 0.087,
          coordinationTokens: 12_536_746,
          totalTokens: 144_595_424,
          tokenless: { delivery: 1, coordination: 0 },
        },
      },
    });
    expect(queryByText("27%")).toBeNull();
    expect(
      getByText(
        "operator and controller runs reported $13.38; 169 of 215 runs report no cost (169 on Codex), so there is no share to take",
      ),
    ).toBeTruthy();
    // The card that still says something true, in the unit both backends
    // report — and it discloses its own excluded row.
    expect(getByText("Coordination tokens")).toBeTruthy();
    expect(getByText("9%")).toBeTruthy();
    expect(
      getByText(
        "12.5M of 144.6M tokens processed; tokens, not dollars · 1 of 215 runs report no provider total",
      ),
    ).toBeTruthy();
  });

  /**
   * Ruling 211(g), from the adversarial self-review of ruling 201. The
   * parenthetical counts the WHOLE cost-silent population, so it may only ride
   * a clause that names the whole population. Attached to "no delivery run
   * reported a cost" while coordination was ALSO partly silent, it handed the
   * reader a number belonging to both sides under a sentence blaming one — and
   * hid the partly-silent coordination side, which is the very thing ruling 201
   * exists to disclose.
   */
  it("ruling 211(g): when BOTH sides are silent, the sentence says so and the count is labelled as the total", () => {
    const { getByText } = renderPage({
      ...FULL,
      oversight: {
        ...FULL.oversight,
        traceability: { deliveredTasks: 4, tracedTasks: 2, pct: 0.5 , untraced: []},
        coordination: {
          ...FULL.oversight.coordination,
          coordinationCostUsd: 13.38,
          totalCostUsd: 13.38,
          share: null,
          runs: { delivery: 32, coordination: 143 },
          uncosted: { delivery: 32, coordination: 137 },
          uncostedByBackend: [{ backend: "codex", runs: 169 }],
        },
      },
    });
    // CANARY: attach "(169 on Codex)" to the delivery-only clause (ruling 201's
    // shipped text) and the reader is told 169 delivery runs went silent when
    // there are only 32 of them.
    expect(
      getByText(
        "operator and controller runs reported $13.38; no delivery run reported a cost, and 169 of 175 runs report no cost in total (169 on Codex), so there is no share to take",
      ),
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

  it("names the reading's age and a refused credential's sentence in the accessibility tree, not only in `title` (acce-5)", async () => {
    const { container } = renderPage({
      ...FULL,
      backendQuota: [
        {
          backend: "claude",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.4,
            resetsAt: null,
            isUsingOverage: false,
            observedAt: "2026-08-27T12:59:20.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: null,
        },
        {
          backend: "codex",
          reading: null,
          credentialRefused: {
            providerText: "token revoked",
            runId: "run_2",
            observedAt: "2026-08-31T09:00:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          exhausted: null,
        },
      ],
    });
    await waitFor(() => {
      const observed = container.querySelector(".bar-cost[title^='observed ']")!;
      expect(observed.querySelector(".vh")?.textContent).toBe(" · " + observed.getAttribute("title"));
    });
    const refused = container.querySelector(".bar-cost[title^='run run_2 was refused ']")!;
    expect(refused.querySelector(".vh")?.textContent).toBe(" · " + refused.getAttribute("title"));
    expect(refused.querySelector(".vh")?.textContent).toContain("token revoked");
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
      // Interface review 2026-09-24 (acce-5): the same sentence in `.vh`, for
      // everyone a title never reaches.
      expect(bar.querySelector(".vh")?.textContent).toBe(" · " + bar.getAttribute("title"));
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
      totals: { runs: 0, costedRuns: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokenlessRuns: 0, turns: 0 },
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
    // paint), never a bare calendar date. The day bucket is optional: on the
    // fixture's own calendar day `formatDayDotTime` prints the bare clock.
    expect(getByText(/resets (.+ · )?\d{1,2}:\d{2}/)).toBeTruthy();
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

/**
 * Ruling 369: the prompt-cache panel — the warm-start rate over the runs that
 * have a first call, the write/read ratio, the large first writes and the TTL
 * lifetimes, by run kind and by credential kind, every figure on a `data-`
 * attribute; a group with no first call prints "n/a", never 0%.
 */
describe("the prompt-cache panel (ruling 369)", () => {
  it("renders both groupings with their figures", () => {
    const { container } = renderPage(FULL);
    const panel = container.querySelector('[data-comment-anchor="prompt-cache"]')!;
    expect(panel.querySelector("h2")?.textContent).toBe("Prompt cache");
    const primary = panel.querySelector('[data-cache-row="by run kind:primary"]')!;
    expect(primary.querySelector("[data-runs]")?.getAttribute("data-runs")).toBe("20");
    expect(visibleText(primary.querySelector("[data-warm-rate]"))).toBe("28%");
    expect(primary.querySelector("[data-warm-rate]")?.getAttribute("title")).toBe("5 of 18 first calls read more than they wrote");
    // Interface review 2026-09-24 (acce-5): the fraction reaches the
    // accessibility tree too, not only a hovering mouse.
    expect(primary.querySelector("[data-warm-rate] .vh")?.textContent).toBe(
      ", 5 of 18 first calls read more than they wrote",
    );
    expect(primary.querySelector("[data-write]")?.getAttribute("data-write")).toBe("1900000");
    expect(primary.querySelector("[data-write-read]")?.textContent).toBe("0.020");
    expect(primary.querySelector("[data-large]")?.textContent).toBe("1");
    expect(primary.querySelector("[data-ttl-1h]")?.textContent).toBe("18 × 1h");
    const operator = panel.querySelector('[data-cache-row="by run kind:operator"]')!;
    expect(visibleText(operator.querySelector("[data-warm-rate]"))).toBe("n/a");
    expect(operator.querySelector("[data-write-read]")?.textContent).toBe("n/a");
    expect(operator.querySelector("[data-ttl-1h]")?.textContent).toBe("not reported");
    expect(panel.querySelector('[data-cache-row="by credential kind:login"]')).not.toBeNull();
    // The line the large-write column counts against is named.
    expect(panel.textContent).toContain("above 100.0K");
  });

  it("scrolls the table in its own keyboard-reachable box, not the page (layo-21)", () => {
    // Eight nowrap columns are ~690px: without the wrap, /insights scrolled
    // sideways at phone width and at 200% zoom.
    const { getByRole } = renderPage(FULL);
    const region = getByRole("region", { name: "Prompt cache by group" });
    expect(region.classList.contains("md-table-wrap")).toBe(true);
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.querySelector("table.cache-table")).not.toBeNull();
  });
});

/**
 * Ruling 395 (F39-22): the write column obeys the rule the panel's own
 * docstring already states. Live it read `WRITTEN 0 · READ 45.0M · 0.000` for
 * 21 Codex runs, because Codex declares `cache_write_input_tokens` and answers
 * 0 for it every single time.
 */
describe("the prompt-cache panel: an unreported write (ruling 395)", () => {
  const UNREPORTED: InsightsSummary = {
    ...FULL,
    cache: {
      ...FULL.cache,
      byKind: [
        {
          label: "primary",
          runs: 21,
          firstCalls: 21,
          warmStarts: 3,
          warmRate: 3 / 21,
          writeTokens: null,
          writeReportingRuns: 0,
          readTokens: 45_000_000,
          writeReadRatio: null,
          largeFirstWrites: 0,
          ttl: { fiveMinute: 0, oneHour: 0, mixed: 0 },
        },
      ],
      byCredentialKind: [],
    },
  };

  it("says not reported, empties the data attribute, and keeps the ratio n/a", () => {
    const { container } = renderPage(UNREPORTED);
    const panel = container.querySelector('[data-comment-anchor="prompt-cache"]')!;
    const primary = panel.querySelector('[data-cache-row="by run kind:primary"]')!;
    // CANARY: print `fmtTokens(r.writeTokens ?? 0)` here and the cell reads "0"
    // beside a 45.0M read, which is what the live instance showed.
    expect(primary.querySelector("[data-write]")?.textContent).toBe("not reported");
    expect(primary.querySelector("[data-write]")?.getAttribute("data-write")).toBe("");
    expect(primary.querySelector("[data-write-read]")?.textContent).toBe("n/a");
    // The read beside it is a real figure and stays one.
    expect(primary.querySelector("[data-read]")?.textContent).toBe("45.0M");
    // And the caption says which backends answer the question at all.
    expect(panel.textContent).toContain("Codex reports neither");
  });
});
