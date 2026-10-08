import { Fragment, type ReactNode } from "react";
import type {
  BackendRuns,
  Breakdown,
  CacheRow,
  CacheSummary,
  CoordinationShare,
  OperatorBurstSummary,
  OversightSummary,
  InsightsSummary,
  QuotaWindow,
  ResumeSummary,
  RunAnalytics,
  RunMeasure,
} from "~/server/insights/insights-query.server";
import type { RunBackend } from "~/features/runtime/runtime-types";
import { Link, useSearchParams } from "react-router";
import { Icon } from "~/ui/icon";
import { useHydrated } from "~/ui/local-time";
import {
  formatDayBucketUTC,
  formatDayDotTime,
  utcDayKey,
  formatClockUTC,
  formatCalendarDateUTC,
} from "~/shared/dates/format";
import { observedAfter } from "~/shared/freshness";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { formatCost, formatDuration } from "~/shared/text/figures";
import { countLabel, pluralNoun } from "~/shared/text/plural";
import { quotaWindowLabel } from "~/shared/text/quota-window";

/**
 * Insights: a read-only analytics dashboard. All numbers come from ONE server
 * read (`getInsightsSummary`); the page only formats and draws. Org-admin gated
 * at the route.
 *
 * Ruling 635: the instance's own record (delivery oversight) comes first and
 * covers every backend. Below it the agent runs are read one backend at a time,
 * under a switch that names each backend with its run count: Claude and Codex
 * do not measure alike, so nothing on the page sums across them.
 *
 * Ruling 642 (owner: "be critical of the design that feels finished product no
 * ai slop"): one surface language. Each band of figures is one panel whose
 * cells a hairline divides, sized to the count it holds so no row ends in a
 * hole; a figure reads label, number, one line of context, and no icon; the
 * day chart and the usage limits share a row; the five breakdowns are one
 * table under a switch; the prompt cache's diagnostics fold under its summary.
 */

/** "100.0K" is 100K: a scaled figure drops the zeros its rounding left. */
function trimScaled(fixed: string): string {
  return fixed.replace(/\.?0+$/, "");
}

/** Each unit starts where the one below would round up to 1,000 of itself, so
 *  nothing prints "1000.0M". Ruling 635: a backend's input passes a billion in
 *  days, and "5361.5M" read as a typo. */
function fmtTokens(n: number): string {
  if (n >= 999_950_000) return `${trimScaled((n / 1_000_000_000).toFixed(2))}B`;
  if (n >= 999_950) return `${trimScaled((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${trimScaled((n / 1_000).toFixed(1))}K`;
  return String(n);
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

/** A figure in its backend's measure (ruling 635): dollars, or tokens. Null is
 *  "not reported", never a zero the data cannot vouch for. */
function fmtMeasure(measure: RunMeasure, value: number | null): string {
  if (value === null) return "not reported";
  return measure === "cost" ? formatCost(value) : fmtTokens(value);
}

export function InsightsPage({ summary }: { summary: InsightsSummary }) {
  const empty = summary.backends.every((b) => b.runs === 0);
  // D33-3: Insights was the one full-page surface with no screen label, so
  // tests and agents could not address it by name like every other one
  // (docs/ui/surfaces.md §4).
  return (
    <main className="insights" data-screen-label="Insights">
      {/* Ruling 625: Instance settings' header (ruling 145), one title step and
          one lede. */}
      <div className="set-head">
        <div>
          <h1>Insights</h1>
          <p className="sub">Delivery and agent runs across this instance.</p>
        </div>
      </div>

      {empty ? (
        // Design pass 2026-09-08: a page-level empty state is a composed
        // object, and Home's `.empty-hero` is the app's one.
        <div className="empty-hero" data-screen-label="Empty state">
          <span className="glyph">
            <Icon name="activity" />
          </span>
          <h2>No agent runs yet</h2>
          <p>
            Once agents start working, their cost, tokens, timing and outcomes
            show up here.
          </p>
        </div>
      ) : (
        <>
          <OversightBand oversight={summary.oversight} />
          <AgentRuns backends={summary.backends} runs={summary.runs} />
        </>
      )}
    </main>
  );
}

/**
 * A search parameter the page reads in the browser (ruling 635's switch): the
 * loader reads none, so a choice is a URL rewrite with no request, replaced in
 * place like the board's filters, and a link holds it.
 */
function useSearchChoice<T extends string>(
  name: string,
  known: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const chosen = known.find((k) => k === raw) ?? fallback;
  const choose = (next: T) =>
    setParams(
      (prev) => {
        const url = new URLSearchParams(prev);
        url.set(name, next);
        return url;
      },
      { replace: true, preventScrollReset: true },
    );
  return [chosen, choose];
}

/**
 * Ruling 635: one backend's runs. Everything from the switch down reads only
 * that backend: its totals, its days, its usage limits, where its runs went and
 * its prompt cache. Each backend is weighed in what it reports
 * (`runs.measure`): cost on a backend that reports one, tokens on one that does
 * not. With no choice, or one the page does not know, it opens on the backend
 * doing most of the work.
 */
function AgentRuns({ backends, runs: read }: { backends: BackendRuns[]; runs: RunAnalytics[] }) {
  const busiest = backends.reduce((most, b) => (b.runs > most.runs ? b : most)).backend;
  const [backend, choose] = useSearchChoice(
    "backend",
    backends.map((b) => b.backend),
    busiest,
  );
  const runs = read.find((r) => r.backend === backend);
  return (
    <>
      <section>
        <div className="sec-h">
          <h2>Agent runs</h2>
          <BackendSwitch backends={backends} selected={backend} onSelect={choose} />
        </div>
        {runs ? <RunTotals runs={runs} /> : <div className="empty">No {BACKEND_LABEL[backend]} runs yet.</div>}
      </section>
      {runs && (
        <>
          <div className="insights-pair">
            <DailyChart runs={runs} />
            <UsageLimits runs={runs} />
          </div>
          <BreakdownPanel runs={runs} />
          <CachePanel cache={runs.cache} backend={runs.backend} />
        </>
      )}
    </>
  );
}

/**
 * One figure in a band: its name, the number, one line of context. An absent
 * reading is a muted phrase in the number's place ("Not reported", "No
 * deliveries yet"): "n/a" at the number's size read as a data point.
 */
function Metric({
  label,
  value,
  absent = false,
  sub,
  note,
  names,
  more,
  wide = false,
}: {
  label: string;
  value: string;
  absent?: boolean;
  sub?: string;
  /** A second line under `sub`: a disclosure the first line would bury. */
  note?: string;
  /** Ruling 290: the exceptions this number counts, BY NAME. A card that
   *  reports "41 of 42 delivered tasks carry branch + PR" and will not say
   *  which one cannot be traced has withheld the only fact a reader needs. */
  names?: readonly string[];
  /** How many more there are than the card names, so a capped list never reads
   *  as the whole set. */
  more?: number;
  /** Spans the band's full width. */
  wide?: boolean;
}) {
  return (
    <div className={"metric" + (wide ? " wide" : "")}>
      <span className="metric-label">{label}</span>
      <span className={"metric-val" + (absent ? " na" : "")}>{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
      {note && <span className="metric-sub">{note}</span>}
      {names && names.length > 0 && (
        <span className="metric-sub metric-names">
          {names.map((n) => (
            <Link key={n} to={taskHref(n)} className="linkish">
              {n.split("/")[1] ?? n}
            </Link>
          ))}
          {more != null && more > 0 && <span className="dim">+{more} more</span>}
        </span>
      )}
    </div>
  );
}

/** Ruling 635: one backend's totals. Ruling 642: six figures, three to a row;
 *  the turn count rides under the run count it belongs to. */
function RunTotals({ runs }: { runs: RunAnalytics }) {
  const name = BACKEND_LABEL[runs.backend];
  const { totals, outcomes } = runs;
  // A backend whose envelope carries no price is "not reported", never $0.00
  // (ruling 395), and says so once, on this figure. A Claude run stopped before
  // its result reports no cost either, so the figure names the runs it leaves
  // out.
  const silentRuns = totals.runs - totals.costedRuns;
  const unpriced = totals.costedRuns === 0;
  return (
    <div className="metric-band three">
      <Metric label="Runs" value={fmtCount(totals.runs)} sub={`${fmtCount(totals.turns)} turns`} />
      <Metric
        label="Cost"
        value={unpriced ? "Not reported" : formatCost(totals.cost)}
        absent={unpriced}
        sub={
          unpriced
            ? `none of the ${fmtCount(totals.runs)} ${name} runs reported one`
            : silentRuns > 0
              ? `${fmtCount(silentRuns)} of ${fmtCount(totals.runs)} runs reported no cost`
              : undefined
        }
      />
      <Metric
        label="Tokens"
        value={fmtTokens(totals.inputTokens + totals.outputTokens)}
        // `in` is the whole prompt of every call and `cached` the share of it
        // served from the prompt cache.
        sub={
          `${fmtTokens(totals.inputTokens)} in` +
          (totals.inputTokens > 0
            ? `, ${fmtPercent(totals.cachedInputTokens / totals.inputTokens)} cached`
            : "") +
          ` · ${fmtTokens(totals.outputTokens)} out`
        }
        // F35-1: the sums cover provider totals only, so the figure names how
        // many runs are outside them: a stopped run and one that errored
        // before the provider answered never get a total.
        note={
          totals.tokenlessRuns > 0
            ? `${fmtCount(totals.tokenlessRuns)} of ${fmtCount(totals.runs)} runs report no provider total`
            : undefined
        }
      />
      <Metric
        // R26-3 (owner ruling): "Completion rate", not "Success rate": this
        // measures runs that RAN to completion (finished vs errored/stopped),
        // which is not the same as work that was accepted on review. F26-5:
        // running/queued join the line when present, so the outcome counts
        // always reconcile with "Runs". Pass 35 U35-7: the stopped count names
        // how many a restart stopped and how many never started; the latter
        // are out of the rate's denominator.
        label="Completion rate"
        value={outcomes.successRate === null ? "No outcomes yet" : fmtPercent(outcomes.successRate)}
        absent={outcomes.successRate === null}
        sub={[
          `${fmtCount(outcomes.finished)} finished`,
          `${fmtCount(outcomes.error)} error`,
          stoppedLabel(outcomes),
          ...(outcomes.running ? [`${fmtCount(outcomes.running)} running`] : []),
          ...(outcomes.queued ? [`${fmtCount(outcomes.queued)} queued`] : []),
        ].join(" · ")}
      />
      <Metric
        label="Avg run time"
        value={runs.avgDurationMs === null ? "No finished runs" : formatDuration(runs.avgDurationMs)}
        absent={runs.avgDurationMs === null}
        sub={runs.avgDurationMs === null ? undefined : "finished runs"}
      />
      {/* F31-D6: coordination cost was invisible next to the work it
          coordinated (pass 31 measured 63% with no figure saying so).
          "Coordination" is the operator AND the controller: both decide what
          the working agents do rather than doing the work. */}
      <Metric
        label="Coordination share"
        value={runs.coordination.share === null ? "No share" : fmtPercent(runs.coordination.share)}
        absent={runs.coordination.share === null}
        sub={coordinationSentence(runs.coordination)}
      />
    </div>
  );
}

/**
 * Ruling 635: Claude | Codex, each with its run count, so the split between
 * them reads at a glance without a sum that means nothing.
 */
function BackendSwitch({
  backends,
  selected,
  onSelect,
}: {
  backends: BackendRuns[];
  selected: RunBackend;
  onSelect: (backend: RunBackend) => void;
}) {
  return (
    <div className="seg push" role="group" aria-label="Backend">
      {backends.map(({ backend, runs }) => (
        <button
          key={backend}
          type="button"
          className={backend === selected ? "on" : ""}
          aria-pressed={backend === selected}
          onClick={() => {
            if (backend !== selected) onSelect(backend);
          }}
        >
          {BACKEND_LABEL[backend]}
          <span className="tally">· {fmtCount(runs)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * F31-D6 under ruling 635: the coordination runs' share of one backend's
 * measure. Ruling 190 still decides when there is no share: a side that RAN and
 * put no figure in at all was never observed, so "100%" or "0%" would be the
 * quotient of a gap. A stopped run here and there is the Cost and Tokens
 * figures' disclosure, beside this one.
 */
function coordinationSentence(c: CoordinationShare): string {
  const what = c.measure === "cost" ? "a cost" : "a token total";
  if (c.total <= 0) return `no run has reported ${what} yet`;
  if (c.share === null) {
    const side =
      c.reached.delivery > 0 && c.silent.delivery === c.reached.delivery
        ? "no delivery run"
        : "no operator or controller run";
    return `${side} reported ${what}, so there is no share to take`;
  }
  const figures =
    c.measure === "cost"
      ? `${formatCost(c.coordination)} of ${formatCost(c.total)}`
      : `${fmtTokens(c.coordination)} of ${fmtTokens(c.total)} tokens`;
  return `operator and controller runs, ${figures}`;
}

/**
 * Pass 35 U35-7: "4 stopped (3 by a restart, 2 never started)". A restart's
 * toll reads as what it was, and the never-started share says why the rate's
 * denominator is smaller than the terminal count.
 */
function stoppedLabel(outcomes: RunAnalytics["outcomes"]): string {
  const detail = [
    ...(outcomes.interruptedByRestart
      ? [`${fmtCount(outcomes.interruptedByRestart)} by a restart`]
      : []),
    ...(outcomes.interruptedNeverStarted
      ? [`${fmtCount(outcomes.interruptedNeverStarted)} never started`]
      : []),
  ];
  return `${fmtCount(outcomes.interrupted)} stopped${detail.length ? ` (${detail.join(", ")})` : ""}`;
}

/**
 * Delivery-oversight outcomes (pass 29): the PRD's own measurable-outcome
 * criteria, finally measured (ownership/state clarity, key↔branch↔PR
 * traceability, blocked-decision latency and time-to-review) from the
 * projections and the audit trail the product already keeps. Ruling 635: the
 * instance's own record, so it covers every backend and sits above the switch.
 * Ruling 642: four figures to a row, the long timelines across the band's foot.
 */
function OversightBand({ oversight: g }: { oversight: OversightSummary }) {
  const wait = g.packetResolution;
  return (
    <section>
      <div className="sec-h">
        <h2>Delivery oversight</h2>
      </div>
      <div className="metric-band">
        <Metric
          label="Owner & state clarity"
          value={g.clarity.pct === null ? "No active tasks" : fmtPercent(g.clarity.pct)}
          absent={g.clarity.pct === null}
          sub={
            g.clarity.activeTasks
              ? `${g.clarity.clearTasks} of ${g.clarity.activeTasks} active tasks have a definite next actor`
              : undefined
          }
          names={g.clarity.unclear}
          more={g.clarity.activeTasks - g.clarity.clearTasks - g.clarity.unclear.length}
        />
        <Metric
          label="Branch & PR traceability"
          value={g.traceability.pct === null ? "No deliveries yet" : fmtPercent(g.traceability.pct)}
          absent={g.traceability.pct === null}
          sub={
            g.traceability.deliveredTasks
              ? `${g.traceability.tracedTasks} of ${g.traceability.deliveredTasks} delivered tasks carry branch + PR`
              : undefined
          }
          names={g.traceability.untraced}
          more={g.traceability.deliveredTasks - g.traceability.tracedTasks - g.traceability.untraced.length}
        />
        <Metric
          label="Blocked-decision wait"
          value={
            wait.medianMs !== null
              ? formatDuration(wait.medianMs)
              : wait.openNow
                ? "None resolved"
                : "No decisions yet"
          }
          absent={wait.medianMs === null}
          sub={
            wait.resolved
              ? `median of ${wait.resolved} resolved · avg ${formatDuration(wait.avgMs)}` +
                (wait.openNow ? ` · ${wait.openNow} open now` : "")
              : wait.openNow
                ? `${wait.openNow} open now`
                : undefined
          }
        />
        <Metric
          label="Time to review-ready"
          value={g.timeToReview.medianMs === null ? "None yet" : formatDuration(g.timeToReview.medianMs)}
          absent={g.timeToReview.medianMs === null}
          sub={
            g.timeToReview.tasks
              ? `median of ${g.timeToReview.tasks} tasks · avg ${formatDuration(g.timeToReview.avgMs)}`
              : "no task has reached review yet"
          }
        />
        <Metric
          wide
          label="Long timelines"
          value={fmtCount(g.longTimelines)}
          sub={
            g.longTimelines
              ? "tasks past their project's compression threshold, longest first"
              : "no task is past its project's compression threshold"
          }
          names={g.longTimelineKeys}
          more={g.longTimelines - g.longTimelineKeys.length}
        />
      </div>
    </section>
  );
}

/**
 * The latest provider rate-limit reading for the chosen backend (pass 29):
 * approaching quota exhaustion is visible here BEFORE a run fails on it. A
 * backend with no reading renders neutral: this is an observation log, never a
 * probe. Ruling 635: one row per window the reading lists (ruling 608), so
 * Codex's five-hour window and its weekly one both show, each aged on its own
 * reset (ruling 612). Ruling 642: a row is the window's name and figure over a
 * full-width track, its reset under it, so every track starts and ends on the
 * same lines.
 *
 * D5 (pass 31): the live reading channel was Claude-only, so a Codex account
 * that was ALREADY spent showed "no reading yet" while every run on it was
 * being refused. (Ruling 604 reads Codex's from its rollout, once a run makes a
 * model call.) A refused run is its own row state, rendered as what it is
 * ("from a refused run"), never merged into a utilization number.
 */
function UsageLimits({ runs }: { runs: RunAnalytics }) {
  const hydrated = useHydrated();
  const { backend, reading, exhausted, credentialRefused } = runs.quota;
  const name = BACKEND_LABEL[backend];
  // V4 (pass 31): an exhaustion record is a claim about ONE moment. A
  // utilization reading this backend reported AFTER that moment is fresher
  // evidence from the same provider, so it wins: the refusal is history by
  // then, and showing it would pin the row at 100% while the backend is
  // demonstrably answering runs again.
  const refusal =
    exhausted && !observedAfter(reading?.observedAt, exhausted.observedAt) ? exhausted : null;

  let rows: ReactNode;
  if (credentialRefused) {
    // F32-4 (pass 32): a REJECTED CREDENTIAL outranks every other state: no
    // run on this backend can start until someone fixes it, whatever the
    // utilization window says. It is its own record (the failed run and the
    // provider's sentence) and is cleared by a run that completes on the
    // backend or by the named account being replaced or disconnected (ruling
    // 165); the row says exactly that.
    rows = <CredentialRefusedRow name={name} refused={credentialRefused} hydrated={hydrated} />;
  } else if (refusal) {
    rows = <RunRefusalRow name={name} refusal={refusal} hydrated={hydrated} />;
  } else if (reading == null) {
    rows = (
      <li className="quota-row">
        <span className="quota-name">{name}</span>
        <span className="quota-val na">No reading yet</span>
        <span className="quota-track" />
      </li>
    );
  } else {
    rows = runs.quotaWindows.map((w) => (
      <QuotaWindowRow key={w.rateLimitType} w={w} reading={reading} hydrated={hydrated} />
    ));
  }

  return (
    <section className="panel usage-limits">
      <div className="panel-head">
        <h2>Usage limits</h2>
      </div>
      <ul className="quota-list">{rows}</ul>
      <p className="fine">
        {/* The reading's own age, on the page: a weeks-old 91% must be visibly
            stale, not current (the server module's honesty rule). */}
        {reading
          ? `Latest reading from a ${name} run${hydrated ? `, ${formatDayDotTime(reading.observedAt)}` : ""}.`
          : `No ${name} run has reported a reading yet.`}{" "}
        Near 100%, new runs may be refused until the window resets.
        {refusal && !credentialRefused
          ? " “Usage limit reached” comes from a run the provider refused, not from a reported figure; it clears when a run on this backend completes, when the account it names changes, when the window it names has passed, or when the backend reports a newer reading."
          : ""}
      </p>
    </section>
  );
}

/* Ruling 700(e), the split of `UsageLimits`: the card's three kinds of row,
   each hook-free in the list slot the card's branches filled (the card keeps
   `useHydrated` and hands its answer down), and what a window row reads off
   the reading, as pure functions. */

type QuotaReading = NonNullable<RunAnalytics["quota"]["reading"]>;

const pctOf = (u: number) => Math.max(0, Math.min(100, Math.round(u * 100)));

// D32-2 (ruling 4): the app's ONE date formatter, never the server locale's
// `toLocaleString`. Every localized instant here is hydration-gated: rendered
// during SSR it would be the SERVER's timezone, and React re-renders the page
// rather than patching a text mismatch.
const instant = (unixSeconds: number) =>
  formatDayDotTime(new Date(unixSeconds * 1000).toISOString());

/** A refused credential's row (F32-4, above). */
function CredentialRefusedRow({
  name,
  refused: credentialRefused,
  hydrated,
}: {
  name: string;
  refused: NonNullable<RunAnalytics["quota"]["credentialRefused"]>;
  hydrated: boolean;
}) {
  const refused = hydrated
    ? `run ${credentialRefused.runId} was refused ${formatDayDotTime(credentialRefused.observedAt)}: ${credentialRefused.providerText}`
    : undefined;
  return (
    <li className="quota-row spent">
      <span className="quota-name">{name}</span>
      <span className="quota-val">
        Credential refused
        {credentialRefused.credentialLabel ? ` · ${credentialRefused.credentialLabel}'s account` : ""}
      </span>
      <span className="quota-track">
        <span className="quota-fill full" />
      </span>
      <span className="quota-meta" title={refused}>
        from a refused run · clears when a run on this backend completes or the account changes
        {/* Interface review 2026-09-24 (acce-5): the title is the pointer's
            extra; touch, keyboard and screen readers get the same sentence
            from `.vh`. */}
        {refused && <span className="vh">{" · " + refused}</span>}
      </span>
    </li>
  );
}

/** A run the provider refused for its limit (D5, V4 above). */
function RunRefusalRow({
  name,
  refusal,
  hydrated,
}: {
  name: string;
  refusal: NonNullable<RunAnalytics["quota"]["exhausted"]>;
  hydrated: boolean;
}) {
  const refused = hydrated
    ? `run ${refusal.runId} was refused ${formatDayDotTime(refusal.observedAt)}: ${refusal.providerText}`
    : undefined;
  return (
    <li className="quota-row spent">
      <span className="quota-name">{name}</span>
      <span className="quota-val">Usage limit reached</span>
      <span className="quota-track">
        {/* D5: a provider that REFUSED a run said the window is spent, so
            the track is full. That is the provider's own words, not an
            invented utilization number. */}
        <span className="quota-fill full" />
      </span>
      <span className="quota-meta" title={refused}>
        {[
          // Say where this came from. It is NOT a utilization reading the
          // provider volunteered. Ruling 130(d): and WHOSE account it was.
          refusal.credentialLabel
            ? `from a refused run on ${refusal.credentialLabel}'s account`
            : "from a refused run",
          // V9: only an `exact` reset is a real instant (the provider
          // emitted a unix epoch). A `prose` one was reconstructed from
          // wall-clock words in the ACCOUNT's timezone, which this app does
          // not know, so it renders as the calendar DATE it named and never
          // as a to-the-minute local time we cannot stand behind. Pass 34
          // review: `clock` is a to-the-minute UTC instant too (a provider's
          // "resets 11:50am (UTC)"), so it keeps its hour.
          refusal.resetsAt != null
            ? `retry after ${
                hydrated &&
                (refusal.resetsAtPrecision === "exact" || refusal.resetsAtPrecision === "clock")
                  ? instant(refusal.resetsAt)
                  : // P07-I: a prose-derived date is a UTC calendar day,
                    // and says so: it can be a day off locally.
                    `${utcDayKey(new Date(refusal.resetsAt * 1000).toISOString())} (UTC)`
              }`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {refused && <span className="vh">{" · " + refused}</span>}
      </span>
    </li>
  );
}

/** What one window's row reads off the backend's reading. */
function windowState(w: QuotaWindow, reading: QuotaReading) {
  // Ruling 481(d): a window whose reset has passed keeps its row, in the
  // past tense, with no percentage and no bar.
  const pct = w.reset || w.utilization == null ? null : pctOf(w.utilization);
  // The provider's status and overage belong to the binding window. A
  // warning outranks the reset: the panel exists to warn BEFORE a run
  // fails, so "warning" must never hide behind a date. Not once the window
  // it warned about has reset.
  const binding = w.rateLimitType === reading.rateLimitType && !w.reset;
  const warning = binding && reading.status !== "allowed";
  const overage = binding && reading.isUsingOverage;
  return { pct, warning, overage };
}

/** A window row's meta line: its reset, the provider's warning and overage,
 *  and when it resets. */
function windowMeta(
  w: QuotaWindow,
  reading: QuotaReading,
  warning: boolean,
  overage: boolean,
  hydrated: boolean,
): string {
  return [
    w.reset ? "no reading since" : null,
    warning ? reading.status.replace(/^allowed_/, "").replaceAll("_", " ") : null,
    overage ? "overage" : null,
    // Ruling 130(d): the HOUR when the provider sent one. Before
    // hydration, the timezone-neutral UTC day and clock, marked as
    // such (P07-I), so the first paint is honest either way.
    w.resetsAt != null
      ? `${w.reset ? "reset" : "resets"} ${
          hydrated
            ? instant(w.resetsAt)
            : `${utcDayKey(new Date(w.resetsAt * 1000).toISOString())} ${formatClockUTC(new Date(w.resetsAt * 1000).toISOString())} (UTC)`
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One window the reading lists (ruling 635, ruling 642 above). */
function QuotaWindowRow({
  w,
  reading,
  hydrated,
}: {
  w: QuotaWindow;
  reading: QuotaReading;
  hydrated: boolean;
}) {
  const { pct, warning, overage } = windowState(w, reading);
  return (
    <li
      className={"quota-row" + (warning || overage ? " warn" : "")}
      data-quota-window={w.rateLimitType}
    >
      <span className="quota-name" title={w.rateLimitType}>
        {quotaWindowLabel(w.rateLimitType)}
      </span>
      <span className={"quota-val" + (pct == null ? " na" : "")}>
        {/* Three honest states: a percentage; a window that has reset
            since (no reading on the new one yet); a reading whose
            envelope carried no utilization (the provider's five_hour
            events often omit it). Absent states render de-emphasized
            (.na), never at value weight. */}
        {w.reset ? "Window reset" : pct == null ? "Not reported" : `${pct}%`}
      </span>
      <span className="quota-track">
        <span className="quota-fill" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="quota-meta">
        {windowMeta(w, reading, warning, overage, hydrated)}
      </span>
    </li>
  );
}

/** One column of the prompt-cache table: its head and its cell. `writes` marks
 *  a column made of a figure only some backends report (ruling 395), which
 *  ruling 635 leaves out whole on a backend that reports none. */
interface CacheColumn {
  head: ReactNode;
  cell: (r: CacheRow) => ReactNode;
  writes?: true;
}

/** Ruling 642: the panel's one line, over every run the backend made. */
function cacheHeadline(cache: CacheSummary): string {
  const sum = (pick: (r: CacheRow) => number) => cache.byCredentialKind.reduce((n, r) => n + pick(r), 0);
  const firstCalls = sum((r) => r.firstCalls);
  return [
    firstCalls ? `${fmtPercent(sum((r) => r.warmStarts) / firstCalls)} warm starts` : "no first call yet",
    `${fmtTokens(sum((r) => r.readTokens))} read`,
    cache.reportsWrites ? `${fmtTokens(sum((r) => r.writeTokens ?? 0))} written` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Ruling 369: the prompt-cache record of the chosen backend's runs, by run kind
 * and by credential kind: the warm-start rate over the runs that have a first
 * call, the write/read ratio, the first calls that wrote more than the
 * large-write line, and how many runs' writes were billed under each cache
 * lifetime. Ruling 505 adds PLAN.md's baseline columns (the mean first write,
 * reads per run, the peak prompt's median · p90 · max), and under the table the
 * resumes by idle time and the operator bursts. Every figure is on a `data-`
 * attribute so the DOM reads without the words; a rate with no first call
 * behind it prints "n/a", never 0%.
 *
 * Ruling 642: the panel says its headline in one line and folds the tables and
 * their definitions under it. They are a tuning instrument, and opened they
 * were the page's largest object.
 */
function CachePanel({ cache, backend }: { cache: CacheSummary; backend: RunBackend }) {
  const warmWhy = (r: CacheRow) =>
    `${fmtCount(r.warmStarts)} of ${fmtCount(r.firstCalls)} first calls read more than they wrote`;
  const columns: CacheColumn[] = [
    { head: "group", cell: (r) => <td>{r.label}</td> },
    { head: "runs", cell: (r) => <td data-runs={r.runs}>{fmtCount(r.runs)}</td> },
    {
      head: "warm starts",
      cell: (r) => (
        <td
          data-warm-rate={r.warmRate === null ? "" : r.warmRate}
          className={r.warmRate === null ? "na" : undefined}
          title={warmWhy(r)}
        >
          {r.warmRate === null ? "n/a" : fmtPercent(r.warmRate)}
          {/* Interface review 2026-09-24 (acce-5): the fraction behind the
              rate was title-only. */}
          <span className="vh">{", " + warmWhy(r)}</span>
        </td>
      ),
    },
    { head: "mean first write", writes: true, cell: (r) => <FirstWriteCell r={r} /> },
    {
      head: "read / run",
      cell: (r) => (
        <td
          data-read-per-run={r.readPerRun === null ? "" : r.readPerRun}
          className={r.readPerRun === null ? "na" : undefined}
          title={
            r.readPerRun === null
              ? "No run in this group reached the provider."
              : `Over the ${fmtCount(r.firstCalls)} runs that reached the provider`
          }
        >
          {r.readPerRun === null ? "n/a" : fmtTokens(Math.round(r.readPerRun))}
        </td>
      ),
    },
    {
      head: "peak prompt (median · p90 · max)",
      cell: (r) => (
        <td
          data-peak-median={r.peakPrompt?.median ?? ""}
          data-peak-p90={r.peakPrompt?.p90 ?? ""}
          data-peak-max={r.peakPrompt?.max ?? ""}
          className={r.peakPrompt === null ? "na" : undefined}
        >
          {r.peakPrompt === null
            ? "n/a"
            : [r.peakPrompt.median, r.peakPrompt.p90, r.peakPrompt.max].map(fmtTokens).join(" · ")}
        </td>
      ),
    },
    {
      head: "written",
      writes: true,
      // Ruling 395: a group with no run on a backend that reports the figure
      // has no figure, and the rest of this page already says "not reported"
      // rather than printing a zero it cannot vouch for.
      cell: (r) => (
        <td
          data-write={r.writeTokens === null ? "" : r.writeTokens}
          className={r.writeTokens === null ? "na" : undefined}
          title={
            r.writeTokens === null
              ? NO_WRITE_FIGURE
              : `${fmtCount(r.writeReportingRuns)} of ${fmtCount(r.runs)} runs report one`
          }
        >
          {r.writeTokens === null ? "not reported" : fmtTokens(r.writeTokens)}
        </td>
      ),
    },
    { head: "read", cell: (r) => <td data-read={r.readTokens}>{fmtTokens(r.readTokens)}</td> },
    {
      head: "write / read",
      writes: true,
      cell: (r) => (
        <td
          data-write-read={r.writeReadRatio === null ? "" : r.writeReadRatio}
          className={r.writeReadRatio === null ? "na" : undefined}
        >
          {r.writeReadRatio === null ? "n/a" : r.writeReadRatio.toFixed(3)}
        </td>
      ),
    },
    {
      head: <>first writes &gt; {fmtTokens(cache.largeWriteTokens)}</>,
      writes: true,
      cell: (r) => <td data-large={r.largeFirstWrites}>{fmtCount(r.largeFirstWrites)}</td>,
    },
    {
      head: "lifetime",
      writes: true,
      cell: (r) => (
        <td data-ttl-5m={r.ttl.fiveMinute} data-ttl-1h={r.ttl.oneHour} data-ttl-mixed={r.ttl.mixed}>
          {ttlLabel(r)}
        </td>
      ),
    },
  ];
  const shown = columns.filter((c) => cache.reportsWrites || !c.writes);
  const rows = (group: string, list: CacheRow[]) => (
    <>
      <tr className="group">
        <td colSpan={shown.length}>{group}</td>
      </tr>
      {list.map((r) => (
        <tr key={`${group}:${r.label}`} data-cache-row={`${group}:${r.label}`}>
          {shown.map((c, i) => (
            <Fragment key={i}>{c.cell(r)}</Fragment>
          ))}
        </tr>
      ))}
    </>
  );
  return (
    <section className="panel" data-comment-anchor="prompt-cache">
      <div className="panel-head">
        <h2>Prompt cache</h2>
        <span className="right fine">{cacheHeadline(cache)}</span>
      </div>
      <details className="cache-more">
        <summary>
          Details
          <Icon name="chevron" className="disc-chev" />
        </summary>
        {/* Interface review 2026-09-24 (layo-21): the nowrap columns are wider
            than a phone, so the table scrolls in its own box (the markdown
            tables' wrap), focusable so the keyboard can scroll it too. */}
        <div
          className="md-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Prompt cache by group"
        >
          <table className="cache-table">
            <thead>
              <tr>
                {shown.map((c, i) => (
                  <th key={i}>{c.head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows("by run kind", cache.byKind)}
              {rows("by credential kind", cache.byCredentialKind)}
            </tbody>
          </table>
        </div>
        <ResumeTable resumes={cache.resumes} />
        {cache.operatorBursts && <BurstNote bursts={cache.operatorBursts} />}
        <dl className="cache-defs">
          <dt>Warm start</dt>
          <dd>the run&rsquo;s first model call read more than it wrote.</dd>
          <dt>Read / run, peak prompt</dt>
          <dd>
            over the runs that reached the provider; the peak is each run&rsquo;s largest prompt,
            as median · p90 · max.
          </dd>
          {cache.reportsWrites ? (
            <>
              <dt>Mean first write, write / read</dt>
              <dd>over the same runs; the ratio is tokens written over tokens read.</dd>
              <dt>First writes &gt; {fmtTokens(cache.largeWriteTokens)}</dt>
              <dd>the whole-history replay a stale resume causes.</dd>
              <dt>Lifetime</dt>
              <dd>how many runs&rsquo; writes were billed under each cache TTL.</dd>
            </>
          ) : (
            <>
              <dt>Writes</dt>
              <dd>
                {`${BACKEND_LABEL[backend]} reports no cache write and no cache lifetime, so those columns are left out.`}
              </dd>
            </>
          )}
          <dt>Resumes by idle time</dt>
          <dd>
            the warm resumes out of all the resumes idle that long. A row assumes the cache lasts
            its TTL: a warm resume past it means the cache outlived that, and a cold one inside it
            means the cache lapsed sooner.
          </dd>
          <dt>Set aside</dt>
          <dd>
            sessions idle past the TTL and larger than {fmtTokens(cache.resumes.freshContextTokens)}{" "}
            tokens, which started fresh instead of replaying.
          </dd>
        </dl>
      </details>
    </section>
  );
}

const NO_WRITE_FIGURE = "No run in this group is on a backend that reports a cache-write figure.";

/**
 * Ruling 505: PLAN.md's "avg first-call write". A group with no run on a
 * backend that reports writes says so, as the write column does (ruling 395);
 * one whose reporting runs never reached the provider has no mean to take.
 */
function FirstWriteCell({ r }: { r: CacheRow }) {
  const value =
    r.writeReportingRuns === 0
      ? "not reported"
      : r.avgFirstCallWrite === null
        ? "n/a"
        : fmtTokens(Math.round(r.avgFirstCallWrite));
  return (
    <td
      data-first-write-mean={r.avgFirstCallWrite === null ? "" : r.avgFirstCallWrite}
      className={r.avgFirstCallWrite === null ? "na" : undefined}
      title={
        r.writeReportingRuns === 0
          ? NO_WRITE_FIGURE
          : r.avgFirstCallWrite === null
            ? "No run in this group on a backend that reports writes reached the provider."
            : "Over the runs that reached the provider on a backend that reports writes"
      }
    >
      {value}
    </td>
  );
}

/** An idle edge or a TTL: whole hours as hours, the rest as minutes. Spelled
 *  out, because the table heads are upper-cased and "5M" reads as millions. */
function fmtSpan(ms: number): string {
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours)) return `${hours} ${pluralNoun(hours, "hour")}`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "5 to 10 min", "10 min to 1 hour", "1 to 24 hours": the lower edge drops its
 *  unit when both edges share one, so a narrow head wraps less. */
function fmtSpanRange(lower: number, upper: number): string {
  const inHours = (ms: number) => Number.isInteger(ms / 3_600_000);
  if (inHours(lower) !== inHours(upper)) return `${fmtSpan(lower)} to ${fmtSpan(upper)}`;
  const bare = inHours(lower) ? lower / 3_600_000 : Math.round(lower / 60_000);
  return `${bare} to ${fmtSpan(upper)}`;
}

/**
 * Ruling 505: resumes by how long their session sat idle, one row per
 * credential kind the earlier run billed (the TTL table is keyed on that kind
 * and the backend, which ruling 635's switch has chosen). A warm cell past the
 * row's assumed TTL says the cache outlived it, which is what PLAN.md's Codex
 * retention probe asks; a cold one inside it says the cache lapsed sooner. Each
 * bucket lies wholly inside or wholly past every TTL, because the edges are
 * those TTLs.
 */
function ResumeTable({ resumes }: { resumes: ResumeSummary }) {
  const edges = resumes.edgesMs;
  const buckets = [...edges, Number.POSITIVE_INFINITY].map((upper, i) => {
    const lower = i === 0 ? 0 : edges[i - 1]!;
    const label =
      i === 0
        ? `up to ${fmtSpan(upper)}`
        : i === edges.length
          ? `over ${fmtSpan(lower)}`
          : fmtSpanRange(lower, upper);
    return { lower, label };
  });
  return resumes.rows.length === 0 ? (
    <p className="fine dim">No resumed session yet.</p>
  ) : (
    <div className="md-table-wrap" tabIndex={0} role="region" aria-label="Resumes by idle time">
      <table className="cache-table">
        <thead>
          <tr>
            <th>credential</th>
            <th>assumed TTL</th>
            {buckets.map((b) => (
              <th key={b.label}>{b.label}</th>
            ))}
            <th>set aside</th>
          </tr>
        </thead>
        <tbody>
          {resumes.rows.map((r) => (
            <tr key={r.label} data-resume-row={r.label}>
              <td>{r.label}</td>
              <td data-assumed-ttl={r.assumedTtlMs}>{fmtSpan(r.assumedTtlMs)}</td>
              {r.cells.map((c, i) => {
                const bucket = buckets[i]!;
                const past = bucket.lower >= r.assumedTtlMs;
                const why =
                  `${fmtCount(c.warmStarts)} of ${fmtCount(c.firstCalls)} resumes idle ` +
                  `${bucket.label} read more than they wrote` +
                  (past ? `, past the ${fmtSpan(r.assumedTtlMs)} this row assumes` : "");
                return (
                  <td
                    key={bucket.label}
                    data-bucket={i}
                    data-first-calls={c.firstCalls}
                    data-warm={c.warmStarts}
                    data-past-ttl={past ? "true" : "false"}
                    className={c.firstCalls === 0 ? "na" : undefined}
                    title={c.firstCalls === 0 ? undefined : why}
                  >
                    {/* The fraction is the visible text; no `.vh` beside it:
                        the far columns sit past a phone's edge, and an
                        absolutely placed span there widened the page. */}
                    {c.firstCalls === 0
                      ? "n/a"
                      : `${fmtCount(c.warmStarts)} of ${fmtCount(c.firstCalls)}`}
                  </td>
                );
              })}
              <td data-set-aside={r.setAside}>{fmtCount(r.setAside)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Ruling 505: the operator bursts PLAN.md said to count before building a gate
 * that holds simultaneous starts back. The cold ones in a burst, and what their
 * first calls wrote, are the most such a gate could save.
 */
function BurstNote({ bursts: b }: { bursts: OperatorBurstSummary }) {
  const text =
    b.starts === 0
      ? "Operator bursts: no Claude operator start has reached the provider yet, so there are none to count."
      : `Operator bursts: ${fmtCount(b.starts)} Claude operator ${pluralNoun(b.starts, "start")} ` +
        `reached the provider, and ${fmtCount(b.inBursts)} came within ${fmtSpan(b.windowMs)} of ` +
        `the previous start for the same project, account and model.` +
        (b.inBursts === 0
          ? ""
          : b.coldInBursts === 0
            ? " None of those started cold."
            : ` ${fmtCount(b.coldInBursts)} of those started cold and wrote ` +
              `${fmtTokens(b.coldBurstWrite)} tokens, the most a gate holding such starts ` +
              `back could save.`) +
        ` ${fmtCount(b.coldStarts)} of all the operator starts were cold.`;
  return (
    <p
      className="fine"
      data-operator-bursts
      data-starts={b.starts}
      data-in-bursts={b.inBursts}
      data-cold-in-bursts={b.coldInBursts}
      data-cold-burst-write={b.coldBurstWrite}
      data-cold-starts={b.coldStarts}
    >
      {text}
    </p>
  );
}

function ttlLabel(r: CacheRow): string {
  const parts: string[] = [];
  if (r.ttl.oneHour) parts.push(`${fmtCount(r.ttl.oneHour)} × 1h`);
  if (r.ttl.fiveMinute) parts.push(`${fmtCount(r.ttl.fiveMinute)} × 5m`);
  if (r.ttl.mixed) parts.push(`${fmtCount(r.ttl.mixed)} mixed`);
  return parts.length ? parts.join(" · ") : "not reported";
}

/** `PROJ/KEY` → the task page. The query hands back the pair precisely so the
 *  figure can link rather than leave a reader searching for the key. */
function taskHref(projectAndKey: string): string {
  const [slug, key] = projectAndKey.split("/");
  return `/projects/${slug}/tasks/${key}`;
}

/** Ruling 642: the five breakdowns, one at a time, Agent first. */
const DIMENSIONS = ["agent", "task", "model", "project", "kind"] as const;
type Dimension = (typeof DIMENSIONS)[number];
const DIMENSION_LABEL = {
  agent: "Agent",
  task: "Task",
  model: "Model",
  project: "Project",
  kind: "Kind",
} as const satisfies Record<Dimension, string>;

function breakdownOf(runs: RunAnalytics, by: Dimension): Breakdown {
  if (by === "agent") return runs.byProfile;
  if (by === "task") return runs.byTask;
  if (by === "model") return runs.byModel;
  if (by === "project") return runs.byProject;
  return runs.byKind;
}

/**
 * Where the backend's runs went, by one dimension at a time (`?by=`, read in
 * the browser like `?backend=`): a table of the group's name, its runs and its
 * measure. Ruling 642: the five cards each repeated "runs · cost" over a
 * ragged two-column grid, and each bar measured RUNS beside rows ordered by the
 * MEASURE (F26-4's order), so a cheaper group's bar outgrew the dearer
 * one above it. A row's bar now sits behind its name and measures what the
 * rows are ordered by; a group that reported none of it has no bar.
 */
function BreakdownPanel({ runs }: { runs: RunAnalytics }) {
  const [by, choose] = useSearchChoice("by", DIMENSIONS, "agent");
  const data = breakdownOf(runs, by);
  const { measure } = runs;
  const figure = (r: Breakdown["rows"][number]) => (measure === "cost" ? r.cost : r.tokens);
  const max = data.rows.reduce((m, r) => Math.max(m, figure(r) ?? 0), 0);
  // Ruling 635: the task rows are `project/KEY`, each a link to its page,
  // named by its key alone when every row is one project's: the prefix ruling
  // 308 adds so two projects' A-1 stay apart wrapped every row onto two lines
  // on an instance with one project.
  const projects = new Set(data.rows.flatMap((r) => (r.label.includes("/") ? [r.label.split("/")[0]] : [])));
  return (
    <section className="panel breakdown">
      <div className="panel-head">
        <h2>Breakdown</h2>
        <div className="seg" role="group" aria-label="Break runs down by">
          {DIMENSIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === by ? "on" : ""}
              aria-pressed={d === by}
              onClick={() => {
                if (d !== by) choose(d);
              }}
            >
              {DIMENSION_LABEL[d]}
            </button>
          ))}
        </div>
      </div>
      {data.rows.length === 0 ? (
        <p className="fine">No runs.</p>
      ) : (
        <table className="breakdown-table">
          <thead>
            <tr>
              <th scope="col">{DIMENSION_LABEL[by]}</th>
              <th scope="col" className="bd-num">
                Runs
              </th>
              <th scope="col" className="bd-num bd-fig">
                {measure === "cost" ? "Cost" : "Tokens"}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const value = figure(r);
              return (
                <tr key={r.label} data-breakdown-row={r.label}>
                  <th scope="row" className="bd-name" title={r.name === r.label ? undefined : r.label}>
                    {value !== null && max > 0 && (
                      <span className="bd-fill" style={{ width: `${Math.round((value / max) * 100)}%` }} />
                    )}
                    <span className="bd-text">
                      {by === "task" && r.label.includes("/") ? (
                        <Link to={taskHref(r.label)} className="linkish">
                          {projects.size === 1 ? r.label.split("/")[1] : r.label}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </span>
                  </th>
                  <td className="bd-num">{fmtCount(r.runs)}</td>
                  {/* A group whose runs never reported the figure is UNKNOWN,
                      not free, and reads at the de-emphasized weight. */}
                  <td className={"bd-num bd-fig" + (value === null ? " na" : "")}>{fmtMeasure(measure, value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* Ruling 308: the window says what it left out. Eight of thirty groups
          with nothing said reads as the whole instance, on the surface a
          person opens to decide where their money goes. The figure follows
          `CountRow`'s own rule: absent is "not reported", never 0. */}
      {data.hidden > 0 ? (
        <p className="fine dim">
          {fmtCount(data.hidden)} more not shown · {fmtCount(data.hiddenRuns)} {pluralNoun(data.hiddenRuns, "run")} ·{" "}
          {spokenMeasure(measure, measure === "cost" ? data.hiddenCost : data.hiddenTokens)}
        </p>
      ) : null}
    </section>
  );
}

/** A figure in a sentence: "$0.40", "1.2B tokens", "cost not reported". */
function spokenMeasure(measure: RunMeasure, value: number | null): string {
  if (value === null) return measure === "cost" ? "cost not reported" : "tokens not reported";
  return measure === "cost" ? formatCost(value) : `${fmtTokens(value)} tokens`;
}

/**
 * A 30-day column chart of the backend's runs per day, its day's figures on
 * hover. Each column's height is its share of the busiest day. Ruling 642: the
 * head totals the window, the busiest day's count marks the top line, the
 * first, middle and last days label the base, and an empty day is the bare
 * baseline rather than a grey tick.
 */
function DailyChart({ runs }: { runs: RunAnalytics }) {
  const busiest = runs.daily.reduce((m, d) => Math.max(m, d.runs), 0);
  const max = busiest || 1;
  const windowRuns = runs.daily.reduce((n, d) => n + d.runs, 0);
  const figures = runs.daily.map((d) => (runs.measure === "cost" ? d.cost : d.tokens));
  const windowFigure = figures.some((f) => f !== null) ? figures.reduce<number>((n, f) => n + (f ?? 0), 0) : null;
  // The first, middle and last days label the base, each under its column.
  const ticked = new Set([0, Math.floor((runs.daily.length - 1) / 2), runs.daily.length - 1]);
  return (
    <section className="panel daily-panel">
      <div className="panel-head">
        <h2>Runs per day</h2>
        <span className="right fine">
          Last {runs.windowDays} days · {fmtCount(windowRuns)} {pluralNoun(windowRuns, "run")} ·{" "}
          {spokenMeasure(runs.measure, windowFigure)}
        </span>
      </div>
      <div className="daily-plot">
        {busiest > 0 && (
          <span className="daily-max" aria-hidden="true">
            {fmtCount(busiest)}
          </span>
        )}
        {/* Interface review 2026-09-24 (acce-5): a list, not role="img": an
            image's children are presentational, so the per-day counts and
            costs reached nobody but a hovering mouse. Each column says its
            day in `.vh`. Ruling 634: the pointer's card (`.daily-tip`) shows
            the same figures the moment a column is hovered. */}
        <div
          className="daily-chart"
          role="list"
          aria-label={`${BACKEND_LABEL[runs.backend]} runs per day over the last ${runs.windowDays} days`}
        >
          {runs.daily.map((d, i) => {
            const figure = figures[i] ?? null;
            return (
              <span
                key={d.date}
                className="daily-col"
                role="listitem"
                data-empty={d.runs === 0 || undefined}
              >
                <span
                  className="daily-bar"
                  style={{ height: `${Math.max(3, Math.round((d.runs / max) * 100))}%` }}
                >
                  <span className="daily-tip" aria-hidden="true">
                    <span className="daily-tip-date">{formatCalendarDateUTC(d.date)}</span>
                    <span className="daily-tip-row">
                      <span className="daily-tip-key" />
                      Runs <b>{fmtCount(d.runs)}</b>
                    </span>
                    <span className="daily-tip-row plain">
                      {runs.measure === "cost" ? "Cost" : "Tokens"} <b>{fmtMeasure(runs.measure, figure)}</b>
                    </span>
                  </span>
                </span>
                <span className="vh">{`${d.date}: ${countLabel(d.runs, "run")}, ${spokenMeasure(runs.measure, figure)}`}</span>
                {ticked.has(i) && (
                  <span className="daily-tick" aria-hidden="true">
                    {formatDayBucketUTC(d.date)}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
