import { Link } from "react-router";
import type {
  CountRow,
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
        <Link to="/" className="btn sm">
          <Icon name="arrow" />
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

          <div className="insights-cols">
            <BreakdownCard title="By backend" rows={summary.byBackend} />
            <BreakdownCard title="By run kind" rows={summary.byKind} />
            <BreakdownCard title="By project" rows={summary.byProject} />
            <BreakdownCard title="By model" rows={summary.byModel} />
          </div>
        </>
      )}
    </main>
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
  return (
    <div className="stat-card">
      <span className="stat-ico">
        <Icon name={icon} />
      </span>
      <span className="stat-val">{value}</span>
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
                {fmtCount(r.runs)}
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
