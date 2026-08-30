import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Guardrail } from "~/schemas/project-file.schema";
import { createTestDbContext } from "../../../test-support/test-db";
import { getInsightsSummary } from "./insights-query.server";

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
  },
) {
  seq += 1;
  db.prepare(
    `INSERT INTO agent_runs
       (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
        started_at, finished_at, turns, input_tokens, cached_input_tokens,
        output_tokens, total_cost_usd, created_at, updated_at, agent_profile_id)
     VALUES (?, ?, ?, ?, 'Dev', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'developer')`,
  ).run(
    `run_${seq}`,
    `VIB-${seq}`,
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
    r.cost ?? null,
  );
}

const NOW = "2026-08-23T12:00:00.000Z";

describe("getInsightsSummary", () => {
  it("sums totals and counts outcomes with a success rate", () => {
    const db = ctx.makeDb();
    insertRun(db, { state: "finished", cost: 0.1, outTok: 100, inTok: 50, turns: 2 });
    insertRun(db, { state: "finished", cost: 0.2, outTok: 200, inTok: 60, turns: 3 });
    insertRun(db, { state: "error", cost: 0.05, outTok: 10 });
    insertRun(db, { state: "interrupted", cost: null, outTok: 5 });
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
    const claude = s.byBackend.find((r) => r.label === "claude")!;
    expect(claude.runs).toBe(2);
    expect(claude.cost).toBeCloseTo(0.2, 5);
    expect(s.byBackend.find((r) => r.label === "codex")?.runs).toBe(1);
    expect(s.byKind.map((r) => r.label).sort()).toEqual([
      "operator",
      "primary",
      "reviewer",
    ]);
    expect(s.byProject.find((r) => r.label === "p2")?.cost).toBeCloseTo(0.3, 5);
    expect(s.byModel.find((r) => r.label === "gpt-5")?.runs).toBe(1);
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
    expect(s.byModel).toHaveLength(8);
    // The expensive outlier is present (a run-first order would have dropped it).
    expect(s.byModel[0]?.label).toBe("pricey-xl");
    expect(s.byModel.some((r) => r.label === "pricey-xl")).toBe(true);
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
    const busiest = s.byModel.find((r) => r.label === "gpt-5");
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
  { id: "triage", name: "Triage", color: "#aaa" },
  { id: "impl", name: "In Progress", color: "#bbb" },
  { id: "review", name: "Review", color: "#ccc" },
  { id: "done", name: "Done", color: "#ddd" },
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
    packetJson?: string | null;
    eventCount?: number;
    createdAt?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO task_projections
       (project_slug, task_key, title, stage, readiness, waiting, urgent,
        archived, validation, owner_user_id, branch, pr_json,
        work_revision_sha, packet_json, event_count, created_at,
        source_path, content_hash, parsed_at)
     VALUES (?, ?, ?, ?, 'ready', ?, 0, ?, 'none', ?, ?, ?, ?, ?, ?, ?,
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

  it("computes key↔branch↔PR traceability over tasks with a delivery footprint", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    // Traced: branch + PR both recorded.
    insertTask(db, { key: "VIB-1", branch: "vib-1", prJson: '{"number":9}', revisionSha: "a".repeat(40) });
    // Delivered but NOT traced: a branch with no PR.
    insertTask(db, { key: "VIB-2", branch: "vib-2" });
    // No footprint at all → out of the denominator.
    insertTask(db, { key: "VIB-3" });

    const g = getInsightsSummary(db, NOW).oversight;
    expect(g.traceability.deliveredTasks).toBe(2);
    expect(g.traceability.tracedTasks).toBe(1);
    expect(g.traceability.pct).toBeCloseTo(0.5, 5);
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

  it("counts long timelines at the compression threshold and scopes everything by project", () => {
    const db = ctx.makeDb();
    insertProject(db, "gp");
    insertProject(db, "other");
    insertTask(db, { key: "VIB-1", eventCount: 40 }); // at threshold → long
    insertTask(db, { key: "VIB-2", eventCount: 39 });
    insertTask(db, { project: "other", key: "OT-1", eventCount: 99, waiting: "agent" });

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
    // Actively compacted in `tight` (25 >= 10) — invisible against a flat 40.
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
      { backend: "claude", reading: null },
      { backend: "codex", reading: null },
    ]);

    recordBackendRateLimit(db, "claude", {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: 1_787_832_000,
      isUsingOverage: false,
      observedAt: "2026-08-23T11:00:00.000Z",
    });
    // A later reading REPLACES the earlier one — latest wins.
    recordBackendRateLimit(db, "claude", {
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
