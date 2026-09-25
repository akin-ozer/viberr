import type {
  Breakdown,
  CacheRow,
  CacheSummary,
  OversightSummary,
  InsightsSummary,
} from "~/server/insights/insights-query.server";
import { Link } from "react-router";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime, useHydrated } from "~/ui/local-time";
import { formatDayDotTime, utcDayKey, formatClockUTC } from "~/shared/dates/format";
import { observedAfter } from "~/shared/freshness";
import { countLabel } from "~/shared/text/plural";

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
        // Design pass 2026-09-08: this was a bare `.empty` — one centred
        // sentence adrift in a full-height page, left-aligned header above it
        // and 600px of nothing below. A page-level empty state is a composed
        // object, and the app already has one: `.empty-hero`, which Home uses
        // when a person has no projects. Same idiom here, so the two pages
        // teach the same thing.
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

          <CachePanel cache={summary.cache} />

          <OversightCards oversight={summary.oversight} />

          <div className="insights-cols">
            <BreakdownCard title="By backend" data={summary.byBackend} />
            <BreakdownCard title="By run kind" data={summary.byKind} />
            <BreakdownCard title="By project" data={summary.byProject} />
            <BreakdownCard title="By model" data={summary.byModel} />
            <BreakdownCard title="By agent profile" data={summary.byProfile} />
            <BreakdownCard title="By task" data={summary.byTask} />
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
        names={g.clarity.unclear}
        more={g.clarity.activeTasks - g.clarity.clearTasks - g.clarity.unclear.length}
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
        names={g.traceability.untraced}
        more={
          g.traceability.deliveredTasks -
          g.traceability.tracedTasks -
          g.traceability.untraced.length
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
        names={g.longTimelineKeys}
        more={g.longTimelines - g.longTimelineKeys.length}
      />
      {/* F31-D6: pass 31 measured coordination at 63% of all run spend with
          no card saying so — coordination cost was invisible next to the
          work it coordinated. "Coordination" is the operator AND the
          controller: both decide what the working agents do rather than doing
          the work, so the sub-text names both instead of implying the
          controller's turns are free.

          Ruling 190 → 201: the share is shown only when EVERY run on both
          sides reported a cost. Anything less and the figure is a ratio of
          whichever runs happened to bill — on a mixed-backend instance that is
          a small minority, because only Claude's result envelope carries a
          price. The suppressed case gives the dollars that ARE real and names
          the silent runs by their count and their backend; the token card
          beside it carries the share that survives the blind spot. */}
      <StatCard
        label="Coordination overhead"
        value={fmtPercent(g.coordination.share)}
        icon="shield"
        sub={
          g.coordination.totalCostUsd <= 0
            ? "no run has reported a cost yet"
            : g.coordination.share === null
              ? `operator and controller runs reported $${g.coordination.coordinationCostUsd.toFixed(2)}; ${costSilence(g.coordination)}, so there is no share to take`
              : // D04-U12 (pass 32): name the denominator. It is now every run
                // in scope, which is what makes the quotient a measurement.
                `operator and controller runs spent $${g.coordination.coordinationCostUsd.toFixed(2)} of $${g.coordination.totalCostUsd.toFixed(2)}; every run reported a cost`
        }
      />
      {/* Ruling 201: the owner's call on F37-21 — suppress the dollar share
          when it cannot be measured, and put a real number beside it rather
          than a gap. Tokens are the unit BOTH backends report. Its own unit is
          stated on the card, because a token is not a dollar and the models on
          either side of this ratio are not priced alike. */}
      <StatCard
        label="Coordination tokens"
        value={fmtPercent(g.coordination.tokenShare)}
        icon="memory"
        sub={
          g.coordination.totalTokens <= 0
            ? "no run has reported a provider token total yet"
            : g.coordination.tokenShare === null
              ? `operator and controller runs processed ${fmtTokens(g.coordination.coordinationTokens)} tokens; ${tokenSilence(g.coordination)}, so there is no share to take`
              : `${fmtTokens(g.coordination.coordinationTokens)} of ${fmtTokens(g.coordination.totalTokens)} tokens processed; tokens, not dollars` +
                (g.coordination.tokenless.delivery + g.coordination.tokenless.coordination > 0
                  ? ` · ${fmtCount(g.coordination.tokenless.delivery + g.coordination.tokenless.coordination)} of ${fmtCount(g.coordination.runs.delivery + g.coordination.runs.coordination)} runs report no provider total`
                  : "")
        }
      />
      </div>
    </section>
  );
}

/** Ruling 201: which runs left the dollar share unmeasurable, in the reader's
 *  terms. A side that reported NOTHING and a side that reported SOME are
 *  different facts and get different sentences; the backend clause comes off
 *  the rows, so it names whatever actually went silent rather than a backend
 *  this file guessed at. */
function costSilence(c: OversightSummary["coordination"]): string {
  const backends = c.uncostedByBackend
    // Title-cased from the row, not matched against a list of backend names
    // this file knows: ruling 191's lesson is that copy which hardcodes what
    // the environment contains goes stale the day the environment changes.
    .map((b) => `${fmtCount(b.runs)} on ${b.backend.charAt(0).toUpperCase()}${b.backend.slice(1)}`)
    .join(" and ");
  const silent = c.uncosted.delivery + c.uncosted.coordination;
  const total = c.runs.delivery + c.runs.coordination;
  // Ruling 211(g): the parenthetical counts the WHOLE cost-silent population,
  // so it may only ride a clause that names the whole population. Attached to
  // "no delivery run reported a cost" it told the reader a number that belongs
  // to both sides while blaming one — and hid that coordination was partly
  // silent too, which is the very thing ruling 201 exists to disclose.
  const wholeSideSilent =
    c.runs.delivery > 0 && c.uncosted.delivery === c.runs.delivery
      ? "no delivery run reported a cost"
      : c.runs.coordination > 0 && c.uncosted.coordination === c.runs.coordination
        ? "no operator or controller run reported a cost"
        : null;
  // Only when the OTHER side is partly silent too does the count span more than
  // the clause names; when the named side owns every silent run, the original
  // single clause is exact.
  const otherPartlySilent =
    wholeSideSilent === "no delivery run reported a cost"
      ? c.uncosted.coordination > 0
      : c.uncosted.delivery > 0;
  if (wholeSideSilent !== null && otherPartlySilent) {
    // One side is entirely silent AND the other is partly silent: say both, and
    // keep the backend breakdown on the total where it belongs.
    const rest = `${fmtCount(silent)} of ${fmtCount(total)} runs report no cost in total`;
    return backends
      ? `${wholeSideSilent}, and ${rest} (${backends})`
      : `${wholeSideSilent}, and ${rest}`;
  }
  const counted = wholeSideSilent ?? `${fmtCount(silent)} of ${fmtCount(total)} runs report no cost`;
  return backends ? `${counted} (${backends})` : counted;
}

/** The same sentence for the token share, whose gap is a side that landed no
 *  provider figure at all (F35-1's excluded rows, concentrated on one side). */
function tokenSilence(c: OversightSummary["coordination"]): string {
  return c.runs.delivery > 0 && c.tokenless.delivery === c.runs.delivery
    ? "no delivery run reported a provider token total"
    : "no operator or controller run reported a provider token total";
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
        {quota.map(({ backend, reading, exhausted, credentialRefused, readingWindowReset }) => {
          // Ruling 481(d) (F40-50): a reading whose own window has reset
          // describes a window that is over. It keeps its row, in the past
          // tense, but no percentage and no bar: "92% of five hour · resets
          // 03:30" at 09:00 read as a nearly spent window about to reopen.
          const lapsed = reading != null && readingWindowReset === true;
          const pct = reading && !lapsed ? pctOf(reading.utilization) : null;
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
            // D32-2 (ruling 4): the app's ONE date formatter, never the
            // server locale's `toLocaleString`.
            const refused = hydrated
              ? `run ${credentialRefused.runId} was refused ${formatDayDotTime(
                  credentialRefused.observedAt,
                )}: ${credentialRefused.providerText}`
              : undefined;
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
                  <span className="bar-cost" title={refused}>
                    from a refused run · clears when a run on this backend completes or the account changes
                    {/* Interface review 2026-09-24 (acce-5): the title is the
                        pointer's extra; touch, keyboard and screen readers get
                        the same sentence from `.vh` (the rows below too). */}
                    {refused && <span className="vh">{" · " + refused}</span>}
                  </span>
                </span>
              </li>
            );
          }
          // Hydration-gated: a localized instant rendered during SSR is the
          // SERVER's timezone, and React re-renders rather than patching it.
          const refused =
            refusal && hydrated
              ? `run ${refusal.runId} was refused ${formatDayDotTime(refusal.observedAt)}: ${refusal.providerText}`
              : undefined;
          // The reading's own age — a weeks-old 91% must be visibly stale, not
          // current (the server module's honesty rule). Same hydration gate.
          const observed =
            reading && hydrated ? `observed ${formatDayDotTime(reading.observedAt)}` : undefined;
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
                    : lapsed
                      ? `${reading.rateLimitType.replaceAll("_", " ")} · window reset, no reading since`
                      : pct == null
                        ? `${reading.rateLimitType.replaceAll("_", " ")} · utilization not reported`
                        : `${pct}% of ${reading.rateLimitType.replaceAll("_", " ")}`}
                {refusal && (
                  <span className="bar-cost" title={refused}>
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
                    {refused && <span className="vh">{" · " + refused}</span>}
                  </span>
                )}
                {!refusal && reading && (
                  <span className="bar-cost" title={observed}>
                    {[
                      // A provider warning outranks the reset date — the panel
                      // exists to warn BEFORE a run fails, so "allowed_warning"
                      // must never hide behind "resets 9/18". Not once the
                      // window it warned about has reset (ruling 481(d)).
                      reading.status !== "allowed" && !lapsed
                        ? reading.status.replace(/^allowed_/, "").replaceAll("_", " ")
                        : null,
                      reading.isUsingOverage && !lapsed ? "overage" : null,
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
                        ? // Ruling 481(d): past tense once it has passed.
                          `${lapsed ? "reset" : "resets"} ${
                            hydrated
                              ? formatDayDotTime(new Date(reading.resetsAt * 1000).toISOString())
                              : `${utcDayKey(new Date(reading.resetsAt * 1000).toISOString())} ${formatClockUTC(new Date(reading.resetsAt * 1000).toISOString())} (UTC)`
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || reading.status}
                    {observed && <span className="vh">{" · " + observed}</span>}
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
  /** Ruling 290: the exceptions this number counts, BY NAME. A card that
   *  reports "41 of 42 delivered tasks carry branch + PR" and will not say
   *  which one cannot be traced has withheld the only fact a reader needs. */
  names,
  /** How many more there are than the card names, so a capped list never reads
   *  as the whole set. */
  more,
}: {
  label: string;
  value: string;
  icon: Parameters<typeof Icon>[0]["name"];
  sub?: string;
  names?: readonly string[];
  more?: number;
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
      {names && names.length > 0 && (
        <span className="stat-sub stat-names">
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

/**
 * Ruling 369: the prompt-cache record, by run kind and by credential kind —
 * the warm-start rate over the runs that have a first call, the write/read
 * ratio, the first calls that wrote more than the large-write line, and how
 * many runs' writes were billed under each cache lifetime. Every figure is on
 * a `data-` attribute so the DOM reads without the words; a rate with no
 * first call behind it prints "n/a", never 0%.
 */
function CachePanel({ cache }: { cache: CacheSummary }) {
  const warmWhy = (r: CacheRow) =>
    `${fmtCount(r.warmStarts)} of ${fmtCount(r.firstCalls)} first calls read more than they wrote`;
  const rows = (group: string, list: CacheRow[]) => (
    <>
      <tr className="group">
        <td colSpan={7}>{group}</td>
      </tr>
      {list.map((r) => (
        <tr key={`${group}:${r.label}`} data-cache-row={`${group}:${r.label}`}>
          <td>{r.label}</td>
          <td data-runs={r.runs}>{fmtCount(r.runs)}</td>
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
          {/* Ruling 395: a group with no run on a backend that reports the
              figure has no figure, and the rest of this page already says
              "not reported" rather than printing a zero it cannot vouch for. */}
          <td
            data-write={r.writeTokens === null ? "" : r.writeTokens}
            className={r.writeTokens === null ? "na" : undefined}
            title={
              r.writeTokens === null
                ? "No run in this group is on a backend that reports a cache-write figure."
                : `${fmtCount(r.writeReportingRuns)} of ${fmtCount(r.runs)} runs report one`
            }
          >
            {r.writeTokens === null ? "not reported" : fmtTokens(r.writeTokens)}
          </td>
          <td data-read={r.readTokens}>{fmtTokens(r.readTokens)}</td>
          <td
            data-write-read={r.writeReadRatio === null ? "" : r.writeReadRatio}
            className={r.writeReadRatio === null ? "na" : undefined}
          >
            {r.writeReadRatio === null ? "n/a" : r.writeReadRatio.toFixed(3)}
          </td>
          <td data-large={r.largeFirstWrites}>{fmtCount(r.largeFirstWrites)}</td>
          <td data-ttl-5m={r.ttl.fiveMinute} data-ttl-1h={r.ttl.oneHour} data-ttl-mixed={r.ttl.mixed}>
            {ttlLabel(r)}
          </td>
        </tr>
      ))}
    </>
  );
  return (
    <section className="panel" data-comment-anchor="prompt-cache">
      <div className="panel-head">
        <h2>Prompt cache</h2>
      </div>
      <p className="fine">
        What the provider's prompt cache did for the runs on this instance: a warm start read more
        than it wrote on its first model call; the ratio is tokens written over tokens read; a
        large first write is one above {fmtTokens(cache.largeWriteTokens)}, the whole-history
        replay a stale resume causes. The lifetime column is how many runs' writes were billed
        under each cache TTL. Claude reports both the write figure and the lifetime; Codex
        reports neither, so a group of Codex runs reads "not reported" rather than zero.
      </p>
      {/* Interface review 2026-09-24 (layo-21): eight nowrap columns are wider
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
              <th>group</th>
              <th>runs</th>
              <th>warm starts</th>
              <th>written</th>
              <th>read</th>
              <th>write / read</th>
              <th>first writes &gt; {fmtTokens(cache.largeWriteTokens)}</th>
              <th>lifetime</th>
            </tr>
          </thead>
          <tbody>
            {rows("by run kind", cache.byKind)}
            {rows("by credential kind", cache.byCredentialKind)}
          </tbody>
        </table>
      </div>
    </section>
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
 *  card can link rather than leave a reader searching for the key. */
function taskHref(projectAndKey: string): string {
  const [slug, key] = projectAndKey.split("/");
  return `/projects/${slug}/tasks/${key}`;
}

/** A labelled horizontal bar list, each bar sized to the row's share of the
 *  busiest row (by runs). Cost rides the value column. */
function BreakdownCard({ title, data }: { title: string; data: Breakdown }) {
  const rows = data.rows;
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
      {/* Ruling 308: the window says what it left out. Eight of thirty groups
          with nothing said reads as the whole instance, on the surface a
          person opens to decide where their money goes. The cost follows
          `CountRow`'s own rule: absent is "not reported", never $0. */}
      {data.hidden > 0 ? (
        <p className="fine dim">
          {fmtCount(data.hidden)} more {data.hidden === 1 ? "group" : "groups"} not
          shown, {fmtCount(data.hiddenRuns)}{" "}
          {data.hiddenRuns === 1 ? "run" : "runs"} between them
          {data.hiddenCost == null ? ", cost not reported" : `, ${fmtCost(data.hiddenCost)}`}.
        </p>
      ) : null}
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
      {/* Interface review 2026-09-24 (acce-5): a list, not role="img" — an
          image's children are presentational, so the per-day counts and costs
          reached nobody but a hovering mouse. Each column says its day in
          `.vh`; the title stays the pointer's extra. */}
      <div className="daily-chart" role="list" aria-label={`Agent runs per day over the last ${summary.windowDays} days`}>
        {summary.daily.map((d) => {
          const day = `${d.date}: ${countLabel(d.runs, "run")}, ${d.cost == null ? "cost not reported" : fmtCost(d.cost)}`;
          return (
            <span key={d.date} className="daily-col" role="listitem" title={day}>
              <span
                className="daily-bar"
                style={{ height: `${Math.max(3, Math.round((d.runs / max) * 100))}%` }}
              />
              <span className="vh">{day}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
