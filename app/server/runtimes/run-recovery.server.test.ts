import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { defaultModelFor } from "./model-catalog.server";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import {
  finalizeOrphanedRuns,
  recoverStrandedOperatorPlans,
  recoverUnreactedAgentRuns,
  settleAbandonedWaits,
  RECOVERY_REINVOKE_CAP,
} from "./run-recovery.server";
import { getRun, insertRunLine, patchRun, upsertRun } from "./run-store.server";
import {
  codexCompactionHomeId,
  ensureBackendAccountHome,
  ensureUserBackendHome,
  prepareCodexRunHome,
} from "./user-homes.server";
import { loginTargetFor, recordBackendLogin } from "./backend-credentials.server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
});

afterEach(() => ctx.cleanup());

function seedRun(id: string, over: Partial<Parameters<typeof upsertRun>[1]> = {}) {
  upsertRun(store.db, {
    id, taskKey: "VIB-1", projectSlug: store.slug, threadId: `op-${id}`,
    role: "Operator", kind: "operator", backend: "claude",
    agentProfileId: "operator",
    model: "sonnet", sdk: "Claude Agent SDK", state: "running",
    startedAt: new Date().toISOString(), ...over,
  });
}

describe("outcome_key lives in the run store (C1, pass 31)", () => {
  /**
   * BEFORE: `registerAgentCompletion` persisted the staging key with a raw
   * `UPDATE agent_runs SET outcome_key = ?`, so the store's own `AgentRunRow`
   * did not declare the column and `RunPatch` could not write it — the one
   * column on this table whose reads were untyped and whose writes bypassed
   * `patchRun` entirely. This pins the typed round-trip.
   */
  it("patchRun writes outcome_key and getRun reads it back", () => {
    seedRun("run_oc");
    // A run that never staged an envelope reads null, not undefined — the row
    // type has to admit the column.
    expect(getRun(store.db, "run_oc")!.outcome_key).toBeNull();
    patchRun(store.db, "run_oc", { outcomeKey: "oc_1" });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBe("oc_1");
    // Clearing is expressible too (null is a value, not "leave alone").
    patchRun(store.db, "run_oc", { outcomeKey: null });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBeNull();
    // An omitted key leaves the column untouched (the `undefined` skip).
    patchRun(store.db, "run_oc", { outcomeKey: "oc_2" });
    patchRun(store.db, "run_oc", { phase: "working" });
    expect(getRun(store.db, "run_oc")!.outcome_key).toBe("oc_2");
  });

  /**
   * Ruling 248 (pass 37, F37-77): the run executed with NO working tree, so the
   * completion pipeline closes its verdict path. Persisted on the ROW rather
   * than held in the completion closure for the reason `outcome_key` is: the
   * closure dies with the process, and a no-checkout reviewer recovered after a
   * restart would have its report re-classified into a verdict it never gave.
   */
  it("patchRun writes no_checkout and getRun reads it back (ruling 248)", () => {
    seedRun("run_nc");
    // A row written before viberr recorded the fact reads 0, which is the
    // honest value: nothing here says this run was checkout-less.
    expect(getRun(store.db, "run_nc")!.no_checkout).toBe(0);
    patchRun(store.db, "run_nc", { noCheckout: 1 });
    expect(getRun(store.db, "run_nc")!.no_checkout).toBe(1);
    // CANARY: leave `noCheckout` out of `patchRun`'s assignable map and the
    // exhaustiveness `satisfies` catches it at compile time; leave it out of
    // the baseline healer and an existing data root fails every completion.
    patchRun(store.db, "run_nc", { phase: "working" });
    expect(getRun(store.db, "run_nc")!.no_checkout).toBe(1);
  });

  it("patchRun writes interrupted_reason and getRun reads it back (pass 35 U35-7)", () => {
    seedRun("run_ir");
    expect(getRun(store.db, "run_ir")!.interrupted_reason).toBeNull();
    patchRun(store.db, "run_ir", { interruptedReason: "restart" });
    expect(getRun(store.db, "run_ir")!.interrupted_reason).toBe("restart");
    patchRun(store.db, "run_ir", { phase: "working" });
    expect(getRun(store.db, "run_ir")!.interrupted_reason).toBe("restart");
    patchRun(store.db, "run_ir", { interruptedReason: null });
    expect(getRun(store.db, "run_ir")!.interrupted_reason).toBeNull();
  });
});

describe("finalizeOrphanedRuns (F-RUN1)", () => {
  /**
   * Pass 35 U35-7: a restart is a REASON, not an actor. The sweep used to write
   * `state: error` with the literal "restart" in `interrupted_by`, so the run
   * projection looked "restart" up as a user, the pill read "continuity error"
   * and Insights counted every orphan (17 of the live 23 had never executed a
   * turn) as a failure. Canary: put `state: "error", interruptedBy: "restart"`
   * back in `finalizeOrphanedRuns` and all three assertions fail.
   */
  it("flips a running run to interrupted with interrupted_reason=restart and no interrupter", () => {
    seedRun("run_orphan", { state: "running", phase: "Working", step: "Bash · npm test" });
    const { finalized } = finalizeOrphanedRuns(store.db);
    expect(finalized).toBe(1);
    const row = getRun(store.db, "run_orphan")!;
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_reason).toBe("restart");
    expect(row.interrupted_by).toBeNull();
    expect(row.finished_at).toBeTruthy();
    // A finalized row is not mid-step any more (the human-interrupt path
    // clears the same two columns).
    expect(row.phase).toBeNull();
    expect(row.step).toBeNull();
  });

  it("also finalizes a queued run, as interrupted by a restart", () => {
    seedRun("run_queued", { state: "queued", startedAt: null });
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(1);
    const row = getRun(store.db, "run_queued")!;
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_reason).toBe("restart");
    expect(row.interrupted_by).toBeNull();
  });

  it("keeps the person who interrupted a run the restart then finalized", () => {
    // The live-handle interrupt stamps `interrupted_by` at once and leaves the
    // state to the adapter's exit; a restart in that window finalizes the row.
    // The person is a fact, the restart is the reason: both stay.
    seedRun("run_half", { state: "running", interruptedBy: "u-arda" });
    finalizeOrphanedRuns(store.db);
    const row = getRun(store.db, "run_half")!;
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_by).toBe("u-arda");
    expect(row.interrupted_reason).toBe("restart");
  });

  it("ruling 177 / U36-8: an interrupted task run leaves a note on the task's timeline", async () => {
    // Pass 36 U36-8: four runs were cut by a restart and the task files said
    // nothing — the re-fired operator's directive was the first trace. Canary:
    // delete the `appendTimelineEvent` call from the orphan loop.
    seedRun("run_dev_orphan", { state: "running", kind: "primary", role: "Implementation", agentProfileId: "developer" });
    seedRun("run_op_orphan", { state: "queued", startedAt: null });
    const res = finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot });
    await res.notes;
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    const note = parsed.timeline.find((e) => e.type === "note" && e.title === "Interrupted by a restart");
    expect(note).toBeDefined();
    expect(note!.text).toMatch(/still running when the server stopped/);
    expect(note!.text).toContain("run_dev_orphan");
    expect(note!.text).toContain("run_op_orphan");
    /**
     * Ruling 310(b). This note called EVERY finalized run "still running when
     * the server stopped", and the sweep finalizes queued runs too — so a run
     * that never got a concurrency slot was described as having been running.
     * `run_op_orphan` is seeded `queued` with `startedAt: null` precisely
     * because that is the case the sentence got wrong.
     *
     * Found by the controller joining the timeline against the run records on
     * the live board: `run_VlR9mwnxyouc` carried `startedAt: null, turns: 0`
     * and its restart note said it was still running. `started_at` is kept on
     * the row permanently, and this writer had it in hand.
     *
     * CANARY: collapse the two clauses back into one and the queued run is
     * described as having been running.
     */
    expect(note!.text).toContain("queued behind the concurrent-run cap and had not started");
    // Each run sits under the clause that is true of IT, not of the pair.
    const [runningClause, queuedClause] = note!.text.split("; ");
    expect(runningClause).toContain("run_dev_orphan");
    expect(runningClause).toContain("still running when the server stopped");
    expect(runningClause).not.toContain("run_op_orphan");
    expect(queuedClause).toContain("run_op_orphan");
    expect(queuedClause).toContain("queued behind the concurrent-run cap");
    expect(queuedClause).not.toContain("run_dev_orphan");
    expect(note!.text).toMatch(/the operator is re-invoked/);
    // One note per task, not one per run.
    expect(parsed.timeline.filter((e) => e.title === "Interrupted by a restart")).toHaveLength(1);
  });

  /**
   * Ruling 567. A person's Stop and a failed run both reach the completion
   * effects, which post the run's saved files under its name and record a
   * deliverer's as the delivery. A restart reached none of it. Live on AWSC-7
   * a deploy cut the Calculator Builder after it had saved every result file:
   * the files belonged to nobody, `deliveredAt` stayed null, the move to Review
   * offered acceptance before the Judge had started, and the Judge's verdict
   * could bind to nothing.
   */
  function cutRunWithFiles(kind: "primary" | "reviewer", profileId: string, files: string[]) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        waiting: "agent",
        engagements: [
          { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
          { profileId: "judge", backend: "claude", role: "Judge", delivers: false, verdictCapable: true },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun(`run_${profileId}_cut`, {
      kind,
      role: profileId === "developer" ? "Implementation" : "Judge",
      agentProfileId: profileId,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const dir = path.join(store.dataRoot, "projects", store.slug, "tasks", "VIB-1", "attachments");
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(path.join(dir, f), f);
  }

  it("ruling 567: a deliverer the restart cut off keeps its saved files as the delivery, recorded before the operator runs again", async () => {
    // CANARIES: drop the replay from the notes loop and the files belong to
    // nobody with `deliveredAt` null; drop `await notes` from the re-invokes and
    // the operator is called while `deliveredAt` is still null.
    cutRunWithFiles("primary", "developer", ["estimate-link.md", "summary.md"]);
    /** What the re-invoked operator would read, at the moment it is called. */
    const deliveredAtWhenCalled: (string | null)[] = [];
    const res = finalizeOrphanedRuns(store.db, {
      dataRoot: store.dataRoot,
      runOperator: async () => {
        deliveredAtWhenCalled.push(
          readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
            .parsed.frontmatter.deliveredAt,
        );
        return { runId: null, queued: true, backend: "claude", autonomy: "supervised" };
      },
    });
    await res.notes;
    await res.reinvokes;
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    const producing = parsed.timeline.find(
      (e) => e.actor.kind === "agent" && (e.attachments ?? []).includes("estimate-link.md"),
    );
    expect(producing?.actor).toMatchObject({ kind: "agent", profileId: "developer" });
    expect(producing!.attachments).toEqual(expect.arrayContaining(["estimate-link.md", "summary.md"]));
    expect(parsed.frontmatter.deliveredAt).toBe(producing!.occurredAt);
    const note = parsed.timeline.find((e) => e.title === "Interrupted by a restart")!;
    expect(note.occurredAt >= producing!.occurredAt).toBe(true);
    expect(deliveredAtWhenCalled).toEqual([producing!.occurredAt]);
  });

  it("ruling 567: a reviewer the restart cut off has its files posted under its name, and they are not the delivery", async () => {
    // Ruling 388: a reviewer's captures are evidence, never the subject.
    cutRunWithFiles("reviewer", "judge", ["page-capture.png"]);
    await finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot }).notes;
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    const producing = parsed.timeline.find(
      (e) => e.actor.kind === "agent" && (e.attachments ?? []).includes("page-capture.png"),
    );
    expect(producing?.actor).toMatchObject({ kind: "agent", profileId: "judge" });
    expect(parsed.frontmatter.deliveredAt).toBeNull();
  });

  it("ruling 181: a Codex run the restart orphaned gets its private home finished at boot — sign-in written back, directory gone", () => {
    // Live 19:48Z: `codex-home/runs/` still held the two developer runs a
    // restart had cut, each with its copy of the sign-in — the adapter's settle
    // never ran for a process that died. Canary: drop the `finishCodexRunHome`
    // call from the orphan loop.
    const sharedHome = ensureUserBackendHome("u-arda", "codex", store.dataRoot);
    writeFileSync(path.join(sharedHome, "auth.json"), '{"token":"old"}', { mode: 0o600 });
    const home = prepareCodexRunHome(sharedHome, "run_codex_orphan");
    // The CLI refreshed the token inside the run home before the process died.
    writeFileSync(path.join(home.dir, "auth.json"), '{"token":"refreshed"}', { mode: 0o600 });
    seedRun("run_codex_orphan", {
      state: "running",
      kind: "primary",
      role: "Implementation",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-5.6-luna",
      sdk: "Codex SDK",
      credentialUserId: "u-arda",
    });
    // A run whose row predates ruling 127 (no credential principal) is left to
    // the retention sweep — nothing to resolve a home from.
    seedRun("run_codex_nobody", { state: "running", backend: "codex", credentialUserId: null });
    expect(finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot }).finalized).toBe(2);
    expect(existsSync(home.dir)).toBe(false);
    expect(readFileSync(path.join(sharedHome, "auth.json"), "utf8")).toBe('{"token":"refreshed"}');
    // The shared directories behind the links survive the removal.
    expect(existsSync(path.join(sharedHome, "sessions"))).toBe(true);
    expect(getRun(store.db, "run_codex_orphan")!.state).toBe("interrupted");
  });

  it("ruling 507: an orphaned run's refreshed sign-in goes back to the ACCOUNT it billed, its compaction's fork too", () => {
    // Two accounts: an older one whose sign-in sits in the shared home, and
    // the one the orphaned run billed, in a home of its own. Canary: finish
    // the run home against the shared home again and the older account's
    // sign-in is overwritten with the billed one's token.
    const arda = store.users.arda;
    const sharedHome = ensureUserBackendHome(arda.id, "codex", store.dataRoot);
    writeFileSync(path.join(sharedHome, "auth.json"), '{"token":"other-account"}');
    const target = loginTargetFor(store.db, arda.id, "codex");
    recordBackendLogin(store.db, { userId: arda.id, label: arda.email }, "codex", "device", {}, target);
    const { home: accountHome } = ensureBackendAccountHome(arda.id, "codex", target, store.dataRoot);
    writeFileSync(path.join(accountHome, "auth.json"), '{"token":"billed-old"}');

    const run = prepareCodexRunHome(sharedHome, "run_codex_acct", undefined, accountHome);
    writeFileSync(path.join(run.dir, "auth.json"), '{"token":"billed-refreshed"}');
    // The restart also cut the run's completion compaction, in its own fork.
    const compaction = prepareCodexRunHome(
      sharedHome,
      codexCompactionHomeId("run_codex_acct"),
      undefined,
      accountHome,
    );
    seedRun("run_codex_acct", {
      state: "running",
      kind: "primary",
      role: "Implementation",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-5.6-luna",
      sdk: "Codex SDK",
      credentialUserId: arda.id,
      credentialAccountId: target.id,
    });
    expect(finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot }).finalized).toBe(1);
    expect(existsSync(run.dir)).toBe(false);
    expect(existsSync(compaction.dir)).toBe(false);
    expect(readFileSync(path.join(accountHome, "auth.json"), "utf8")).toBe('{"token":"billed-refreshed"}');
    expect(readFileSync(path.join(sharedHome, "auth.json"), "utf8")).toBe('{"token":"other-account"}');
  });

  it("ruling 507: an orphaned run of an account removed since hands its token back to nobody", () => {
    const arda = store.users.arda;
    const sharedHome = ensureUserBackendHome(arda.id, "codex", store.dataRoot);
    writeFileSync(path.join(sharedHome, "auth.json"), '{"token":"other-account"}');
    const run = prepareCodexRunHome(sharedHome, "run_codex_removed");
    writeFileSync(path.join(run.dir, "auth.json"), '{"token":"refreshed"}');
    seedRun("run_codex_removed", {
      state: "running",
      backend: "codex",
      credentialUserId: arda.id,
      credentialAccountId: "ubc_removed00000",
    });
    finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot });
    expect(existsSync(run.dir)).toBe(false);
    expect(readFileSync(path.join(sharedHome, "auth.json"), "utf8")).toBe('{"token":"other-account"}');
  });

  it("re-invokes the operator for an orphan under the crash-loop cap", () => {
    seedRun("run_orphan", { state: "running" });
    const res = finalizeOrphanedRuns(store.db);
    expect(res.finalized).toBe(1);
    expect(res.reinvoked).toBe(1);
    expect(res.capped).toBe(0);
  });

  it("finalizes but does NOT re-invoke once the crash-loop cap is hit (F7-BOOT1)", () => {
    // Simulate CAP prior recovery re-invokes for this task (a boot→orphan→crash
    // loop): each real boot recorded a `run.recovery.reinvoked` audit row.
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reinvoked",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { attempt: i + 1 },
      });
    }
    seedRun("run_orphan_loop", { state: "running" });
    const res = finalizeOrphanedRuns(store.db);
    // The orphan row is still finalized as interrupted by the restart…
    expect(res.finalized).toBe(1);
    const row = getRun(store.db, "run_orphan_loop")!;
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_reason).toBe("restart");
    // …but the operator is NOT re-invoked (capped).
    expect(res.reinvoked).toBe(0);
    expect(res.capped).toBe(1);
    // No new re-invoke audit row was written (count stays at the cap).
    // SAFETY: `SELECT COUNT(*) AS n` always returns exactly one row whose only
    // column is that integer, so `get` cannot come back undefined here.
    const n = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'run.recovery.reinvoked' AND task_key = 'VIB-1'`,
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(RECOVERY_REINVOKE_CAP);
  });

  /**
   * Ruling 198 (F37-19, live): the restart note promised "the operator is
   * re-invoked to decide what to do next" on EVERY orphaned task, and it was
   * written before the cap loop had even run — so a capped task carried a
   * promise Viberr had already decided not to keep, kept `waiting: "agent"`
   * with no agent alive, and nothing revisited it. SHOP-7 sat that way for two
   * hours while the board and the review queue both said "agent working".
   */
  it("ruling 198: a capped task's note says what actually happened, and stops claiming an agent", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        // What a cut delivery leaves behind.
        waiting: "agent",
        ownerUserId: "u-arda",
      }),
    });
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reinvoked",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { attempt: i + 1 },
      });
    }
    seedRun("run_capped", { state: "running", kind: "primary", role: "Implementation" });
    const res = finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot });
    await res.notes;
    expect(res.capped).toBe(1);
    expect(res.reinvoked).toBe(0);

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    const note = parsed.timeline.find((e) => e.title === "Interrupted by a restart")!;
    // CANARY: write the note before the cap loop again and this promise comes
    // back on a task nothing is coming for.
    expect(note.text).not.toMatch(/the operator is re-invoked/);
    expect(note.text).toContain("Viberr did NOT re-invoke the operator");
    expect(note.text).toContain("crash-loop guard");
    expect(note.text).toContain("Run the operator from this page when you are ready");
    // The self-review caught the first draft over-promising here. This loop
    // decides ONE thing — whether IT re-invokes — and `recoverUnreactedAgentRuns`
    // further down the same boot chain can still run an `agent-reply` operator
    // turn on this very task, under its own separate cap. CANARY: put "Nothing
    // further happens on its own" back and the note claims something about the
    // rest of the boot that this loop does not know.
    expect(note.text).not.toContain("Nothing further happens on its own");
    // CANARY: drop the `clearWaitingToHuman` call and the board keeps saying an
    // agent is working on a task with no run alive.
    expect(parsed.frontmatter.waiting).toBe("human");
    // And the owner is told, rather than left to notice.
    // SAFETY: `SELECT COUNT(*) AS n` always yields exactly one integer row.
    const n = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u-arda' AND task_key = 'VIB-1'`,
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("ruling 198: an UNCAPPED task keeps the promise, because a turn really is coming", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    seedRun("run_uncapped", { state: "running", kind: "primary", role: "Implementation" });
    const res = finalizeOrphanedRuns(store.db, { dataRoot: store.dataRoot });
    await res.notes;
    expect(res.reinvoked).toBe(1);
    const note = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.title === "Interrupted by a restart")!;
    expect(note.text).toMatch(/the operator is re-invoked/);
    expect(note.text).not.toContain("crash-loop guard");
  });

  it("leaves already-terminal runs untouched and is idempotent", () => {
    seedRun("run_done", { state: "finished", finishedAt: new Date().toISOString() });
    seedRun("run_live", { state: "running" });
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(1);
    expect(getRun(store.db, "run_done")!.state).toBe("finished");
    // Second boot finds nothing running.
    expect(finalizeOrphanedRuns(store.db).finalized).toBe(0);
  });

  it("sweeps the processes of exactly the orphans it finalizes (ruling 174)", async () => {
    // The dead server's CLIs led their own groups and did not die with it; a
    // survivor could still be writing the tree boot reclaims. Terminal runs
    // settled in their own process and were swept there.
    seedRun("run_done", { state: "finished", finishedAt: new Date().toISOString() });
    seedRun("run_running", { state: "running" });
    seedRun("run_waiting", { state: "queued", startedAt: null });
    const asked: string[][] = [];
    const reapProcesses = async (targets: { runIds: readonly string[] }) => {
      asked.push([...targets.runIds].sort());
      return { terminated: 0, killed: 0 };
    };

    const res = finalizeOrphanedRuns(store.db, { reapProcesses });
    await res.reaped;
    // Ruling 376: each orphan's completion-compaction marker is swept beside it.
    expect(asked).toEqual([
      ["run_running", "run_running:compaction", "run_waiting", "run_waiting:compaction"],
    ]);

    // Nothing orphaned, nothing to sweep.
    asked.length = 0;
    await finalizeOrphanedRuns(store.db, { reapProcesses }).reaped;
    expect(asked).toEqual([]);
  });

  it("a failing sweep never rejects the boot chain that joins it", async () => {
    seedRun("run_running", { state: "running" });
    const res = finalizeOrphanedRuns(store.db, {
      reapProcesses: async () => {
        throw new Error("no /proc here");
      },
    });
    await expect(res.reaped).resolves.toBeUndefined();
    expect(res.finalized).toBe(1);
  });
});

/**
 * Ruling 213 (live on SHOP-4). Every other boot path keys on a RUN — the ones
 * still running, the finished ones whose reply never landed, the Codex plans
 * that never executed. None covers an operator drive that COMPLETED cleanly and
 * whose settle was still in flight when the process died: the run row is
 * `finished`, its reply is not missing, its plan ran, and the only trace is a
 * board that says an agent is working while every run on the task is over.
 * SHOP-4's operator moved it Review → Build at 18:57:34 and the container
 * restarted at 18:57:35; six minutes later nothing had looked at it.
 */
describe("settleAbandonedWaits (ruling 213)", () => {
  it("re-invokes the operator for a task waiting on an agent that is not there, and says so", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // A run that FINISHED — the shape no other boot pass selects.
    seedRun("run_settled", {
      kind: "primary",
      role: "Primary specialist",
      agentProfileId: "developer",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });

    // CANARY: drop the sweep from `reconcileRestartedWork` (or narrow its SELECT
    // to live runs) and this returns 0 — the board keeps claiming an agent.
    const settled = await settleAbandonedWaits(store.db, { dataRoot: store.dataRoot });
    expect(settled).toBe(1);

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    const note = parsed.timeline.find((e) => e.title === "Left waiting on an absent agent");
    expect(note, "the record must say why a run started").toBeTruthy();
    expect(note!.text).toContain("no run was live when the server came back");
    /**
     * Ruling 317(b). This task DOES have a finished run, so the note may say
     * the follow-up is what did not happen. CANARY: go back to the fixed
     * sentence and the no-run case below starts asserting a run that never
     * existed.
     */
    expect(note!.text).toContain("run_settled");
    expect(note!.text).toContain("the follow-up that would have moved the task did not run");
    // …and the operator was actually re-invoked, which is the remedy: it
    // re-reads the task and decides, exactly as it does for an orphaned run.
    const operatorRuns = store.db
      .prepare(`SELECT id FROM agent_runs WHERE task_key = ? AND kind = 'operator'`)
      .all("VIB-1");
    expect(operatorRuns.length).toBeGreaterThan(0);
  });

  /**
   * Ruling 317(b). The sweep's SELECT proves ONE thing: `waiting = 'agent'` and
   * no run in `running` or `queued`. The note asserted three more — that a run
   * existed, that it "finished just before the stop", and that "nothing was
   * lost from the record".
   *
   * Live on SHOP-37 the contradiction sits fifteen minutes apart in one file.
   * 09:15:13 — "**Held:** Codex is out of quota... **nothing was dispatched**
   * and no decision is needed." 09:30:29 — "the run finished just before the
   * stop". A dispatch held on quota records the wait and starts nothing.
   *
   * This is the class ruling 310(b) named in the neighbouring sweep of this
   * same file, whose commit quoted the controller: "One writer fixed, its
   * neighbour still inventing."
   */
  it("ruling 317(b): a task that never had a run is not told one finished", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // No run at all — the SHOP-37 shape: the dispatch was held before it
    // reached a process, and the wait was recorded anyway.

    const settled = await settleAbandonedWaits(store.db, { dataRoot: store.dataRoot });
    expect(settled).toBe(1);

    const note = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.title === "Left waiting on an absent agent");
    // CANARY: restore the fixed sentence and viberr tells the person a run
    // finished on a task where none was ever started.
    expect(note!.text).toContain("No agent run has ever been started on it");
    expect(note!.text).not.toContain("the run finished just before the stop");
    expect(note!.text).not.toMatch(/follow-up that would have moved the task did not run/);
    // Ruling 337(b): it states the board fact and claims no turn that may not
    // run — the note is written BEFORE `runOperator` is called, so a refusal
    // would leave it promising one (the unconditional promise ruling 198
    // removed from the sibling orphan sweep).
    // CANARY: restore "the operator is re-invoked to decide what happens next".
    expect(note!.text).toContain("The board has stopped claiming an agent");
    expect(note!.text).toContain("Viberr is invoking the operator");
    expect(note!.text).toContain("if no operator can run, this task is waiting on a person");
    expect(note!.text).not.toMatch(/the operator is re-invoked/);
  });

  /**
   * Ruling 215 (F37-35). The deploy that shipped 213 produced two restart notes
   * on the same task, one second apart: "the run `run_JFvmbz…` (reviewer) was
   * still running when the server stopped" and "no run was live when the server
   * came back". Both cannot be true. `finalizeOrphanedRuns` runs first and its
   * whole job is to move live runs to `interrupted`, so by the time this sweep
   * asks its question the evidence is already gone — and its re-invoke raced the
   * orphan sweep's own, two coordination drives for one restart.
   */
  it("ruling 337: reads the RECORD, not just the index — a parked dispatch is not an abandoned wait", async () => {
    /**
     * This sweep selected entirely on `t.waiting = 'agent'` with no live run and
     * never opened the task file. So a dispatch viberr ITSELF had parked was
     * swept as an abandoned wait — and unlike the read-only checks around it,
     * this one writes a note and spends a paid operator turn.
     *
     * Live on SHOP-37, 2026-09-15, and it overrode a person:
     *   09:15:13.200  Arda: "Decision: Re-run the Integration Verifier on the
     *                 Codex backend."
     *   09:15:13.298  policy-engine, "Dispatch held": Codex is out of quota
     *                 until Sep 19, the run is scheduled for then, "nothing was
     *                 dispatched and no decision is needed."
     *   09:30:29.868  THIS SWEEP: "Left waiting on an absent agent… the run
     *                 finished just before the stop and the follow-up that
     *                 would have moved the task went with the process."
     *   09:32:25.171  the drive it forced: "a fresh-context re-run of your
     *                 pass, on the CLAUDE backend."
     *   09:39:19.846  Arda cancels, by hand, the schedule viberr promised.
     *
     * Every clause of that note was false on the task's own record, and it
     * reversed the owner's explicit backend decision fifteen minutes after they
     * made it. The guard is borrowed from `findStrandedTasks` (ruling 330,
     * shipped hours earlier), which re-reads the file for exactly these cases:
     * the older sweep does MORE and checked LESS.
     *
     * CANARY: drop any one of the file-side `continue`s.
     */
    const parked: [string, Partial<Parameters<typeof baseTaskFrontmatter>[1]>][] = [
      // SHOP-37's own shape: a held dispatch parked on a pending schedule.
      ["VIB-1", {
        schedules: [{
          id: "sch_1", action: "run-agent", dueAt: "2026-09-19T09:37:00.000Z",
          profileId: "integration-verifier", prompt: "", createdBy: "u_1",
          createdByLabel: "Arda", createdAt: "2026-09-15T09:15:13.275Z",
          status: "pending", firedAt: null, claimedAt: null, retries: 0,
        }],
      }],
      // The other reasons the file already explains.
      ["VIB-2", { blockedBy: ["VIB-9"] }],
      ["VIB-3", {
        queuedQuestions: [{
          id: "q1", profileId: "reviewer", directive: "What else blocks?",
          decidedBy: "u_1", decidedByLabel: "Arda",
          decidedAt: "2026-09-15T09:00:00.000Z", heldBy: ["VIB-9"],
        }],
      }],
    ];
    for (const [key, patch] of parked) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "impl", waiting: "agent", ...patch }),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const settled = await settleAbandonedWaits(store.db, { dataRoot: store.dataRoot });
    expect(settled, "a parked dispatch was swept as an abandoned wait").toBe(0);
    for (const [key] of parked) {
      const parsedTask = readTaskFile({
        projectSlug: store.slug,
        taskKey: key,
        dataRoot: store.dataRoot,
      })!.parsed;
      expect(
        parsedTask.timeline.find((e) => e.title === "Left waiting on an absent agent"),
        `${key} had a reason for the quiet and was swept anyway`,
      ).toBeUndefined();
    }
  });

  it("does not re-claim a task the orphan sweep already took (ruling 215)", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // The shape the orphan sweep leaves behind: its run WAS live at the stop
    // and it has just been finalized, so the board looks identical to an
    // abandoned wait and is not one.
    seedRun("run_orphaned", {
      kind: "reviewer",
      role: "Code Reviewer",
      agentProfileId: "code-reviewer",
      state: "interrupted",
      finishedAt: new Date().toISOString(),
    });

    // CANARY: drop the filter and this settles 1, writing "no run was live"
    // under the orphan sweep's own "was still running when the server stopped".
    const settled = await settleAbandonedWaits(
      store.db,
      { dataRoot: store.dataRoot },
      new Set([`${store.slug}/VIB-1`]),
    );
    expect(settled).toBe(0);

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(
      parsed.timeline.find((e) => e.title === "Left waiting on an absent agent"),
      "the orphan sweep owns this task and already said what happened",
    ).toBeUndefined();
  });

  it("leaves a task alone while a run is actually live", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun("run_live", {
      kind: "primary",
      role: "Primary specialist",
      agentProfileId: "developer",
      state: "running",
    });
    expect(await settleAbandonedWaits(store.db, { dataRoot: store.dataRoot })).toBe(0);
  });
});

describe("recoverUnreactedAgentRuns (NFR17/B9 crash-loop backstop)", () => {
  // A finished specialist run whose in-process reply callback was dropped by a
  // restart: the task is stalled at waiting=agent and no `task.agent.replied`
  // audit exists for the run, so the recovery reconciler selects it. The project
  // has no operator deployed (test store `agents: []`), so completion effects post
  // the reply and settle waiting→human without an awaited operator re-invoke.
  function seedDroppedReplyRun(id: string): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun(id, {
      kind: "primary",
      role: "Primary specialist",
      agentProfileId: "developer",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store.db, {
      runId: id,
      seq: 1,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: {
        t: "1",
        ev: "text",
        tag: "assistant",
        text: "done: delivered the change and opened the PR",
      },
    });
  }

  function countReplayAudits(runId: string): number {
    return listAuditEvents(store.db, { action: "run.recovery.reply_replayed" }).filter(
      (e) => e.details?.runId === runId,
    ).length;
  }

  it("records a replay-attempt audit and recovers a dropped reply under the cap", async () => {
    seedDroppedReplyRun("run_dropped");
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(0);
    expect(res.recovered).toBe(1);
    // The attempt audit is recorded BEFORE the effects run — so the next boot
    // counts it even if the effects (or the process) die mid-flight.
    expect(countReplayAudits("run_dropped")).toBe(1);
  });

  /**
   * Ruling 207(a) (claim audit). `noteCompletionEffectsLost` writes, in ONE
   * update, `waiting = "human"` and a note saying "Run recovery replays the
   * effects on the next restart" — while this reconciler selected on
   * `t.waiting = 'agent'`. The note's own write made the replay it promised
   * unreachable, and the effects it names include a required reviewer's VERDICT,
   * so the acceptance gate stayed shut on a review that had actually happened.
   */
  it("ruling 207(a): a run whose completion effects were LOST is still replayed, though its task now waits on a human", async () => {
    seedDroppedReplyRun("run_lost");
    // Exactly what noteCompletionEffectsLost leaves behind: the honest board
    // state, and the marker that says why.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "human" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    recordAudit(store.db, {
      action: "run.completion.effects_lost",
      actor: { userId: null, label: "system" },
      subjectKind: "task",
      subjectId: "VIB-1",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      details: { runId: "run_lost", kind: "primary" },
    });

    // CANARY: drop the `run.completion.effects_lost` arm from the SELECT and
    // this recovers 0 — which is what the note promised would not happen.
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.recovered).toBe(1);
    expect(countReplayAudits("run_lost")).toBe(1);
  });

  it("ruling 207(a): a task waiting on a human with NO effects-lost marker is still left alone", async () => {
    // The scope the original `waiting = 'agent'` filter was protecting: old
    // history, not a live stall. Widening the selection must not sweep it in.
    seedDroppedReplyRun("run_old");
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting: "human" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.recovered).toBe(0);
  });

  it("consumes a persisted staged report_outcome envelope on recovery (AO-1)", async () => {
    seedDroppedReplyRun("run_staged");
    // Simulate a run whose completion was registered (outcome_key persisted to
    // the row) and whose report_outcome envelope was staged — then the process
    // died before the callback fired. Pre-fix, recovery had no key and the
    // staged row was orphaned (verdict fell back to the prose regex).
    store.db
      .prepare(`UPDATE agent_runs SET outcome_key = 'oc_staged' WHERE id = 'run_staged'`)
      .run();
    store.db
      .prepare(
        `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at)
         VALUES ('oc_staged', '{"kind":"report"}', ?)`,
      )
      .run(new Date().toISOString());

    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.recovered).toBe(1);
    // The staged envelope was TAKEN by its key (consumed once) — proof the
    // recovery path reached it via the persisted outcome_key.
    // SAFETY: as above — a COUNT(*) row always exists and carries `n`.
    const remaining = store.db
      .prepare(`SELECT COUNT(*) AS n FROM staged_outcomes WHERE outcome_key = 'oc_staged'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("C02-R11 (pass 32): the dispatch-completion contract survives a restart — the recovered reply carries its cc line", async () => {
    // The dispatcher used to live only in the in-process closure, so a run
    // recovered after a crash posted its report with no cc line and without
    // the guaranteed operator re-invoke. Persisted on the row now (the same
    // shape as outcome_key). Canary: drop the `dispatched_by_*` re-supply in
    // recoverUnreactedAgentRuns and the cc line vanishes.
    seedDroppedReplyRun("run_dispatched");
    patchRun(store.db, "run_dispatched", {
      dispatchedByName: "Arda Kaya",
      dispatchedByUserId: store.users.arda.id,
    });
    expect(getRun(store.db, "run_dispatched")).toMatchObject({
      dispatched_by_name: "Arda Kaya",
      dispatched_by_user_id: store.users.arda.id,
    });

    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.recovered).toBe(1);
    const reply = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "comment" && e.actor.kind === "agent");
    expect(reply?.text).toContain("done: delivered the change");
    expect(reply?.text).toContain("cc @Arda Kaya @operator");
  });

  it("does not reprocess a run after a successful recovery (idempotent)", async () => {
    seedDroppedReplyRun("run_dropped");
    expect((await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot })).recovered).toBe(1);
    // `task.agent.replied` now exists → the NOT EXISTS clause excludes the run.
    const second = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(second.recovered).toBe(0);
    expect(second.capped).toBe(0);
    // No second attempt audit either.
    expect(countReplayAudits("run_dropped")).toBe(1);
  });

  it("skips a run once the replay cap is hit, without re-firing effects", async () => {
    // Simulate CAP prior replays for THIS run within the window (a boot→recover→
    // crash loop where the reply write kept failing so `task.agent.replied` never
    // landed and the run was re-selected every boot).
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { runId: "run_loop", attempt: i + 1 },
      });
    }
    seedDroppedReplyRun("run_loop");
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(1);
    expect(res.recovered).toBe(0);
    // No NEW attempt audit was written (count stays exactly at the cap).
    expect(countReplayAudits("run_loop")).toBe(RECOVERY_REINVOKE_CAP);
    // The run was NEVER reacted to: no reply audit landed.
    expect(
      listAuditEvents(store.db, { action: "task.agent.replied" }).filter(
        (e) => e.details?.runId === "run_loop",
      ).length,
    ).toBe(0);
  });

  it("caps per run — a distinct run on the same task is still recovered", async () => {
    // The capped run's prior replays must NOT starve a sibling run on the task.
    for (let i = 0; i < RECOVERY_REINVOKE_CAP; i++) {
      recordAudit(store.db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: "VIB-1",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        details: { runId: "run_capped", attempt: i + 1 },
      });
    }
    // Two dropped runs on the SAME task: one already at the cap, one fresh.
    seedDroppedReplyRun("run_capped");
    seedRun("run_fresh", {
      kind: "primary",
      role: "Primary specialist",
      agentProfileId: "developer",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store.db, {
      runId: "run_fresh",
      seq: 1,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: { t: "1", ev: "text", tag: "assistant", text: "done: sibling delivery" },
    });
    const res = await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
    expect(res.capped).toBe(1); // run_capped skipped
    expect(res.recovered).toBe(1); // run_fresh recovered
    expect(countReplayAudits("run_fresh")).toBe(1);
    expect(countReplayAudits("run_capped")).toBe(RECOVERY_REINVOKE_CAP);
  });
});

// ------------------------------------ P14-RT-08: a stranded codex operator plan

describe("recoverStrandedOperatorPlans (P14-RT-08)", () => {
  /**
   * A Codex operator coordinates AFTER its provider run finishes: the completion
   * callback parses the structured plan and executes it. A restart in that
   * window lost the whole turn with no trace — the finished operator row is
   * outside `finalizeOrphanedRuns` (running/queued only) and outside
   * `recoverUnreactedAgentRuns` (primary/reviewer only).
   */
  function deployCodexOperator(): void {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: [{ capabilityId: "append-typed-events", mode: "direct" }],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
  }

  /** A finished codex operator run holding a valid plan its process never ran. */
  function seedStrandedPlan(id: string, waiting: "agent" | "human" = "agent"): void {
    deployCodexOperator();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", waiting }),
      goal: "Coordinate the implementation.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedRun(id, {
      backend: "codex",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store.db, {
      runId: id,
      seq: 1,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: {
        t: "1",
        ev: "text",
        tag: "agent_message",
        text: JSON.stringify({
          reasoning: "",
          actions: [
            {
              tool: "post_comment",
              profileId: null,
              delivers: null,
              toStageId: null,
              packetType: null,
              text: "Implementation looks complete — moving to review next.",
              reason: null,
              packetOptions: null,
            },
          ],
        }),
      },
    });
  }

  const timeline = () =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;

  it("executes the plan the restart dropped and marks the turn taken", async () => {
    seedStrandedPlan("run_stranded");

    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });

    expect(res.recovered).toBe(1);
    expect(
      timeline().some((e) =>
        e.text.includes("Implementation looks complete"),
      ),
    ).toBe(true);
    expect(
      listAuditEvents(store.db, { action: "runtime.operator.plan_executed" }),
    ).toHaveLength(1);
  });

  it("is idempotent — a turn already taken up is never re-executed", async () => {
    seedStrandedPlan("run_stranded");
    await recoverStrandedOperatorPlans(store.db, { dataRoot: store.dataRoot });

    const second = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(second.recovered).toBe(0);
    // The comment landed exactly once — re-running a plan would duplicate every
    // governed action it contains.
    expect(
      timeline().filter((e) => e.text.includes("Implementation looks complete")),
    ).toHaveLength(1);
  });

  it("leaves a task that is no longer waiting on an agent alone", async () => {
    seedStrandedPlan("run_settled", "human");
    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(res.recovered).toBe(0);
  });

  it("reports an OLD stranded plan instead of re-deciding it", async () => {
    seedStrandedPlan("run_old");
    // A boot hours later is not recovering a dropped turn: the plan named a
    // stage and a profile for a task state that has since moved on.
    store.db
      .prepare(`UPDATE agent_runs SET finished_at = ? WHERE id = 'run_old'`)
      .run(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());

    const res = await recoverStrandedOperatorPlans(store.db, {
      dataRoot: store.dataRoot,
    });
    expect(res).toEqual({ recovered: 0, stale: 1 });
    expect(
      timeline().some((e) => e.text.includes("Implementation looks complete")),
    ).toBe(false);
  });
});
