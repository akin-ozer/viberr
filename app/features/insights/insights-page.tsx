import { Link } from "react-router";
import type {
  CountRow,
  OversightSummary,
  InsightsSummary,
} from "~/server/insights/insights-query.server";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";

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
  return (
    <main className="insights">
      <div className="insights-head">
        <div>
          <h1>Insights</h1>
          <p className="fine">
            Analytics across every agent run on this instance. Generated{" "}
            <LocalDayDotTime iso={summary.generatedAt} />.
          </p>
        </div>
        {/* Back-navigation points BACK — same idiom as org settings'
            "← Projects" (a forward arrow on a back link reads reversed). */}
        <Link to="/" className="btn sm">
          <Icon name="arrow" className="r180" />
          Home
        </Link>
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
            <StatCard label="Total cost" value={fmtCost(totals.cost)} icon="bolt" />
            <StatCard
              label="Output tokens"
              value={fmtTokens(totals.outputTokens)}
              icon="memory"
              sub={`${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.cachedInputTokens)} cached`}
            />
            <StatCard
              // R26-3 (owner ruling): "Completion rate", not "Success rate" — this
              // measures runs that RAN to completion (finished vs errored/stopped),
              // which is not the same as work that was accepted on review. F26-5:
              // running/queued join the sub-label when present, so the outcome
              // counts always reconcile with "Total runs".
              label="Completion rate"
              value={fmtPercent(outcomes.successRate)}
              icon="check"
              sub={[
                `${outcomes.finished} finished`,
                `${outcomes.error} error`,
                `${outcomes.interrupted} stopped`,
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
        sub="tasks past the compression threshold"
      />
      </div>
    </section>
  );
}

/**
 * Latest provider rate-limit reading per backend (pass 29): approaching quota
 * exhaustion is visible here BEFORE a run fails on it. A backend with no
 * reading renders neutral — this is an observation log, never a probe.
 */
function BackendQuotaPanel({ quota }: { quota: InsightsSummary["backendQuota"] }) {
  const pctOf = (u: number | null) =>
    u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  return (
    <section className="panel breakdown">
      <div className="panel-head">
        <h2>Backend quota</h2>
      </div>
      <ul className="bar-list">
        {quota.map(({ backend, reading }) => {
          const pct = reading ? pctOf(reading.utilization) : null;
          return (
            <li key={backend} className="bar-row">
              <span className="bar-label" title={backend}>
                {backend}
              </span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </span>
              <span className={"bar-val" + (reading == null || pct == null ? " na" : "")}>
                {/* Three honest states: no reading ever; a reading whose
                    envelope carried no utilization number (the provider's
                    five_hour events often omit it — say so, never "no reading
                    yet" next to a reset date); a full percentage reading.
                    Absent states render de-emphasized (.na), never at value
                    weight. */}
                {reading == null
                  ? "no reading yet"
                  : pct == null
                    ? `${reading.rateLimitType.replaceAll("_", " ")} · utilization not reported`
                    : `${pct}% of ${reading.rateLimitType.replaceAll("_", " ")}`}
                {reading && (
                  <span
                    className="bar-cost"
                    // The reading's own age — a weeks-old 91% must be visibly
                    // stale, not current (the server module's honesty rule).
                    title={`observed ${new Date(reading.observedAt).toLocaleString()}`}
                  >
                    {[
                      // A provider warning outranks the reset date — the panel
                      // exists to warn BEFORE a run fails, so "allowed_warning"
                      // must never hide behind "resets 9/18".
                      reading.status !== "allowed"
                        ? reading.status.replace(/^allowed_/, "").replaceAll("_", " ")
                        : null,
                      reading.isUsingOverage ? "overage" : null,
                      reading.resetsAt != null
                        ? `resets ${new Date(reading.resetsAt * 1000).toLocaleDateString()}`
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
        means new runs may start failing when the window is exhausted.
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
                <span className="bar-cost">{fmtCost(r.cost)}</span>
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
            title={`${d.date}: ${d.runs} run${d.runs === 1 ? "" : "s"}, ${fmtCost(d.cost)}`}
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
