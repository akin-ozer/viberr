// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, useLocation } from "react-router";
import type {
  InsightsSummary,
  QuotaWindow,
  RunAnalytics,
} from "~/server/insights/insights-query.server";
import type { BackendQuotaRow } from "~/server/runtimes/backend-quota.server";
import { InsightsPage } from "./insights-page";

afterEach(cleanup);

/** What a sighted reader sees: the element's text without its `.vh` copy. */
function visibleText(el: Element | null): string {
  const copy = el?.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const vh of copy.querySelectorAll(".vh")) vh.remove();
  return copy.textContent ?? "";
}

/** The usage-limits card's note, under its rows. */
function quotaNote(container: Element): string {
  return container.querySelector(".usage-limits > p.fine")?.textContent ?? "";
}

/** One figure of a band, by its label (ruling 642). */
function metric(container: Element, label: string): Element {
  const found = [...container.querySelectorAll(".metric")].find(
    (m) => m.querySelector(".metric-label")?.textContent === label,
  );
  if (!found) throw new Error(`no figure labelled ${label}`);
  return found;
}

/** The URL's query, where the switch writes its choice. */
function SearchProbe() {
  return <output data-search={useLocation().search} />;
}

/** `search` is the URL's query: the backend switch reads `?backend=`. */
function renderPage(summary: InsightsSummary, search = "") {
  const Stub = createRoutesStub([
    {
      path: "/insights",
      Component: () => (
        <>
          <InsightsPage summary={summary} />
          <SearchProbe />
        </>
      ),
    },
  ]);
  return render(<Stub initialEntries={[`/insights${search}`]} />);
}

type Row = RunAnalytics["byKind"]["rows"][number];
/** A breakdown row; its printed name is its key unless the row says. */
const named = (row: Omit<Row, "name"> & { name?: string }): Row => ({ ...row, name: row.name ?? row.label });

const breakdown = (rows: (Omit<Row, "name"> & { name?: string })[]): RunAnalytics["byKind"] => ({
  rows: rows.map(named),
  hidden: 0,
  hiddenRuns: 0,
  hiddenCost: null,
  hiddenTokens: null,
});

/** Ruling 635: Claude's runs, the page's view of one backend. */
const CLAUDE: RunAnalytics = {
  backend: "claude",
  measure: "cost",
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
  coordination: {
    measure: "cost",
    coordination: 0.6,
    total: 1.2,
    share: 0.5,
    reached: { delivery: 3, coordination: 2 },
    silent: { delivery: 0, coordination: 0 },
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
        // Ruling 505: PLAN.md's baseline columns.
        avgFirstCallWrite: 14_000,
        readPerRun: 95_000_000 / 18,
        peakPrompt: { median: 108_000, p90: 226_000, max: 482_000 },
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
        avgFirstCallWrite: null,
        readPerRun: null,
        peakPrompt: null,
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
        avgFirstCallWrite: 14_000,
        readPerRun: 95_000_000 / 18,
        peakPrompt: { median: 108_000, p90: 226_000, max: 482_000 },
      },
    ],
    reportsWrites: true,
    largeWriteTokens: 100_000,
    // Ruling 505: resumes by idle time, the edges being every TTL assumed.
    resumes: {
      edgesMs: [5 * 60_000, 10 * 60_000, 60 * 60_000, 24 * 60 * 60_000],
      freshContextTokens: 150_000,
      rows: [
        {
          label: "login",
          assumedTtlMs: 60 * 60_000,
          cells: [
            { firstCalls: 3, warmStarts: 3, warmRate: 1 },
            { firstCalls: 0, warmStarts: 0, warmRate: null },
            { firstCalls: 5, warmStarts: 4, warmRate: 0.8 },
            { firstCalls: 2, warmStarts: 0, warmRate: 0 },
            { firstCalls: 0, warmStarts: 0, warmRate: null },
          ],
          setAside: 1,
        },
      ],
    },
    // Ruling 505: the operator bursts, counted before any gate is built.
    operatorBursts: {
      starts: 141,
      inBursts: 12,
      coldInBursts: 1,
      coldBurstWrite: 26_700,
      coldStarts: 3,
      windowMs: 60_000,
    },
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
  byKind: breakdown([
    { label: "primary", name: "Delivering", runs: 20, cost: 2.0, tokens: 1_500_000 },
    { label: "reviewer", name: "Supporting", runs: 15, cost: 1.0, tokens: 800_000 },
    { label: "operator", name: "Operator", runs: 7, cost: 0.5, tokens: 220_000 },
  ]),
  byProject: breakdown([{ label: "viberr-core", runs: 42, cost: 3.5, tokens: 2_520_000 }]),
  byModel: breakdown([{ label: "claude-sonnet-4-5", runs: 42, cost: 3.5, tokens: 2_520_000 }]),
  byProfile: breakdown([{ label: "code-reviewer", runs: 15, cost: 1.0, tokens: 800_000 }]),
  byTask: {
    rows: [named({ label: "viberr-core/VIB-1", runs: 9, cost: 0.75, tokens: 400_000 })],
    hidden: 3,
    hiddenRuns: 11,
    hiddenCost: 0.4,
    hiddenTokens: 300_000,
  },
  avgDurationMs: 185_000,
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    runs: i === 29 ? 5 : 0,
    cost: i === 29 ? 1.2 : 0,
    tokens: i === 29 ? 600_000 : 0,
  })),
  quota: {
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
  quotaWindows: [{ rateLimitType: "seven_day", utilization: 0.91, resetsAt: 1_787_832_000, reset: false }],
  windowDays: 30,
};

/** Ruling 635: Codex's runs. No cost, no cache write: weighed in tokens. */
const CODEX: RunAnalytics = {
  ...CLAUDE,
  backend: "codex",
  measure: "tokens",
  totals: {
    runs: 14,
    costedRuns: 0,
    cost: 0,
    inputTokens: 3_831_292_921,
    cachedInputTokens: 3_695_003_264,
    outputTokens: 33_008_750,
    tokenlessRuns: 0,
    turns: 30_650,
  },
  coordination: {
    measure: "tokens",
    coordination: 1_200,
    total: 9_400,
    share: 1_200 / 9_400,
    reached: { delivery: 3, coordination: 1 },
    silent: { delivery: 0, coordination: 0 },
  },
  byKind: breakdown([
    { label: "reviewer", runs: 437, cost: null, tokens: 1_150_000_000 },
    { label: "primary", runs: 150, cost: null, tokens: 2_550_000_000 },
  ]),
  byTask: {
    rows: [named({ label: "aws-cost-calculator/AWSC-52", runs: 41, cost: null, tokens: 210_000_000 })],
    hidden: 3,
    hiddenRuns: 11,
    hiddenCost: null,
    hiddenTokens: 3_300,
  },
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    runs: i === 29 ? 5 : 0,
    cost: i === 29 ? null : 0,
    tokens: i === 29 ? 2_400_000_000 : 0,
  })),
  cache: {
    ...CLAUDE.cache,
    byKind: [
      {
        label: "primary",
        runs: 150,
        firstCalls: 139,
        warmStarts: 83,
        warmRate: 83 / 139,
        writeTokens: null,
        writeReportingRuns: 0,
        readTokens: 2_546_400_000,
        writeReadRatio: null,
        largeFirstWrites: 0,
        ttl: { fiveMinute: 0, oneHour: 0, mixed: 0 },
        avgFirstCallWrite: null,
        readPerRun: 60_000_000 / 14,
        peakPrompt: { median: 90_000, p90: 175_000, max: 210_000 },
      },
    ],
    byCredentialKind: [],
    reportsWrites: false,
    resumes: {
      ...CLAUDE.cache.resumes,
      rows: [
        {
          label: "login",
          assumedTtlMs: 10 * 60_000,
          cells: [
            { firstCalls: 2, warmStarts: 2, warmRate: 1 },
            { firstCalls: 1, warmStarts: 1, warmRate: 1 },
            { firstCalls: 3, warmStarts: 1, warmRate: 1 / 3 },
            { firstCalls: 0, warmStarts: 0, warmRate: null },
            { firstCalls: 0, warmStarts: 0, warmRate: null },
          ],
          setAside: 0,
        },
      ],
    },
    operatorBursts: null,
  },
  quota: { backend: "codex", reading: null, credentialRefused: null, exhausted: null },
  quotaWindows: [],
};

const FULL: InsightsSummary = {
  oversight: {
    clarity: { activeTasks: 8, clearTasks: 7, pct: 7 / 8, unclear: [] },
    traceability: { deliveredTasks: 5, tracedTasks: 5, pct: 1, untraced: [] },
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
  backends: [
    { backend: "claude", runs: 42 },
    { backend: "codex", runs: 14 },
  ],
  runs: [CLAUDE, CODEX],
};

/** FULL with one backend's runs patched (Claude's unless `base` says). */
function withRuns(patch: Partial<RunAnalytics>, base: RunAnalytics = CLAUDE): InsightsSummary {
  return { ...FULL, runs: FULL.runs.map((r) => (r.backend === base.backend ? { ...base, ...patch } : r)) };
}

/** FULL with one backend's quota, its windows given or none. Render a Codex
 *  one under `?backend=codex`. */
function withQuota(quota: BackendQuotaRow, quotaWindows: QuotaWindow[] = []): InsightsSummary {
  return withRuns({ quota, quotaWindows }, quota.backend === "codex" ? CODEX : CLAUDE);
}

describe("InsightsPage", () => {
  // D33-3: every top-level surface is addressable by name (surfaces.md §4);
  // Insights was the only one that was not, on the page AND in the empty state.
  it("carries the Insights screen label", () => {
    const noRuns: InsightsSummary = {
      ...FULL,
      backends: [
        { backend: "claude", runs: 0 },
        { backend: "codex", runs: 0 },
      ],
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
    // The figures carry the headline values (some also appear in a breakdown
    // row, so read them from the `.metric-val` slot specifically).
    const statVals = [...container.querySelectorAll(".metric-val")].map(
      (el) => el.textContent,
    );
    expect(statVals).toContain("42"); // runs
    expect(statVals).toContain("$3.50"); // cost
    expect(statVals).toContain("2.5M"); // tokens, in + out
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
    const idle = structuredClone(CLAUDE);
    idle.outcomes.running = 0;
    idle.totals.tokenlessRuns = 3;
    expect(renderPage(withRuns(idle)).container.textContent).toContain(
      "3 of 42 runs report no provider total",
    );
    cleanup();
    // Every run reported a provider total: no qualifier at all.
    const clean = structuredClone(CLAUDE);
    clean.totals.tokenlessRuns = 0;
    expect(renderPage(withRuns(clean)).container.textContent).not.toContain(
      "report no provider total",
    );
  });

  it("renders the breakdown bars and the daily chart", () => {
    const { container } = renderPage(FULL, "?by=kind");
    // Ruling 642: one table under a switch, its columns named once.
    const table = container.querySelector(".breakdown-table")!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Kind", "Runs", "Cost"]);
    // Each row prints its name and keeps its key in the title.
    const names = [...table.querySelectorAll<HTMLElement>("tbody .bd-name")];
    expect(names.map((n) => n.textContent)).toEqual(["Delivering", "Supporting", "Operator"]);
    expect(names.map((n) => n.title)).toEqual(["primary", "reviewer", "operator"]);
    // A row's bar measures what the rows are ordered by: cost here.
    // CANARY: size the bars by runs again and the second reads 75%, a bar
    // that answers a different question from the order beside it.
    expect([...table.querySelectorAll<HTMLElement>(".bd-fill")].map((f) => f.style.width)).toEqual([
      "100%",
      "50%",
      "25%",
    ]);
    // One daily column per window day.
    expect(container.querySelectorAll(".daily-col")).toHaveLength(30);
    // Interface review 2026-09-24 (acce-5): the chart is a list whose items
    // say their day, run count and cost; as role="img" its children were
    // presentational and the per-day figures lived only in hover titles.
    const chart = container.querySelector(".daily-chart")!;
    expect(chart.getAttribute("role")).toBe("list");
    expect(chart.getAttribute("aria-label")).toBe("Claude runs per day over the last 30 days");
    expect(chart.querySelectorAll('[role="listitem"]')).toHaveLength(30);
    const last = chart.querySelectorAll(".daily-col")[29]!;
    expect(last.querySelector(".vh")?.textContent).toBe("2026-07-30: 5 runs, $1.20");
    // Ruling 642: the base names its first, middle and last days, and the head
    // totals the window.
    expect([...chart.querySelectorAll(".daily-tick")].map((t) => t.textContent)).toEqual(["Jul 1", "Jul 15", "Jul 30"]);
    expect(container.querySelector(".daily-panel .panel-head .right")?.textContent).toBe(
      "Last 30 days · 5 runs · $1.20",
    );
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
    expect(getByText("Coordination share")).toBeTruthy();
    expect(getByText("50%")).toBeTruthy();
    // CANARY: put "operator runs" back and the card credits the whole
    // coordination figure to one of the two kinds that produced it.
    expect(getByText("operator and controller runs, $0.60 of $1.20")).toBeTruthy();
  });

  // Ruling 190 (F37-12, live): a delivery side that reported no cost left the
  // controller's turns as the ENTIRE denominator, and the card answered "100%"
  // to a question the data cannot answer. A null share must not read as a
  // measured extreme — it must read as the gap it is.
  it("ruling 190: a share with nothing but coordination in it reads as a gap, not as 100%", () => {
    const { getByText, container } = renderPage({
      ...withRuns({
        coordination: {
          measure: "cost",
          coordination: 4.34,
          total: 4.34,
          share: null,
          reached: { delivery: 32, coordination: 5 },
          silent: { delivery: 32, coordination: 0 },
        },
      }),
      // FULL's traceability is a real 100%; move it so the only card that
      // could print "100%" here is the one under test.
      oversight: { ...FULL.oversight, traceability: { deliveredTasks: 4, tracedTasks: 2, pct: 0.5, untraced: [] } },
    });
    // CANARY: hand `share: 1` back and "100%" appears on the card.
    expect([...container.querySelectorAll(".metric-val")].map((v) => v.textContent)).not.toContain("100%");
    expect(getByText("no delivery run reported a cost, so there is no share to take")).toBeTruthy();
  });

  it("names whose quota it reads, and a neutral 'no reading yet' for a backend that never reported", () => {
    const { getByText, container } = renderPage(FULL);
    expect(getByText("Usage limits")).toBeTruthy();
    // Claude's 91% weekly window, and the provider's own warning under it.
    const row = container.querySelector('[data-quota-window="seven_day"]')!;
    expect(row.querySelector(".quota-name")?.textContent).toBe("Weekly");
    expect(row.querySelector(".quota-val")?.textContent).toBe("91%");
    expect(row.querySelector(".quota-meta")?.textContent).toMatch(/^warning · resets /);
    expect(row.classList.contains("warn")).toBe(true);
    cleanup();
    expect(renderPage(FULL, "?backend=codex").getByText("No reading yet")).toBeTruthy();
  });

  /**
   * Ruling 635 on ruling 608: a reading lists every window it knows, and the
   * card draws each one. The binding window used to be the only row, so on the
   * evening the weekly window bound, Codex's five-hour window — the one that
   * stalled a round twice — was nowhere on the page.
   */
  it("draws a row for every window the reading lists, the lapsed one in the past tense", async () => {
    const reading = {
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.42,
      resetsAt: 1_791_495_289,
      isUsingOverage: false,
      observedAt: "2026-10-02T20:59:30.000Z",
      credentialUserId: null,
      credentialLabel: null,
    };
    const { container } = renderPage(
      withQuota(
        { backend: "codex", reading, credentialRefused: null, exhausted: null },
        [
          { rateLimitType: "five_hour", utilization: 0.68, resetsAt: 1_790_980_628, reset: false },
          { rateLimitType: "seven_day", utilization: 0.42, resetsAt: 1_791_495_289, reset: false },
          { rateLimitType: "seven_day_fable", utilization: null, resetsAt: 1_790_000_000, reset: true },
        ],
      ),
      "?backend=codex",
    );
    // CANARY: draw the binding reading alone and the five-hour row is gone.
    const rows = [...container.querySelectorAll("[data-quota-window]")];
    // Ruling 642: a window by the name a person reads, its id in the title.
    expect(rows.map((r) => r.querySelector(".quota-name")?.textContent)).toEqual([
      "5-hour",
      "Weekly",
      "Weekly · Fable",
    ]);
    expect(rows.map((r) => r.querySelector(".quota-name")?.getAttribute("title"))).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
    expect(rows.map((r) => r.querySelector<HTMLElement>(".quota-fill")!.style.width)).toEqual(["68%", "42%", "0%"]);
    expect(rows[2]!.querySelector(".quota-val")?.textContent).toBe("Window reset");
    await waitFor(() => expect(rows[2]!.querySelector(".quota-meta")!.textContent).toMatch(/^no reading since · reset /));
  });

  it("a reading WITHOUT a utilization number says so — never 'no reading yet' beside a reset date", () => {
    // Live-caught (pass 29): the provider's five_hour envelopes often omit
    // `utilization`; the row used to render the contradiction
    // "no reading yet · resets 8/27/2026".
    const { container, queryByText } = renderPage(
      withQuota(
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
        [{ rateLimitType: "five_hour", utilization: null, resetsAt: 1_787_848_800, reset: false }],
      ),
    );
    expect(container.querySelector('[data-quota-window="five_hour"] .quota-val')?.textContent).toBe("Not reported");
    expect(queryByText("No reading yet")).toBeNull();
  });

  /**
   * The reading's own age, which a weeks-old 91% must show, sits on the page
   * now that one backend's reading is the card; a refused credential's
   * sentence still reaches the accessibility tree, not only `title` (acce-5).
   */
  it("says when the reading was observed, and names a refused credential's sentence for everyone", () => {
    const observed = renderPage(FULL);
    expect(quotaNote(observed.container)).toMatch(/^Latest reading from a Claude run, .+\. Near 100%, new runs may be refused/);
    cleanup();
    const { container } = renderPage(
      withQuota({
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
      }),
      "?backend=codex",
    );
    const refused = container.querySelector(".quota-meta[title^='run run_2 was refused ']")!;
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
  const refusedQuota = (exhausted: BackendQuotaRow["exhausted"]): InsightsSummary =>
    withQuota({ backend: "codex", reading: null, credentialRefused: null, exhausted });

  it("says the window is exhausted when a run was refused, and names that as its source", async () => {
    const { getByText, container } = renderPage(refusedQuota(REFUSED), "?backend=codex");
    expect(getByText("Usage limit reached")).toBeTruthy();
    // Honest about its provenance: this is not a utilization reading.
    expect(getByText(/^from a refused run/)).toBeTruthy();
    // D32-2 (ruling 4): the refusal's hover title dates the run with the app's
    // ONE formatter ("<day> · <clock>"), never the server locale's
    // toLocaleString ("9/1/2026, 9:00:00 AM") — and with no stray "$" before
    // the date (a template-literal slip the first D32-2 edit shipped).
    await waitFor(() => {
      const bar = container.querySelector(".quota-meta[title^='run run_abc was refused ']")!;
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
    // The note says where the row came from and what clears it.
    expect(quotaNote(container)).toContain(
      "comes from a run the provider refused, not from a reported figure",
    );
  });

  /**
   * F32-4 (pass 32): a REJECTED credential is a different fact from a spent
   * window — the backend cannot run anything until a person fixes it — and it
   * outranks a utilization reading the same backend reported earlier. The row
   * names its provenance (a refused run) and what retires it (a completed run).
   */
  it("says the credential was refused, above any earlier reading, and names what clears it", () => {
    const { getByText, queryByText } = renderPage(
      withQuota(
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
        [{ rateLimitType: "five_hour", utilization: 0.2, resetsAt: null, reset: false }],
      ),
      "?backend=codex",
    );
    expect(getByText("Credential refused")).toBeTruthy();
    expect(getByText(/clears when a run on this backend completes/)).toBeTruthy();
    // The stale 20% reading does not get to reassure anyone.
    expect(queryByText("20%")).toBeNull();
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
    const prose = renderPage(refusedQuota(REFUSED), "?backend=codex");
    // CANARY: drop `refusal.resetsAtPrecision === "exact"` from the hydrated
    // branch and this renders a to-the-minute local time nobody can vouch for.
    expect(prose.getByText(/retry after 2026-09-18/)).toBeTruthy();
    cleanup();

    const exact = renderPage(refusedQuota({ ...REFUSED, resetsAtPrecision: "exact" }), "?backend=codex");
    // Locale-independent assertion: the date-only form is what an exact reset
    // must NOT collapse to (its own rendering is the viewer's locale string).
    expect(exact.getByText(/retry after /)).toBeTruthy();
    expect(exact.queryByText(/retry after 2026-09-18/)).toBeNull();
    cleanup();

    // Pass 34 review: a `clock` reset is a to-the-minute UTC instant too (a
    // provider's "resets 11:50am (UTC)"), so it keeps its hour like `exact`.
    // Canary: drop the `clock` arm from the hydrated branch — the hour is lost
    // and the row collapses to the bare UTC day.
    const clock = renderPage(refusedQuota({ ...REFUSED, resetsAtPrecision: "clock" }), "?backend=codex");
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
  it.each([
    // An hour after the refusal: the window is demonstrably open.
    { observedAt: "2026-08-31T10:00:00.000Z", refusalStands: false },
    // BEFORE the refusal — stale, and the refusal is what happened next.
    { observedAt: "2026-08-31T08:00:00.000Z", refusalStands: true },
  ])("V4: a reading observed at $observedAt against a 09:00 refusal", ({ observedAt, refusalStands }) => {
    const { queryByText, container } = renderPage(
      withQuota(
        {
          backend: "codex",
          reading: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.12,
            resetsAt: null,
            isUsingOverage: false,
            observedAt,
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: REFUSED,
        },
        [{ rateLimitType: "five_hour", utilization: 0.12, resetsAt: null, reset: false }],
      ),
      "?backend=codex",
    );
    // CANARY: collapse `refusal` back to `exhausted` and the later reading's
    // row reads "usage limit reached" at 100% over a backend answering runs.
    expect(queryByText("Usage limit reached") !== null).toBe(refusalStands);
    expect(queryByText("12%") !== null).toBe(!refusalStands);
    // The refusal's full track, or the reading's 12%.
    const fill = container.querySelector<HTMLElement>(".usage-limits .quota-fill")!;
    expect(refusalStands ? fill.classList.contains("full") : fill.style.width).toBe(refusalStands ? true : "12%");
  });

  it("shows an empty state when there are no runs on any backend", () => {
    const { getByText, container } = renderPage({
      ...FULL,
      backends: [
        { backend: "claude", runs: 0 },
        { backend: "codex", runs: 0 },
      ],
    });
    expect(getByText(/No agent runs yet/)).toBeTruthy();
    expect(container.querySelector(".metric-band")).toBeNull();
  });

  it("renders with a null success rate and null duration", () => {
    const { container } = renderPage(
      withRuns({
        outcomes: { ...CLAUDE.outcomes, finished: 0, error: 0, interrupted: 0, successRate: null },
        avgDurationMs: null,
      }),
    );
    // Both the success-rate and avg-duration figures read as absent, and no
    // other figure does: the cache panel prints its own "n/a" cells, so a
    // page-wide count of a placeholder proves nothing about these two.
    // CANARY: render a null rate as "0%" and "Completion rate" drops out.
    const na = [...container.querySelectorAll(".metric")]
      .filter((c) => c.querySelector(".metric-val.na"))
      .map((c) => `${c.querySelector(".metric-label")?.textContent}: ${c.querySelector(".metric-val")?.textContent}`);
    expect(na).toEqual(["Completion rate: No outcomes yet", "Avg run time: No finished runs"]);
  });
});

/**
 * Ruling 635 (owner, 2026-10-03: "since claude and codex parity on numbers
 * can't be achieved, let's just have a selector on backends on the token data
 * etc. viberr data itself is global"). The delivery oversight is the instance's
 * own record and comes first; the agent runs below it are one backend's.
 */
describe("ruling 635: one backend's runs under a switch", () => {
  it("names each backend with its run count, under the instance's own record, and switches on a click", async () => {
    const { container, getByRole } = renderPage(FULL);
    // The oversight first, the switch on the section it scopes.
    expect([...container.querySelectorAll("h2")].slice(0, 2).map((h) => h.textContent)).toEqual([
      "Delivery oversight",
      "Agent runs",
    ]);
    const group = getByRole("group", { name: "Backend" });
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Claude· 42", "Codex· 14"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    const search = () => container.querySelector("output")!.getAttribute("data-search");
    const cost = () => metric(container, "Cost").querySelector(".metric-val")?.textContent;
    expect(cost()).toBe("$3.50");
    // The pressed backend is already on screen: no navigation.
    fireEvent.click(buttons[0]!);
    expect(search()).toBe("");
    // CANARY: drop the URL write and the page never leaves Claude's figures.
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(search()).toBe("?backend=codex"));
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(cost()).toBe("Not reported");
  });

  it("opens on the backend doing most of the work, unless the URL names one it knows", () => {
    const busier: InsightsSummary = {
      ...FULL,
      backends: [
        { backend: "claude", runs: 42 },
        { backend: "codex", runs: 589 },
      ],
    };
    const pressed = (search: string) => {
      const { getByRole } = renderPage(busier, search);
      const on = getByRole("group", { name: "Backend" }).querySelector('[aria-pressed="true"]')?.textContent;
      cleanup();
      return on;
    };
    // CANARY: default to the first backend and Codex's 589 runs open on Claude.
    expect(pressed("")).toBe("Codex· 589");
    expect(pressed("?backend=claude")).toBe("Claude· 42");
    expect(pressed("?backend=gemini")).toBe("Codex· 589");
  });

  it("says so under the switch when the chosen backend never ran, and keeps the oversight", () => {
    const { container, getByText } = renderPage(
      {
        ...FULL,
        backends: [
          { backend: "claude", runs: 42 },
          { backend: "codex", runs: 0 },
        ],
        runs: [CLAUDE],
      },
      "?backend=codex",
    );
    expect(getByText("No Codex runs yet.")).toBeTruthy();
    expect(getByText("Owner & state clarity")).toBeTruthy();
    expect(container.querySelector(".daily-chart")).toBeNull();
  });

  /**
   * A backend whose runs report no cost is weighed in tokens: the Cost card
   * says "not reported" once, and every figure that was a dollar amount on
   * Claude is a token count, labelled as one. Live, every Codex row read
   * "not reported" in the cost column and the busiest groups were ranked by a
   * figure none of them had.
   */
  it("weighs a backend that reports no cost in tokens, says so once, and prints a billion as B", () => {
    const { container } = renderPage(FULL, "?backend=codex&by=kind");
    // CANARY: render `fmtCost(totals.cost)` for a backend with no costed run
    // and the figure reads "$0.00", a price Codex never quoted.
    const cost = metric(container, "Cost");
    expect(cost.querySelector(".metric-val")?.textContent).toBe("Not reported");
    expect(cost.querySelector(".metric-val")?.classList.contains("na")).toBe(true);
    expect(cost.querySelector(".metric-sub")?.textContent).toBe("none of the 14 Codex runs reported one");
    // Ruling 635: "3864.3M" read as a typo. Ruling 642: "33.0M" is 33M.
    const tokens = metric(container, "Tokens");
    expect(tokens.querySelector(".metric-val")?.textContent).toBe("3.86B");
    expect(tokens.querySelector(".metric-sub")?.textContent).toBe("3.83B in, 96% cached · 33M out");
    expect(metric(container, "Coordination share").querySelector(".metric-sub")?.textContent).toBe(
      "operator and controller runs, 1.2K of 9.4K tokens",
    );
    // The breakdown says its unit, and gives it.
    const table = container.querySelector(".breakdown-table")!;
    expect(table.querySelector("thead th:last-child")?.textContent).toBe("Tokens");
    expect([...table.querySelectorAll("tbody td:last-child")].map((c) => c.textContent)).toEqual(["1.15B", "2.55B"]);
    // And so does the day card.
    const last = container.querySelectorAll(".daily-col")[29]!;
    expect(last.querySelector(".daily-tip-row.plain")?.textContent).toBe("Tokens 2.4B");
    expect(last.querySelector(".vh")?.textContent).toBe("2026-07-30: 5 runs, 2.4B tokens");
    cleanup();
    // Ruling 308: the window says what it left out, in the backend's unit.
    const tasks = renderPage(FULL, "?backend=codex&by=task");
    expect(tasks.container.querySelector(".breakdown .fine.dim")?.textContent).toBe(
      "3 more not shown · 11 runs · 3.3K tokens",
    );
  });
});

describe("ruling 635: the task breakdown", () => {
  it("links each task to its page, by its key alone when every row is one project's", () => {
    const one = renderPage(FULL, "?by=task");
    expect(one.getByRole("link", { name: "VIB-1" }).getAttribute("href")).toBe("/projects/viberr-core/tasks/VIB-1");
    cleanup();
    // CANARY: drop the one-project test and two projects' A-1 read alike.
    const row = (label: string) => named({ label, runs: 2, cost: 0.1, tokens: 1_000 });
    const two = renderPage(
      withRuns({ byTask: { ...CLAUDE.byTask, rows: [row("alpha/A-1"), row("beta/A-1"), row("controller conversations")] } }),
      "?by=task",
    );
    expect(two.getByRole("link", { name: "alpha/A-1" }).getAttribute("href")).toBe("/projects/alpha/tasks/A-1");
    expect(two.getByRole("link", { name: "beta/A-1" })).toBeTruthy();
    expect(two.getByText("controller conversations").closest("a")).toBeNull();
  });
});

/** Ruling 130(d): a refused or exhausted row says whose account, and the
 *  reading row names the hour. Canary: drop the label interpolation. */
describe("ruling 130(d): whose account, and the hour", () => {
  it("an exhausted row names the account it billed; a reading row names the hour", () => {
    const exhausted = renderPage(
      withQuota({
        backend: "claude",
        reading: null,
        credentialRefused: null,
        exhausted: {
          resetsAt: 1_788_781_800, resetsAtPrecision: "exact", providerText: "session limit", runId: "run_1",
          observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: "u_arda", credentialLabel: "Arda Kaya",
        },
      }),
    );
    expect(exhausted.getByText(/from a refused run on Arda Kaya's account/)).toBeTruthy();
    cleanup();
    const reading = renderPage(
      withQuota(
        {
          backend: "codex",
          reading: {
            status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1_788_781_800, isUsingOverage: false,
            observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: null, credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: null,
        },
        [{ rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1_788_781_800, reset: false }],
      ),
      "?backend=codex",
    );
    // The reading row names the HOUR (local once hydrated, UTC on the first
    // paint), never a bare calendar date. The day bucket is optional: on the
    // fixture's own calendar day `formatDayDotTime` prints the bare clock.
    expect(reading.getByText(/resets (.+ · )?\d{1,2}:\d{2}/)).toBeTruthy();
  });

  /**
   * Ruling 481(d) (F40-50): a window that has reset is history. The row keeps
   * it, in the past tense, with no percentage and no bar; it used to read "92%
   * of five hour · resets 03:30" hours after 03:30.
   *
   * Canary: drop `w.reset` from the `pct` line (the bar fills to 92% and the
   * percentage returns), or from the reset clause (present tense returns).
   */
  it("a window that has reset draws no bar and says 'reset' (ruling 481)", async () => {
    const resetsAt = Date.parse("2026-08-23T03:30:00.000Z") / 1000;
    const { getByText, queryByText } = renderPage(
      withQuota(
        {
          backend: "claude",
          reading: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.92,
            resetsAt,
            isUsingOverage: false,
            observedAt: "2026-08-23T03:01:00.000Z",
            credentialUserId: null,
            credentialLabel: null,
          },
          credentialRefused: null,
          exhausted: null,
          readingWindowReset: true,
        },
        [{ rateLimitType: "five_hour", utilization: 0.92, resetsAt, reset: true }],
      ),
    );
    expect(getByText("Window reset")).toBeTruthy();
    expect(queryByText(/92%/)).toBeNull();
    const row = getByText("Window reset").closest(".quota-row")!;
    expect(row.querySelector<HTMLElement>(".quota-fill")!.style.width).toBe("0%");
    await waitFor(() => expect(row.querySelector(".quota-meta")!.textContent).toMatch(/^no reading since · reset /));
    // The old window's warning warns about nothing now.
    expect(row.textContent).not.toContain("warning");
  });

  it("a refused credential row names the account", () => {
    const { getByText } = renderPage(
      withQuota({
        backend: "claude",
        reading: null,
        credentialRefused: { providerText: "token revoked", runId: "run_2", observedAt: "2026-09-07T09:00:00.000Z", credentialUserId: "u_arda", credentialLabel: "Arda Kaya" },
        exhausted: null,
      }),
    );
    expect(getByText(/Credential refused · Arda Kaya's account/)).toBeTruthy();
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
    const { getByText } = renderPage(
      withRuns({
        outcomes: { ...CLAUDE.outcomes, interrupted: 23, interruptedByRestart: 23, interruptedNeverStarted: 17 },
      }),
    );
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
    expect(panel.querySelector("thead")?.textContent).toContain("first writes > 100K");
    // Ruling 642: the panel's one line, over every run, with the tables folded
    // under it.
    expect(panel.querySelector(".panel-head .right")?.textContent).toBe("28% warm starts · 95M read · 1.9M written");
    expect(panel.querySelector("details.cache-more")?.hasAttribute("open")).toBe(false);
  });

  it("scrolls the table in its own keyboard-reachable box, not the page (layo-21)", () => {
    // The nowrap columns (eight then, ~690px; eleven since ruling 505) are
    // wider than a phone: without the wrap, /insights scrolled sideways at
    // phone width and at 200% zoom.
    const { getByRole } = renderPage(FULL);
    const region = getByRole("region", { name: "Prompt cache by group" });
    expect(region.classList.contains("md-table-wrap")).toBe(true);
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.querySelector("table.cache-table")).not.toBeNull();
  });
});

/**
 * Ruling 395 (F39-22): a figure the provider never reports is not a zero. Live
 * the write column read `WRITTEN 0 · READ 45.0M · 0.000` for 21 Codex runs,
 * because Codex declares `cache_write_input_tokens` and answers 0 for it every
 * single time. Ruling 635: once the panel is one backend's, a backend that
 * reports no write has no write column at all, rather than five columns of
 * "not reported".
 */
describe("the prompt-cache panel: a backend that reports no write (rulings 395 and 635)", () => {
  it("leaves the write columns out whole and says why, keeping the reads", () => {
    const { container } = renderPage(FULL, "?backend=codex");
    const panel = container.querySelector('[data-comment-anchor="prompt-cache"]')!;
    const table = panel.querySelector('[aria-label="Prompt cache by group"] table')!;
    // CANARY: drop the `reportsWrites` filter and the eleven columns return,
    // five of them "not reported" on every row.
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "group",
      "runs",
      "warm starts",
      "read / run",
      "peak prompt (median · p90 · max)",
      "read",
    ]);
    const primary = panel.querySelector('[data-cache-row="by run kind:primary"]')!;
    expect(primary.querySelector("[data-write], [data-first-write-mean], [data-ttl-1h]")).toBeNull();
    expect(primary.querySelector("[data-read]")?.textContent).toBe("2.55B");
    expect(primary.querySelector("[data-read-per-run]")?.textContent).toBe("4.3M");
    // The group rows span what is left.
    for (const td of table.querySelectorAll("tr.group td")) expect(td.getAttribute("colspan")).toBe("6");
    expect(panel.textContent).toContain(
      "Codex reports no cache write and no cache lifetime, so those columns are left out.",
    );
    // Codex's cache does not cross threads: no operator-burst count to give.
    expect(panel.querySelector("[data-operator-bursts]")).toBeNull();
  });

  it("says 'not reported' for a Claude group whose runs never reported a write", () => {
    const { container } = renderPage(
      withRuns({
        cache: {
          ...CLAUDE.cache,
          byKind: [{ ...CLAUDE.cache.byKind[0]!, writeTokens: null, writeReportingRuns: 0, writeReadRatio: null, avgFirstCallWrite: null }],
        },
      }),
    );
    const primary = container.querySelector('[data-cache-row="by run kind:primary"]')!;
    // CANARY: print `fmtTokens(r.writeTokens ?? 0)` and the cell reads "0"
    // beside a 95.0M read.
    expect(primary.querySelector("[data-write]")?.textContent).toBe("not reported");
    expect(primary.querySelector("[data-write]")?.getAttribute("data-write")).toBe("");
    expect(primary.querySelector("[data-first-write-mean]")?.textContent).toBe("not reported");
    expect(primary.querySelector("[data-write-read]")?.textContent).toBe("n/a");
  });
});

/**
 * Ruling 505: what the prompt-cache plan asked the page
 * for. PR 1's acceptance was that the page reproduce the plan's baseline table
 * (the mean first write, reads per run, the peak prompt's spread, Codex on its
 * own rows); PR 6 asked whether a Codex resume idle past ten minutes ever reads
 * its prefix back; PR 5 asked for the operator bursts to be counted before a
 * gate is built.
 */
describe("the prompt-cache panel: PLAN.md's baseline columns (ruling 505)", () => {
  it("draws the mean first write, reads per run and the peak prompt's spread", () => {
    const { container } = renderPage(FULL);
    const panel = container.querySelector('[data-comment-anchor="prompt-cache"]')!;
    const primary = panel.querySelector('[data-cache-row="by run kind:primary"]')!;
    expect(primary.querySelector("[data-first-write-mean]")?.textContent).toBe("14K");
    expect(primary.querySelector("[data-read-per-run]")?.textContent).toBe("5.3M");
    expect(primary.querySelector("[data-peak-median]")?.textContent).toBe("108K · 226K · 482K");
    expect(primary.querySelector("[data-peak-p90]")?.getAttribute("data-peak-p90")).toBe("226000");
    // No first call behind a group: nothing to average, and it says so.
    const operator = panel.querySelector('[data-cache-row="by run kind:operator"]')!;
    expect(operator.querySelector("[data-first-write-mean]")?.textContent).toBe("n/a");
    expect(operator.querySelector("[data-read-per-run]")?.textContent).toBe("n/a");
    expect(operator.querySelector("[data-peak-median]")?.textContent).toBe("n/a");
    expect(operator.querySelector("[data-peak-median]")?.getAttribute("data-peak-median")).toBe("");
  });

  it("spans every column with each group's label row", () => {
    const { container } = renderPage(FULL);
    const table = container.querySelector('[aria-label="Prompt cache by group"] table')!;
    const columns = table.querySelectorAll("thead th").length;
    expect(columns).toBe(11);
    const groups = [...table.querySelectorAll("tr.group td")];
    expect(groups.map((td) => td.textContent)).toEqual(["by run kind", "by credential kind"]);
    // CANARY: add a column and leave the label rows at the old span, and the
    // group rows stop short of the table's edge.
    for (const td of groups) expect(td.getAttribute("colspan")).toBe(String(columns));
  });
});

describe("the prompt-cache panel: resumes by idle time (ruling 505)", () => {
  const cell = (row: Element, i: number) => row.querySelector(`[data-bucket="${i}"]`)!;

  it("sorts each row's resumes into idle buckets, marking the ones past its assumed TTL", () => {
    const { getByRole } = renderPage(FULL, "?backend=codex");
    const region = getByRole("region", { name: "Resumes by idle time" });
    expect(region.classList.contains("md-table-wrap")).toBe(true);
    expect(region.getAttribute("tabindex")).toBe("0");
    // Spelled out: the heads are upper-cased, and "5M" would read as millions.
    expect([...region.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "credential",
      "assumed TTL",
      "up to 5 min",
      "5 to 10 min",
      "10 min to 1 hour",
      "1 to 24 hours",
      "over 24 hours",
      "set aside",
    ]);
    const codex = region.querySelector('[data-resume-row="login"]')!;
    expect(codex.querySelector("[data-assumed-ttl]")?.textContent).toBe("10 min");
    // Five to ten minutes is inside Codex's ten; ten minutes to an hour is past it.
    expect(cell(codex, 1).getAttribute("data-past-ttl")).toBe("false");
    expect(visibleText(cell(codex, 2))).toBe("1 of 3");
    expect(cell(codex, 2).getAttribute("data-past-ttl")).toBe("true");
    expect(cell(codex, 2).getAttribute("title")).toBe(
      "1 of 3 resumes idle 10 min to 1 hour read more than they wrote, past the 10 min this row assumes",
    );
    // No visually hidden copy in these cells: the far columns sit past a
    // phone's edge, and an absolutely placed `.vh` there widened the page by
    // 44px at 390px (measured in Chromium).
    expect(region.querySelector("tbody .vh")).toBeNull();
    // A bucket with no resume has no fraction to show.
    expect(visibleText(cell(codex, 3))).toBe("n/a");
    expect(cell(codex, 3).classList.contains("na")).toBe(true);
  });

  it("assumes Claude's hour on a sign-in, so only the last two buckets are past it", () => {
    const { getByRole } = renderPage(FULL);
    const claude = getByRole("region", { name: "Resumes by idle time" }).querySelector('[data-resume-row="login"]')!;
    expect([0, 1, 2, 3, 4].map((i) => cell(claude, i).getAttribute("data-past-ttl"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "true",
    ]);
    expect(claude.querySelector("[data-set-aside]")?.textContent).toBe("1");
  });

  it("names the size past which a stale session starts fresh, and says when nothing resumed", () => {
    const { container, queryByRole, getByText } = renderPage(
      withRuns({ cache: { ...CLAUDE.cache, resumes: { ...CLAUDE.cache.resumes, rows: [] } } }),
    );
    const panel = container.querySelector('[data-comment-anchor="prompt-cache"]')!;
    expect(panel.textContent).toContain("larger than 150K tokens");
    expect(queryByRole("region", { name: "Resumes by idle time" })).toBeNull();
    expect(getByText("No resumed session yet.")).toBeTruthy();
  });
});

describe("the prompt-cache panel: operator bursts (ruling 505)", () => {
  it("counts the starts close behind another and what the cold ones wrote", () => {
    const { container } = renderPage(FULL);
    const note = container.querySelector("[data-operator-bursts]")!;
    expect(note.getAttribute("data-in-bursts")).toBe("12");
    expect(note.getAttribute("data-cold-burst-write")).toBe("26700");
    expect(note.textContent).toBe(
      "Operator bursts: 141 Claude operator starts reached the provider, and 12 came within 1 min " +
        "of the previous start for the same project, account and model. 1 of those started cold and " +
        "wrote 26.7K tokens, the most a gate holding such starts back could save. 3 of all the " +
        "operator starts were cold.",
    );
  });

  it("says so when there is nothing to count, or no burst started cold", () => {
    const bursts = (operatorBursts: NonNullable<RunAnalytics["cache"]["operatorBursts"]>) =>
      withRuns({ cache: { ...CLAUDE.cache, operatorBursts } });
    const none = renderPage(
      bursts({ starts: 0, inBursts: 0, coldInBursts: 0, coldBurstWrite: 0, coldStarts: 0, windowMs: 60_000 }),
    );
    expect(none.container.querySelector("[data-operator-bursts]")?.textContent).toBe(
      "Operator bursts: no Claude operator start has reached the provider yet, so there are none to count.",
    );
    cleanup();
    const warm = renderPage(
      bursts({ starts: 1, inBursts: 1, coldInBursts: 0, coldBurstWrite: 0, coldStarts: 0, windowMs: 60_000 }),
    );
    expect(warm.container.querySelector("[data-operator-bursts]")?.textContent).toBe(
      "Operator bursts: 1 Claude operator start reached the provider, and 1 came within 1 min of the " +
        "previous start for the same project, account and model. None of those started cold. 0 of all " +
        "the operator starts were cold.",
    );
  });
});
