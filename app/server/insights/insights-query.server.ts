import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { guardrailSchema } from "~/schemas/project-file.schema";
import {
  latestBackendRateLimits,
  type BackendQuotaRow,
} from "~/server/runtimes/backend-quota.server";
import { DEFAULT_COMPACTION } from "~/server/tasks/timeline-compaction.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { FIRST_CALL_LARGE_WRITE_TOKENS } from "~/server/runtimes/context-policy.server";

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
   *  (`agent_runs.usage_final = 1`); a live estimate is not a total and is not
   *  in them. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Runs the three sums above leave out (`usage_final = 0`): a run still in
   *  flight, one that was stopped or errored before a provider figure landed,
   *  and every row a root carried before the column existed. The card names
   *  this count, so an understated token headline is never silent. */
  tokenlessRuns: number;
  turns: number;
}

/**
 * Ruling 308: one breakdown dimension, and what its window left out.
 *
 * `rows` is the TOP_N kept (half the slots reserved for the busiest groups so a
 * cost view still shows where the work happens). `hidden` is how many groups
 * that dropped, with their runs and — when any of them reported one — their
 * cost. A breakdown that shows eight of thirty and says nothing reads as the
 * whole instance.
 */
export interface Breakdown {
  rows: CountRow[];
  hidden: number;
  hiddenRuns: number;
  /** Null when NO hidden group reported a cost, never 0 — the same rule
   *  `CountRow.cost` follows for the same reason. */
  hiddenCost: number | null;
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
  clarity: {
    activeTasks: number;
    clearTasks: number;
    pct: number | null;
    /** Ruling 290: WHICH active tasks have no definite next actor. */
    unclear: string[];
  };
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
  traceability: {
    deliveredTasks: number;
    tracedTasks: number;
    pct: number | null;
    /** Ruling 290: WHICH delivered tasks are untraced, not just how many. */
    untraced: string[];
  };
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
  /** Ruling 290: WHICH of them, capped — the count alone names no task to open. */
  longTimelineKeys: string[];
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
    /** Ruling 201 (F37-21): coordination / total, and null unless EVERY run on
     *  BOTH sides reported a cost. Ruling 190 suppressed the share when a side
     *  reported *nothing*; the partial case is the same defect and is the
     *  ordinary one — cost is a Claude-only observation (the Codex result
     *  envelope carries tokens and no price), so a mixed-backend instance
     *  computes this over whichever runs happen to bill. With both sides
     *  partly silent the visible ratio is not even a bound: unreported
     *  delivery spend pushes it down and unreported coordination spend pushes
     *  it up. */
    share: number | null;
    /** Runs in scope per side, and how many of them reported no cost — the
     *  population a share would have to ignore. The card reads the pair: all
     *  of a side (the ruling-190 case, "no delivery run reported a cost") and
     *  some of it (the ruling-201 case, "137 of 142") are different sentences
     *  and the counts tell them apart. */
    runs: { delivery: number; coordination: number };
    uncosted: { delivery: number; coordination: number };
    /** Those same cost-silent runs by backend, descending, zero counts
     *  dropped. F35-1 counts the rows its token sums leave out so the card can
     *  NAME them; cost gets the same treatment, and `agent_runs.backend` makes
     *  it specific ("209 Codex runs report no cost") rather than the hedge
     *  "cost-reporting runs", which names no quantity and reads as "all". */
    uncostedByBackend: readonly { backend: string; runs: number }[];
    /** Coordination's share of TOKENS processed — the unit both backends
     *  report, so it survives the blind spot above. A different question from
     *  the dollar share and never a substitute: a luna-max token and an opus
     *  token are not the same money. Null when a side ran and contributed no
     *  final provider figure at all (ruling 190's test, at the token level). */
    tokenShare: number | null;
    coordinationTokens: number;
    totalTokens: number;
    /** Runs whose provider usage never landed (F35-1: interrupted, or errored
     *  with an empty usage block), per side — the token share's own excluded
     *  population, named for the same reason. */
    tokenless: { delivery: number; coordination: number };
  };
}

/**
 * The backends that report a prompt-cache WRITE figure at all (ruling 395).
 *
 * Claude reports `cache_creation_input_tokens` per call and it moves. Codex
 * declares `cache_write_input_tokens` in the SDK's own types — "the number of
 * input tokens written to the prompt cache during the turn" — and returns
 * exactly 0 for it on every turn: 101 of 101 usage envelopes across the live
 * ax-clone instance, against 67.2M tokens reported READ. One value, never
 * anything else, is not a measurement, and the schema already draws this line
 * one column over (`cache_ttl_bucket`: "NULL on Codex (no such figure)").
 */
const CACHE_WRITE_REPORTING_BACKENDS = ["claude"] as const;

/**
 * Ruling 369: what the prompt cache did for one group of runs — by run kind,
 * and by the kind of credential the runs billed (the TTL follows it).
 */
export interface CacheRow {
  label: string;
  runs: number;
  /** Runs whose first model call reported its figures. The rate below is
   *  over these, never over `runs`: a run that never reached the provider
   *  started neither warm nor cold. */
  firstCalls: number;
  warmStarts: number;
  /** warmStarts / firstCalls, null with no first call at all. */
  warmRate: number | null;
  /**
   * Tokens written into the cache, or NULL when no run in this group is on a
   * backend that reports the figure at all.
   *
   * Ruling 395 (F39-22): Codex declares `cache_write_input_tokens` and returns
   * exactly 0 for it on every turn — 101 of 101 usage envelopes on the live
   * ax-clone instance, while the sibling field reported 67.2M tokens READ. The
   * column used to sum those zeros and print `0` with a `0.000` ratio beside a
   * `45.0M` read, which reads as a measurement of a cache doing nothing. This
   * panel's own docstring already holds the rule it broke — "a rate with no
   * first call behind it prints n/a, never 0%" — and the caption already names
   * the asymmetry for the lifetime column next door.
   */
  writeTokens: number | null;
  readTokens: number;
  /** Runs in this group on a backend that reports a write figure at all. */
  writeReportingRuns: number;
  /** writeTokens / readTokens, null when nothing was read or nothing reports. */
  writeReadRatio: number | null;
  /** First calls that wrote more than `FIRST_CALL_LARGE_WRITE_TOKENS` — the
   *  whole-history replay shape ruling 372 removes. */
  largeFirstWrites: number;
  /** How many runs' writes were billed under each cache lifetime. */
  ttl: { fiveMinute: number; oneHour: number; mixed: number };
}

export interface CacheSummary {
  byKind: CacheRow[];
  byCredentialKind: CacheRow[];
  /** The line `largeFirstWrites` counts against, so the card can name it. */
  largeWriteTokens: number;
}

export interface InsightsSummary {
  totals: InsightsTotals;
  /** Ruling 369: the prompt-cache record, all-time like the totals. */
  cache: CacheSummary;
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
  byBackend: Breakdown;
  byKind: Breakdown;
  byProject: Breakdown;
  byModel: Breakdown;
  /** Ruling 308: cost and runs per TASK. Labelled `project/task` when the read
   *  is not scoped to one project, because a task key is project-local. */
  byTask: Breakdown;
  /** Ruling 308: cost and runs per agent PROFILE — "which reviewer earns its
   *  runs", which `byKind` cannot answer because every reviewer is one kind. */
  byProfile: Breakdown;
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
  /** Ruling 190: each side's runs, and how many of them put a figure into the
   *  share. A side with runs but no figures was never observed, whichever side
   *  it is; a side with no runs at all contributes a real zero. */
  delivery_runs: z.number().nullable(),
  costed_delivery_runs: z.number().nullable(),
  coordination_runs: z.number().nullable(),
  costed_coordination_runs: z.number().nullable(),
  coordination_tokens: z.number().nullable(),
  tokenless_delivery_runs: z.number().nullable(),
  tokenless_coordination_runs: z.number().nullable(),
  input_tokens: z.number().nullable(),
  cached_input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  tokenless_runs: z.number().nullable(),
  turns: z.number().nullable(),
});

const groupSchema = z.object({
  label: z.string().nullable(),
  runs: z.number(),
  cost: z.number().nullable(),
});

/** Ruling 369: one grouped cache row as SQLite returns it; every SUM over a
 *  boolean or a nullable column is nullable. */
const cacheGroupSchema = z.object({
  label: z.string().nullable(),
  runs: z.number(),
  first_calls: z.number().nullable(),
  warm_starts: z.number().nullable(),
  write_tokens: z.number().nullable(),
  write_reporting_runs: z.number().nullable(),
  read_tokens: z.number().nullable(),
  large_first_writes: z.number().nullable(),
  ttl_5m: z.number().nullable(),
  ttl_1h: z.number().nullable(),
  ttl_mixed: z.number().nullable(),
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
  // Ruling 407: read for its `commits` alone — whether this task's delivery
  // was commit-shaped at all.
  github_json: z.string().nullable(),
  packet_json: z.string().nullable(),
  event_count: z.number(),
  created_at: z.string().nullable(),
});

/** Ruling 407: the one field the commit-shape test reads. */
const githubCommitsSchema = z
  .object({ commits: z.array(z.unknown()).catch([]) })
  .transform((g) => g.commits)
  .catch([]);

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
                branch, pr_json, work_revision_sha, github_json, packet_json, event_count,
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
  // Ruling 290 (F37-125): the NAMES, not just the counts. Every one of these
  // three numbers is a count of EXCEPTIONS — work that is untraceable, work
  // with no next actor, a record past the readability guardrail — and each one
  // withheld the only fact a person needs to act on it. "41 of 42 delivered
  // tasks carry branch + PR" is a traceability metric that will not say which
  // task cannot be traced. Ruling 253 settled this shape for a knowledge base
  // ("an agent cannot ask for a rule it cannot name"); a dashboard is the same
  // rule with a person reading it.
  const unclearTasks = active.filter(
    (t) => t.waiting === "none" && t.owner_user_id == null,
  );
  const clearTasks = active.length - unclearTasks.length;

  // 2. Key↔branch↔PR traceability over DELIVERED tasks: a delivered revision
  // or a recorded PR. A branch alone is not a delivery — ruling 122 allocates
  // the name at first dispatch, before any work exists (ruling 143, U34-9).
  //
  // Ruling 407 (F39-34): a delivery that was never commit-shaped has no branch
  // and no PR to carry, so counting it here states a demand that can NEVER be
  // met — on finished work, in a metric whose whole point (ruling 290) is to
  // name exceptions a person can act on. Live: ax-clone AX-12 delivered an
  // upstream-fidelity REPORT as 20 attachments, `noChanges: true`, zero
  // commits, force-accepted and Done; Insights read its `workRevision`, found
  // no PR, and reported "18 of 19 delivered tasks carry branch + PR" naming
  // AX-12 as the one that does not. Ruling 391 settled that a report is
  // delivered work and ruling 401 dropped the same task's "behind main" pill
  // on the same reasoning, with the same predicate — terminal stage, no PR, no
  // commits — which is reused here rather than re-derived. A task that DID
  // commit and never opened a PR is still untraceable and still counted.
  const commitless = (t: z.infer<typeof govTaskSchema>): boolean => {
    const terminal = roles.get(t.project_slug)?.terminalId ?? null;
    if (terminal == null || t.stage !== terminal) return false;
    if (t.pr_json != null) return false;
    return parsedJson(githubCommitsSchema, t.github_json, []).length === 0;
  };
  const delivered = tasks.filter(
    (t) => (t.work_revision_sha != null || t.pr_json != null) && !commitless(t),
  );
  const untracedTasks = delivered.filter(
    (t) => t.branch == null || t.pr_json == null,
  );
  const traced = delivered.length - untracedTasks.length;

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

  const longTimelineTasks = tasks.filter((t) => {
    const threshold = compressionAt.get(t.project_slug);
    // The boundary is the MACHINERY's, not a guess: `compactTimelineEvents`
    // opens with `if (events.length <= options.threshold) return events`, so a
    // task sitting exactly ON the threshold is not compacted and is not one the
    // readability machinery is managing. Counting it as "past their project's
    // compression threshold" put a task in the card that the fold never touches
    // — off by one against the only rule that decides.
    return threshold != null && t.event_count > threshold;
  });

  return {
    clarity: {
      activeTasks: active.length,
      clearTasks,
      pct: active.length ? clearTasks / active.length : null,
      unclear: namedKeys(unclearTasks),
    },
    traceability: {
      deliveredTasks: delivered.length,
      tracedTasks: traced,
      pct: delivered.length ? traced / delivered.length : null,
      untraced: namedKeys(untracedTasks),
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
    // The boundary is the MACHINERY's, not a guess: `compactTimelineEvents`
    // opens with `if (events.length <= options.threshold) return events`, so a
    // task sitting exactly ON the threshold is not compacted and is not one the
    // readability machinery is managing. Counting it as "past their project's
    // compression threshold" put a task in the card that the fold never touches
    // — off by one against the only rule that decides.
    longTimelines: longTimelineTasks.length,
    longTimelineKeys: namedKeys(longTimelineTasks),
    coordination,
  };
}

/**
 * Ruling 290: how many exception KEYS a card names before it stops.
 *
 * Enough that a small set is named in full — a dashboard's job is to point at
 * the thing — and few enough that a badly-drifted instance does not turn one
 * card into a wall. Past it the card says how many more there are, so the
 * number is never quietly smaller than the truth.
 */
export const INSIGHTS_NAMED_EXCEPTIONS = 8;

/** `PROJ/KEY` for each row, capped, newest-looking order preserved. */
function namedKeys(rows: readonly { project_slug: string; task_key: string }[]): string[] {
  return rows.slice(0, INSIGHTS_NAMED_EXCEPTIONS).map((t) => `${t.project_slug}/${t.task_key}`);
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
        // The rows left out are COUNTED in the same pass (`tokenless_runs`), so
        // the card can name them: an interrupted run and an errored one whose
        // usage was empty never get a provider figure, so their exclusion is
        // permanent and would otherwise understate the headline in silence.
        `SELECT count(*) AS runs,
                count(total_cost_usd) AS costed_runs,
                COALESCE(SUM(total_cost_usd), 0) AS cost,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                  THEN total_cost_usd END), 0) AS coordination_cost,
                COALESCE(SUM(CASE WHEN kind NOT IN ('operator', 'controller')
                                  THEN 1 ELSE 0 END), 0) AS delivery_runs,
                COALESCE(SUM(CASE WHEN kind NOT IN ('operator', 'controller')
                                   AND total_cost_usd IS NOT NULL
                                  THEN 1 ELSE 0 END), 0) AS costed_delivery_runs,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                  THEN 1 ELSE 0 END), 0) AS coordination_runs,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                   AND total_cost_usd IS NOT NULL
                                  THEN 1 ELSE 0 END), 0) AS costed_coordination_runs,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                   AND usage_final = 1
                                  THEN input_tokens + output_tokens END), 0) AS coordination_tokens,
                COALESCE(SUM(CASE WHEN kind NOT IN ('operator', 'controller')
                                   AND usage_final = 0
                                  THEN 1 ELSE 0 END), 0) AS tokenless_delivery_runs,
                COALESCE(SUM(CASE WHEN kind IN ('operator', 'controller')
                                   AND usage_final = 0
                                  THEN 1 ELSE 0 END), 0) AS tokenless_coordination_runs,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN input_tokens END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN cached_input_tokens END), 0) AS cached_input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN output_tokens END), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 0 THEN 1 ELSE 0 END), 0) AS tokenless_runs,
                COALESCE(SUM(turns), 0) AS turns
         FROM agent_runs ${clause}`,
      )
      .get(...params),
  );

  // F31-D6: the share is read off the totals pair — both sides come from the
  // same scan, so they can never disagree about what "all reported spend" is.
  //
  // Ruling 190 (F37-12): a share is a measurement only when BOTH sides could
  // have been seen. Live, a Codex delivery fleet reported no cost at all, so
  // the denominator held nothing but the four Claude controller turns and the
  // quotient was 1 by construction — "100%" answering a question ("how much of
  // my spend is coordination?") this data cannot answer. The mirror is just as
  // wrong and just as reachable (a Codex operator and controller under a Claude
  // delivery fleet reads 0%, claiming coordination is free when it merely never
  // reported), so the rule is symmetric: a side that RAN and reported nothing
  // was not observed, and the share is null. A side that never ran contributes
  // a real zero and is not a gap — an instance with no delivery runs at all
  // genuinely spent everything on coordination.
  //
  // Ruling 201 (F37-21): ruling 190 guards the EMPTY case and not the PARTIAL
  // one, and the partial case is the ordinary one. Cost is a Claude-only
  // observation — `costUsd` is assigned off the Claude result envelope, and the
  // Codex envelope carries token counts with no price — so on a mixed-backend
  // instance most runs never report. Live, at the time of the ruling: 209 of
  // 215 runs, 94% of the tokens. Ruling 190's test passed the moment ONE run on
  // each side reported, and the card would then divide 6 costed coordination
  // runs by a denominator the other 137 never entered. So the share is a
  // measurement only when every run on both sides reported one; short of that
  // the ratio is not a bound in either direction, and the card says what it
  // does not know and offers the token share instead.
  const coordinationCost = totals.coordination_cost ?? 0;
  const totalCost = totals.cost ?? 0;
  const deliveryRuns = totals.delivery_runs ?? 0;
  const costedDeliveryRuns = totals.costed_delivery_runs ?? 0;
  const coordinationRuns = totals.coordination_runs ?? 0;
  const costedCoordinationRuns = totals.costed_coordination_runs ?? 0;
  const uncosted = {
    delivery: deliveryRuns - costedDeliveryRuns,
    coordination: coordinationRuns - costedCoordinationRuns,
  };
  const fullyCosted = uncosted.delivery === 0 && uncosted.coordination === 0;
  // The card names the silent runs by backend rather than by a hedge. Derived
  // from the rows, never from a list of backend names in the source: ruling
  // 191's lesson is that advice which hardcodes what the environment contains
  // goes stale the day the environment changes.
  const uncostedByBackend = z
    .array(z.object({ backend: z.string(), runs: z.number() }))
    .parse(
      db
        .prepare(
          `SELECT backend, count(*) AS runs FROM agent_runs ${and("total_cost_usd IS NULL")}
           GROUP BY backend ORDER BY runs DESC, backend ASC`,
        )
        .all(...params),
    );
  // Tokens: the unit both backends report. Same suppression test as ruling 190
  // applied one level down — a side that RAN and landed no provider figure at
  // all was not observed, and its 0 is not a measurement. The incidental gap
  // (F35-1: an interrupted run, or one that errored with an empty usage block)
  // is COUNTED and named instead of suppressing the figure, because it is not
  // systematic to one side the way the cost blind spot is.
  const coordinationTokens = totals.coordination_tokens ?? 0;
  const totalTokens = (totals.input_tokens ?? 0) + (totals.output_tokens ?? 0);
  const tokenless = {
    delivery: totals.tokenless_delivery_runs ?? 0,
    coordination: totals.tokenless_coordination_runs ?? 0,
  };
  const tokenBlind =
    (deliveryRuns > 0 && tokenless.delivery === deliveryRuns) ||
    (coordinationRuns > 0 && tokenless.coordination === coordinationRuns);
  const coordination = {
    coordinationCostUsd: coordinationCost,
    totalCostUsd: totalCost,
    share: totalCost > 0 && fullyCosted ? coordinationCost / totalCost : null,
    runs: { delivery: deliveryRuns, coordination: coordinationRuns },
    uncosted,
    uncostedByBackend,
    tokenShare: totalTokens > 0 && !tokenBlind ? coordinationTokens / totalTokens : null,
    coordinationTokens,
    totalTokens,
    tokenless,
  };

  // Ruling 369: the prompt-cache record, grouped by run kind and by the
  // credential kind the runs billed. Every figure is a plain SUM over the
  // columns the sink folded; the rates are taken over the runs that HAVE a
  // first call, so a refused run is neither warm nor cold.
  const reportingPlaceholders = CACHE_WRITE_REPORTING_BACKENDS.map(() => "?").join(", ");
  const cacheGroup = (column: string): CacheRow[] =>
    z
      .array(cacheGroupSchema)
      .parse(
        db
          .prepare(
            `SELECT ${column} AS label, count(*) AS runs,
                    SUM(CASE WHEN first_call_warm IS NOT NULL THEN 1 ELSE 0 END) AS first_calls,
                    SUM(CASE WHEN first_call_warm = 1 THEN 1 ELSE 0 END) AS warm_starts,
                    SUM(cache_write_tokens) AS write_tokens,
                    SUM(CASE WHEN backend IN (${reportingPlaceholders}) THEN 1 ELSE 0 END)
                      AS write_reporting_runs,
                    SUM(cached_input_tokens) AS read_tokens,
                    SUM(CASE WHEN first_call_cache_write > ? THEN 1 ELSE 0 END) AS large_first_writes,
                    SUM(CASE WHEN cache_ttl_bucket = '5m' THEN 1 ELSE 0 END) AS ttl_5m,
                    SUM(CASE WHEN cache_ttl_bucket = '1h' THEN 1 ELSE 0 END) AS ttl_1h,
                    SUM(CASE WHEN cache_ttl_bucket = 'mixed' THEN 1 ELSE 0 END) AS ttl_mixed
             FROM agent_runs ${clause}
             GROUP BY ${column} ORDER BY runs DESC, label ASC`,
          )
          .all(...CACHE_WRITE_REPORTING_BACKENDS, FIRST_CALL_LARGE_WRITE_TOKENS, ...params),
      )
      .map((r) => {
        const firstCalls = r.first_calls ?? 0;
        const warmStarts = r.warm_starts ?? 0;
        const writeReportingRuns = r.write_reporting_runs ?? 0;
        // Ruling 395: no reporting run behind the sum means there is no figure,
        // not a figure of zero.
        const writeTokens = writeReportingRuns > 0 ? (r.write_tokens ?? 0) : null;
        const readTokens = r.read_tokens ?? 0;
        return {
          label: r.label ?? "unknown",
          runs: r.runs,
          firstCalls,
          warmStarts,
          warmRate: firstCalls > 0 ? warmStarts / firstCalls : null,
          writeTokens,
          readTokens,
          writeReportingRuns,
          writeReadRatio:
            writeTokens !== null && readTokens > 0 ? writeTokens / readTokens : null,
          largeFirstWrites: r.large_first_writes ?? 0,
          ttl: { fiveMinute: r.ttl_5m ?? 0, oneHour: r.ttl_1h ?? 0, mixed: r.ttl_mixed ?? 0 },
        };
      });
  const cache: CacheSummary = {
    byKind: cacheGroup("kind"),
    // A row written before the kind was stored, or a refused run, has none.
    byCredentialKind: cacheGroup("COALESCE(credential_kind, 'unknown')"),
    largeWriteTokens: FIRST_CALL_LARGE_WRITE_TOKENS,
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
  const group = (column: string): Breakdown => {
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
    const shown = [...kept.values()].sort(
      (a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.runs - a.runs,
    );
    // Ruling 308: say what the window left out. A breakdown that shows eight
    // of thirty groups and says nothing reads as the whole instance, which is
    // the same defect ruling 302 fixed on the timeline windows — and this one
    // is on the surface a person opens to decide where their money goes.
    const hiddenRows = rows.filter((r) => !kept.has(r.label));
    return {
      rows: shown,
      hidden: hiddenRows.length,
      hiddenRuns: hiddenRows.reduce((n, r) => n + r.runs, 0),
      hiddenCost: hiddenRows.some((r) => r.cost !== null)
        ? hiddenRows.reduce((n, r) => n + (r.cost ?? 0), 0)
        : null,
    };
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
      tokenlessRuns: totals.tokenless_runs ?? 0,
      turns: totals.turns ?? 0,
    },
    cache,
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
    // Ruling 308: the two the controller asked for and could not answer —
    // "what did SHOP-27 cost across eleven rework rounds" and "which reviewer
    // earns its runs". A task key is only unique inside its project, so an
    // unscoped read labels each row with the project it belongs to.
    // U39-22: a controller turn's `task_key` is its CONVERSATION id and its
    // project is '' (ruling 99), so every turn read as a task named
    // "/cnv_tjVMn13JkW-0". They are one row, named for what they are.
    byTask: group(
      `CASE WHEN kind = 'controller' THEN 'controller conversations' ELSE ${
        filter.projectSlug ? "task_key" : "project_slug || '/' || task_key"
      } END`,
    ),
    byProfile: group("agent_profile_id"),
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
