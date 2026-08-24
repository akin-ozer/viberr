import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
