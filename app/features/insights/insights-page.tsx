import type {
  CountRow,
  OversightSummary,
  InsightsSummary,
} from "~/server/insights/insights-query.server";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime, useHydrated } from "~/ui/local-time";
import { formatDayDotTime, utcDayKey, formatClockUTC } from "~/shared/dates/format";

/**
 * Insights: a read-only analytics dashboard over agent runs — totals, outcomes,
 * per-backend/kind/project/model breakdowns and a 30-day activity chart. All
 * numbers come from ONE server query (`getInsightsSummary`); the page only
 * formats and draws. Org-admin gated at the route.
 */

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

export function InsightsPage({ summary }: { summary: InsightsSummary }) {
  const { totals, outcomes } = summary;
  const empty = totals.runs === 0;
  // D33-3: Insights was the one full-page surface with no screen label, so
  // tests and agents could not address it by name like every other one
  // (docs/ui/surfaces.md §4).
  return (
    <main className="insights" data-screen-label="Insights">
      <div className="insights-head">
        <div>
          <h1>Insights</h1>
          <p className="fine">
            Analytics across every agent run on this instance. Generated{" "}
            <LocalDayDotTime iso={summary.generatedAt} />.
          </p>
        </div>
      </div>

      {empty ? (
        <div className="empty">
          No agent runs yet. Once agents start working, their cost, tokens and
          outcomes show up here.
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Total runs" value={fmtCount(totals.runs)} icon="cpu" />
            <StatCard
              label="Total cost"
              value={fmtCost(totals.cost)}
              icon="bolt"
              // Only Claude runs report a cost, so a silent headline reads as
              // the whole instance's spend when it covers a subset of the runs.
              {...(totals.costedRuns < totals.runs
                ? {
                    sub: `${fmtCount(totals.runs - totals.costedRuns)} of ${fmtCount(totals.runs)} runs reported no cost`,
                  }
                : {})}
            />
            <StatCard
              label="Output tokens"
              value={fmtTokens(totals.outputTokens)}
              icon="memory"
              // `in` is the whole prompt of every call on both backends and
              // `cached` the subset of it served from the prompt cache.
              // F35-1: the sums cover provider totals only, so the card names
              // how many runs are outside them, in the shape the Cost card
              // uses for the runs that reported no cost. The count is the
              // sums' own (`tokenlessRuns`), not "runs in flight": a stopped
              // run and one that errored before the provider answered never
              // get a total either, and the reader has to be told.
              sub={
                `${fmtTokens(totals.inputTokens)} in (${fmtTokens(totals.cachedInputTokens)} cached)` +
                (totals.tokenlessRuns > 0
                  ? ` · ${fmtCount(totals.tokenlessRuns)} of ${fmtCount(totals.runs)} runs report no provider token total`
                  : "")
              }
            />
            <StatCard
              // R26-3 (owner ruling): "Completion rate", not "Success rate" — this
              // measures runs that RAN to completion (finished vs errored/stopped),
              // which is not the same as work that was accepted on review. F26-5:
              // running/queued join the sub-label when present, so the outcome
              // counts always reconcile with "Total runs". Pass 35 U35-7: the
              // stopped count names how many a restart stopped and how many
              // never started; the latter are out of the rate's denominator.
              label="Completion rate"
              value={fmtPercent(outcomes.successRate)}
              icon="check"
              sub={[
                `${outcomes.finished} finished`,
                `${outcomes.error} error`,
                stoppedLabel(outcomes),
                ...(outcomes.running ? [`${outcomes.running} running`] : []),
                ...(outcomes.queued ? [`${outcomes.queued} queued`] : []),
              ].join(" · ")}
            />
            <StatCard
              label="Avg run time"
              value={fmtDuration(summary.avgDurationMs)}
              icon="clock"
              sub="finished runs"
            />
            <StatCard label="Turns" value={fmtCount(totals.turns)} icon="refresh" />
          </div>

          <DailyChart summary={summary} />

          <OversightCards oversight={summary.oversight} />

          <div className="insights-cols">
            <BreakdownCard title="By backend" rows={summary.byBackend} />
            <BreakdownCard title="By run kind" rows={summary.byKind} />
            <BreakdownCard title="By project" rows={summary.byProject} />
            <BreakdownCard title="By model" rows={summary.byModel} />
          </div>

          <BackendQuotaPanel quota={summary.backendQuota} />
        </>
      )}
    </main>
  );
}

/**
 * Pass 35 U35-7: "4 stopped (3 by a restart, 2 never started)". A restart's
 * toll reads as what it was, and the never-started share says why the rate's
 * denominator is smaller than the terminal count.
 */
function stoppedLabel(outcomes: InsightsSummary["outcomes"]): string {
  const detail = [
    ...(outcomes.interruptedByRestart
      ? [`${outcomes.interruptedByRestart} by a restart`]
      : []),
    ...(outcomes.interruptedNeverStarted
      ? [`${outcomes.interruptedNeverStarted} never started`]
      : []),
  ];
  return `${outcomes.interrupted} stopped${detail.length ? ` (${detail.join(", ")})` : ""}`;
}

/**
 * Delivery-oversight outcomes (pass 29): the PRD's own measurable-outcome criteria,
 * finally measured — ownership/state clarity, key↔branch↔PR traceability,
 * blocked-decision latency and time-to-review — from the projections and the
 * audit trail the product already keeps.
 */
function OversightCards({ oversight }: { oversight: OversightSummary }) {
  const g = oversight;
  return (
    // Pass 30: this second stat band was visually identical to the run totals
    // above with nothing introducing it — every other band on the page has a
    // heading, so this one gets the same section-label idiom.
    <section>
      <div className="sec-h">
        <Icon name="check" />
        <h2>Delivery oversight</h2>
      </div>
      <div className="stat-grid">
      <StatCard
        label="Owner & state clarity"
        value={fmtPercent(g.clarity.pct)}
        icon="user"
        sub={
          g.clarity.activeTasks
            ? `${g.clarity.clearTasks} of ${g.clarity.activeTasks} active tasks have a definite next actor`
            : "no active tasks"
        }
      />
      <StatCard
        label="Branch & PR traceability"
        value={fmtPercent(g.traceability.pct)}
        icon="branch"
        sub={
          g.traceability.deliveredTasks
            ? `${g.traceability.tracedTasks} of ${g.traceability.deliveredTasks} delivered tasks carry branch + PR`
            : "no delivered tasks yet"
        }
      />
      <StatCard
        label="Blocked-decision wait"
        value={fmtDuration(g.packetResolution.medianMs)}
        icon="clock"
        sub={
          g.packetResolution.resolved
            ? `median of ${g.packetResolution.resolved} resolved · avg ${fmtDuration(g.packetResolution.avgMs)}` +
              (g.packetResolution.openNow
                ? ` · ${g.packetResolution.openNow} open now`
                : "")
            : g.packetResolution.openNow
              ? `${g.packetResolution.openNow} open now · none resolved yet`
              : "no decision packets yet"
        }
      />
      <StatCard
        label="Time to review-ready"
        value={fmtDuration(g.timeToReview.medianMs)}
        icon="check"
        sub={
          g.timeToReview.tasks
            ? `median of ${g.timeToReview.tasks} tasks · avg ${fmtDuration(g.timeToReview.avgMs)}`
            : "no task has reached review yet"
        }
      />
      <StatCard
        label="Long timelines"
        value={fmtCount(g.longTimelines)}
        icon="memory"
        sub="tasks past their project's compression threshold"
      />
      {/* F31-D6: pass 31 measured coordination at 63% of all run spend with
          no card saying so — coordination cost was invisible next to the
          work it coordinated. "Coordination" is the operator AND the
          controller: both decide what the working agents do rather than doing
          the work, so the sub-text names both instead of implying the
          controller's turns are free. Share over COST-REPORTING runs only;
          null when nothing reported a cost (never a fake 0%). */}
      <StatCard
        label="Coordination overhead"
        value={fmtPercent(g.coordination.share)}
        icon="shield"
        sub={
          g.coordination.totalCostUsd > 0
            ? // D04-U12 (pass 32): name the denominator — cost-REPORTING runs
              // only, the way "Total cost" above discloses its subset.
              `operator and controller runs spent $${g.coordination.coordinationCostUsd.toFixed(2)} of $${g.coordination.totalCostUsd.toFixed(2)} reported by cost-reporting runs`
            : "no run has reported a cost yet"
        }
      />
      </div>
    </section>
  );
}

/** Is `iso` strictly newer than `thanIso`? False when either is missing or
 *  unparseable — an unreadable stamp never displaces a recorded claim. */
function observedAfter(iso: string | undefined, thanIso: string): boolean {
  if (!iso) return false;
  const a = Date.parse(iso);
  const b = Date.parse(thanIso);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/**
 * Latest provider rate-limit reading per backend (pass 29): approaching quota
 * exhaustion is visible here BEFORE a run fails on it. A backend with no
 * reading renders neutral — this is an observation log, never a probe.
 *
 * D5 (pass 31): the live reading channel is Claude-only, so a Codex account
 * that was ALREADY spent showed "no reading yet" while every run on it was
 * being refused. A refused run is now its own row state, rendered as what it is
 * ("from a refused run"), never merged into the utilization number.
 */
function BackendQuotaPanel({ quota }: { quota: InsightsSummary["backendQuota"] }) {
  const hydrated = useHydrated();
  const pctOf = (u: number | null) =>
    u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  return (
    <section className="panel breakdown">
      <div className="panel-head">
        <h2>Backend quota</h2>
      </div>
      <ul className="bar-list">
        {quota.map(({ backend, reading, exhausted, credentialRefused }) => {
          const pct = reading ? pctOf(reading.utilization) : null;
          // V4 (pass 31): an exhaustion record is a claim about ONE moment. A
          // utilization reading this backend reported AFTER that moment is
          // fresher evidence from the same provider, so it wins — the refusal
          // is history by then, and showing it would pin the row at 100% while
          // the backend is demonstrably answering runs again.
          const refusal =
            exhausted && !observedAfter(reading?.observedAt, exhausted.observedAt)
              ? exhausted
              : null;
          // F32-4 (pass 32): a REJECTED CREDENTIAL outranks every other state —
          // no run on this backend can start until someone fixes it, whatever
          // the utilization window says. It is its own record (the failed run
          // + the provider's sentence) and is cleared by a run that completes
          // on the backend or by the named account being replaced or
          // disconnected (ruling 165); the row says exactly that.
          if (credentialRefused) {
            return (
              <li key={backend} className="bar-row">
                <span className="bar-label" title={backend}>
                  {backend}
                </span>
                <span className="bar-track">
                  <span className="bar-fill full" />
                </span>
                <span className="bar-val">
                  credential refused
                  {credentialRefused.credentialLabel ? ` · ${credentialRefused.credentialLabel}'s account` : ""}
                  <span
                    className="bar-cost"
                    title={
                      // D32-2 (ruling 4): the app's ONE date formatter, never the
                      // server locale's `toLocaleString`.
                      hydrated
                        ? `run ${credentialRefused.runId} was refused ${formatDayDotTime(
                            credentialRefused.observedAt,
                          )}: ${credentialRefused.providerText}`
                        : undefined
                    }
                  >
                    from a refused run · clears when a run on this backend completes or the account changes
                  </span>
                </span>
              </li>
            );
          }
          return (
            <li key={backend} className="bar-row">
              <span className="bar-label" title={backend}>
                {backend}
              </span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  // D5: a provider that REFUSED a run said the window is spent,
                  // so the track is full. That is the provider's own words, not
                  // an invented utilization number: the refusal is a separate
                  // record from `reading`, and the label below says which one
                  // the row is showing.
                  style={{ width: `${refusal ? 100 : (pct ?? 0)}%` }}
                />
              </span>
              <span
                className={
                  "bar-val" +
                  (refusal == null && (reading == null || pct == null) ? " na" : "")
                }
              >
                {/* Four honest states: the provider refused a run for being over
                    its limit (D5 — the strongest signal there is, and the only
                    one a backend with no live rate-limit channel ever produces);
                    no reading ever; a reading whose envelope carried no
                    utilization number (the provider's five_hour events often
                    omit it, so say so rather than "no reading yet" next to a
                    reset date); a full percentage reading. Absent states render
                    de-emphasized (.na), never at value weight. */}
                {refusal
                  ? "usage limit reached"
                  : reading == null
                    ? "no reading yet"
                    : pct == null
                      ? `${reading.rateLimitType.replaceAll("_", " ")} · utilization not reported`
                      : `${pct}% of ${reading.rateLimitType.replaceAll("_", " ")}`}
                {refusal && (
                  <span
                    className="bar-cost"
                    // Same hydration gate as the reading branch below: a
                    // localized instant rendered during SSR is the SERVER's
                    // timezone, and React re-renders rather than patching it.
                    title={
                      hydrated
                        ? `run ${refusal.runId} was refused ${formatDayDotTime(refusal.observedAt)}: ${refusal.providerText}`
                        : undefined
                    }
                  >
                    {[
                      // Say where this came from. It is NOT a utilization
                      // reading the provider volunteered, and a card that
                      // blurred the two would be claiming a live measurement it
                      // never took. Ruling 130(d): and WHOSE account it was.
                      refusal.credentialLabel
                        ? `from a refused run on ${refusal.credentialLabel}'s account`
                        : "from a refused run",
                      // V9: only an `exact` reset is a real instant (the
                      // provider emitted a unix epoch). A `prose` one was
                      // reconstructed from wall-clock words in the ACCOUNT's
                      // timezone, which this app does not know, so it renders
                      // as the calendar DATE it named and never as a
                      // to-the-minute local time we cannot stand behind.
                      refusal.resetsAt != null
                        ? `retry after ${
                            // Pass 34 review: `clock` is a to-the-minute UTC
                            // instant too (a provider's "resets 11:50am (UTC)"),
                            // so it keeps its hour like `exact` — it used to
                            // fall into the prose branch and lose it.
                            hydrated &&
                            (refusal.resetsAtPrecision === "exact" ||
                              refusal.resetsAtPrecision === "clock")
                              ? formatDayDotTime(new Date(refusal.resetsAt * 1000).toISOString())
                              : // P07-I: a prose-derived date is a UTC calendar
                                // day, and says so — it can be a day off locally.
                                `${utcDayKey(new Date(refusal.resetsAt * 1000).toISOString())} (UTC)`
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
                {!refusal && reading && (
                  <span
                    className="bar-cost"
                    // The reading's own age — a weeks-old 91% must be visibly
                    // stale, not current (the server module's honesty rule).
                    // Hydration-gated: SSR would bake the SERVER's
                    // locale/timezone into the attribute and React never
                    // patches the mismatch (the app's local-time discipline).
                    title={
                      hydrated
                        ? `observed ${formatDayDotTime(reading.observedAt)}`
                        : undefined
                    }
                  >
                    {[
                      // A provider warning outranks the reset date — the panel
                      // exists to warn BEFORE a run fails, so "allowed_warning"
                      // must never hide behind "resets 9/18".
                      reading.status !== "allowed"
                        ? reading.status.replace(/^allowed_/, "").replaceAll("_", " ")
                        : null,
                      reading.isUsingOverage ? "overage" : null,
                      // Hydration-gated for the same reason the `title` above
                      // is: a local calendar date renders in the SERVER's
                      // timezone during SSR and the viewer's on the client, and
                      // React never patches a text mismatch — it re-renders the
                      // whole page. The ungated form is the timezone-neutral
                      // UTC day, marked as such (P07-I), so the first paint is
                      // honest either way. D32-2: the shared formatter, not
                      // `toLocaleDateString`.
                      // Ruling 130(d): the reading names the HOUR when the
                      // provider sent one, not a bare calendar date.
                      reading.resetsAt != null
                        ? `resets ${
                            hydrated
                              ? formatDayDotTime(new Date(reading.resetsAt * 1000).toISOString())
                              : `${utcDayKey(new Date(reading.resetsAt * 1000).toISOString())} ${formatClockUTC(new Date(reading.resetsAt * 1000).toISOString())} (UTC)`
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || reading.status}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="fine">
        Latest reading each backend reported during a run. A high number here
        means new runs may start failing when the window is exhausted. A row
        reading &ldquo;usage limit reached&rdquo; is derived from a run the
        provider refused, not from a reported utilization figure; it clears as
        soon as a run on that backend completes, when the account it names is
        disconnected or replaced, when the window it names has passed, or when
        the backend reports a newer reading.
      </p>
    </section>
  );
}

function StatCard({
  label,
  value,
  icon,
  sub,
}: {
  label: string;
  value: string;
  icon: Parameters<typeof Icon>[0]["name"];
  sub?: string;
}) {
  // An absent reading must not be the loudest thing on the card: "n/a" at
  // full stat emphasis reads like a data point.
  const absent = value === "n/a";
  return (
    <div className="stat-card">
      <span className="stat-ico">
        <Icon name={icon} />
      </span>
      <span className={"stat-val" + (absent ? " na" : "")}>{value}</span>
      <span className="stat-label">{label}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

/** A labelled horizontal bar list, each bar sized to the row's share of the
 *  busiest row (by runs). Cost rides the value column. */
function BreakdownCard({ title, rows }: { title: string; rows: CountRow[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.runs), 0) || 1;
  return (
    <section className="panel breakdown">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="fine">No runs.</p>
      ) : (
        <ul className="bar-list">
          {rows.map((r) => (
            <li key={r.label} className="bar-row">
              <span className="bar-label" title={r.label}>
                {r.label}
              </span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${Math.round((r.runs / max) * 100)}%` }}
                />
              </span>
              <span className="bar-val">
                {/* Fixed right-aligned slots: the counts and costs of a
                    breakdown must line up vertically to be comparable. */}
                <span className="bar-num">{fmtCount(r.runs)}</span>
                {/* The same honesty rule `BackendQuotaPanel` uses for an
                    absent utilization: a group whose runs never reported a cost
                    is UNKNOWN, not free. Only the Claude result envelope
                    carries one, so "$0.00" on a Codex group was a claim the
                    data cannot support. `.bar-cost` is already the
                    de-emphasized column, so the absent state never reads at
                    value weight. */}
                <span className="bar-cost">
                  {r.cost == null ? "not reported" : fmtCost(r.cost)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A 30-day column chart of runs per day, cost in the tooltip. Each column's
 *  height is its share of the busiest day; empty days render a floor tick. */
function DailyChart({ summary }: { summary: InsightsSummary }) {
  const max = summary.daily.reduce((m, d) => Math.max(m, d.runs), 0) || 1;
  return (
    <section className="panel daily">
      <div className="panel-head">
        <h2>Runs · last {summary.windowDays} days</h2>
      </div>
      <div className="daily-chart" role="img" aria-label={`Agent runs per day over the last ${summary.windowDays} days`}>
        {summary.daily.map((d) => (
          <span
            key={d.date}
            className="daily-col"
            title={`${d.date}: ${d.runs} run${d.runs === 1 ? "" : "s"}, ${d.cost == null ? "cost not reported" : fmtCost(d.cost)}`}
          >
            <span
              className="daily-bar"
              style={{ height: `${Math.max(3, Math.round((d.runs / max) * 100))}%` }}
            />
          </span>
        ))}
      </div>
    </section>
  );
}
