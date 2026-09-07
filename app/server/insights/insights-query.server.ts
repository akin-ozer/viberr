import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { guardrailSchema } from "~/schemas/project-file.schema";
import {
  latestBackendRateLimits,
  type BackendQuotaRow,
} from "~/server/runtimes/backend-quota.server";
import { DEFAULT_COMPACTION } from "~/server/tasks/timeline-compaction.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";

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
  /** Runs that actually reported a cost. `runs - costedRuns` is the slice the
   *  `cost` sum below can say nothing about, because only Claude reports one. */
  costedRuns: number;
  cost: number;
  /** F35-1: the three token sums cover only rows whose provider total landed
   *  (`agent_runs.usage_final = 1`); a running run's live estimate is not in
   *  them, which the card says whenever a run is running. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface CountRow {
  label: string;
  runs: number;
  /** Summed reported cost, or null when NO run in the group reported one. Only
   *  the Claude result envelope carries a cost, so a Codex group's cost is
   *  UNKNOWN, not zero. */
  cost: number | null;
}

export interface DailyPoint {
  /** YYYY-MM-DD. */
  date: string;
  runs: number;
  /** Total cost for the day, or null when the day HAS runs but none reported a
   *  cost (all-Codex) — rendered "not reported", never a dishonest $0.00. A
   *  gap-filled quiet day (no runs) is a real 0. */
  cost: number | null;
}

/**
 * Governance outcomes (pass 29, critique gap 3.1 — owner "build it now"): the
 * PRD's own "Measurable outcomes" (prd.md) promise unambiguous ownership/state,
 * task↔branch↔PR traceability, fast decisions on blocked work, and readable
 * long timelines — and until now the product measured none of them. These are
 * computed from the projections + audit trail the app already keeps; nothing
 * new is recorded. All-time (like the totals above), not windowed.
 */
export interface OversightSummary {
  /** Active (non-archived, non-terminal-stage) tasks with a definite next
   *  actor: `waiting` names human/agent, or a human owns the task. */
  clarity: { activeTasks: number; clearTasks: number; pct: number | null };
  /** Of DELIVERED tasks — a delivered work revision or a recorded PR — how
   *  many carry BOTH the task branch and a recorded PR, the key↔branch↔PR
   *  chain (ruling 143). An allocated branch alone is NOT a delivery: ruling
   *  122 names the branch at first dispatch, before an agent has written
   *  anything, so counting it grew the denominator to every task that ever
   *  engaged a deliverer (pass 34, U34-9: "7 of 8 delivered tasks" while one
   *  of the eight had delivered nothing). The residue is deliberate: a
   *  delivered revision with NO pull request stays in the denominator,
   *  because an unpushed delivery is exactly the untraceable one this number
   *  exists to find. */
  traceability: { deliveredTasks: number; tracedTasks: number; pct: number | null };
  /** How long an operator-opened decision/blocked packet waits for the human,
   *  from the packet-opened audit row to its task's next packet-resolved row. */
  packetResolution: {
    resolved: number;
    avgMs: number | null;
    medianMs: number | null;
    /** Live count of unresolved packets on active tasks — the current queue. */
    openNow: number;
  };
  /** Task creation → first transition into the project's review-role stage. */
  timeToReview: { tasks: number; avgMs: number | null; medianMs: number | null };
  /** Tasks whose timeline passed THEIR OWN project's compression-guardrail
   *  threshold — long-running records the readability machinery is actively
   *  managing. A project with the guardrail off contributes none: nothing is
   *  compacting there. */
  longTimelines: number;
  /** F31-D6 — coordination overhead: the COORDINATION runs' share of all
   *  reported run spend in scope. Live pass 31 read 63% before anyone had a
   *  number for it. Coordination is `operator` + `controller` (RunKind): both
   *  are machinery that decides what the working agents do rather than doing
   *  the work, they carry real cost, and the runtime treats them as one class
   *  (claude-runtime: "the controller is coordination machinery like the
   *  operator"). Counting only the operator understated the overhead by every
   *  controller turn on the instance. Derived from the same cost column the
   *  totals card sums; runs that reported no cost contribute to neither side,
   *  and with zero reported spend the share is null (never a fake 0%). */
  coordination: {
    coordinationCostUsd: number;
    totalCostUsd: number;
    /** coordination / total over cost-reporting runs; null when none. */
    share: number | null;
  };
}

export interface InsightsSummary {
  totals: InsightsTotals;
  /** Terminal-outcome breakdown + the success rate over terminal runs. */
  outcomes: {
    finished: number;
    error: number;
    /** Every `interrupted` run, a person's stop and a restart's alike, so the
     *  five counts still reconcile with `totals.runs` (F26-5). */
    interrupted: number;
    /** Pass 35 U35-7: the subset of `interrupted` that never executed a turn
     *  (`turns = 0` and no `started_at`): a queued run a restart or a person
     *  stopped before any runtime slot opened. Out of the completion
     *  denominator, because nothing ran to complete or fail. */
    interruptedNeverStarted: number;
    /** Pass 35 U35-7: the subset of `interrupted` whose stored reason is a
     *  restart (boot recovery). Named on the card so a boot's toll reads as
     *  what it was, not as failures. */
    interruptedByRestart: number;
    running: number;
    queued: number;
    /** finished / (finished + error + interrupted - interruptedNeverStarted);
     *  null when that denominator is zero. */
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
  oversight: OversightSummary;
  /** Latest observed provider rate-limit reading per backend (null = none yet). */
  backendQuota: BackendQuotaRow[];
  windowDays: number;
  generatedAt: string;
}

const totalsSchema = z.object({
  runs: z.number(),
  costed_runs: z.number(),
  cost: z.number().nullable(),
  /** F31-D6's numerator, summed in the SAME pass as `cost` — it is the same
   *  rows under the same scope, so a second full aggregate over `agent_runs`
   *  bought nothing but another table scan. */
  coordination_cost: z.number().nullable(),
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

/** Pass 35 U35-7: the two facts about `interrupted` runs the completion rate
 *  needs. `SUM` over no rows is NULL, hence nullable. */
const interruptedSchema = z.object({
  never_started: z.number().nullable(),
  by_restart: z.number().nullable(),
});

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

// ---------------------------------------------------------- governance

/** The project.md `guardrails` row that decides when a timeline is compacted —
 *  the same id the compaction paths read. Its value is PER PROJECT and can be
 *  switched off, so there is no instance-wide threshold to hard-code here. */
const COMPRESSION_GUARDRAIL_ID = "compression-threshold";

const govTaskSchema = z.object({
  project_slug: z.string(),
  task_key: z.string(),
  stage: z.string(),
  waiting: z.string(),
  owner_user_id: z.string().nullable(),
  archived: z.number(),
  branch: z.string().nullable(),
  pr_json: z.string().nullable(),
  work_revision_sha: z.string().nullable(),
  packet_json: z.string().nullable(),
  event_count: z.number(),
  created_at: z.string().nullable(),
});

const govProjectSchema = z.object({
  slug: z.string(),
  stages_json: z.string(),
  workflow_json: z.string(),
  guardrails_json: z.string(),
});

const govAuditSchema = z.object({
  project_slug: z.string().nullable(),
  task_key: z.string().nullable(),
  action: z.string(),
  occurred_at: z.string(),
  details_json: z.string().nullable(),
});

/** Tolerant, schema-typed JSON parse of a projected column — a corrupt or
 *  missing row reads as the fallback, never a crash on an analytics loader. */
function parsedJson<S extends z.ZodType>(
  schema: S,
  text: string | null,
  fallback: z.infer<S>,
): z.infer<S> {
  if (!text) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

const stageDefsSchema = z.array(z.object({ id: z.string() }).loose());
const workflowDefsSchema = z.array(
  z.object({ from: z.string(), to: z.string() }).loose(),
);
const guardrailDefsSchema = z.array(guardrailSchema);

/**
 * The event count past which THIS project's timelines are actually compacted,
 * or null when the project has the compression guardrail off or never carried
 * it.
 *
 * A card claiming the readability machinery is managing a task has to agree
 * with the machinery: a hard-coded 40 counted tasks in a project that compacts
 * at 10 as short, and tasks in a project that compacts nothing at all as
 * actively managed.
 */
function compressionThreshold(guardrailsJson: string): number | null {
  const rows = parsedJson(guardrailDefsSchema, guardrailsJson, []);
  const rail = rows.find((g) => g.id === COMPRESSION_GUARDRAIL_ID && g.on);
  if (!rail) return null;
  return rail.value != null && rail.value > 0
    ? rail.value
    : DEFAULT_COMPACTION.threshold;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function avg(values: number[]): number | null {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

function oversightSummary(
  db: DatabaseSync,
  filter: InsightsFilter,
  // F31-D6 rides in from the totals aggregate rather than re-querying
  // `agent_runs`: same rows, same scope, one scan.
  coordination: OversightSummary["coordination"],
): OversightSummary {
  const { clause, params } = scope(filter);

  const tasks = z.array(govTaskSchema).parse(
    db
      .prepare(
        `SELECT project_slug, task_key, stage, waiting, owner_user_id, archived,
                branch, pr_json, work_revision_sha, packet_json, event_count,
                created_at
         FROM task_projections ${clause}`,
      )
      .all(...params),
  );
  const projects = z.array(govProjectSchema).parse(
    db
      .prepare(
        `SELECT slug, stages_json, workflow_json, guardrails_json FROM projects` +
          (filter.projectSlug ? ` WHERE slug = ?` : ``),
      )
      .all(...(filter.projectSlug ? [filter.projectSlug] : [])),
  );

  // Per-project stage roles, from the same resolver every governed surface uses.
  const roles = new Map(
    projects.map((p) => [
      p.slug,
      resolveStageRoles(
        parsedJson(stageDefsSchema, p.stages_json, []),
        parsedJson(workflowDefsSchema, p.workflow_json, []),
      ),
    ]),
  );

  // Each project's OWN compression threshold, from the same rows the stage
  // roles come from: a project with the guardrail off compacts nothing, so no
  // task in it can be one the readability machinery is managing.
  const compressionAt = new Map(
    projects.map((p) => [p.slug, compressionThreshold(p.guardrails_json)]),
  );

  // 1. Ownership/state clarity over ACTIVE tasks (not archived, not terminal).
  const active = tasks.filter((t) => {
    if (t.archived) return false;
    const terminal = roles.get(t.project_slug)?.terminalId ?? null;
    return terminal == null || t.stage !== terminal;
  });
  const clearTasks = active.filter(
    (t) => t.waiting !== "none" || t.owner_user_id != null,
  ).length;

  // 2. Key↔branch↔PR traceability over DELIVERED tasks: a delivered revision
  // or a recorded PR. A branch alone is not a delivery — ruling 122 allocates
  // the name at first dispatch, before any work exists (ruling 143, U34-9).
  const delivered = tasks.filter(
    (t) => t.work_revision_sha != null || t.pr_json != null,
  );
  const traced = delivered.filter(
    (t) => t.branch != null && t.pr_json != null,
  ).length;

  // 3. Blocked-decision resolution: pair each packet-opened audit row with the
  // task's NEXT packet-resolved row. Withdrawn/superseded packets never resolve
  // and simply don't contribute a duration — honest, not a fabricated zero.
  const auditRows = z.array(govAuditSchema).parse(
    db
      .prepare(
        `SELECT project_slug, task_key, action, occurred_at, details_json
         FROM audit_events
         WHERE action IN ('task.operator.packet_opened',
                          'task.agent.packet_opened',
                          'task.packet.resolved',
                          'task.transition')
           ${filter.projectSlug ? "AND project_slug = ?" : ""}
         ORDER BY occurred_at ASC`,
      )
      .all(...(filter.projectSlug ? [filter.projectSlug] : [])),
  );
  const packetDurations: number[] = [];
  const pendingOpen = new Map<string, number>();
  for (const row of auditRows) {
    if (!row.task_key) continue;
    const key = `${row.project_slug}/${row.task_key}`;
    const at = Date.parse(row.occurred_at);
    if (Number.isNaN(at)) continue;
    if (row.action.endsWith("packet_opened")) {
      // A re-opened packet before a resolve replaces the pending mark — the
      // human answers the packet that is actually in front of them.
      pendingOpen.set(key, at);
    } else if (row.action === "task.packet.resolved") {
      const opened = pendingOpen.get(key);
      if (opened != null && at >= opened) {
        packetDurations.push(at - opened);
        pendingOpen.delete(key);
      }
    }
  }
  packetDurations.sort((a, b) => a - b);
  const openNow = tasks.filter(
    (t) => !t.archived && t.packet_json != null,
  ).length;

  // 4. Time to review-ready: task created → its FIRST transition into the
  // project's review-role stage (from the same audit trail).
  const firstReviewAt = new Map<string, number>();
  for (const row of auditRows) {
    if (row.action !== "task.transition" || !row.task_key) continue;
    const key = `${row.project_slug}/${row.task_key}`;
    if (firstReviewAt.has(key)) continue;
    const details = parsedJson(
      z.object({ to: z.string().catch("") }).loose(),
      row.details_json,
      { to: "" },
    );
    const reviewId = row.project_slug
      ? (roles.get(row.project_slug)?.reviewId ?? null)
      : null;
    if (reviewId == null || details.to !== reviewId) continue;
    const at = Date.parse(row.occurred_at);
    if (!Number.isNaN(at)) firstReviewAt.set(key, at);
  }
  const reviewDurations: number[] = [];
  for (const t of tasks) {
    const reached = firstReviewAt.get(`${t.project_slug}/${t.task_key}`);
    if (reached == null || t.created_at == null) continue;
    const created = Date.parse(t.created_at);
    if (Number.isNaN(created) || reached < created) continue;
    reviewDurations.push(reached - created);
  }
  reviewDurations.sort((a, b) => a - b);

  return {
    clarity: {
      activeTasks: active.length,
      clearTasks,
      pct: active.length ? clearTasks / active.length : null,
    },
    traceability: {
      deliveredTasks: delivered.length,
      tracedTasks: traced,
      pct: delivered.length ? traced / delivered.length : null,
    },
    packetResolution: {
      resolved: packetDurations.length,
      avgMs: avg(packetDurations),
      medianMs: median(packetDurations),
      openNow,
    },
    timeToReview: {
      tasks: reviewDurations.length,
      avgMs: avg(reviewDurations),
      medianMs: median(reviewDurations),
    },
    longTimelines: tasks.filter((t) => {
      const threshold = compressionAt.get(t.project_slug);
      return threshold != null && t.event_count >= threshold;
    }).length,
    coordination,
  };
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
        // F31-D6's numerator is one more CASE column here rather than its own
        // aggregate: `operator` and `controller` are the coordination kinds
        // (RunKind) — machinery that decides what the working agents do — and
        // both carry real cost.
        // F35-1: the token columns count only rows whose PROVIDER figure has
        // landed (`usage_final = 1`). A running Claude row holds the adapter's
        // live estimate and a running Codex row holds nothing; neither is a
        // total. Cost is untouched: only the result envelope ever writes it.
        `SELECT count(*) AS runs,
                count(total_cost_usd) AS costed_runs,
                COALESCE(SUM(total_cost_usd), 0) AS cost,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                  THEN total_cost_usd END), 0) AS coordination_cost,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN input_tokens END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN cached_input_tokens END), 0) AS cached_input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN output_tokens END), 0) AS output_tokens,
                COALESCE(SUM(turns), 0) AS turns
         FROM agent_runs ${clause}`,
      )
      .get(...params),
  );

  // F31-D6: the share is read off the totals pair — both sides come from the
  // same scan, so they can never disagree about what "all reported spend" is.
  const coordinationCost = totals.coordination_cost ?? 0;
  const totalCost = totals.cost ?? 0;
  const coordination = {
    coordinationCostUsd: coordinationCost,
    totalCostUsd: totalCost,
    share: totalCost > 0 ? coordinationCost / totalCost : null,
  };

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
  // Pass 35 U35-7: boot recovery interrupts every queued/running row a restart
  // orphaned. Live (2026-09-06 18:40Z) that was 23 rows, 17 of them queued runs
  // that never executed a turn, and every one counted as an error that lowered
  // this rate. An interrupted run is not a failure, and one that never started
  // is not an outcome at all: it leaves the denominator.
  const interruptedFacts = interruptedSchema.parse(
    db
      .prepare(
        `SELECT SUM(CASE WHEN turns = 0 AND started_at IS NULL THEN 1 ELSE 0 END)
                  AS never_started,
                SUM(CASE WHEN interrupted_reason = 'restart' THEN 1 ELSE 0 END)
                  AS by_restart
           FROM agent_runs ${and("state = 'interrupted'")}`,
      )
      .get(...params),
  );
  const interruptedNeverStarted = interruptedFacts.never_started ?? 0;
  const interruptedByRestart = interruptedFacts.by_restart ?? 0;
  const terminal = finished + errored + interrupted - interruptedNeverStarted;

  // F26-4: order by COST first, then runs. This is a cost dashboard, and the
  // breakdown is capped at TOP_N — a run-first order could truncate away a rare
  // but expensive outlier (the exact thing "what's driving spend" needs), keeping
  // eight cheap-but-frequent groups instead. Cost-first guarantees the top cost
  // drivers always survive the cap.
  // The cap is applied HERE rather than in SQL. Only the Claude result envelope
  // reports a cost, so SUM over a Codex-only group is NULL and SQLite's DESC
  // ordering sorts NULL last — the busiest groups on the instance were the
  // first thing the LIMIT dropped. A label is a backend/kind/model/project, a
  // handful of real entities, so grouping over the whole set is cheap; the top
  // by RUNS is unioned in so no group is dropped purely for being unpriced.
  const group = (column: string): CountRow[] => {
    const rows: CountRow[] = z
      .array(groupSchema)
      .parse(
        db
          .prepare(
            `SELECT ${column} AS label, count(*) AS runs,
                    SUM(total_cost_usd) AS cost
             FROM agent_runs ${clause}
             GROUP BY ${column}`,
          )
          .all(...params),
      )
      // Ruling 99: controller turns carry project_slug "" (instance scope) —
      // label them honestly instead of rendering a blank bar.
      .map((r) => ({
        label: r.label === "" ? "controller (instance)" : (r.label ?? "unknown"),
        runs: r.runs,
        cost: r.cost,
      }));

    const byCost = [...rows].sort(
      (a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.runs - a.runs,
    );
    const byRuns = [...rows].sort((a, b) => b.runs - a.runs);
    const kept = new Map<string, CountRow>();
    // Half the slots are reserved for the busiest groups, so a cost dashboard
    // still leads with spend without hiding where the work happens.
    const runSlots = Math.floor(TOP_N / 2);
    for (const row of byRuns.slice(0, runSlots)) kept.set(row.label, row);
    for (const row of byCost) {
      if (kept.size >= TOP_N) break;
      kept.set(row.label, row);
    }
    return [...kept.values()].sort(
      (a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.runs - a.runs,
    );
  };

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
        // No COALESCE: a day whose runs all report no cost (all-Codex) keeps a
        // NULL sum, surfaced as "not reported" — never a dishonest $0.00, the
        // same honesty the breakdown groups carry.
        `SELECT substr(started_at, 1, 10) AS date, count(*) AS runs,
                SUM(total_cost_usd) AS cost
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
    // A real day keeps its (possibly null) cost; a gap-filled quiet day is 0.
    daily.push({ date: d, runs: row?.runs ?? 0, cost: row ? row.cost : 0 });
  }

  return {
    totals: {
      runs: totals.runs,
      costedRuns: totals.costed_runs,
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
      interruptedNeverStarted,
      interruptedByRestart,
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
    oversight: oversightSummary(db, filter, coordination),
    // D5: `nowIso` retires an exhaustion record whose provider-named reset
    // instant has already passed — the window it described is over.
    backendQuota: latestBackendRateLimits(db, nowIso),
    windowDays: WINDOW_DAYS,
    generatedAt: nowIso,
  };
}
