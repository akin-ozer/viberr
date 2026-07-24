import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { insertRunLine, upsertRun, type InsertRunInput } from "./run-store.server";
import { projectRunsForTask } from "./run-projection.server";

/**
 * Run projection GROUPING (BUG 2): one Agent-logs entry PER AGENT, not per run
 * row. Every resume mints a new run row (fresh thread id, shared session), so
 * grouping collapses an agent's runs into a single entry labeled by the agent's
 * own NAME. The representative run is the running one (if any), else the newest.
 */

let ctx: TestDbContext;
let db: import("node:sqlite").DatabaseSync;

const SLUG = "viberr-core";
const TASK = "VIB-1";

beforeEach(() => {
  ctx = createTestDbContext();
  db = ctx.makeDb();
});

afterEach(() => ctx.cleanup());

let seq = 0;
function insert(patch: Partial<InsertRunInput>): void {
  seq += 1;
  upsertRun(db, {
    id: patch.id ?? `run_${seq}`,
    projectSlug: SLUG,
    taskKey: TASK,
    threadId: patch.threadId ?? `t${seq}`,
    role: "Primary specialist",
    kind: "primary",
    backend: "claude",
    model: "claude-sonnet-4-5",
    sdk: "Claude Agent SDK",
    state: "finished",
    ...patch,
    agentProfileId:
      patch.agentProfileId ?? (patch.kind === "operator" ? "operator" : "developer"),
  });
}

describe("projectRunsForTask grouping", () => {
  it("collapses 3 runs of one specialist + 1 operator into 2 grouped RunViews", () => {
    // Operator (its own group).
    insert({
      id: "run_op",
      threadId: "op",
      kind: "operator",
      role: "Operator",
      agentName: "Operator",
      agentProfileId: "operator",
      state: "finished",
    });
    // Three runs of the SAME specialist "dev" (resumes → new rows).
    insert({ id: "run_d1", threadId: "primary", agentName: "dev", agentProfileId: "dev", state: "finished" });
    insert({ id: "run_d2", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev", state: "finished" });
    insert({ id: "run_d3", threadId: "primary-r2", agentName: "dev", agentProfileId: "dev", state: "running" });

    const views = projectRunsForTask(db, SLUG, TASK);

    // Exactly 2 grouped entries: the operator + the single "dev" specialist.
    expect(views.length).toBe(2);
    const [op, dev] = views;
    expect(op!.op).toBe(true);
    expect(op!.who.name).toBe("Operator");

    // The "dev" group is labeled by the agent's NAME (not the backend name).
    expect(dev!.who.name).toBe("dev");
    // Representative = the RUNNING run (run_d3), so the live strip keeps working.
    expect(dev!.serverRunId).toBe("run_d3");
    expect(dev!.id).toBe("primary-r2");
    expect(dev!.state).toBe("running");
  });

  it("picks the most-recently-created run as representative when none is running", () => {
    insert({ id: "run_a", threadId: "primary", agentName: "dev", agentProfileId: "dev", state: "finished" });
    insert({ id: "run_b", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev", state: "interrupted" });
    insert({ id: "run_c", threadId: "primary-r2", agentName: "dev", agentProfileId: "dev", state: "finished" });

    const views = projectRunsForTask(db, SLUG, TASK);
    expect(views.length).toBe(1);
    // Newest by created_at / rowid is run_c.
    expect(views[0]!.serverRunId).toBe("run_c");
    expect(views[0]!.id).toBe("primary-r2");
  });

  it("groups distinct agents separately and keeps three entries (op + primary + reviewer)", () => {
    insert({ id: "run_op", threadId: "op", kind: "operator", role: "Operator", agentName: "Operator", agentProfileId: "operator" });
    insert({ id: "run_p", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    insert({
      id: "run_c",
      threadId: "c0",
      kind: "reviewer",
      role: "Reviewer",
      backend: "codex",
      agentName: "reviewer",
      agentProfileId: "reviewer",
    });

    const views = projectRunsForTask(db, SLUG, TASK);
    expect(views.map((v) => v.who.name)).toEqual(["Operator", "dev", "reviewer"]);
    // Order preserved by first-seen (created_at ASC).
    expect(views.map((v) => v.id)).toEqual(["op", "primary", "c0"]);
  });

  it("groups null-identity runs of the same role together (seed op/primary/c0 shape)", () => {
    // Legacy rows with NO identity still collapse per role (kind:role key).
    insert({ id: "run_p1", threadId: "primary", role: "Primary specialist", state: "finished" });
    insert({ id: "run_p2", threadId: "primary-r1", role: "Primary specialist", state: "running" });
    const views = projectRunsForTask(db, SLUG, TASK);
    expect(views.length).toBe(1);
    expect(views[0]!.serverRunId).toBe("run_p2"); // the running one
  });

  it("flags a backend-availability failure so the UI can retry on the other backend (D4)", () => {
    insert({ id: "run_q", threadId: "primary", kind: "primary", backend: "codex", state: "error" });
    insertRunLine(db, {
      runId: "run_q",
      seq: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", text: "You've hit your usage limit. Try again later." }),
      display: { kind: "error", text: "usage limit" } as never,
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBe("claude"); // codex failed → offer claude
  });

  it("flags an R7-2 fail-fast 'unavailable' run via its structured tag (D4 retry)", () => {
    // The no-credential fail-fast (failRunUnavailable) emits an err line tagged
    // `run·unavailable` whose prose ("…is unavailable — no usable credential…")
    // matches none of the quota/rate-limit signatures. The projection must key
    // off the tag so the "retry on the other backend" affordance still renders.
    insert({ id: "run_u", threadId: "primary", kind: "primary", backend: "claude", state: "error" });
    insertRunLine(db, {
      runId: "run_u",
      seq: 0,
      occurredAt: "2026-07-16T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", source: "viberr", message: "Claude Code is unavailable — no usable credential is configured." }),
      display: { t: "00:00:00", ev: "err", tag: "run·unavailable", text: "Claude Code is unavailable — no usable credential is configured." } as never,
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBe("codex"); // claude failed → offer codex
  });

  it("does NOT flag a genuine task failure as backend-unavailable", () => {
    insert({ id: "run_f", threadId: "primary", kind: "primary", backend: "codex", state: "error" });
    insertRunLine(db, {
      runId: "run_f",
      seq: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", text: "TypeError: cannot read property of undefined" }),
      display: { kind: "error", text: "task error" } as never,
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failedBackendUnavailable).toBeUndefined();
  });
});

/* ------------- resumed history stays visible (P13-UI-53) ------------- */

describe("projectRunsForTask — resumed history", () => {
  it("keeps every run's lines, with an explicit resume boundary", () => {
    insert({ id: "run_1", threadId: "primary-a", kind: "primary", backend: "claude", state: "finished" });
    insertRunLine(db, {
      runId: "run_1",
      seq: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      raw: "{}",
      display: { t: "00:00:00", ev: "text", tag: "assistant", text: "first answer" } as never,
    });
    insert({ id: "run_2", threadId: "primary-b", kind: "primary", backend: "claude", state: "finished" });
    insertRunLine(db, {
      runId: "run_2",
      seq: 0,
      occurredAt: "2026-07-11T00:01:00.000Z",
      raw: "{}",
      display: { t: "00:01:00", ev: "text", tag: "assistant", text: "second answer" } as never,
    });

    const [view] = projectRunsForTask(db, SLUG, TASK);
    const texts = view!.lines.map((l) => (l as unknown as { text: string }).text);
    // Before this fix the console showed ONLY the representative run, so an
    // agent that had answered twice looked like it had answered once and the
    // earlier evidence was unreachable from the UI.
    expect(texts).toContain("first answer");
    expect(texts).toContain("second answer");
    expect(texts.some((t) => t.includes("resumed · run 2 of 2"))).toBe(true);
  });
});
