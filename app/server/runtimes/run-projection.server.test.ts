import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { insertRunLine, upsertRun, type InsertRunInput } from "./run-store.server";
import {
  RUN_LOG_WINDOW_BYTES,
  RUN_LOG_WINDOW_LINES,
  projectRunsForTask,
} from "./run-projection.server";

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
    insert({
      id: "run_q",
      threadId: "primary",
      kind: "primary",
      backend: "codex",
      state: "error",
      // Ruling 127: a run that actually spawned billed somebody, so the retry
      // offer is about THAT person's other account.
      credentialUserId: "u_owner",
    });
    insertRunLine(db, {
      runId: "run_q",
      seq: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", text: "You've hit your usage limit. Try again later." }),
      display: { t: "00:00:00", ev: "err", tag: "error", text: "usage limit" },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBe("claude"); // codex failed → offer claude
  });

  it("flags an R7-2 fail-fast 'unavailable' run via its structured tag (D4 retry)", () => {
    // The no-credential fail-fast (failRunUnavailable) emits an err line tagged
    // `run·unavailable` whose prose matches none of the quota/rate-limit
    // signatures. The projection must key off the tag so the "retry on the
    // other backend" affordance still renders.
    //
    // Ruling 127: this is the refusal the other backend CAN fix — the task's
    // owner is known (the row records whose account it would have billed) and
    // has simply not connected Claude.
    const refusal =
      "Claude isn't connected for Ada Lovelace (ada@viberr.dev), the task owner. " +
      "Runs on this task use the owner's accounts; they can connect Claude on " +
      "Profile → Agent accounts. No agent process was started.";
    insert({
      id: "run_u",
      threadId: "primary",
      kind: "primary",
      backend: "claude",
      state: "error",
      credentialUserId: "u_owner",
    });
    insertRunLine(db, {
      runId: "run_u",
      seq: 0,
      occurredAt: "2026-07-16T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", source: "viberr", message: refusal }),
      display: { t: "00:00:00", ev: "err", tag: "run·unavailable", text: refusal },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBe("codex"); // claude failed → offer codex
  });

  it("withholds the retry offer when NO principal was resolvable (ruling 127)", () => {
    // An unowned task (or one whose owner account is gone) has nobody to bill
    // on EITHER backend, and the run service records that as a null
    // `credential_user_id`. Offering "Retry on Codex" here would promise a
    // second identical refusal; the run still reports its failure, and the way
    // out is a human taking the task, which the run's own line says.
    const refusal =
      "Claude runs on VIB-1 need a task owner: agent runs use the owner's accounts " +
      "and this task has none. Own the task (Assign me) and run the agent again. " +
      "No agent process was started.";
    insert({
      id: "run_n",
      threadId: "primary",
      kind: "primary",
      backend: "claude",
      state: "error",
      credentialUserId: null,
    });
    insertRunLine(db, {
      runId: "run_n",
      seq: 0,
      occurredAt: "2026-07-16T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", source: "viberr", message: refusal }),
      display: { t: "00:00:00", ev: "err", tag: "run·unavailable", text: refusal },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.state).toBe("error");
    // The FAILURE is still reported — it is a true statement about the run, and
    // the console's footer selects its failure sentence from it. Only the
    // ALTERNATIVE is withheld: with no `altBackend` the panel states what
    // happened and offers no retry.
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBeUndefined();
  });

  it("does NOT flag a genuine task failure as backend-unavailable", () => {
    insert({ id: "run_f", threadId: "primary", kind: "primary", backend: "codex", state: "error" });
    insertRunLine(db, {
      runId: "run_f",
      seq: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      raw: JSON.stringify({ type: "error", text: "TypeError: cannot read property of undefined" }),
      display: { t: "00:00:00", ev: "err", tag: "error", text: "task error" },
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
      display: { t: "00:00:00", ev: "text", tag: "assistant", text: "first answer" },
    });
    insert({ id: "run_2", threadId: "primary-b", kind: "primary", backend: "claude", state: "finished" });
    insertRunLine(db, {
      runId: "run_2",
      seq: 0,
      occurredAt: "2026-07-11T00:01:00.000Z",
      raw: "{}",
      display: { t: "00:01:00", ev: "text", tag: "assistant", text: "second answer" },
    });

    const [view] = projectRunsForTask(db, SLUG, TASK);
    const texts = view!.lines.map((l) => l.text);
    // Before this fix the console showed ONLY the representative run, so an
    // agent that had answered twice looked like it had answered once and the
    // earlier evidence was unreachable from the UI.
    expect(texts).toContain("first answer");
    expect(texts).toContain("second answer");
    expect(texts.some((t) => t.includes("resumed · run 2 of 2"))).toBe(true);
    // Small history → the whole thing fits; nothing to page.
    expect(view!.logWindow.hasMore).toBe(false);
    expect(view!.logWindow.oldest).toBeNull();
    expect(view!.logWindow.runIds).toEqual(["run_1", "run_2"]);
  });
});

/* ---------------- bounded run-log window (P13-D-11 / NFR5) ---------------- */

describe("projectRunsForTask — bounded log window", () => {
  /** `count` console lines on `runId`, each ~`bytes` of raw envelope. */
  function fill(runId: string, count: number, bytes = 40): void {
    const filler = "x".repeat(Math.max(bytes, 1));
    for (let i = 0; i < count; i++) {
      insertRunLine(db, {
        runId,
        seq: i,
        occurredAt: "2026-07-24T00:00:00.000Z",
        raw: JSON.stringify({ i, filler }),
        display: { t: "00:00:00", ev: "out", tag: "tool_result", text: `line ${i}` },
      });
    }
  }

  const textsOf = (lines: LogLine[]) => lines.map((l) => l.text);

  it("ships the NEWEST lines only, and reports what it withheld", () => {
    insert({ id: "run_big", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    const total = RUN_LOG_WINDOW_LINES + 25;
    fill("run_big", total);

    const [view] = projectRunsForTask(db, SLUG, TASK);
    // BEFORE: `listRunLines` had no LIMIT, so the loader shipped all of it on
    // every SSE revalidation (measured: ~928 KB for one task).
    expect(view!.lines.length).toBe(RUN_LOG_WINDOW_LINES);
    const texts = textsOf(view!.lines);
    // The TAIL survives — that is what anyone is reading.
    expect(texts[texts.length - 1]).toBe(`line ${total - 1}`);
    expect(texts[0]).toBe(`line ${total - RUN_LOG_WINDOW_LINES}`);
    // …and `raw` stays index-aligned with `lines` (the `{ } raw` toggle).
    expect(view!.raw.length).toBe(view!.lines.length);

    // Honest markers: the count is of lines that EXIST, plus a backward cursor.
    expect(view!.lineCount).toBe(total);
    expect(view!.logWindow.totalLines).toBe(total);
    expect(view!.logWindow.hasMore).toBe(true);
    expect(view!.logWindow.oldest).toEqual({
      runId: "run_big",
      seq: total - RUN_LOG_WINDOW_LINES,
    });
    expect(view!.logWindow.headSeq).toBe(total - 1);
  });

  it("bounds by BYTES too — a few huge tool outputs cannot blow the payload", () => {
    insert({ id: "run_fat", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    // 30 lines × 32 KB = ~960 KB: far under the line cap, far over the byte cap.
    fill("run_fat", 30, 32 * 1024);

    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.lines.length).toBeLessThan(30);
    const bytes = view!.raw.reduce((sum, r) => sum + r.length, 0);
    expect(bytes).toBeLessThanOrEqual(RUN_LOG_WINDOW_BYTES);
    expect(view!.logWindow.hasMore).toBe(true);
    // Still the newest ones.
    expect(textsOf(view!.lines).at(-1)).toBe("line 29");
  });

  it("PAGINATES the agent's whole history rather than truncating it (UI-53)", () => {
    // Three resume runs; the window is filled newest-first, so the oldest run
    // falls entirely outside it — but its id is still listed so the console can
    // page back into it.
    insert({ id: "run_a", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    insert({ id: "run_b", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev" });
    insert({ id: "run_c", threadId: "primary-r2", agentName: "dev", agentProfileId: "dev" });
    fill("run_a", 100);
    fill("run_b", 100);
    fill("run_c", RUN_LOG_WINDOW_LINES - 50);

    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.logWindow.totalLines).toBe(200 + RUN_LOG_WINDOW_LINES - 50);
    expect(view!.logWindow.runIds).toEqual(["run_a", "run_b", "run_c"]);
    expect(view!.logWindow.hasMore).toBe(true);
    // run_c (newest) is whole, run_b is partial, run_a did not fit at all.
    expect(view!.logWindow.oldest!.runId).toBe("run_b");
    expect(view!.logWindow.oldest!.seq).toBeGreaterThan(0);
    // The resume boundary still labels the run by its position in the WHOLE
    // history ("run 3 of 3"), not by its position in the window.
    const texts = textsOf(view!.lines);
    expect(texts.some((t) => t.includes("resumed · run 3 of 3"))).toBe(true);
    expect(texts.some((t) => t.includes("resumed · run 2 of 3"))).toBe(false);
    // headSeq is the REPRESENTATIVE run's head — not `lines.length - 1`, which
    // has been wrong since the console started concatenating runs.
    expect(view!.logWindow.headSeq).toBe(RUN_LOG_WINDOW_LINES - 51);
  });

  it("keeps the newest line even when it alone busts the byte budget", () => {
    insert({ id: "run_huge", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    fill("run_huge", 1, RUN_LOG_WINDOW_BYTES * 2);
    const [view] = projectRunsForTask(db, SLUG, TASK);
    // An empty console is a worse answer than an oversized one.
    expect(view!.lines.length).toBe(1);
    expect(view!.logWindow.hasMore).toBe(false);
  });

  it("a freshly-queued newest run does not blank the console", () => {
    // The common shape the moment an agent is re-engaged: history on the older
    // run, nothing on the new one yet. A newest-first walk that STOPPED on the
    // empty run would ship an empty console over a 40-line history.
    insert({ id: "run_old", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    insert({ id: "run_new", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev", state: "running" });
    fill("run_old", 40);

    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.lines.length).toBe(40);
    expect(textsOf(view!.lines)[0]).toBe("line 0");
    expect(view!.logWindow.hasMore).toBe(false);
    // The representative is the RUNNING run, which has no lines yet.
    expect(view!.serverRunId).toBe("run_new");
    expect(view!.logWindow.headSeq).toBe(-1);
  });

  it("reports an empty window for a run with no lines", () => {
    insert({ id: "run_none", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.lines).toEqual([]);
    expect(view!.logWindow).toMatchObject({
      totalLines: 0,
      hasMore: false,
      oldest: null,
      headSeq: -1,
    });
  });
});
