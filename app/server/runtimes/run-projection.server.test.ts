import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { insertRunLine, patchRun, upsertRun, type InsertRunInput } from "./run-store.server";
import {
  RUN_LOG_WINDOW_BYTES,
  RUN_LOG_WINDOW_LINES,
  projectRunsForTask,
  runLogWindowFor,
} from "./run-projection.server";
import { getRun } from "./run-store.server";
import { runStatePill } from "~/features/runtime/runs-helpers";

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

  it("a CLASSIFIED failure is not overridden by quota words in its own log tail", () => {
    // The raw prose scan is documented as a fallback for lines written before
    // the failure class existed, but it was an `||` arm, so it also fired for
    // runs that WERE classified — as something else. A hung or turn-capped run
    // whose console merely mentions "rate limit"/"429"/"quota" (an agent
    // quoting an API error it already handled) was then reported as a
    // backend-availability failure and offered a retry on the other backend,
    // which fixes nothing and hides the real cause.
    // Canary: put `isBackendUnavailableError(raw)` back as an `||` arm.
    insert({
      id: "run_c",
      threadId: "primary",
      kind: "primary",
      backend: "claude",
      state: "error",
    });
    insertRunLine(db, {
      runId: "run_c",
      seq: 0,
      occurredAt: "2026-07-12T00:00:00.000Z",
      raw: JSON.stringify({
        type: "error",
        text: "the upstream API answered 429 rate limit; retried and continued",
      }),
      display: {
        t: "00:00:00",
        ev: "err",
        tag: "run·max_turns",
        text: "the run exceeded its turn cap",
        failure: {
          kind: "max_turns",
          resetsAt: null,
          window: null,
          windowRejected: false,
          apiError: null,
          apiErrorStatus: null,
          terminalReason: null,
          origin: null,
        },
      },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.state).toBe("error");
    expect(
      view!.failedBackendUnavailable,
      "the classification decides, not words in the log",
    ).toBeUndefined();
  });

  it("a CLASSIFIED provider overload (Agent SDK 0.3.261 upgrade) counts as the backend being unavailable, so the other-backend retry is offered", () => {
    // The SDK now ends a run it gave up on after repeated 529s with
    // `api_error_status: 529`, and the adapter classifies that `overloaded`.
    // Because a classified run is decided by its class alone (the test above),
    // the class has to carry the retry offer itself: before it existed the same
    // run classified `unknown` and LOST the offer the raw "overloaded" scan gave
    // an unclassified run. Canary: drop `overloaded` from `classifiedUnavailable`.
    insert({
      id: "run_o",
      threadId: "primary",
      kind: "primary",
      backend: "claude",
      state: "error",
      credentialUserId: "u_owner",
    });
    insertRunLine(db, {
      runId: "run_o",
      seq: 0,
      occurredAt: "2026-09-06T00:00:00.000Z",
      raw: "",
      display: {
        t: "00:00:00",
        ev: "err",
        tag: "run·error·overloaded",
        text: "Claude could not serve this run: the provider was overloaded (HTTP 529). Nothing about the account or the task is wrong; retry in a few minutes.",
        failure: {
          kind: "overloaded",
          resetsAt: null,
          window: null,
          windowRejected: false,
          apiError: null,
          apiErrorStatus: 529,
          terminalReason: "api_error",
          origin: "provider",
        },
      },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.failureKind).toBe("overloaded");
    expect(view!.failedBackendUnavailable).toBe(true);
    expect(view!.altBackend).toBe("codex");
    expect(view!.failureOrigin).toBe("provider");
  });

  it("U35-11: the origin of an overload rides the view (`local` for a connection that failed in this deployment), and only for that kind", () => {
    // Canary: drop the `failureOrigin` assignment in `projectRunsForTask`.
    insert({ id: "run_net", threadId: "primary", kind: "primary", backend: "claude", state: "error", credentialUserId: "u_owner" });
    insertRunLine(db, {
      runId: "run_net", seq: 0, occurredAt: "2026-09-06T21:41:00.000Z", raw: "",
      display: {
        t: "21:41:00", ev: "err", tag: "run·error·overloaded",
        text: "Claude could not be reached from this deployment: the connection failed before the provider answered (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR).",
        failure: { kind: "overloaded", resetsAt: null, window: null, windowRejected: false, apiError: "server_error", apiErrorStatus: null, terminalReason: "api_error", origin: "local" },
      },
    });
    const view = projectRunsForTask(db, SLUG, TASK).find((v) => v.serverRunId === "run_net")!;
    expect(view.failureKind).toBe("overloaded");
    expect(view.failureOrigin).toBe("local");
    expect(view.failedBackendUnavailable, "the retry offer is unchanged").toBe(true);
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

/**
 * F35-1 (pass 35): the strip's Tokens cell tells an estimate from a total. A
 * live Claude row holds the adapter's estimate until the result lands
 * (`usage_final = 0`), a live Codex row holds nothing until its turn ends, and
 * a row the provider has totalled prints plain.
 */
describe("F35-1: tokens are marked estimated until the provider's total lands", () => {
  it("a running Claude row projects its live figure as an estimate", () => {
    insert({ id: "run_live", threadId: "primary", state: "running", inputTokens: 1000, outputTokens: 500 });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.tokens).toBe(1500);
    // Canary: drop the `usage_final` test in the projection and this is false.
    expect(view!.tokensEstimated).toBe(true);
  });

  it("a running Codex row with no usage yet projects null", () => {
    insert({ id: "run_codex", threadId: "primary", backend: "codex", model: "gpt-5.4-codex", sdk: "Codex SDK", state: "running" });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.tokens).toBeNull();
    expect(view!.tokensEstimated).toBe(true);
  });

  it("a row whose provider total landed projects plain, live or finished", () => {
    insert({ id: "run_final", threadId: "primary", state: "running", inputTokens: 1000, outputTokens: 900 });
    patchRun(db, "run_final", { usageFinal: 1 });
    expect(projectRunsForTask(db, SLUG, TASK)[0]).toMatchObject({ tokens: 1900, tokensEstimated: false });

    patchRun(db, "run_final", { state: "finished", finishedAt: "2026-09-06T10:00:00.000Z" });
    expect(projectRunsForTask(db, SLUG, TASK)[0]).toMatchObject({ tokens: 1900, tokensEstimated: false });
  });

  /**
   * A run somebody stopped never receives a Claude `result` or a Codex
   * `turn.completed`, so its row keeps the adapter's estimate for good. The
   * figure is the best one that will ever exist for the run (never "pending"),
   * and it is still an estimate, so it keeps the tilde. Canary: put `&&
   * !finished` back on `tokensEstimated` and the panel prints the estimate as
   * the provider's total on exactly the rows Insights leaves out of its sums.
   */
  it("an interrupted row that never got a provider total keeps its figure AND its estimate mark", () => {
    insert({ id: "run_cut", threadId: "primary", state: "interrupted", finishedAt: "2026-09-06T10:00:00.000Z", inputTokens: 300, outputTokens: 40 });
    expect(projectRunsForTask(db, SLUG, TASK)[0]).toMatchObject({ tokens: 340, tokensEstimated: true });
  });
});

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

/**
 * Ruling 130(a): the projection consults the CLASSIFIED terminal line first,
 * for every run kind, so a refusal whose raw tail carries no prose signature
 * is still flagged, on a specialist and on an operator run alike. Canary:
 * remove the tag/failure clause (the raw scan alone flags nothing here).
 */
describe("ruling 130(a): the classified failure reaches the view for every run kind", () => {
  it("flags a run whose classified tag is ·auth or ·quota even when the raw tail carries no signature", () => {
    insert({ id: "run_auth", threadId: "primary", kind: "primary", backend: "claude", state: "error", credentialUserId: "u_owner" });
    insertRunLine(db, {
      runId: "run_auth", seq: 0, occurredAt: "2026-09-04T00:00:00.000Z", raw: JSON.stringify({ type: "result" }),
      display: {
        t: "00:00:00", ev: "err", tag: "run·error·auth", text: "refused",
        failure: { kind: "auth", resetsAt: null, window: null, windowRejected: false, apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error", origin: null },
      },
    });
    insert({ id: "run_op", threadId: "operator", kind: "operator", backend: "claude", state: "error", credentialUserId: "u_owner" });
    insertRunLine(db, {
      runId: "run_op", seq: 0, occurredAt: "2026-09-04T00:00:01.000Z", raw: JSON.stringify({ type: "result" }),
      display: { t: "00:00:01", ev: "err", tag: "run·error·quota", text: "spent" },
    });
    const views = projectRunsForTask(db, SLUG, TASK);
    const primary = views.find((v) => v.id === "primary")!;
    expect(primary.failedBackendUnavailable).toBe(true);
    expect(primary.failureKind).toBe("auth");
    const operator = views.find((v) => v.id === "operator")!;
    expect(operator.failedBackendUnavailable).toBe(true);
    expect(operator.failureKind).toBe("quota");
  });
});

describe("pass 35 U35-7: a restart is a reason, not an actor", () => {
  /**
   * Boot recovery used to store the literal "restart" in `interrupted_by`, so
   * this projection called `findUserById(db, "restart")` and the pill named a
   * pseudo-user. Canary: drop `interruptedReason` from the view and the first
   * two assertions fail; the pill assertion fails with it.
   */
  it("projects interrupted_reason as interruptedReason with no interrupter, and the pill says so", () => {
    insert({
      id: "run_restart",
      threadId: "primary",
      state: "interrupted",
      interruptedReason: "restart",
      startedAt: "2026-09-06T18:30:00.000Z",
      finishedAt: "2026-09-06T18:40:30.963Z",
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.lifecycle).toBe("interrupted");
    expect(view!.interruptedReason).toBe("restart");
    expect(view!.interruptedBy).toBeNull();
    // Idle-shaped, never an error: no continuity was lost, a process was.
    expect(view!.state).toBe("idle");
    expect(view!.failureKind).toBeUndefined();
    expect(runStatePill(view!)).toEqual({ kind: "neutral", label: "interrupted · by a restart" });
  });

  it("a person's interrupt still names the person and carries no reason", () => {
    insert({
      id: "run_human",
      threadId: "primary",
      state: "interrupted",
      interruptedBy: "u-nobody",
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.interruptedReason).toBeNull();
    expect(view!.interruptedBy).toEqual({ userId: "u-nobody", label: "u-nobody" });
  });
});

/**
 * Ruling 369: the projection reads the prompt-cache record off the row as the
 * sink stored it, and a row with no first call says so (null), never "cold".
 */
describe("ruling 369: the cache record on the run view", () => {
  it("projects every stored figure, and null for a first call that never landed", () => {
    insert({ id: "run_cache", threadId: "primary", state: "finished" });
    patchRun(db, "run_cache", {
      cachedInputTokens: 6_100_000,
      cacheWriteTokens: 120_800,
      firstCallPromptTokens: 14_102,
      firstCallCacheWrite: 14_100,
      firstCallCacheRead: 0,
      firstCallWarm: 0,
      firstCallMissReason: "previous_message_not_found",
      cacheTtlBucket: "1h",
      peakPromptTokens: 226_000,
      lastPromptTokens: 180_000,
      compactions: 2,
    });
    const [view] = projectRunsForTask(db, SLUG, TASK);
    expect(view!.cache).toEqual({
      writeTokens: 120_800,
      readTokens: 6_100_000,
      firstCall: { promptTokens: 14_102, write: 14_100, read: 0, warm: false, missReason: "previous_message_not_found" },
      ttlBucket: "1h",
      peakPromptTokens: 226_000,
      lastPromptTokens: 180_000,
      compactions: 2,
    });
    insert({ id: "run_bare", threadId: "c0", kind: "reviewer", agentProfileId: "critic", state: "queued" });
    const bare = projectRunsForTask(db, SLUG, TASK).find((v) => v.serverRunId === "run_bare")!;
    expect(bare.cache).toEqual({
      writeTokens: 0,
      readTokens: 0,
      firstCall: null,
      ttlBucket: null,
      peakPromptTokens: 0,
      lastPromptTokens: 0,
      compactions: 0,
    });
  });
});

/* ------------- ruling 454: how much of the console a payload carries ------------- */

/**
 * Owner decision 2 (2026-09-24): a hard refresh carries the shown agent's
 * console (display lines), a revalidation or a client navigation carries none,
 * and the console fills a thread with one request. Whatever a projection
 * carries, the WINDOW is the same one: the same bounds, the same cursor, the
 * same keys, so a thread filled later is exactly the one a hard refresh would
 * have shipped.
 */
describe("ruling 454: console shipping", () => {
  /** `count` lines of ~`bytes` on `runId`, from `from`. */
  function fill(runId: string, count: number, bytes = 40, from = 0): void {
    for (let i = from; i < from + count; i++) {
      insertRunLine(db, {
        runId,
        seq: i,
        occurredAt: "2026-09-24T00:00:00.000Z",
        raw: JSON.stringify({ i, filler: "x".repeat(bytes) }),
        display: { t: "00:00:00", ev: "out", tag: "tool_result", text: `${runId} ${i}` },
      });
    }
  }

  /** Two agents: an operator (finished) and a resumed developer, running,
   *  whose history outgrows the window by bytes. */
  function twoAgents(): void {
    insert({ id: "run_op", threadId: "op", kind: "operator", role: "Operator", agentName: "Operator", agentProfileId: "operator" });
    fill("run_op", 30);
    insert({ id: "run_d1", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    insert({ id: "run_d2", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev", state: "running" });
    fill("run_d1", 120, 2_000);
    fill("run_d2", 150, 2_000);
  }

  it("bounds the same window whatever it carries", () => {
    twoAgents();
    const all = projectRunsForTask(db, SLUG, TASK, { console: "all" });
    for (const mode of ["shown", "none"] as const) {
      const other = projectRunsForTask(db, SLUG, TASK, { console: mode });
      other.forEach((view, i) => {
        expect({ ...view.logWindow, loaded: true }, `${mode} ${view.id}`).toEqual(all[i]!.logWindow);
        expect(view.lineCount).toBe(all[i]!.lineCount);
      });
    }
    // The byte budget cut the developer's window inside run_d1.
    expect(all[1]!.logWindow.oldest!.runId).toBe("run_d1");
    expect(all[1]!.logWindow.hasMore).toBe(true);
  });

  it("a .data request carries no line, only each window's facts", () => {
    twoAgents();
    for (const view of projectRunsForTask(db, SLUG, TASK, { console: "none" })) {
      expect(view.lines).toEqual([]);
      expect(view.raw).toEqual([]);
      expect(view.logWindow.loaded).toBe(false);
    }
  });

  it("a document carries the running agent's display lines with their keys, and no envelope", () => {
    twoAgents();
    const all = projectRunsForTask(db, SLUG, TASK, { console: "all" });
    const [op, dev] = projectRunsForTask(db, SLUG, TASK, { console: "shown" });
    expect(op!.lines).toEqual([]);
    expect(op!.logWindow.loaded).toBe(false);
    expect(dev!.logWindow.loaded).toBe(true);
    expect(dev!.lines).toEqual(all[1]!.lines);
    expect(dev!.raw).toEqual([]);
    // A line is keyed by its run's place in the group and its seq; the UI-53
    // boundary by the run it opens.
    expect(dev!.lineKeys).toEqual(all[1]!.lineKeys);
    expect(dev!.lineKeys!.at(-1)).toBe("1:149");
    expect(dev!.lineKeys).toContain("1:resumed");
    expect(new Set(dev!.lineKeys).size).toBe(dev!.lineKeys!.length);
  });

  it("a document with nothing running carries the first agent's window", () => {
    insert({ id: "run_op", threadId: "op", kind: "operator", role: "Operator", agentName: "Operator", agentProfileId: "operator" });
    fill("run_op", 3);
    insert({ id: "run_d", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    fill("run_d", 3);
    const [op, dev] = projectRunsForTask(db, SLUG, TASK, { console: "shown" });
    expect(op!.lines.map((l) => l.text)).toEqual(["run_op 0", "run_op 1", "run_op 2"]);
    expect(dev!.lines).toEqual([]);
  });

  it("the console's window request answers what a document carries for that group", () => {
    twoAgents();
    const [, dev] = projectRunsForTask(db, SLUG, TASK, { console: "shown" });
    // Asked by any run of the group, it answers for the group's representative.
    const page = runLogWindowFor(db, getRun(db, "run_d1")!);
    expect(page.runId).toBe("run_d2");
    expect(page.threadId).toBe("primary-r1");
    expect(page.lines).toEqual(dev!.lines);
    expect(page.lineKeys).toEqual(dev!.lineKeys);
    expect(page.logWindow).toEqual(dev!.logWindow);
    expect(page.facts).toMatchObject({ phase: dev!.phase, step: dev!.step, turns: dev!.turns });
  });

  it("UI-30: a withheld projection bounds no window and keeps the failure class", () => {
    insert({ id: "run_q", threadId: "primary", state: "error", credentialUserId: "u_owner" });
    insertRunLine(db, {
      runId: "run_q",
      seq: 0,
      occurredAt: "2026-09-24T00:00:00.000Z",
      raw: JSON.stringify({ type: "result" }),
      display: { t: "00:00:00", ev: "err", tag: "run·error·quota", text: "refused" },
    });
    const [view] = projectRunsForTask(db, SLUG, TASK, { console: "withheld" });
    expect(view!.lines).toEqual([]);
    expect(view!.logWindow).toMatchObject({ totalLines: 0, runIds: [], headSeq: -1 });
    expect(view!.failureKind).toBe("quota");
    expect(view!.failedBackendUnavailable).toBe(true);
  });
});

/**
 * Ruling 454 (TASK-1) moved the Continuity Recovery Panel's marker search to
 * the projection: the panel scanned `lines` and `raw`, which a payload now
 * carries on a hard load only. P13-D-2's contract is unchanged: the marker is
 * found by its tag's shared suffix, the dead session is read out of the STORED
 * envelope (never display text), and only while the marker is inside the
 * group's window (the panel's retirement rule).
 */
describe("ruling 454: the continuity marker (sessionMissing)", () => {
  /** The envelope `recordSessionMissing` stores; `session_id` is ABSENT (not
   *  null) when the writer never learned one. */
  interface MarkerEnvelope {
    type: string;
    source: string;
    reason: string;
    session_id?: string;
    message: string;
  }
  const MARKER_ENVELOPE = (sessionId?: string) => {
    const envelope: MarkerEnvelope = {
      type: "error",
      source: "viberr",
      reason: "session_missing",
      message: "The Claude session was not found.",
    };
    if (sessionId !== undefined) envelope.session_id = sessionId;
    return JSON.stringify(envelope);
  };

  function marked(tag: string, raw: string, after = 0): void {
    insert({ id: "run_dead", threadId: "primary", agentName: "dev", agentProfileId: "dev", state: "error" });
    insertRunLine(db, {
      runId: "run_dead",
      seq: 0,
      occurredAt: "2026-09-24T00:00:00.000Z",
      raw,
      display: { t: "00:00:00", ev: "err", tag, text: "The Claude session was not found." },
    });
    insert({ id: "run_fresh", threadId: "primary-r1", agentName: "dev", agentProfileId: "dev", state: "running" });
    for (let i = 0; i < after; i++) {
      insertRunLine(db, {
        runId: "run_fresh",
        seq: i,
        occurredAt: "2026-09-24T00:00:01.000Z",
        raw: "{}",
        display: { t: "00:00:01", ev: "text", tag: "assistant", text: `fresh ${i}` },
      });
    }
  }

  it("matches every writer's marker tag by its shared suffix, on every kind of payload", () => {
    for (const tag of ["run·session_missing", "run·error·session_missing", "error·session_missing"]) {
      ctx.cleanup();
      ctx = createTestDbContext();
      db = ctx.makeDb();
      marked(tag, MARKER_ENVELOPE("sess-dead"));
      for (const mode of ["all", "shown", "none"] as const) {
        const [view] = projectRunsForTask(db, SLUG, TASK, { console: mode });
        expect(view!.sessionMissing, `${tag} ${mode}`).toEqual({ sessionId: "sess-dead" });
      }
    }
  });

  it("names no session the envelope does not carry, and still reports the break", () => {
    marked("run·session_missing", MARKER_ENVELOPE());
    expect(projectRunsForTask(db, SLUG, TASK, { console: "none" })[0]!.sessionMissing).toEqual({ sessionId: null });
  });

  it("reads the id out of the stored envelope only (an unparseable one names nothing)", () => {
    marked("run·session_missing", "not json");
    expect(projectRunsForTask(db, SLUG, TASK)[0]!.sessionMissing).toEqual({ sessionId: null });
  });

  it("retires once the marker falls out of the group's window", () => {
    marked("run·session_missing", MARKER_ENVELOPE("sess-dead"), RUN_LOG_WINDOW_LINES);
    const [view] = projectRunsForTask(db, SLUG, TASK, { console: "none" });
    expect(view!.logWindow.oldest!.runId).toBe("run_fresh");
    expect(view!.sessionMissing).toBeNull();
  });

  it("reports nothing for a group with no marker", () => {
    insert({ id: "run_ok", threadId: "primary", agentName: "dev", agentProfileId: "dev" });
    expect(projectRunsForTask(db, SLUG, TASK)[0]!.sessionMissing).toBeNull();
  });
});
