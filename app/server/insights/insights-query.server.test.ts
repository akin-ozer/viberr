import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Guardrail } from "~/schemas/project-file.schema";
import { createTestDbContext } from "../../../test-support/test-db";
import { compactTimelineEvents } from "~/server/tasks/timeline-compaction.server";
import { INSIGHTS_NAMED_EXCEPTIONS, getInsightsSummary } from "./insights-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

let seq = 0;
function insertRun(
  db: DatabaseSync,
  r: {
    project?: string;
    kind?: string;
    backend?: string;
    model?: string;
    state?: string;
    cost?: number | null;
    inTok?: number;
    cachedTok?: number;
    outTok?: number;
    turns?: number;
    startedAt?: string | null;
    finishedAt?: string | null;
    /** Pass 35 U35-7: the stored reason an interrupted run stopped. */
    interruptedReason?: "restart" | null;
    /** F35-1: 0 while the row holds a live estimate (default 1: a total). */
    usageFinal?: 0 | 1;
    /** Ruling 308: the two columns the task and profile breakdowns group on. */
    taskKey?: string;
    agentProfileId?: string;
    /** Ruling 395: what the provider said it wrote into the cache. */
    cacheWrite?: number;
  },
) {
  seq += 1;
  db.prepare(
    `INSERT INTO agent_runs
       (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
        started_at, finished_at, turns, input_tokens, cached_input_tokens,
        output_tokens, usage_final, total_cost_usd, created_at, updated_at, agent_profile_id,
        interrupted_reason, cache_write_tokens)
     VALUES (?, ?, ?, ?, 'Dev', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    `run_${seq}`,
    r.taskKey ?? `VIB-${seq}`,
    r.project ?? "viberr-core",
    `t_${seq}`,
    r.kind ?? "primary",
    r.backend ?? "claude",
    r.model ?? "claude-sonnet-4-5",
    r.state ?? "finished",
    r.startedAt ?? null,
    r.finishedAt ?? null,
    r.turns ?? 0,
    r.inTok ?? 0,
    r.cachedTok ?? 0,
    r.outTok ?? 0,
    r.usageFinal ?? 1,
    r.cost ?? null,
    r.agentProfileId ?? "developer",
    r.interruptedReason ?? null,
    r.cacheWrite ?? 0,
  );
}

const NOW = "2026-08-23T12:00:00.000Z";

describe("getInsightsSummary", () => {
  it("sums totals and counts outcomes with a success rate", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", cost: 0.1, outTok: 100, inTok: 50, turns: 2 });
    insertRun(db, { state: "finished", cost: 0.2, outTok: 200, inTok: 60, turns: 3 });
    insertRun(db, { state: "error", cost: 0.05, outTok: 10 });
    // A person stopped this one mid-run: it started, so it stays in the rate.
    insertRun(db, { state: "interrupted", cost: null, outTok: 5, startedAt: "2026-08-22T09:00:00.000Z" });
    insertRun(db, { state: "running", cost: null });

    const s = getInsightsSummary(db, NOW);
    expect(s.totals.runs).toBe(5);
    expect(s.totals.cost).toBeCloseTo(0.35, 5);
    expect(s.totals.outputTokens).toBe(315);
    expect(s.totals.inputTokens).toBe(110);
    expect(s.totals.turns).toBe(5);
    expect(s.outcomes.finished).toBe(2);
    expect(s.outcomes.error).toBe(1);
    expect(s.outcomes.interrupted).toBe(1);
    expect(s.outcomes.running).toBe(1);
    // 2 finished of (2+1+1)=4 terminal → 0.5.
    expect(s.outcomes.successRate).toBeCloseTo(0.5, 5);
  });

  /**
   * F35-1 (pass 35): a running row's token columns hold the Claude adapter's
   * live ESTIMATE (or nothing, on Codex), not a total. The sums used to add
   * them in, so the headline moved with every streamed envelope and then
   * corrected itself at the result. Runs and turns still count the row.
   */
  it("F35-1: token totals leave out rows whose provider total has not landed", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", outTok: 100, inTok: 50, cachedTok: 20, turns: 2 });
    // Canary: restore the plain SUM and the totals read 5100 / 1050 / 420.
    insertRun(db, { state: "running", outTok: 5000, inTok: 1000, cachedTok: 400, turns: 3, usageFinal: 0 });
    const s = getInsightsSummary(db, NOW);
    expect(s.totals.runs).toBe(2);
    expect(s.totals.turns).toBe(5);
    expect(s.totals.outputTokens).toBe(100);
    expect(s.totals.inputTokens).toBe(50);
    expect(s.totals.cachedInputTokens).toBe(20);
  });

  /**
   * The rows the sums drop are not only the ones in flight: a run somebody
   * stopped, and one that errored before the provider answered, never get a
   * provider figure, so they are out of the token sums for good while they
   * still count in Total runs and Turns. The totals therefore report HOW MANY
   * runs they leave out, so the card can name them (the sums cannot be read
   * honestly without that number). Canary: drop `tokenless_runs` from the
   * SELECT and the count is 0.
   */
  it("F35-1: the totals count the runs their token sums leave out, whatever state those runs are in", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", outTok: 100, inTok: 50, cachedTok: 20, turns: 2 });
    insertRun(db, {
      state: "interrupted",
      outTok: 5000,
      inTok: 1000,
      cachedTok: 400,
      turns: 3,
      usageFinal: 0,
      startedAt: "2026-08-22T09:00:00.000Z",
      finishedAt: "2026-08-22T09:12:00.000Z",
    });
    insertRun(db, { state: "running", outTok: 20, inTok: 10, usageFinal: 0 });
    const s = getInsightsSummary(db, NOW);
    expect(s.totals.runs).toBe(3);
    expect(s.totals.outputTokens).toBe(100);
    expect(s.totals.tokenlessRuns).toBe(2);
  });

  it("a day whose runs all report no cost shows null, not $0, in the daily series (bug-sweep #15)", () => {
    const db = ctx.makeDb();
    const day = "2026-08-22";
    // Both runs on this day are Codex — no cost reported (total_cost_usd NULL).
    insertRun(db, { state: "finished", cost: null, startedAt: `${day}T09:00:00.000Z` });
    insertRun(db, { state: "finished", cost: null, startedAt: `${day}T10:00:00.000Z` });
    const s = getInsightsSummary(db, NOW);
    const point = s.daily.find((d) => d.date === day)!;
    expect(point.runs).toBe(2);
    // Unknown, not a dishonest $0.00 — the same honesty the breakdown groups carry.
    expect(point.cost).toBeNull();
    // A gap-filled quiet day (no runs) is still a real 0, not "not reported".
    expect(s.daily.find((d) => d.runs === 0)!.cost).toBe(0);
  });

  /**
   * Pass 35 U35-7 (owner, Q35-16: "interrupted state, honest counts"). Boot
   * recovery interrupts every row a restart orphaned; live that was 23 runs,
   * 17 of them queued runs that never executed a turn, and every one used to
   * land in `error` and pull the completion rate down. Canary: drop the
   * `interruptedNeverStarted` subtraction from the denominator and the rate
   * assertion fails (2/3 becomes 1/2); drop the by-restart count and its
   * assertion fails.
   */
  it("two restart-interrupted orphans (one started, one queued) count as stopped, never as errors, and the queued one leaves the denominator", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", cost: 0.1, turns: 3, startedAt: "2026-08-22T09:00:00.000Z" });
    // The primary a restart cut mid-step: it ran, so its interruption is an outcome.
    insertRun(db, {
      state: "interrupted",
      interruptedReason: "restart",
      turns: 4,
      startedAt: "2026-08-22T10:00:00.000Z",
      finishedAt: "2026-08-22T10:40:30.000Z",
    });
    // The queued run the same boot finalized: no started_at, no turn, nothing ran.
    insertRun(db, {
      state: "interrupted",
      interruptedReason: "restart",
      turns: 0,
      startedAt: null,
      finishedAt: "2026-08-22T10:40:30.000Z",
    });
    const s = getInsightsSummary(db, NOW).outcomes;
    expect(s.error).toBe(0);
    expect(s.interrupted).toBe(2);
    expect(s.interruptedByRestart).toBe(2);
    expect(s.interruptedNeverStarted).toBe(1);
    // 1 finished of (1 finished + 1 interrupted that ran) = 0.5; the
    // never-started run is out of the denominator.
    expect(s.successRate).toBeCloseTo(0.5, 5);
    // The counts still reconcile with the total (F26-5).
    expect(s.finished + s.error + s.interrupted + s.running + s.queued).toBe(3);
  });

  it("a person's stop of a still-queued run leaves the denominator too, with no restart counted", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", turns: 2, startedAt: "2026-08-22T09:00:00.000Z" });
    insertRun(db, { state: "interrupted", turns: 0, startedAt: null });
    const s = getInsightsSummary(db, NOW).outcomes;
    expect(s.interruptedNeverStarted).toBe(1);
    expect(s.interruptedByRestart).toBe(0);
    expect(s.successRate).toBe(1);
  });

  it("successRate is null when every terminal run never started", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "interrupted", interruptedReason: "restart", turns: 0, startedAt: null });
    expect(getInsightsSummary(db, NOW).outcomes.successRate).toBeNull();
  });

  it("successRate is null with no terminal runs", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "running" });
    insertRun(db, { state: "queued" });
    expect(getInsightsSummary(db, NOW).outcomes.successRate).toBeNull();
  });

  it("groups by backend, kind, project and model", () => {
    const db = ctx.makeDb();
    insertRun(db, { backend: "claude", kind: "primary", project: "p1", model: "sonnet", cost: 0.1 });
    insertRun(db, { backend: "claude", kind: "reviewer", project: "p1", model: "sonnet", cost: 0.1 });
    insertRun(db, { backend: "codex", kind: "operator", project: "p2", model: "gpt-5", cost: 0.3 });

    const s = getInsightsSummary(db, NOW);
    const claude = s.byBackend.rows.find((r) => r.label === "claude")!;
    expect(claude.runs).toBe(2);
    expect(claude.cost).toBeCloseTo(0.2, 5);
    expect(s.byBackend.rows.find((r) => r.label === "codex")?.runs).toBe(1);
    expect(s.byKind.rows.map((r) => r.label).sort()).toEqual([
      "operator",
      "primary",
      "reviewer",
    ]);
    expect(s.byProject.rows.find((r) => r.label === "p2")?.cost).toBeCloseTo(0.3, 5);
    expect(s.byModel.rows.find((r) => r.label === "gpt-5")?.runs).toBe(1);
  });

  it("averages finished-run wall-clock duration in ms", () => {
    const db = ctx.makeDb();
    // 2 minutes and 4 minutes → mean 3 minutes = 180000 ms.
    insertRun(db, {
      state: "finished",
      startedAt: "2026-08-20T10:00:00.000Z",
      finishedAt: "2026-08-20T10:02:00.000Z",
    });
    insertRun(db, {
      state: "finished",
      startedAt: "2026-08-20T10:00:00.000Z",
      finishedAt: "2026-08-20T10:04:00.000Z",
    });
    // An unfinished run and one missing timestamps are excluded.
    insertRun(db, { state: "running", startedAt: "2026-08-20T10:00:00.000Z" });
    const s = getInsightsSummary(db, NOW);
    expect(s.avgDurationMs).toBeCloseTo(180000, -2);
  });

  // F26-6: a row whose finished_at precedes started_at is clamped to 0, never
  // dragging the average negative into a nonsense "-600s".
  it("clamps a negative duration (finished before started) to zero", () => {
    const db = ctx.makeDb();
    insertRun(db, {
      state: "finished",
      startedAt: "2026-08-20T10:10:00.000Z",
      finishedAt: "2026-08-20T10:00:00.000Z", // 10 min BEFORE start
    });
    const s = getInsightsSummary(db, NOW);
    expect(s.avgDurationMs).not.toBeNull();
    expect(s.avgDurationMs!).toBeGreaterThanOrEqual(0);
  });

  // F26-4: the byModel/byProject breakdowns are capped at TOP_N (8). A rare but
  // expensive model must survive the cap — it is exactly what a cost dashboard
  // exists to surface — so ordering is cost-first, not run-first.
  it("keeps the top cost driver in the breakdown even when frequency is low", () => {
    const db = ctx.makeDb();
    // One pricey model, one run. Then 8 cheap-but-frequent models, 3 runs each —
    // enough distinct models to overflow the TOP_N cap.
    insertRun(db, { model: "pricey-xl", cost: 500, state: "finished" });
    for (let m = 0; m < 8; m++) {
      for (let r = 0; r < 3; r++) {
        insertRun(db, { model: `cheap-${m}`, cost: 0.01, state: "finished" });
      }
    }
    const s = getInsightsSummary(db, NOW);
    expect(s.byModel.rows).toHaveLength(8);
    // The expensive outlier is present (a run-first order would have dropped it).
    expect(s.byModel.rows[0]?.label).toBe("pricey-xl");
    expect(s.byModel.rows.some((r) => r.label === "pricey-xl")).toBe(true);
  });

  /**
   * Ruling 308 (pass 37, F37-143): the window says what it left out.
   *
   * The cap keeps eight groups and reserves half the slots for the busiest, so
   * a cost view still shows where the work happens. It dropped everything else
   * in silence, on the one surface a person opens to decide where their money
   * goes: eight of thirty groups, presented as the instance.
   */
  it("ruling 308: a capped breakdown reports the groups it dropped, their runs and their cost", () => {
    const db = ctx.makeDb();
    // 12 models — four more than the cap — so four are dropped.
    for (let m = 0; m < 12; m++) {
      insertRun(db, { model: `m-${m}`, cost: 1, state: "finished" });
      insertRun(db, { model: `m-${m}`, cost: 1, state: "finished" });
    }
    const s = getInsightsSummary(db, NOW);
    expect(s.byModel.rows).toHaveLength(8);
    // CANARY: return the rows alone and eight of twelve reads as all of them.
    expect(s.byModel.hidden).toBe(4);
    expect(s.byModel.hiddenRuns).toBe(8);
    expect(s.byModel.hiddenCost).toBe(8);
    // Nothing dropped says so as zero, never as a missing field.
    expect(s.byBackend.hidden).toBe(0);
    expect(s.byBackend.hiddenRuns).toBe(0);
  });

  /**
   * Ruling 308's other half, from the controller: "'What did SHOP-27 cost
   * across eleven rework rounds' has no answer. 'Which reviewer earns its runs'
   * has no answer. You are running this instance and cannot see what it costs
   * you." `byKind` cannot answer the second, because every reviewer is one kind.
   */
  it("ruling 308: breaks down by task and by agent profile, and labels a task with its project when unscoped", () => {
    const db = ctx.makeDb();
    insertRun(db, {
      project: "alpha",
      taskKey: "A-1",
      agentProfileId: "code-reviewer",
      cost: 2,
      state: "finished",
    });
    insertRun(db, {
      project: "beta",
      taskKey: "A-1",
      agentProfileId: "code-reviewer",
      cost: 3,
      state: "finished",
    });
    insertRun(db, {
      project: "alpha",
      taskKey: "A-2",
      agentProfileId: "backend-engineer",
      cost: 5,
      state: "finished",
    });

    // CANARY: group on `task_key` alone when unscoped and the two projects'
    // A-1 collapse into one row that belongs to neither.
    const all = getInsightsSummary(db, NOW);
    const labels = all.byTask.rows.map((r) => r.label).sort();
    expect(labels).toContain("alpha/A-1");
    expect(labels).toContain("beta/A-1");

    // Scoped to a project, the prefix is noise: the keys are already local.
    const scoped = getInsightsSummary(db, NOW, { projectSlug: "alpha" });
    expect(scoped.byTask.rows.map((r) => r.label).sort()).toEqual(["A-1", "A-2"]);

    // The question byKind cannot answer: which PROFILE earns its runs.
    // CANARY: drop byProfile.
    const reviewer = all.byProfile.rows.find((r) => r.label === "code-reviewer");
    expect(reviewer?.runs).toBe(2);
    expect(reviewer?.cost).toBe(5);
  });

  /**
   * Only the Claude result envelope reports a cost, so every Codex run row is
   * NULL. Coalescing that to 0 turned "unobservable" into "free", and because
   * the breakdown was ordered cost-first and capped, the busiest groups on the
   * instance were the first thing the cap dropped.
   */
  it("keeps an unpriced but busy group in the breakdown and reports its cost as absent, not $0", () => {
    const db = ctx.makeDb();
    // Eight priced Claude models, one run each.
    for (let m = 0; m < 8; m++) {
      insertRun(db, { backend: "claude", model: `claude-${m}`, cost: 0.5 });
    }
    // The busiest model on the instance reports no cost at all.
    for (let r = 0; r < 12; r++) {
      insertRun(db, { backend: "codex", model: "gpt-5", cost: null });
    }

    const s = getInsightsSummary(db, NOW);
    const busiest = s.byModel.rows.find((r) => r.label === "gpt-5");
    expect(busiest, "the busiest model must survive the cap").toBeTruthy();
    expect(busiest!.runs).toBe(12);
    // Unknown, never "$0.00".
    expect(busiest!.cost).toBeNull();
    // And the headline says how much of the instance the cost covers.
    expect(s.totals.runs).toBe(20);
    expect(s.totals.costedRuns).toBe(8);
  });

  it("gap-fills the daily window to exactly windowDays points, oldest first", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", startedAt: "2026-08-22T09:00:00.000Z", cost: 0.5 });
    insertRun(db, { state: "finished", startedAt: "2026-08-22T15:00:00.000Z", cost: 0.5 });
    const s = getInsightsSummary(db, NOW);
    expect(s.daily).toHaveLength(s.windowDays);
    expect(s.daily[0]?.date < s.daily[s.daily.length - 1]!.date).toBe(true);
    const aug22 = s.daily.find((d) => d.date === "2026-08-22")!;
    expect(aug22.runs).toBe(2);
    expect(aug22.cost).toBeCloseTo(1.0, 5);
    // A day with no runs is a real zero, not absent.
    const aug21 = s.daily.find((d) => d.date === "2026-08-21")!;
    expect(aug21.runs).toBe(0);
  });

  it("scopes to one project when asked", () => {
    const db = ctx.makeDb();
    insertRun(db, { project: "p1", cost: 0.1 });
    insertRun(db, { project: "p2", cost: 0.2 });
    const s = getInsightsSummary(db, NOW, { projectSlug: "p1" });
    expect(s.totals.runs).toBe(1);
    expect(s.totals.cost).toBeCloseTo(0.1, 5);
  });
});

// ------------------------------------------------- governance (pass 29)

const STAGES = JSON.stringify([
  { id: "triage", name: "Triage", color: "slate" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
]);
const WORKFLOW = JSON.stringify([
  { from: "triage", to: "impl", boundary: "auto" },
  { from: "impl", to: "review", boundary: "approval" },
  { from: "review", to: "done", boundary: "human" },
]);

// The default mirrors the project template's own guardrail row (on, 40
// events), so every existing case keeps the threshold it was written against.
// A test that cares about the threshold passes its own.
function insertProject(
  db: DatabaseSync,
  slug: string,
  guardrails: Guardrail[] = [
    { id: "compression-threshold", desc: "", on: true, value: 40, unit: "events" },
  ],
) {
  db.prepare(
    `INSERT INTO projects
       (slug, name, task_prefix, stages_json, workflow_json, guardrails_json,
        source_path, content_hash, parsed_at)
     VALUES (?, ?, 'VIB', ?, ?, ?, ?, 'hash', '2026-08-01T00:00:00.000Z')`,
  ).run(
    slug,
    slug,
    STAGES,
    WORKFLOW,
    JSON.stringify(guardrails),
    `projects/${slug}/project.md`,
  );
}

function insertTask(
  db: DatabaseSync,
  t: {
    project?: string;
    key: string;
    stage?: string;
    waiting?: string;
    owner?: string | null;
    archived?: number;
    branch?: string | null;
    prJson?: string | null;
    revisionSha?: string | null;
    githubJson?: string | null;
    packetJson?: string | null;
    eventCount?: number;
    createdAt?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO task_projections
       (project_slug, task_key, title, stage, readiness, waiting, urgent,
        archived, validation, owner_user_id, branch, pr_json,
        work_revision_sha, github_json, packet_json, event_count, created_at,
        source_path, content_hash, parsed_at)
     VALUES (?, ?, ?, ?, 'ready', ?, 0, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?,
             ?, 'hash', '2026-08-01T00:00:00.000Z')`,
  ).run(
    t.project ?? "gp",
    t.key,
    t.key,
    t.stage ?? "impl",
    t.waiting ?? "none",
    t.archived ?? 0,
    t.owner ?? null,
    t.branch ?? null,
    t.prJson ?? null,
    t.revisionSha ?? null,
    t.githubJson ?? null,
    t.packetJson ?? null,
    t.eventCount ?? 0,
    t.createdAt ?? "2026-08-20T00:00:00.000Z",
    `projects/${t.project ?? "gp"}/tasks/${t.key}/task.md`,
  );
}

let auditSeq = 0;
function insertAudit(
  db: DatabaseSync,
  a: { project?: string; task: string; action: string; at: string; details?: object },
) {
  auditSeq += 1;
  db.prepare(
    `INSERT INTO audit_events
       (id, occurred_at, actor_label, action, project_slug, task_key, details_json)
     VALUES (?, ?, 'test', ?, ?, ?, ?)`,
  ).run(
    `aud_${auditSeq}`,
    a.at,
    a.action,
    a.project ?? "gp",
    a.task,
    a.details ? JSON.stringify(a.details) : null,
  );
}

describe("oversight outcomes (pass 29 — the PRD's own success criteria, measured)", () => {
  it("computes ownership clarity over ACTIVE tasks only (archived + terminal excluded)", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertTask(db, { key: "VIB-1", waiting: "agent" }); // clear (agent working)
    insertTask(db, { key: "VIB-2", waiting: "none", owner: "u_1" }); // clear (owned)
    insertTask(db, { key: "VIB-3", waiting: "none" }); // AMBIGUOUS
    insertTask(db, { key: "VIB-4", stage: "done", waiting: "none" }); // terminal → excluded
    insertTask(db, { key: "VIB-5", archived: 1, waiting: "none" }); // archived → excluded

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.clarity.activeTasks).toBe(3);
    expect(g.clarity.clearTasks).toBe(2);
    expect(g.clarity.pct).toBeCloseTo(2 / 3, 5);
  });

  /**
   * V3 (pass 31): the numerator is every COORDINATION run, and `RunKind` has
   * two of them. A controller turn (ruling 99) decides what the working agents
   * do exactly as the operator does, carries real cost, and the runtime treats
   * the pair as one class — counting only `operator` understated the overhead
   * by every controller turn on the instance. The kind list is pinned here.
   */
  it("F31-D6: coordination overhead is the operator AND controller share of REPORTED spend, null when nothing reported", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // $0.50 operator + $0.10 controller = $0.60 coordination, over $1.00
    // reported → 60%. Ruling 201: every run here reports, which is what makes
    // the quotient a measurement — a single cost-less run and this share is
    // suppressed instead (asserted in its own test below).
    insertRun(db, { kind: "operator", cost: 0.5 });
    insertRun(db, { kind: "controller", cost: 0.1 });
    insertRun(db, { kind: "primary", cost: 0.3 });
    insertRun(db, { kind: "reviewer", cost: 0.1 });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: narrow the totals CASE back to `kind = 'operator'` and the share
    // drops to 50%, hiding the controller's spend inside the denominator.
    expect(g.coordination.coordinationCostUsd).toBeCloseTo(0.6, 5);
    expect(g.coordination.totalCostUsd).toBeCloseTo(1.0, 5);
    expect(g.coordination.share).toBeCloseTo(0.6, 5);
    // The denominator is the SAME number the totals card renders — both sides
    // now come off one aggregate, so they cannot disagree.
    expect(getInsightsSummary(db, NOW).totals.cost).toBeCloseTo(
      g.coordination.totalCostUsd,
      5,
    );

    // Canary: with ZERO reported spend the share is null — never a fake 0%.
    const empty = ctx.makeDb();
    insertProject(empty, "gp");
    insertRun(empty, { kind: "operator", cost: null });
    expect(getInsightsSummary(empty, NOW).oversight.coordination.share).toBeNull();
  });

  /**
   * Ruling 190 (F37-12, live): a Codex-only delivery fleet reports no cost at
   * all, so the instance's four Claude CONTROLLER runs were the entire
   * denominator and the card read "Coordination overhead 100%" — arithmetic
   * that cannot be wrong and an answer that cannot be right. The share is a
   * measurement only when its complement could have been observed.
   */
  it("ruling 190: the share is null when a side RAN and reported nothing — no fake 100%, no fake 0%", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // The live shape: Claude controller turns cost money, every Codex delivery
    // run reports nothing.
    insertRun(db, { kind: "controller", cost: 4.0 });
    insertRun(db, { kind: "operator", cost: null });
    insertRun(db, { kind: "primary", cost: null });
    insertRun(db, { kind: "reviewer", cost: null });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: drop the `unobserved` guard from the share and this is 1 — the
    // card prints "100%" off a denominator delivery never entered.
    expect(g.coordination.share).toBeNull();
    // Ruling 201 replaced the `unobserved` enum with the counts the card reads:
    // a side whose every run is cost-silent is the ruling-190 case, and it is
    // legible here as uncosted === runs.
    expect(g.coordination.uncosted.delivery).toBe(g.coordination.runs.delivery);
    expect(g.coordination.uncosted.coordination).toBe(1);
    // The dollar figure that IS real survives: the card still reports it.
    expect(g.coordination.coordinationCostUsd).toBeCloseTo(4.0, 5);
    expect(g.coordination.totalCostUsd).toBeCloseTo(4.0, 5);

    // One delivery run reporting a cost makes the complement observable, and
    // the share comes back — including a real, earned 100%-adjacent figure.
    insertRun(db, { kind: "primary", cost: 1.0 });
    const seen = getInsightsSummary(db, NOW).oversight;
    // Ruling 201: one delivery run reporting is no longer enough — the
    // operator run in this fixture still reports nothing, so there is still no
    // share. Ruling 190 stopped here and printed 0.8.
    expect(seen.coordination.share).toBeNull();
    expect(seen.coordination.uncosted).toEqual({ delivery: 2, coordination: 1 });

    // A delivery run reporting a genuine $0.00 is an observation, not a gap:
    // the complement was seen, it was just free, so 100% is earned and shown.
    const free = ctx.makeDb();
    insertProject(free, "gp");
    insertRun(free, { kind: "controller", cost: 2.0 });
    insertRun(free, { kind: "primary", cost: 0 });
    const g3 = getInsightsSummary(free, NOW).oversight;
    expect(g3.coordination.uncosted).toEqual({ delivery: 0, coordination: 0 });
    expect(g3.coordination.share).toBeCloseTo(1, 5);
  });

  /**
   * Self-review of ruling 190's first draft, which guarded only the delivery
   * side. The mirror is just as reachable — a Codex operator and controller
   * under a Claude delivery fleet — and reads **0%**, which claims coordination
   * is free when it merely never reported. Same defect, opposite sign.
   */
  it("ruling 190: coordination that ran and reported nothing is a gap too, not a free 0%", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertRun(db, { kind: "operator", cost: null });
    insertRun(db, { kind: "controller", cost: null });
    insertRun(db, { kind: "primary", cost: 3.0 });
    insertRun(db, { kind: "reviewer", cost: 1.0 });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: guard only the delivery side and this reads 0 — "coordination
    // costs you nothing", off runs that never reported a figure.
    expect(g.coordination.share).toBeNull();
    expect(g.coordination.uncosted.coordination).toBe(g.coordination.runs.coordination);
    expect(g.coordination.totalCostUsd).toBeCloseTo(4.0, 5);
  });

  it("ruling 190: a side that never RAN contributes a real zero, not a gap", () => {
    // No delivery runs at all is not an unobserved side — this instance really
    // did spend everything it spent on coordination, and 100% is the answer.
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertRun(db, { kind: "controller", cost: 2.0 });
    insertRun(db, { kind: "operator", cost: 1.0 });
    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.coordination.runs.delivery).toBe(0);
    expect(g.coordination.share).toBeCloseTo(1, 5);

    // And the mirror: no coordination runs at all, so 0% is earned.
    const none = ctx.makeDb();
    insertProject(none, "gp");
    insertRun(none, { kind: "primary", cost: 2.0 });
    const g2 = getInsightsSummary(none, NOW).oversight;
    expect(g2.coordination.runs.coordination).toBe(0);
    expect(g2.coordination.share).toBeCloseTo(0, 5);
  });

  /**
   * Ruling 201 (F37-21). Ruling 190 asked whether a side reported ANYTHING and
   * printed a confident percentage the moment it did. Cost is a Claude-only
   * observation — the Codex result envelope carries tokens and no price — so on
   * the live instance 209 of 215 runs reported nothing, and the rule's test was
   * satisfied by the 6 that did. The share is a measurement only when every run
   * on both sides reported one.
   */
  it("ruling 201: a partly-costed instance has no share, and the silent runs are counted and attributed", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // The live shape in miniature: a Codex fleet that never reports, one Claude
    // controller that does, and one Claude deliverer — the single ordinary
    // change that turned ruling 190's honest "n/a" into a confident lie.
    insertRun(db, { kind: "operator", backend: "codex", cost: null });
    insertRun(db, { kind: "operator", backend: "codex", cost: null });
    insertRun(db, { kind: "operator", backend: "codex", cost: null });
    insertRun(db, { kind: "controller", backend: "claude", cost: 12.0 });
    insertRun(db, { kind: "primary", backend: "codex", cost: null });
    insertRun(db, { kind: "reviewer", backend: "codex", cost: null });
    insertRun(db, { kind: "primary", backend: "claude", cost: 36.0 });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: restore ruling 190's test (`costedDelivery === 0 || costedCoord
    // === 0`) and this is 0.25 — "coordination is a quarter of the bill", off
    // one of four coordination runs, with the other three unpriced.
    expect(g.coordination.share).toBeNull();
    expect(g.coordination.coordinationCostUsd).toBeCloseTo(12.0, 5);
    expect(g.coordination.totalCostUsd).toBeCloseTo(48.0, 5);
    expect(g.coordination.runs).toEqual({ delivery: 3, coordination: 4 });
    expect(g.coordination.uncosted).toEqual({ delivery: 2, coordination: 3 });
    // Named, not hedged: the card can say "5 on Codex" because the rows say so.
    expect(g.coordination.uncostedByBackend).toEqual([{ backend: "codex", runs: 5 }]);

    // And the complement: price every run and the share is a real measurement.
    const all = ctx.makeDb();
    insertProject(all, "gp");
    insertRun(all, { kind: "operator", cost: 1.0 });
    insertRun(all, { kind: "primary", cost: 3.0 });
    const g2 = getInsightsSummary(all, NOW).oversight;
    expect(g2.coordination.uncostedByBackend).toEqual([]);
    expect(g2.coordination.share).toBeCloseTo(0.25, 5);
  });

  /**
   * Ruling 201, the other half of the owner's call: suppressing the dollar
   * share leaves the card with nothing to say on an ordinary instance, so it
   * carries the share that CAN be measured. Tokens are the unit both backends
   * report.
   */
  it("ruling 201: the token share is computed over final provider figures, and names the rows it leaves out", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertRun(db, { kind: "operator", backend: "codex", cost: null, inTok: 1000, outTok: 200 });
    insertRun(db, { kind: "controller", backend: "claude", cost: 12.0, inTok: 500, outTok: 100 });
    insertRun(db, { kind: "primary", backend: "codex", cost: null, inTok: 5000, outTok: 1000 });
    insertRun(db, { kind: "reviewer", backend: "codex", cost: null, inTok: 2000, outTok: 200 });
    // F35-1: a live estimate is not a total. Counted as excluded, not summed —
    // on BOTH sides, because the numerator has its own guard and a fixture that
    // only strands a delivery row would let that guard rot untested.
    insertRun(db, {
      kind: "primary",
      backend: "codex",
      cost: null,
      inTok: 900_000,
      outTok: 900_000,
      usageFinal: 0,
    });
    insertRun(db, {
      kind: "operator",
      backend: "codex",
      cost: null,
      inTok: 900_000,
      outTok: 900_000,
      usageFinal: 0,
    });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: drop the `usage_final = 1` guard from `coordination_tokens` and
    // the numerator swallows 1.8M of estimate — a share of 181, printed as
    // "18100%" — while the guarded denominator stays at 10k.
    expect(g.coordination.tokenShare).toBeCloseTo(0.18, 5);
    expect(g.coordination.coordinationTokens).toBe(1800);
    expect(g.coordination.totalTokens).toBe(10_000);
    expect(g.coordination.tokenless).toEqual({ delivery: 1, coordination: 1 });
    // The dollar share is still suppressed on the same data: the two questions
    // are independent, and only one of them has an answer here.
    expect(g.coordination.share).toBeNull();
  });

  it("ruling 201: a side that landed NO provider figure has no token share either", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertRun(db, { kind: "operator", inTok: 1000, outTok: 200 });
    insertRun(db, { kind: "primary", inTok: 5000, outTok: 1000, usageFinal: 0 });
    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: drop the `tokenBlind` test and this reads 1 — "coordination is
    // all of the tokens", which is ruling 190's fake 100% in the other unit.
    expect(g.coordination.tokenShare).toBeNull();
    expect(g.coordination.tokenless).toEqual({ delivery: 1, coordination: 0 });
  });

  it("ruling 143: traceability counts delivered revisions and recorded PRs; an allocated branch alone is not a delivery", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // Traced: a delivered revision with branch + PR both recorded.
    insertTask(db, { key: "VIB-1", branch: "vib-1", prJson: '{"number":9}', revisionSha: "a".repeat(40) });
    // Delivered but NOT traced: a work revision that never reached a PR. It
    // STAYS in the denominator on purpose — an unpushed delivery is exactly
    // the untraceable one the metric exists to find.
    insertTask(db, { key: "VIB-2", branch: "vib-2", revisionSha: "b".repeat(40) });
    // No footprint at all → out of the denominator.
    insertTask(db, { key: "VIB-3" });
    // Branch only. Ruling 122 allocates the name at first dispatch, before an
    // agent has written anything, so this task has delivered nothing (JC-7 in
    // pass 34: "7 of 8 delivered tasks" with this one among the eight).
    // CANARY: put `|| t.branch != null` back in the denominator and it counts
    // (3 delivered, 1 traced).
    insertTask(db, { key: "VIB-4", branch: "vib-4" });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.traceability.deliveredTasks).toBe(2);
    expect(g.traceability.tracedTasks).toBe(1);
    expect(g.traceability.pct).toBeCloseTo(0.5, 5);
    // Ruling 290: and it NAMES the one that cannot be traced. A traceability
    // metric that reports "1 of 2" and will not say which is withholding the
    // only fact a person reads it for. CANARY: return the count alone.
    expect(g.traceability.untraced).toEqual(["gp/VIB-2"]);
  });

  /**
   * Ruling 407 (F39-34), live on ax-clone AX-12.
   *
   * AX-12's deliverable was an upstream-fidelity REPORT, delivered as 20
   * attachments: `noChanges: true`, zero commits, force-accepted, Done. It
   * carries a `workRevision`, so Insights counted it as a delivery, found no
   * PR, and published "18 of 19 delivered tasks carry branch + PR" with AX-12
   * named as the one that does not -- a shortfall that can never be closed,
   * because nothing about a finished task moves again.
   *
   * Ruling 391 settled that a report is delivered work; ruling 401 dropped the
   * same task's "behind main" pill for the same reason, on the same predicate.
   * This is that predicate, in the surface that still demanded a PR.
   */
  it("ruling 407: a delivery that was never commit-shaped is not an untraced one", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertTask(db, { key: "VIB-1", branch: "vib-1", prJson: '{"number":9}', revisionSha: "a".repeat(40) });
    // AX-12's shape: done, a revision on the record, no PR, no commits.
    insertTask(db, {
      key: "VIB-2",
      stage: "done",
      branch: "vib-2",
      revisionSha: "b".repeat(40),
      githubJson: JSON.stringify({ commits: [] }),
    });

    const g = getInsightsSummary(db, NOW).oversight;
    // CANARY: drop `&& !commitless(t)` and this reads 1 of 2, 50%, naming
    // gp/VIB-2 -- which is AX-12's row on the live page, verbatim.
    expect(g.traceability.deliveredTasks).toBe(1);
    expect(g.traceability.tracedTasks).toBe(1);
    expect(g.traceability.pct).toBe(1);
    expect(g.traceability.untraced).toEqual([]);
  });

  it("ruling 407: a task that DID commit and never opened a PR is still untraced", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // Same terminal stage, same missing PR -- but it committed, so the demand
    // for a pull request is one somebody could have met.
    insertTask(db, {
      key: "VIB-2",
      stage: "done",
      branch: "vib-2",
      revisionSha: "b".repeat(40),
      githubJson: JSON.stringify({ commits: [{ sha: "c".repeat(7) }] }),
    });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.traceability.deliveredTasks).toBe(1);
    expect(g.traceability.untraced).toEqual(["gp/VIB-2"]);
  });

  /**
   * Ruling 290 (pass 37, F37-125). Three cards on /insights counted EXCEPTIONS
   * — untraceable work, work with no next actor, records past the readability
   * guardrail — and named none of them. Live this pass the page read "41 of 42
   * delivered tasks carry branch + PR" with no way to reach the 1. Ruling 253
   * settled the same shape for a knowledge base ("an agent cannot ask for a
   * rule it cannot name"); this is that rule with a person reading it.
   */
  it("ruling 290: the clarity and long-timeline cards name their exceptions too, and cap honestly", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // No owner and nothing waited on → no definite next actor.
    insertTask(db, { key: "VIB-9", waiting: "none" });
    // Owned, so it IS clear and must not be named.
    insertTask(db, { key: "VIB-10", waiting: "none", owner: "u_1" });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.clarity.unclear).toEqual(["gp/VIB-9"]);
    expect(g.clarity.clearTasks).toBe(1);
    // A card that names everything it counts reports no remainder.
    expect(g.clarity.activeTasks - g.clarity.clearTasks - g.clarity.unclear.length).toBe(0);
  });

  it("ruling 290: past the cap the names stop and the count does not", () => {
    // The cap is what stops one card becoming a wall on a drifted instance;
    // the remainder is what stops the capped list reading as the whole set.
    // CANARY: drop the `.slice` in `namedKeys` and the first assertion fails;
    // drop the remainder arithmetic on the card and a reader sees 8 of 12.
    const db = ctx.makeDb();
    insertProject(db, "gp");
    for (let i = 0; i < INSIGHTS_NAMED_EXCEPTIONS + 4; i += 1) {
      insertTask(db, { key: `VIB-${100 + i}`, waiting: "none" });
    }
    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.clarity.unclear).toHaveLength(INSIGHTS_NAMED_EXCEPTIONS);
    expect(g.clarity.activeTasks).toBe(INSIGHTS_NAMED_EXCEPTIONS + 4);
    expect(g.clarity.clearTasks).toBe(0);
  });

  it("pairs packet-opened with the task's next packet-resolved; unresolved packets count as open, not as zero", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // A resolved packet: opened 10:00 → resolved 10:10 = 600s.
    insertTask(db, { key: "VIB-1" });
    insertAudit(db, { task: "VIB-1", action: "task.operator.packet_opened", at: "2026-08-22T10:00:00.000Z" });
    insertAudit(db, { task: "VIB-1", action: "task.packet.resolved", at: "2026-08-22T10:10:00.000Z" });
    // A still-open packet on a live task.
    insertTask(db, { key: "VIB-2", packetJson: '{"id":"pkt_x"}' });
    insertAudit(db, { task: "VIB-2", action: "task.agent.packet_opened", at: "2026-08-23T09:00:00.000Z" });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.packetResolution.resolved).toBe(1);
    expect(g.packetResolution.avgMs).toBe(600_000);
    expect(g.packetResolution.medianMs).toBe(600_000);
    expect(g.packetResolution.openNow).toBe(1);
  });

  it("measures created → first transition into the project's REVIEW-role stage", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertTask(db, { key: "VIB-1", createdAt: "2026-08-22T10:00:00.000Z" });
    // Into impl (not review) — ignored; into review at +2h — counted; the later
    // re-entry is ignored (FIRST transition wins).
    insertAudit(db, { task: "VIB-1", action: "task.transition", at: "2026-08-22T10:30:00.000Z", details: { from: "triage", to: "impl" } });
    insertAudit(db, { task: "VIB-1", action: "task.transition", at: "2026-08-22T12:00:00.000Z", details: { from: "impl", to: "review" } });
    insertAudit(db, { task: "VIB-1", action: "task.transition", at: "2026-08-22T15:00:00.000Z", details: { from: "impl", to: "review" } });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.timeToReview.tasks).toBe(1);
    expect(g.timeToReview.medianMs).toBe(2 * 60 * 60 * 1000);
  });

  /**
   * The boundary belongs to `compactTimelineEvents`, which opens with
   * `if (events.length <= options.threshold) return events`. A task sitting
   * exactly ON the threshold is therefore never folded, so counting it as one
   * "past their project's compression threshold" names a task the machinery is
   * not managing. Asserted against the real rule rather than restated, so the
   * two cannot drift apart again.
   */
  it("counts long timelines PAST the threshold, on the same boundary compaction uses", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertProject(db, "other");
    insertTask(db, { key: "VIB-1", eventCount: 40 }); // AT threshold → not folded
    insertTask(db, { key: "VIB-2", eventCount: 41 }); // past it → folded
    insertTask(db, { project: "other", key: "OT-1", eventCount: 99, waiting: "agent" });

    // The rule itself, on the same two lengths.
    const ev = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        occurredAt: `2026-08-22T10:00:${String(i).padStart(2, "0")}.000Z`,
        type: "comment" as const,
        actor: { kind: "operator" as const },
        title: null,
        text: `routine ${i}`,
        toAgent: false,
        evidence: null,
      }));
    const opts = { threshold: 40, keepRecent: 4 };
    expect(compactTimelineEvents(ev(40), opts)).toHaveLength(40); // untouched
    expect(compactTimelineEvents(ev(41), opts).length).toBeLessThan(41);

    const all = getInsightsSummary(db, NOW).oversight;
    expect(all.longTimelines).toBe(2);
    const scoped = getInsightsSummary(db, NOW, { projectSlug: "gp" }).oversight;
    expect(scoped.longTimelines).toBe(1);
    expect(scoped.clarity.activeTasks).toBe(2);
  });

  /**
   * `compression-threshold` is a PER-PROJECT guardrail with a configurable
   * value that can also be switched off. A hard-coded 40 counted a task in a
   * project that compacts at 10 as short, and every task in a project that
   * compacts nothing at all as one "the readability machinery is actively
   * managing" — a card contradicting the machinery it describes.
   */
  it("counts long timelines against each project's own threshold, and not at all where the guardrail is off", () => {
    const db = ctx.makeDb();
    insertProject(db, "tight", [
      { id: "compression-threshold", desc: "", on: true, value: 10, unit: "events" },
    ]);
    insertProject(db, "off", [
      { id: "compression-threshold", desc: "", on: false, value: 40, unit: "events" },
    ]);
    // Actively compacted in `tight` (25 > 10) — invisible against a flat 40.
    insertTask(db, { project: "tight", key: "TI-1", eventCount: 25 });
    // Nothing compacts these: the project has the guardrail off.
    insertTask(db, { project: "off", key: "OF-1", eventCount: 45 });
    insertTask(db, { project: "off", key: "OF-2", eventCount: 99 });

    expect(getInsightsSummary(db, NOW).oversight.longTimelines).toBe(1);
    expect(
      getInsightsSummary(db, NOW, { projectSlug: "tight" }).oversight.longTimelines,
    ).toBe(1);
    expect(
      getInsightsSummary(db, NOW, { projectSlug: "off" }).oversight.longTimelines,
    ).toBe(0);
  });
});

describe("backend quota readings (pass 29)", () => {
  it("returns null readings until a backend reports, then the latest reading round-trips", async () => {
    const db = ctx.makeDb();
    const { recordBackendRateLimit } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const before = getInsightsSummary(db, NOW).backendQuota;
    expect(before).toEqual([
      { backend: "claude", reading: null, credentialRefused: null, exhausted: null },
      { backend: "codex", reading: null, credentialRefused: null, exhausted: null },
    ]);

    recordBackendRateLimit(db, "claude", {
      credentialUserId: null,
      credentialLabel: null,
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: 1_787_832_000,
      isUsingOverage: false,
      observedAt: "2026-08-23T11:00:00.000Z",
    });
    // A later reading REPLACES the earlier one — latest wins.
    recordBackendRateLimit(db, "claude", {
      credentialUserId: null,
      credentialLabel: null,
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.92,
      resetsAt: 1_787_832_000,
      isUsingOverage: false,
      observedAt: "2026-08-23T11:30:00.000Z",
    });

    const after = getInsightsSummary(db, NOW).backendQuota;
    const claude = after.find((q) => q.backend === "claude")!;
    expect(claude.reading?.utilization).toBeCloseTo(0.92, 5);
    expect(claude.reading?.observedAt).toBe("2026-08-23T11:30:00.000Z");
    expect(after.find((q) => q.backend === "codex")!.reading).toBeNull();
  });
});

/**
 * Ruling 395 (F39-22) — a figure the provider never reports, printed as a
 * measured zero, on the page built to judge the prompt-cache work.
 *
 * Live on the ax-clone instance the Prompt cache table read, for 21 Codex
 * specialist runs: `WRITTEN 0 · READ 45.0M · WRITE/READ 0.000`. Codex declares
 * `cache_write_input_tokens` in the SDK's own types and returned exactly 0 for
 * it in 101 of 101 usage envelopes, against 67.2M tokens reported read. A
 * reader checking whether rulings 369-376 do anything on Codex would take
 * `0.000` for an answer.
 *
 * Every neighbouring column on that page already refuses to do this: the cost
 * breakdowns print "not reported" rather than $0.00, the quota panel prints
 * "no reading yet", the lifetime column prints "not reported", and the panel's
 * own docstring says "a rate with no first call behind it prints n/a, never
 * 0%".
 */
describe("ruling 395: a backend that reports no cache write reports no cache write", () => {
  it("prints nothing rather than zero for an all-Codex group, and keeps the ratio out", () => {
    const db = ctx.makeDb();
    // 21 Codex runs, millions read, and the provider's flat zero written.
    for (let i = 0; i < 3; i++) {
      insertRun(db, {
        kind: "primary",
        backend: "codex",
        model: "gpt-5.6-luna",
        inTok: 2_000_000,
        cachedTok: 1_800_000,
        cacheWrite: 0,
      });
    }
    const s = getInsightsSummary(db, NOW);
    const primary = s.cache.byKind.find((r) => r.label === "primary")!;
    expect(primary.readTokens).toBe(5_400_000);
    // CANARY: fall back to `r.write_tokens ?? 0` and this is 0 with a 0.000
    // ratio beside 5.4M read, which is the live defect verbatim.
    expect(primary.writeTokens).toBeNull();
    expect(primary.writeReadRatio).toBeNull();
    expect(primary.writeReportingRuns).toBe(0);
  });

  it("reports the figure when a Claude run is in the group, and says how many report it", () => {
    const db = ctx.makeDb();
    insertRun(db, { kind: "primary", backend: "codex", cachedTok: 1_000_000, cacheWrite: 0 });
    insertRun(db, { kind: "primary", backend: "claude", cachedTok: 1_000_000, cacheWrite: 400_000 });
    const s = getInsightsSummary(db, NOW);
    const primary = s.cache.byKind.find((r) => r.label === "primary")!;
    expect(primary.writeTokens).toBe(400_000);
    expect(primary.writeReportingRuns).toBe(1);
    expect(primary.writeReadRatio).toBeCloseTo(0.2, 5);
  });

  it("keeps a genuine zero from a reporting backend as a zero", () => {
    // Claude answers the question and the answer is none: that IS a
    // measurement, and this ruling must not swallow it.
    const db = ctx.makeDb();
    insertRun(db, { kind: "primary", backend: "claude", cachedTok: 1_000_000, cacheWrite: 0 });
    const s = getInsightsSummary(db, NOW);
    const primary = s.cache.byKind.find((r) => r.label === "primary")!;
    expect(primary.writeTokens).toBe(0);
    expect(primary.writeReadRatio).toBe(0);
  });
});
