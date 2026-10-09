import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { guardrailSchema } from "~/schemas/project-file.schema";
import {
  BACKENDS,
  latestBackendRateLimits,
  type BackendQuotaRow,
} from "~/server/runtimes/backend-quota.server";
import { DEFAULT_COMPACTION } from "~/server/tasks/timeline-compaction.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import {
  FIRST_CALL_LARGE_WRITE_TOKENS,
  OPERATOR_BURST_WINDOW_MS,
  RESUME_FRESH_CONTEXT_TOKENS,
  RESUME_IDLE_EDGES_MS,
  cacheTtlMs,
} from "~/server/runtimes/context-policy.server";
import { modelDisplayName } from "~/server/runtimes/model-catalog.server";
import type { RunBackend } from "~/features/runtime/runtime-types";
import type { CredentialKind } from "~/server/runtimes/backend-credentials.server";
import type { ContinuityLossReason } from "~/server/runtimes/run-service.server";

/**
 * Insights: read-only aggregate analytics over `agent_runs` — the cost, token,
 * timing and outcome numbers a supervisor wants at a glance. Every read is a
 * plain GROUP BY over the runs table; nothing here writes, and the page that
 * renders it is org-admin gated.
 *
 * Ruling 35: the run figures are ONE backend's at a time (`runAnalytics`).
 * Claude and Codex do not measure alike: only Claude's result envelope carries
 * a cost, their tokens are different models' tokens, and Codex reports no
 * cache write. A sum across them is a number about neither. The instance's own
 * record — tasks, packets, the audit trail (`oversightSummary`) — has no
 * backend and is read whole.
 *
 * `nowIso` is injected (not read from a clock) so the "last N days" window is
 * deterministic and testable.
 */

const WINDOW_DAYS = 30;
const TOP_N = 8;

export interface InsightsTotals {
  runs: number;
  /** Runs that actually reported a cost. `runs - costedRuns` is the slice the
   *  `cost` sum below can say nothing about: on Claude a run stopped before its
   *  result envelope, and on Codex every run, whose envelope carries no price. */
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
 * Ruling 35: one breakdown dimension, and what its window left out.
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
  /** The same rule for tokens (ruling 35). */
  hiddenTokens: number | null;
}

export interface CountRow {
  /** The group's key: a run kind, project slug, model id, profile id or
   *  `project/KEY` task, as the runs table holds it. */
  label: string;
  /** Ruling 35: what the page prints for the group. A kind in the engagement
   *  vocabulary the run consoles speak (UXV19-3), a project's and an agent's
   *  own name, a model's display name; a task keeps its key. */
  name: string;
  runs: number;
  /** Summed reported cost, or null when NO run in the group reported one. Only
   *  the Claude result envelope carries a cost, so a Codex group's cost is
   *  UNKNOWN, not zero. */
  cost: number | null;
  /** Ruling 35: input plus output tokens over the runs whose provider total
   *  landed (F35-1), or null when none in the group did. */
  tokens: number | null;
}

export interface DailyPoint {
  /** YYYY-MM-DD. */
  date: string;
  runs: number;
  /** Total cost for the day, or null when the day HAS runs but none reported a
   *  cost (any Codex day) — rendered "not reported", never a dishonest $0.00.
   *  A gap-filled quiet day (no runs) is a real 0. */
  cost: number | null;
  /** Ruling 35: the day's tokens, by `CountRow.tokens`' rule; a quiet day's
   *  is a real 0. */
  tokens: number | null;
}

/** Ruling 35: one backend's run count, which the switch names it with. */
export interface BackendRuns {
  backend: RunBackend;
  runs: number;
}

/**
 * Ruling 35: what one backend's runs are weighed in. Cost where the backend
 * reported one at all, else tokens, the figure every backend reports. Read off
 * the rows, never off a list of which backend prices its runs: a
 * Codex that starts reporting a cost is weighed in it the day it does.
 */
export type RunMeasure = "cost" | "tokens";

/**
 * F31-D6, as ruling 35 left it: the coordination runs' share of one backend's
 * measure. Coordination is `operator` + `controller` (RunKind): machinery that
 * decides what the working agents do rather than doing the work, and both
 * carry real cost.
 */
export interface CoordinationShare {
  measure: RunMeasure;
  /** The coordination runs' figure, and every run's, in `measure`. */
  coordination: number;
  total: number;
  /**
   * coordination / total; null when nothing was measured, or when a side's
   * runs reached the provider and put no figure into the measure at all
   * (ruling 36: a side that was never observed is not a zero, whichever side
   * it is). A side with no run that reached the provider contributes a real
   * zero.
   */
  share: number | null;
  /** Per side, the runs that reached the provider: a turn, or a first call. */
  reached: { delivery: number; coordination: number };
  /**
   * Of those, the ones that put no figure into the measure. Ruling 36 nulled
   * the share when ANY run was silent, because across backends the silence was
   * systematic: every Codex run. Inside one backend it is incidental — a run
   * stopped before its result — so it is counted rather than suppressed, as
   * F35-1 always treated the token sums' gap.
   */
  silent: { delivery: number; coordination: number };
}

/**
 * Governance outcomes (pass 29, critique gap 3.1 — owner "build it now"): the
 * PRD's own "Measurable outcomes" (prd.md) promise unambiguous ownership/state,
 * task↔branch↔PR traceability, fast decisions on blocked work, and readable
 * long timelines — and until now the product measured none of them. These are
 * computed from the projections + audit trail the app already keeps; nothing
 * new is recorded. All-time (like the totals above), not windowed.
 *
 * Ruling 35: the instance's own record, so every backend's. (The coordination
 * share F31-D6 kept here is a figure about runs, and moved to `RunAnalytics`.)
 */
export interface OversightSummary {
  /** Active (non-archived, non-terminal-stage) tasks with a definite next
   *  actor: `waiting` names human/agent, or a human owns the task. */
  clarity: {
    activeTasks: number;
    clearTasks: number;
    pct: number | null;
    /** Ruling 37: WHICH active tasks have no definite next actor. */
    unclear: string[];
  };
  /** Of DELIVERED tasks — a delivered work revision or a recorded PR — how
   *  many carry BOTH the task branch and a recorded PR, the key↔branch↔PR
   *  chain (ruling 37). An allocated branch alone is NOT a delivery: ruling
   *  228 names the branch at first dispatch, before an agent has written
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
    /** Ruling 37: WHICH delivered tasks are untraced, not just how many. */
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
  /** Ruling 37: WHICH of them, capped — the count alone names no task to open.
   *  The longest first (ruling 35). */
  longTimelineKeys: string[];
}

/**
 * The backends that report a prompt-cache WRITE figure at all (ruling 36).
 *
 * Claude reports `cache_creation_input_tokens` per call and it moves. Codex
 * declares `cache_write_input_tokens` in the SDK's own types — "the number of
 * input tokens written to the prompt cache during the turn" — and returns
 * exactly 0 for it on every turn: 101 of 101 usage envelopes across the live
 * ax-clone instance, against 67.2M tokens reported READ. One value, never
 * anything else, is not a measurement, and the schema already draws this line
 * one column over (`cache_ttl_bucket`: "NULL on Codex (no such figure)").
 */
const CACHE_WRITE_REPORTING_BACKENDS: readonly RunBackend[] = ["claude"];

/**
 * Ruling 36: what the prompt cache did for one group of runs — by run kind,
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
   * Ruling 36 (F39-22): Codex declares `cache_write_input_tokens` and returns
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
   *  whole-history replay shape ruling 173 removes. */
  largeFirstWrites: number;
  /** How many runs' writes were billed under each cache lifetime. */
  ttl: { fiveMinute: number; oneHour: number; mixed: number };
  /**
   * Ruling 172: the mean first-call write, over the runs with a first call on
   * a backend that reports writes, so PLAN.md's baseline column ("avg
   * first-call write") reads off the stored rows. Null when no such run is in
   * the group: ruling 36's rule, one column over.
   */
  avgFirstCallWrite: number | null;
  /** Ruling 36: cache reads per run, over the runs that reached the provider
   *  (the ones with a first call) and those runs' reads alone. Null with none. */
  readPerRun: number | null;
  /** Ruling 172: the spread of each run's largest prompt, over the runs that
   *  carried a per-call figure (`peak_prompt_tokens > 0`). Null with none. */
  peakPrompt: PromptSpread | null;
}

/** Ruling 172: PLAN.md's "peak prompt (median · p90 · max)", in tokens. */
export interface PromptSpread {
  median: number;
  /** Nearest rank: the smallest peak at least 90% of the runs stay within. */
  p90: number;
  max: number;
}

/** Ruling 172: the resumed first calls whose idle time fell in one bucket. */
export interface ResumeCell {
  firstCalls: number;
  warmStarts: number;
  /** warmStarts / firstCalls, null with no first call (never 0%). */
  warmRate: number | null;
}

/**
 * Ruling 172: one backend and credential kind, the pair `CACHE_TTL_MS` is
 * keyed on, with its resumes sorted by how long the session sat idle.
 */
export interface ResumeRow {
  /** The credential kind (`login`): the backend is the page's switch
   *  (ruling 35). */
  label: string;
  /** The TTL ruling 173's verdict assumes for this pair (`cacheTtlMs`). */
  assumedTtlMs: number;
  /** One cell per bucket of `ResumeSummary.edgesMs`, plus the open last one. */
  cells: ResumeCell[];
  /** Resumes ruling 173 declined: a fresh session started instead of a
   *  replay (`stale_large_session`), counted from their start audit rows. */
  setAside: number;
}

export interface ResumeSummary {
  /** The buckets' upper edges, ascending (`RESUME_IDLE_EDGES_MS`). */
  edgesMs: readonly number[];
  rows: ResumeRow[];
  /** The size past which a stale session is set aside (ruling 173's line),
   *  so the card can name it. */
  freshContextTokens: number;
}

/**
 * Ruling 172: operator starts that came close behind another of the same
 * prefix. PLAN.md (PR 5) held back a gate serializing them until they were
 * counted: the cold ones here, and what their first calls wrote, are the most
 * such a gate could save. Claude only — Codex's cache does not cross threads
 * (ruling 146), so no gate could make its second start warm.
 */
export interface OperatorBurstSummary {
  /** Claude operator runs that reached the provider (have a first call). */
  starts: number;
  /** Of them, the ones started within `windowMs` after the previous such
   *  start of the same project, principal and model. */
  inBursts: number;
  /** Of the burst starts, the cold ones. */
  coldInBursts: number;
  /** What those cold first calls wrote into the cache. */
  coldBurstWrite: number;
  /** Cold operator starts in all, so the burst share reads against them. */
  coldStarts: number;
  windowMs: number;
}

export interface CacheSummary {
  byKind: CacheRow[];
  byCredentialKind: CacheRow[];
  /** Ruling 35: whether this backend reports a cache-write figure at all
   *  (ruling 36). When it does not, the write columns are left out whole
   *  rather than printed "not reported" in every cell. */
  reportsWrites: boolean;
  /** The line `largeFirstWrites` counts against, so the card can name it. */
  largeWriteTokens: number;
  /** Ruling 172: resumes by idle time (PLAN.md's Codex retention probe). */
  resumes: ResumeSummary;
  /** Ruling 36: operator bursts (PLAN.md's count before the gate). Null on a
   *  backend whose cache does not cross threads (Codex, ruling 146): no
   *  order of starts could make a second one warm, so there is no count. */
  operatorBursts: OperatorBurstSummary | null;
}

/** Ruling 35: one backend's runs, every figure read off them alone. */
export interface RunAnalytics {
  backend: RunBackend;
  measure: RunMeasure;
  totals: InsightsTotals;
  /** F31-D6: the operator and controller runs' share of this backend's measure. */
  coordination: CoordinationShare;
  /** Ruling 36: the prompt-cache record, all-time like the totals. */
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
  byKind: Breakdown;
  byProject: Breakdown;
  byModel: Breakdown;
  /** Ruling 35: cost and runs per TASK. Labelled `project/task` when the read
   *  is not scoped to one project, because a task key is project-local. */
  byTask: Breakdown;
  /** Ruling 35: cost and runs per agent PROFILE — "which reviewer earns its
   *  runs", which `byKind` cannot answer because every reviewer is one kind. */
  byProfile: Breakdown;
  /** Mean wall-clock duration of finished runs with both timestamps, in ms. */
  avgDurationMs: number | null;
  /** Runs, cost and tokens per day over the last WINDOW_DAYS, oldest first,
   *  gap-filled. */
  daily: DailyPoint[];
  /** The latest provider rate-limit reading for this backend. */
  quota: BackendQuotaRow;
  /** Ruling 35: the windows that reading lists. */
  quotaWindows: QuotaWindow[];
  windowDays: number;
}

/**
 * Ruling 35: one usage window of a backend's latest reading, as the page draws
 * it — every window the reading lists (ruling 161(b): Codex's five-hour and
 * weekly windows, Claude's plan windows), shortest first. A reading that lists
 * none is its binding window alone. `reset` marks a window whose own reset
 * instant has passed (ruling 161(c)): its figure is history, and the page says so
 * rather than drawing it as current.
 */
export interface QuotaWindow {
  rateLimitType: string;
  utilization: number | null;
  resetsAt: number | null;
  reset: boolean;
}

export interface InsightsSummary {
  /** Ruling 35: the instance's own record, every backend's. */
  oversight: OversightSummary;
  /** Ruling 35: every backend with its run count, for the switch. */
  backends: BackendRuns[];
  /** Ruling 35: each backend that ran, its runs read alone, in `backends`
   *  order. The page's switch picks one in the browser, so changing it costs
   *  no request. */
  runs: RunAnalytics[];
}

const totalsSchema = z.object({
  runs: z.number(),
  costed_runs: z.number(),
  cost: z.number().nullable(),
  input_tokens: z.number().nullable(),
  cached_input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  tokenless_runs: z.number().nullable(),
  turns: z.number().nullable(),
});

/** F31-D6: one side of the coordination share, as SQLite returns it. */
const sideSchema = z.object({
  side: z.enum(["coordination", "delivery"]),
  cost: z.number().nullable(),
  tokens: z.number().nullable(),
  reached: z.number().nullable(),
  reached_uncosted: z.number().nullable(),
  reached_tokenless: z.number().nullable(),
});

const groupSchema = z.object({
  label: z.string().nullable(),
  runs: z.number(),
  cost: z.number().nullable(),
  tokens: z.number().nullable(),
});

/** Ruling 35: a run kind as the run consoles name it (UXV19-3, `roleShort`):
 *  "primary" and "reviewer" are the rows' machinery, and "reviewer" is written
 *  for every non-delivering run, verdict or not. */
const RUN_KIND_NAME = new Map([
  ["operator", "Operator"],
  ["controller", "Controller"],
  ["primary", "Delivering"],
  ["reviewer", "Supporting"],
]);

const nameRowSchema = z.object({ key: z.string(), name: z.string() });

/** `key → name` from a two-column read (`key`, `name`). */
function namesFrom(db: DatabaseSync, sql: string): Map<string, string> {
  return new Map(
    z
      .array(nameRowSchema)
      .parse(db.prepare(sql).all())
      .map((r) => [r.key, r.name]),
  );
}

/** Ruling 36: one grouped cache row as SQLite returns it; every SUM over a
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
  // Ruling 172: PLAN.md's baseline columns.
  first_write_sum: z.number().nullable(),
  first_write_runs: z.number().nullable(),
  first_call_reads: z.number().nullable(),
});

/** Ruling 172: one run's peak prompt, keyed by the group it falls in. */
const peakRowSchema = z.object({ label: z.string().nullable(), peak: z.number() });

/** Ruling 172: a run that replayed a session, beside the run before it. The
 *  two enums are the `agent_runs` CHECK constraints, which the TTL table is
 *  keyed on. */
const resumeRowSchema = z.object({
  backend: z.enum(["claude", "codex"]),
  prev_credential_kind: z.enum(["login", "api_key", "access_token"]).nullable(),
  started_at: z.string(),
  prev_finished_at: z.string().nullable(),
  /** Ruling 36: the earlier run's last console line, which is the end of its
   *  completion compaction when it had one. Null when its lines were pruned. */
  prev_last_line_at: z.string().nullable(),
  first_call_warm: z.number().nullable(),
});

const setAsideSchema = z.object({
  backend: z.enum(["claude", "codex"]),
  credential_kind: z.enum(["login", "api_key", "access_token"]).nullable(),
  runs: z.number(),
});

/** Ruling 172: a Claude operator start beside the one before it. */
const operatorStartSchema = z.object({
  started_at: z.string(),
  prev_started_at: z.string().nullable(),
  first_call_warm: z.number(),
  first_call_cache_write: z.number().nullable(),
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
  tokens: z.number().nullable(),
});

/** Optional project scope — absent aggregates the whole instance. */
export interface InsightsFilter {
  projectSlug?: string;
}

/** Ruling 35: a read of runs is always one backend's. */
export interface RunFilter extends InsightsFilter {
  backend: RunBackend;
}

interface ScopeClause {
  /** `WHERE …` over the scope, or "" with nothing to scope. */
  clause: string;
  /** The scope's conditions alone, for a read with a WHERE of its own. */
  conditions: string;
  params: string[];
  /** `WHERE` the scope AND `extra`. */
  and(extra: string): string;
}

/**
 * The scope as SQL: `project_slug` (which `agent_runs` and `task_projections`
 * share) and, on a read of runs, `backend`. `alias` prefixes the columns for a
 * read that joins.
 */
function scope(filter: InsightsFilter & { backend?: RunBackend }, alias = ""): ScopeClause {
  const terms: string[] = [];
  const params: string[] = [];
  if (filter.projectSlug) {
    terms.push(`${alias}project_slug = ?`);
    params.push(filter.projectSlug);
  }
  if (filter.backend) {
    terms.push(`${alias}backend = ?`);
    params.push(filter.backend);
  }
  const conditions = terms.join(" AND ");
  const clause = conditions ? `WHERE ${conditions}` : "";
  return {
    clause,
    conditions,
    params,
    and: (extra) => (clause ? `${clause} AND ${extra}` : `WHERE ${extra}`),
  };
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
  // Ruling 37: read for its `commits` alone — whether this task's delivery
  // was commit-shaped at all.
  github_json: z.string().nullable(),
  packet_json: z.string().nullable(),
  event_count: z.number(),
  created_at: z.string().nullable(),
});

/** Ruling 37: the one field the commit-shape test reads. */
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

/** Nearest rank: the smallest value at least `p` of the sorted values reach. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;
}

/** Ruling 35: the instance's own record, so the scope is a project at most —
 *  never a backend, which tasks, packets and the audit trail do not have. */
export function oversightSummary(
  db: DatabaseSync,
  filter: InsightsFilter = {},
): OversightSummary {
  const { clause, params } = scope({ projectSlug: filter.projectSlug });

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
  // Ruling 37 (F37-125): the NAMES, not just the counts. Every one of these
  // three numbers is a count of EXCEPTIONS — work that is untraceable, work
  // with no next actor, a record past the readability guardrail — and each one
  // withheld the only fact a person needs to act on it. "41 of 42 delivered
  // tasks carry branch + PR" is a traceability metric that will not say which
  // task cannot be traced. Ruling 205 settled this shape for a knowledge base
  // ("an agent cannot ask for a rule it cannot name"); a dashboard is the same
  // rule with a person reading it.
  const unclearTasks = active.filter(
    (t) => t.waiting === "none" && t.owner_user_id == null,
  );
  const clearTasks = active.length - unclearTasks.length;

  // 2. Key↔branch↔PR traceability over DELIVERED tasks (ruling 37): a
  // delivered revision or a recorded PR. A branch alone is not a delivery —
  // ruling 228 allocates the name at first dispatch, before any work exists
  // (U34-9).
  //
  // Less `commitless` deliveries (F39-34): a delivery that was never
  // commit-shaped has no branch and no PR to carry, so counting it here states
  // a demand that can NEVER be met — on finished work, in a metric whose whole
  // point is to name exceptions a person can act on. Live: ax-clone AX-12 delivered an
  // upstream-fidelity REPORT as 20 attachments, `noChanges: true`, zero
  // commits, force-accepted and Done; Insights read its `workRevision`, found
  // no PR, and reported "18 of 19 delivered tasks carry branch + PR" naming
  // AX-12 as the one that does not. A report is delivered work (ruling 81),
  // and the branch pill reads `no_branch` for the same task (ruling 237) on
  // the same predicate — terminal stage, no PR, no commits — which is reused
  // here rather than re-derived. A task that DID
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

  const longTimelineTasks = tasks
    .filter((t) => {
      const threshold = compressionAt.get(t.project_slug);
      // The boundary is the MACHINERY's, not a guess: `compactTimelineEvents`
      // opens with `if (events.length <= options.threshold) return events`, so a
      // task sitting exactly ON the threshold is not compacted and is not one the
      // readability machinery is managing. Counting it as "past their project's
      // compression threshold" put a task in the card that the fold never touches
      // — off by one against the only rule that decides.
      return threshold != null && t.event_count > threshold;
    })
    // Ruling 35: the longest first. The card names eight, and in table order
    // those were the oldest tasks (AWSC-1 to AWSC-8 of 70), not the longest.
    .sort((a, b) => b.event_count - a.event_count);

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
    longTimelines: longTimelineTasks.length,
    longTimelineKeys: namedKeys(longTimelineTasks),
  };
}

/**
 * Ruling 37: how many exception KEYS a card names before it stops.
 *
 * Enough that a small set is named in full — a dashboard's job is to point at
 * the thing — and few enough that a badly-drifted instance does not turn one
 * card into a wall. Past it the card says how many more there are, so the
 * number is never quietly smaller than the truth.
 */
const INSIGHTS_NAMED_EXCEPTIONS = 8;

/** `PROJ/KEY` for each row, capped, newest-looking order preserved. */
function namedKeys(rows: readonly { project_slug: string; task_key: string }[]): string[] {
  return rows.slice(0, INSIGHTS_NAMED_EXCEPTIONS).map((t) => `${t.project_slug}/${t.task_key}`);
}

/**
 * Ruling 173: the fresh start `resumeRun` records instead of a replay, in the
 * run's start audit (`continuityReset`). Typed against the service's own
 * reason list, so a rename there fails here.
 */
const STALE_SESSION_SET_ASIDE = "stale_large_session" satisfies ContinuityLossReason;

/**
 * Ruling 36: the prompt-cache record of one backend's runs (ruling 35),
 * grouped by run kind and by the credential kind the runs billed. Every figure
 * is a plain SUM over the columns the sink folded; the rates are taken over the
 * runs that HAVE a first call, so a refused run is neither warm nor cold.
 *
 * Ruling 172 adds what the prompt-cache plan asked the
 * page for and it lacked: the baseline table's own columns (the mean first-call
 * write, reads per run, the peak prompt's spread), resumes by idle time (the
 * Codex retention probe, and the check on every TTL ruling 173 assumes) and the
 * operator bursts the plan said to count before building a gate. All of it is
 * read off rows the sink already writes, so an instance's existing history
 * answers at once.
 */
function cacheSummary(db: DatabaseSync, filter: RunFilter): CacheSummary {
  const { clause, params, and } = scope(filter);
  const reportingPlaceholders = CACHE_WRITE_REPORTING_BACKENDS.map(() => "?").join(", ");

  // Ruling 172: each run's peak prompt, keyed by the same group expression, for
  // the spread; a run whose peak never landed carries no per-call figure.
  const peaksBy = (column: string): Map<string, number[]> => {
    const peaks = new Map<string, number[]>();
    const rows = z.array(peakRowSchema).parse(
      db
        .prepare(
          `SELECT ${column} AS label, peak_prompt_tokens AS peak
           FROM agent_runs ${and("peak_prompt_tokens > 0")}`,
        )
        .all(...params),
    );
    for (const row of rows) {
      const label = row.label ?? "unknown";
      peaks.set(label, [...(peaks.get(label) ?? []), row.peak]);
    }
    return peaks;
  };
  const spreadOf = (values: readonly number[] | undefined): PromptSpread | null => {
    if (!values?.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: nearestRank(sorted, 0.5)!,
      p90: nearestRank(sorted, 0.9)!,
      max: sorted[sorted.length - 1]!,
    };
  };

  const cacheGroup = (column: string): CacheRow[] => {
    const peaks = peaksBy(column);
    return z
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
                    SUM(CASE WHEN cache_ttl_bucket = 'mixed' THEN 1 ELSE 0 END) AS ttl_mixed,
                    SUM(CASE WHEN first_call_warm IS NOT NULL
                              AND backend IN (${reportingPlaceholders})
                             THEN first_call_cache_write END) AS first_write_sum,
                    SUM(CASE WHEN first_call_warm IS NOT NULL
                              AND backend IN (${reportingPlaceholders})
                             THEN 1 ELSE 0 END) AS first_write_runs,
                    SUM(CASE WHEN first_call_warm IS NOT NULL
                             THEN cached_input_tokens END) AS first_call_reads
             FROM agent_runs ${clause}
             GROUP BY ${column} ORDER BY runs DESC, label ASC`,
          )
          .all(
            ...CACHE_WRITE_REPORTING_BACKENDS,
            FIRST_CALL_LARGE_WRITE_TOKENS,
            ...CACHE_WRITE_REPORTING_BACKENDS,
            ...CACHE_WRITE_REPORTING_BACKENDS,
            ...params,
          ),
      )
      .map((r) => {
        const label = r.label ?? "unknown";
        const firstCalls = r.first_calls ?? 0;
        const warmStarts = r.warm_starts ?? 0;
        const writeReportingRuns = r.write_reporting_runs ?? 0;
        // Ruling 36: no reporting run behind the sum means there is no figure,
        // not a figure of zero.
        const writeTokens = writeReportingRuns > 0 ? (r.write_tokens ?? 0) : null;
        const readTokens = r.read_tokens ?? 0;
        const firstWriteRuns = r.first_write_runs ?? 0;
        return {
          label,
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
          // Ruling 172: the same rule as the write column — a mean of first
          // writes only over runs whose backend reports a write at all.
          avgFirstCallWrite: firstWriteRuns > 0 ? (r.first_write_sum ?? 0) / firstWriteRuns : null,
          readPerRun: firstCalls > 0 ? (r.first_call_reads ?? 0) / firstCalls : null,
          peakPrompt: spreadOf(peaks.get(label)),
        };
      });
  };

  return {
    byKind: cacheGroup("kind"),
    // A row written before the kind was stored, or a refused run, has none.
    byCredentialKind: cacheGroup("COALESCE(credential_kind, 'unknown')"),
    reportsWrites: CACHE_WRITE_REPORTING_BACKENDS.includes(filter.backend),
    largeWriteTokens: FIRST_CALL_LARGE_WRITE_TOKENS,
    resumes: resumeSummary(db, filter),
    operatorBursts: filter.backend === "claude" ? operatorBurstSummary(db, filter) : null,
  };
}

/**
 * Ruling 36: resumes sorted by how long their session sat idle, per backend
 * and credential kind — the probe PLAN.md (PR 6) asked for before Codex's
 * ten-minute TTL moves, and the check on every TTL ruling 173's verdict
 * assumes (a warm cell past the assumed TTL says the TTL is too short, a cold
 * one inside it that the cache lapsed sooner).
 *
 * A resume is a run whose provider session an earlier run of the same backend
 * already used (`resumeRun` hands the stored id over and the sink keeps it; a
 * fresh session is a new id, and an operator's is never reused). Its idle time
 * runs from the last call that touched the cache to its own start: the earlier
 * run's finish, or the last line of that run's console when that is later,
 * because a specialist's completion compaction (ruling 175) is written there
 * after the run has finished (ruling 36). The
 * row is keyed by the kind the EARLIER run billed: its writes are what the
 * resume reads, and ruling 173 takes the TTL from it. Only resumes whose first
 * call landed are counted; the set-aside column counts the fresh starts
 * made instead of a replay, from their start audit.
 */
function resumeSummary(db: DatabaseSync, filter: RunFilter): ResumeSummary {
  const { params, and } = scope(filter);
  const edgesMs = RESUME_IDLE_EDGES_MS;
  const rows = new Map<string, ResumeRow>();
  const rowFor = (backend: RunBackend, kind: CredentialKind | null): ResumeRow => {
    // Ruling 35: the backend is the page's switch, so a row is named by the
    // credential kind alone (`unknown` for a run written before it was stored).
    const label = kind ?? "unknown";
    const known = rows.get(label);
    if (known) return known;
    const row: ResumeRow = {
      label,
      assumedTtlMs: cacheTtlMs(backend, kind),
      cells: Array.from({ length: edgesMs.length + 1 }, () => ({
        firstCalls: 0,
        warmStarts: 0,
        warmRate: null,
      })),
      setAside: 0,
    };
    rows.set(label, row);
    return row;
  };

  const resumed = z.array(resumeRowSchema).parse(
    db
      .prepare(
        `SELECT backend, prev_credential_kind, started_at, prev_finished_at, first_call_warm,
                (SELECT l.occurred_at FROM run_log_lines l WHERE l.run_id = prev_id
                  ORDER BY l.seq DESC LIMIT 1) AS prev_last_line_at
         FROM (SELECT backend, started_at, first_call_warm,
                      LAG(id) OVER session AS prev_id,
                      LAG(finished_at) OVER session AS prev_finished_at,
                      LAG(credential_kind) OVER session AS prev_credential_kind
               FROM agent_runs
               ${and("session_id IS NOT NULL AND started_at IS NOT NULL")}
               WINDOW session AS (PARTITION BY backend, session_id ORDER BY started_at, id))
         WHERE prev_id IS NOT NULL AND first_call_warm IS NOT NULL`,
      )
      .all(...params),
  );
  for (const r of resumed) {
    const finished = Date.parse(r.prev_finished_at ?? "");
    const lastLine = r.prev_last_line_at ? Date.parse(r.prev_last_line_at) : Number.NaN;
    const idleMs =
      Date.parse(r.started_at) - (Number.isFinite(lastLine) ? Math.max(finished, lastLine) : finished);
    // An earlier run that never finished, or a clock that ran backwards, gives
    // no idle time to sort by.
    if (!Number.isFinite(idleMs) || idleMs < 0) continue;
    const bucket = edgesMs.findIndex((edge) => idleMs <= edge);
    const cell = rowFor(r.backend, r.prev_credential_kind).cells[
      bucket === -1 ? edgesMs.length : bucket
    ]!;
    cell.firstCalls += 1;
    if (r.first_call_warm === 1) cell.warmStarts += 1;
    cell.warmRate = cell.warmStarts / cell.firstCalls;
  }

  const runs = scope(filter, "r.");
  const setAside = z.array(setAsideSchema).parse(
    db
      .prepare(
        `SELECT r.backend AS backend, r.credential_kind AS credential_kind, count(*) AS runs
         FROM audit_events a JOIN agent_runs r ON r.id = a.subject_id
         WHERE a.action = 'runtime.run.started' AND a.subject_kind = 'run'
           AND json_extract(a.details_json, '$.continuityReset') = ?
           AND ${runs.conditions}
         GROUP BY r.backend, r.credential_kind`,
      )
      .all(STALE_SESSION_SET_ASIDE, ...runs.params),
  );
  for (const r of setAside) rowFor(r.backend, r.credential_kind).setAside += r.runs;

  return {
    edgesMs,
    freshContextTokens: RESUME_FRESH_CONTEXT_TOKENS,
    rows: [...rows.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
  };
}

/**
 * Ruling 36: the operator bursts PLAN.md (PR 5) said to count before building
 * a gate that serializes them. A cache entry exists only once the first
 * response has begun, so an operator run that starts while another run of the
 * same prefix — same project, the same principal's account, the same model —
 * is still waiting for its first response writes the prefix again.
 *
 * Counted over the Claude operator runs that reached the provider: a start
 * within `OPERATOR_BURST_WINDOW_MS` after the previous such start is in a
 * burst, and the cold ones among those, with what their first calls wrote, are
 * the most a gate could save. Codex is left out on purpose: its cache does not
 * cross threads (ruling 146), so no order of starts makes a second one warm.
 * The re-measure behind ruling 36 found 1 cold start in the 141 operator
 * starts that came within five minutes of the one before, which is why the
 * gate waits on this count.
 */
function operatorBurstSummary(db: DatabaseSync, filter: RunFilter): OperatorBurstSummary {
  const { params, and } = scope(filter);
  const starts = z.array(operatorStartSchema).parse(
    db
      .prepare(
        `SELECT started_at, first_call_warm, first_call_cache_write,
                LAG(started_at) OVER prefix AS prev_started_at
         FROM agent_runs
         ${and(
           "kind = 'operator' AND backend = 'claude' AND started_at IS NOT NULL AND first_call_warm IS NOT NULL",
         )}
         WINDOW prefix AS (PARTITION BY project_slug, credential_user_id, model
                           ORDER BY started_at, id)`,
      )
      .all(...params),
  );
  const summary: OperatorBurstSummary = {
    starts: starts.length,
    inBursts: 0,
    coldInBursts: 0,
    coldBurstWrite: 0,
    coldStarts: 0,
    windowMs: OPERATOR_BURST_WINDOW_MS,
  };
  for (const s of starts) {
    const cold = s.first_call_warm === 0;
    if (cold) summary.coldStarts += 1;
    const gapMs = Date.parse(s.started_at) - Date.parse(s.prev_started_at ?? "");
    if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > OPERATOR_BURST_WINDOW_MS) continue;
    summary.inBursts += 1;
    if (!cold) continue;
    summary.coldInBursts += 1;
    summary.coldBurstWrite += s.first_call_cache_write ?? 0;
  }
  return summary;
}

/**
 * F31-D6 under ruling 35: the coordination runs' share of one backend's
 * measure. Coordination is `operator` + `controller` (RunKind), machinery that
 * decides what the working agents do; delivery is every other kind.
 *
 * Ruling 36 (F37-12), one backend at a time: a side whose runs reached the
 * provider and put no figure in at all was never observed, and its zero is not
 * a measurement — "100%" for coordination when the delivery runs merely
 * reported nothing, or "0%" in the mirror. A run that never reached the
 * provider (no turn, no first call) is no evidence either way: it consumed
 * nothing, as U35-7 keeps a never-started run out of the completion rate. Live,
 * two Codex operator runs that errored in their first twelve seconds on day one
 * held Codex's share at "n/a" for good. Ruling 36's stricter test (null unless
 * EVERY run reported) guarded the cross-backend sum, where the silence was
 * systematic; inside one backend it is a stopped run here and there, and the
 * Cost and Tokens cards count it.
 */
function coordinationShare(
  db: DatabaseSync,
  filter: RunFilter,
  measure: RunMeasure,
): CoordinationShare {
  const { clause, params } = scope(filter);
  const sides = z.array(sideSchema).parse(
    db
      .prepare(
        `SELECT CASE WHEN kind IN ('operator', 'controller') THEN 'coordination' ELSE 'delivery' END AS side,
                SUM(total_cost_usd) AS cost,
                SUM(CASE WHEN usage_final = 1 THEN input_tokens + output_tokens END) AS tokens,
                SUM(CASE WHEN turns > 0 OR first_call_warm IS NOT NULL THEN 1 ELSE 0 END) AS reached,
                SUM(CASE WHEN (turns > 0 OR first_call_warm IS NOT NULL)
                          AND total_cost_usd IS NULL THEN 1 ELSE 0 END) AS reached_uncosted,
                SUM(CASE WHEN (turns > 0 OR first_call_warm IS NOT NULL)
                          AND usage_final = 0 THEN 1 ELSE 0 END) AS reached_tokenless
         FROM agent_runs ${clause}
         GROUP BY side`,
      )
      .all(...params),
  );
  const side = (name: "coordination" | "delivery") => {
    const row = sides.find((r) => r.side === name);
    return {
      figure: (measure === "cost" ? row?.cost : row?.tokens) ?? 0,
      reached: row?.reached ?? 0,
      silent: (measure === "cost" ? row?.reached_uncosted : row?.reached_tokenless) ?? 0,
    };
  };
  const coordination = side("coordination");
  const delivery = side("delivery");
  const total = coordination.figure + delivery.figure;
  const unobserved =
    (delivery.reached > 0 && delivery.silent === delivery.reached) ||
    (coordination.reached > 0 && coordination.silent === coordination.reached);
  return {
    measure,
    coordination: coordination.figure,
    total,
    share: total > 0 && !unobserved ? coordination.figure / total : null,
    reached: { delivery: delivery.reached, coordination: coordination.reached },
    silent: { delivery: delivery.silent, coordination: coordination.silent },
  };
}

/**
 * Ruling 35: every backend with its run count, in `BACKENDS` order, a
 * backend that never ran included with 0: the switch names each backend the
 * instance can run, and an empty one is a real answer, not a missing option.
 */
export function backendRuns(db: DatabaseSync, filter: InsightsFilter = {}): BackendRuns[] {
  const { clause, params } = scope({ projectSlug: filter.projectSlug });
  const counted = z
    .array(z.object({ backend: z.string(), runs: z.number() }))
    .parse(
      db
        .prepare(`SELECT backend, count(*) AS runs FROM agent_runs ${clause} GROUP BY backend`)
        .all(...params),
    );
  return BACKENDS.map((backend) => ({
    backend,
    runs: counted.find((c) => c.backend === backend)?.runs ?? 0,
  }));
}

/**
 * Ruling 35: one backend's runs, every figure read off them alone.
 *
 * Each figure is the one this backend's runs report, and nothing is summed
 * across backends: only Claude's result envelope carries a cost, a Codex token
 * and a Claude token are different models' tokens, and Codex reports no cache
 * write. The backend is weighed in `measure`: cost when any of its runs
 * reported one, else tokens.
 */
export function runAnalytics(db: DatabaseSync, nowIso: string, filter: RunFilter): RunAnalytics {
  const { clause, params, and } = scope(filter);

  const totals = totalsSchema.parse(
    db
      .prepare(
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
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN input_tokens END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN cached_input_tokens END), 0) AS cached_input_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 1 THEN output_tokens END), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN usage_final = 0 THEN 1 ELSE 0 END), 0) AS tokenless_runs,
                COALESCE(SUM(turns), 0) AS turns
         FROM agent_runs ${clause}`,
      )
      .get(...params),
  );

  // Ruling 35: the backend is weighed in cost when any of its runs reported
  // one. Read off the rows: which backend prices its runs is a
  // fact about the data, not a list in the source.
  const measure: RunMeasure = totals.costed_runs > 0 ? "cost" : "tokens";
  const coordination = coordinationShare(db, filter, measure);

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

  // F26-4: order by the MEASURE first, then runs. This is where a person looks
  // to see what drives spend, and the breakdown is capped at TOP_N — a
  // run-first order could truncate away a rare but expensive outlier, keeping
  // eight cheap-but-frequent groups instead. Measure-first guarantees the top
  // drivers always survive the cap. Ruling 35: the measure is cost where the
  // backend reports one and tokens where it does not, so a Codex breakdown
  // leads with what its runs consumed instead of a column of nulls.
  // The cap is applied HERE rather than in SQL: SQLite's DESC ordering sorts a
  // NULL sum last, and grouping over the whole set is cheap (a label is a kind,
  // model, project, profile or task). The top by RUNS is unioned in so no group
  // is dropped purely for being unmeasured.
  // Ruling 35: the names the page prints. An agent's is the one its newest run
  // carried (`agent_name`, stamped at dispatch); a project's is its own.
  const agentNames = namesFrom(
    db,
    `SELECT agent_profile_id AS key, agent_name AS name, MAX(created_at) AS newest
       FROM agent_runs WHERE agent_profile_id IS NOT NULL AND agent_name IS NOT NULL
      GROUP BY agent_profile_id`,
  );
  const projectNames = namesFrom(db, `SELECT slug AS key, name FROM projects`);
  projectNames.set("controller (instance)", "Controller (instance)");
  const weigh = (r: CountRow): number => (measure === "cost" ? r.cost : r.tokens) ?? -1;
  const group = (column: string, nameOf: (label: string) => string = (label) => label): Breakdown => {
    const rows: CountRow[] = z
      .array(groupSchema)
      .parse(
        db
          .prepare(
            `SELECT ${column} AS label, count(*) AS runs,
                    SUM(total_cost_usd) AS cost,
                    SUM(CASE WHEN usage_final = 1 THEN input_tokens + output_tokens END) AS tokens
             FROM agent_runs ${clause}
             GROUP BY ${column}`,
          )
          .all(...params),
      )
      // Ruling 251: controller turns carry project_slug "" (instance scope) —
      // label them honestly instead of rendering a blank bar.
      .map((r) => {
        const label = r.label === "" ? "controller (instance)" : (r.label ?? "unknown");
        return { label, name: nameOf(label), runs: r.runs, cost: r.cost, tokens: r.tokens };
      });

    const byMeasure = [...rows].sort((a, b) => weigh(b) - weigh(a) || b.runs - a.runs);
    const byRuns = [...rows].sort((a, b) => b.runs - a.runs);
    const kept = new Map<string, CountRow>();
    // Half the slots are reserved for the busiest groups, so a breakdown that
    // leads with spend still shows where the work happens.
    const runSlots = Math.floor(TOP_N / 2);
    for (const row of byRuns.slice(0, runSlots)) kept.set(row.label, row);
    for (const row of byMeasure) {
      if (kept.size >= TOP_N) break;
      kept.set(row.label, row);
    }
    const shown = [...kept.values()].sort((a, b) => weigh(b) - weigh(a) || b.runs - a.runs);
    // Ruling 35: say what the window left out. A breakdown that shows eight
    // of thirty groups and says nothing reads as the whole instance, which is
    // the same defect ruling 117 fixed on the timeline windows — and this one
    // is on the surface a person opens to decide where their money goes.
    const hiddenRows = rows.filter((r) => !kept.has(r.label));
    const hiddenSum = (pick: (r: CountRow) => number | null): number | null =>
      hiddenRows.some((r) => pick(r) !== null)
        ? hiddenRows.reduce((n, r) => n + (pick(r) ?? 0), 0)
        : null;
    return {
      rows: shown,
      hidden: hiddenRows.length,
      hiddenRuns: hiddenRows.reduce((n, r) => n + r.runs, 0),
      hiddenCost: hiddenSum((r) => r.cost),
      hiddenTokens: hiddenSum((r) => r.tokens),
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
        // No COALESCE: a day whose runs all report no cost keeps a NULL sum,
        // surfaced as "not reported" — never a dishonest $0.00, the same honesty
        // the breakdown groups carry. Tokens follow the same rule.
        `SELECT substr(started_at, 1, 10) AS date, count(*) AS runs,
                SUM(total_cost_usd) AS cost,
                SUM(CASE WHEN usage_final = 1 THEN input_tokens + output_tokens END) AS tokens
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
    // A real day keeps its (possibly null) figures; a gap-filled quiet day is 0.
    daily.push({
      date: d,
      runs: row?.runs ?? 0,
      cost: row ? row.cost : 0,
      tokens: row ? row.tokens : 0,
    });
  }

  // D5: `nowIso` retires an exhaustion record whose provider-named reset
  // instant has already passed — the window it described is over.
  const quota = latestBackendRateLimits(db, nowIso).find((r) => r.backend === filter.backend)!;
  const nowMs = Date.parse(nowIso);
  const reading = quota.reading;
  const quotaWindows: QuotaWindow[] = (
    reading == null ? [] : reading.windows?.length ? reading.windows : [reading]
  ).map((w) => ({
    rateLimitType: w.rateLimitType,
    utilization: w.utilization,
    resetsAt: w.resetsAt,
    // `readingWindowReset`'s test, window by window: the provider's own epoch,
    // no grace, and a reset nobody named never ages.
    reset: w.resetsAt != null && Number.isFinite(nowMs) && w.resetsAt * 1000 <= nowMs,
  }));

  return {
    backend: filter.backend,
    measure,
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
    coordination,
    cache: cacheSummary(db, filter),
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
    byKind: group("kind", (kind) => RUN_KIND_NAME.get(kind) ?? kind),
    byProject: group("project_slug", (slug) => projectNames.get(slug) ?? slug),
    byModel: group("model", (model) => modelDisplayName(filter.backend, model)),
    // Ruling 35: the two the controller asked for and could not answer —
    // "what did SHOP-27 cost across eleven rework rounds" and "which reviewer
    // earns its runs". A task key is only unique inside its project, so an
    // unscoped read labels each row with the project it belongs to.
    // U39-22: a controller turn's `task_key` is its CONVERSATION id and its
    // project is '' (ruling 251), so every turn read as a task named
    // "/cnv_tjVMn13JkW-0". They are one row, named for what they are.
    byTask: group(
      `CASE WHEN kind = 'controller' THEN 'controller conversations' ELSE ${
        filter.projectSlug ? "task_key" : "project_slug || '/' || task_key"
      } END`,
      (task) => (task === "controller conversations" ? "Controller conversations" : task),
    ),
    byProfile: group("agent_profile_id", (id) => agentNames.get(id) ?? id),
    avgDurationMs: duration.avg_ms,
    daily,
    quota,
    quotaWindows,
    windowDays: WINDOW_DAYS,
  };
}

/**
 * The page's read: the instance's oversight, every backend's run count, and
 * each backend that ran, read alone (ruling 35).
 */
export function getInsightsSummary(db: DatabaseSync, nowIso: string): InsightsSummary {
  const backends = backendRuns(db);
  return {
    oversight: oversightSummary(db),
    backends,
    runs: backends
      .filter((b) => b.runs > 0)
      .map((b) => runAnalytics(db, nowIso, { backend: b.backend })),
  };
}
