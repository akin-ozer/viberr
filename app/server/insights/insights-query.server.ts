import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Insights: read-only aggregate analytics over `agent_runs` — the cost, token,
 * timing and outcome numbers a supervisor wants at a glance. Every read is a
 * plain GROUP BY over the runs table; nothing here writes, and the page that
 * renders it is org-admin gated.
 *
 * `nowIso` is injected (not read from a clock) so the "last N days" window and
 * the generated-at stamp are deterministic and testable.
 */

const WINDOW_DAYS = 30;
const TOP_N = 8;

export interface InsightsTotals {
  runs: number;
  cost: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface CountRow {
  label: string;
  runs: number;
  cost: number;
}

export interface DailyPoint {
  /** YYYY-MM-DD. */
  date: string;
  runs: number;
  cost: number;
}

export interface InsightsSummary {
  totals: InsightsTotals;
  /** Terminal-outcome breakdown + the success rate over terminal runs. */
  outcomes: {
    finished: number;
    error: number;
    interrupted: number;
    running: number;
    queued: number;
    /** finished / (finished+error+interrupted); null when no terminal runs. */
    successRate: number | null;
  };
  byBackend: CountRow[];
  byKind: CountRow[];
  byProject: CountRow[];
  byModel: CountRow[];
  /** Mean wall-clock duration of finished runs with both timestamps, in ms. */
  avgDurationMs: number | null;
  /** Runs + cost per day over the last WINDOW_DAYS, oldest first, gap-filled. */
  daily: DailyPoint[];
  windowDays: number;
  generatedAt: string;
}

const totalsSchema = z.object({
  runs: z.number(),
  cost: z.number().nullable(),
  input_tokens: z.number().nullable(),
  cached_input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  turns: z.number().nullable(),
});

const groupSchema = z.object({
  label: z.string().nullable(),
  runs: z.number(),
  cost: z.number().nullable(),
});

const outcomeSchema = z.object({ state: z.string(), runs: z.number() });

const durationSchema = z.object({ avg_ms: z.number().nullable() });

const dailySchema = z.object({
  date: z.string(),
  runs: z.number(),
  cost: z.number().nullable(),
});

/** Optional project scope — null aggregates the whole instance. */
export interface InsightsFilter {
  projectSlug?: string;
}

interface ScopeClause {
  clause: string;
  params: string[];
}

function scope(filter: InsightsFilter): ScopeClause {
  if (filter.projectSlug) {
    return { clause: "WHERE project_slug = ?", params: [filter.projectSlug] };
  }
  return { clause: "", params: [] };
}

export function getInsightsSummary(
  db: DatabaseSync,
  nowIso: string,
  filter: InsightsFilter = {},
): InsightsSummary {
  const { clause, params } = scope(filter);
  const and = (extra: string) => (clause ? `${clause} AND ${extra}` : `WHERE ${extra}`);

  const totals = totalsSchema.parse(
    db
      .prepare(
        `SELECT count(*) AS runs,
                COALESCE(SUM(total_cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(turns), 0) AS turns
         FROM agent_runs ${clause}`,
      )
      .get(...params),
  );

  const outcomeRows = z.array(outcomeSchema).parse(
    db
      .prepare(
        `SELECT state, count(*) AS runs FROM agent_runs ${clause} GROUP BY state`,
      )
      .all(...params),
  );
  const byState = (s: string) => outcomeRows.find((r) => r.state === s)?.runs ?? 0;
  const finished = byState("finished");
  const errored = byState("error");
  const interrupted = byState("interrupted");
  const terminal = finished + errored + interrupted;

  // F26-4: order by COST first, then runs. This is a cost dashboard, and the
  // breakdown is capped at TOP_N — a run-first order could truncate away a rare
  // but expensive outlier (the exact thing "what's driving spend" needs), keeping
  // eight cheap-but-frequent groups instead. Cost-first guarantees the top cost
  // drivers always survive the cap.
  const group = (column: string): CountRow[] =>
    z
      .array(groupSchema)
      .parse(
        db
          .prepare(
            `SELECT ${column} AS label, count(*) AS runs,
                    COALESCE(SUM(total_cost_usd), 0) AS cost
             FROM agent_runs ${clause}
             GROUP BY ${column}
             ORDER BY cost DESC, runs DESC
             LIMIT ${TOP_N}`,
          )
          .all(...params),
      )
      .map((r) => ({ label: r.label ?? "unknown", runs: r.runs, cost: r.cost ?? 0 }));

  const duration = durationSchema.parse(
    db
      .prepare(
        // julianday() parses the ISO instants; the diff in days × 86.4e6 = ms.
        // F26-6: clamp at 0 (MAX is SQLite's scalar 2-arg form) so a row whose
        // finished_at precedes started_at — a clock adjustment, an import, a future
        // regression — can never drag the average negative and render "-600s".
        `SELECT AVG(MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400000)) AS avg_ms
         FROM agent_runs
         ${and("state = 'finished' AND started_at IS NOT NULL AND finished_at IS NOT NULL")}`,
      )
      .get(...params),
  );

  // Last WINDOW_DAYS by start date. Gap-fill so a quiet day is a real zero, not
  // a missing bar (the chart reads a timeline, not a sparse list).
  const cutoff = new Date(
    new Date(nowIso).getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const dailyRows = z.array(dailySchema).parse(
    db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS date, count(*) AS runs,
                COALESCE(SUM(total_cost_usd), 0) AS cost
         FROM agent_runs
         ${and("started_at IS NOT NULL AND substr(started_at, 1, 10) >= ?")}
         GROUP BY date ORDER BY date ASC`,
      )
      .all(...params, cutoff),
  );
  const byDate = new Map(dailyRows.map((r) => [r.date, r]));
  const daily: DailyPoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(new Date(cutoff).getTime() + i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const row = byDate.get(d);
    daily.push({ date: d, runs: row?.runs ?? 0, cost: row?.cost ?? 0 });
  }

  return {
    totals: {
      runs: totals.runs,
      cost: totals.cost ?? 0,
      inputTokens: totals.input_tokens ?? 0,
      cachedInputTokens: totals.cached_input_tokens ?? 0,
      outputTokens: totals.output_tokens ?? 0,
      turns: totals.turns ?? 0,
    },
    outcomes: {
      finished,
      error: errored,
      interrupted,
      running: byState("running"),
      queued: byState("queued"),
      successRate: terminal > 0 ? finished / terminal : null,
    },
    byBackend: group("backend"),
    byKind: group("kind"),
    byProject: group("project_slug"),
    byModel: group("model"),
    avgDurationMs: duration.avg_ms,
    daily,
    windowDays: WINDOW_DAYS,
    generatedAt: nowIso,
  };
}
