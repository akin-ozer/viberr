import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import type { TaskFrontmatter, TaskPacket } from "~/schemas/task-file.schema";
import type { TaskActionDeps } from "./task-action-core.server";
import { operatorCancelSchedule, operatorScheduleRun } from "./operator-dispatch.server";
import { resolveOperatorAuthority } from "./operator-authority.server";
import { STRANDED_NOTE_TITLE, strandedNoteText, sweepStrandedTasks } from "./stranded-sweep.server";

/**
 * Ruling 330 — the state, not the causes.
 *
 * Four separate causes of a task stopping dead were fixed in one day and the
 * owner found a fifth. This is the sweep that makes the CLASS visible: a task
 * with no packet, no recommendation, no queued question, no schedule, no run
 * and no hold is not paused, it has stopped — and nothing in the product could
 * see that.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/**
 * Anchored to the real clock, because `updateTaskFile` stamps `updatedAt` with
 * it and the sweep filters on that column. A synthetic NOW in the past makes
 * every file this test writes look like the future, and the staleness filter
 * then does the work the assertions think they are doing.
 */
const NOW = Date.now();
const LONG_AGO = new Date(NOW - 2 * 60 * 60_000).toISOString();

function seed(store: TestStore, key: string, patch: Partial<TaskFrontmatter> = {}, packet: TaskPacket | null = null) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      stage: "impl",
      readiness: "ready",
      waiting: "agent",
      updatedAt: LONG_AGO,
      ...patch,
    }),
    packet,
  });
}

function prepared(build: (s: TestStore) => void): TestStore {
  const store = setupTestStore(ctx);
  build(store);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

const dataCtx = (store: TestStore) => ({ dataRoot: store.dataRoot });

/** An operator the project actually deploys — `autoInvokeOperator` returns
 *  early without one, so a sweep test that omits it proves nothing. */
function deployOperator(store: TestStore): void {
  const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...pf.parsed.frontmatter,
    agents: [
      ...pf.parsed.frontmatter.agents,
      {
        profileId: "operator",
        capabilities: [{ capabilityId: "dispatch-agents", mode: "direct" }],
        extras: [],
        definition: {
          kind: "operator",
          backends: ["claude"],
          model: "sonnet",
          autonomy: "supervised",
        },
      },
    ],
  });
}

describe("what the sweep finds", () => {
  it("leaves alone every task with a REASON to be quiet", async () => {
    /**
     * Each of these is silence the product already explains, and a sweep that
     * nudged them would be noise on the one signal that has to stay rare.
     * CANARY: drop any one of the file-side checks and its task appears here.
     */
    const store = prepared((s) => {
      seed(s, "VIB-1", { blockedBy: ["VIB-9"] });            // held
      seed(s, "VIB-2", {}, {                                  // a decision is open
        type: "input", kind: "Decision required", from: "operator",
        title: "Pick one", body: "", observations: [],
        options: [{ kind: "custom", t: "A", d: "", rec: true }],
      });
      seed(s, "VIB-3", {                                      // an offer is standing
        recommendations: [{ id: "r1", kind: "transition", toStageId: "review", label: "Move it", detail: "" }],
      });
      seed(s, "VIB-4", {                                      // a question is queued
        queuedQuestions: [{
          id: "q1", profileId: "reviewer", directive: "What else blocks?",
          decidedBy: "u_1", decidedByLabel: "Arda", decidedAt: LONG_AGO, heldBy: ["VIB-9"],
        }],
      });
      seed(s, "VIB-5", {                                      // a dispatch has a date on it
        schedules: [{
          id: "s1", action: "run-operator", dueAt: new Date(NOW + 86_400_000).toISOString(),
          profileId: null, prompt: "", createdBy: "u_1", createdByLabel: "Arda",
          createdAt: LONG_AGO, status: "pending", firedAt: null, claimedAt: null, retries: 0,
        }],
      });
      seed(s, "VIB-6", { archived: true });                   // off the board
      seed(s, "VIB-7", { stage: "done" });                    // finished
      seed(s, "VIB-8", { updatedAt: new Date(NOW - 60_000).toISOString() }); // quiet a minute
    });
    expect(await sweepStrandedTasks(store.db, dataCtx(store), NOW)).toBe(0);
  });

  it("does not speak twice: its own note is the idempotence key", async () => {
    /**
     * The clock has to move for this to prove anything, and the first draft of
     * this test did not move it — so it passed with the guard deleted. Writing
     * the note bumps `updatedAt`, which drops the task out of the `updated_at <
     * cutoff` window all by itself, and the assertion was measuring that.
     *
     * The real invariant is what happens LATER: a task that was nudged and then
     * produced nothing is quiet again by every clock, and must still not be
     * nudged a second time. Without the title check it is re-noted and the
     * operator re-invoked every fifteen minutes, forever, on a task nobody can
     * move — which is a worse noise than the silence it replaced.
     *
     * CANARY: drop the STRANDED_NOTE_TITLE check in findStrandedTasks.
     */
    const store = prepared((s) => seed(s, "VIB-1"));
    expect(await sweepStrandedTasks(store.db, dataCtx(store), NOW)).toBe(1);
    expect(await sweepStrandedTasks(store.db, dataCtx(store), NOW)).toBe(0);
    // …and an hour later, with the note long past the staleness window.
    expect(await sweepStrandedTasks(store.db, dataCtx(store), NOW + 60 * 60_000)).toBe(0);
  });

  it("speaks again once something else has happened", async () => {
    // The counterweight: the key is "I already said this about THIS silence",
    // not "I said it once about this task". A task that moved, stopped again
    // and has something new on top of the sweep's note is a new stall.
    const store = prepared((s) => seed(s, "VIB-1"));
    await sweepStrandedTasks(store.db, dataCtx(store), NOW);
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (f) => {
      f.timeline.unshift({
        occurredAt: new Date(NOW).toISOString(),
        type: "comment",
        actor: { kind: "operator" },
        title: null,
        text: "Looked; nothing to do.",
        toAgent: false,
        evidence: null,
      });
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(await sweepStrandedTasks(store.db, dataCtx(store), NOW + 60 * 60_000)).toBe(1);
  });
});

describe("sweepStrandedTasks", () => {
  it("records the state and invokes the operator", async () => {
    const store = prepared((s) => seed(s, "VIB-1"));
    deployOperator(store);
    // Typed to the real dep so the assertions below need no casts.
    const runOperator = vi.fn<NonNullable<TaskActionDeps["runOperator"]>>(async () => ({
      runId: "run_1",
      queued: false,
      backend: "claude",
      autonomy: "supervised",
    }));
    const n = await sweepStrandedTasks(
      store.db,
      { dataRoot: store.dataRoot, deps: { runOperator } },
      NOW,
    );
    expect(n).toBe(1);
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    const note = parsed.timeline[0]!;
    expect(note.title).toBe(STRANDED_NOTE_TITLE);
    // The board's own claim travels, because it is the misleading part, and
    // the quiet is counted from the task's last write.
    expect(note.text).toContain("no run is live or queued");
    expect(note.text).toContain("Nothing has happened on this task for 120 minutes");
    expect(note.text).toContain("nothing is scheduled to");
    // CANARY: drop the autoInvokeOperator call and the sweep becomes a
    // complaint — it would name the state and leave the task exactly as stuck.
    expect(runOperator).toHaveBeenCalledTimes(1);
    expect(runOperator.mock.lastCall?.[1]).toMatchObject({
      taskKey: "VIB-1",
      trigger: "stranded",
    });
  });

  it("records the state even when no operator can run", async () => {
    // The note is the point: this state used to leave no trace at all, so it
    // must survive an operator that is absent, refuses, or throws.
    // CANARY: write the note after the invoke, or conditionally on it.
    const store = prepared((s) => seed(s, "VIB-1"));
    deployOperator(store);
    const runOperator = vi.fn<NonNullable<TaskActionDeps["runOperator"]>>(async () => {
      throw new Error("the operator run refused");
    });
    await sweepStrandedTasks(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, NOW);
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    // Not necessarily FIRST — `autoInvokeOperator` writes its own failure note
    // on top when the run throws, which is right. The point is that the record
    // of the stranded state survives an operator that could not run.
    expect(parsed.timeline.some((e) => e.title === STRANDED_NOTE_TITLE)).toBe(true);
  });
});

describe("ruling 487: a run the operator scheduled is a reason for quiet", () => {
  /**
   * F40-65: live on WEB-9 the operator opened a packet only so the task "is not
   * left idle with nothing recorded". A pending schedule already counted as a
   * reason for quiet here (ruling 330), and the operator can now make one
   * itself, so the schedule IS the record: the sweep must not nudge a task that
   * holds on nothing else.
   *
   * CANARY: drop the pending-schedule check in `findStrandedTasks`.
   */
  it("a task holding only on an operator-made schedule is not nudged, and is again once the operator cancels it", async () => {
    const store = prepared((s) => seed(s, "VIB-1"));
    deployOperator(store);
    const authority = resolveOperatorAuthority(dataCtx(store), store.slug);
    const scheduled = await operatorScheduleRun(
      store.db,
      dataCtx(store),
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        agent: "operator",
        delayMinutes: 120,
        prompt: "Read the 12:17Z cron run.",
      },
      authority,
    );
    expect(scheduled.outcome).toBe("done");
    const entry = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter.schedules[0]!;
    expect(entry.createdBy).toBe("operator");

    // Half an hour on: quiet by every clock, the run still ninety minutes out.
    const later = Date.now() + 30 * 60_000;
    const runOperator = vi.fn<NonNullable<TaskActionDeps["runOperator"]>>(async () => ({
      runId: "run_1",
      queued: false,
      backend: "claude",
      autonomy: "supervised",
    }));
    expect(
      await sweepStrandedTasks(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, later),
    ).toBe(0);
    expect(runOperator).not.toHaveBeenCalled();

    // The control: with the operator's schedule cancelled nothing is going to
    // move the task, and the sweep sees it.
    const cancelled = await operatorCancelSchedule(
      store.db,
      dataCtx(store),
      { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: entry.id },
      authority,
    );
    expect(cancelled.outcome).toBe("done");
    expect(
      await sweepStrandedTasks(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, Date.now() + 30 * 60_000),
    ).toBe(1);
  });
});

describe("strandedNoteText", () => {
  it("names what the board CLAIMS, because that is the misleading part", () => {
    const agent = strandedNoteText({ projectSlug: "p", taskKey: "VIB-1", waiting: "agent", quietForMs: 3_600_000 });
    expect(agent).toContain("The board says an agent is working on it, and no run is live or queued");
    expect(agent).toContain("60 minutes");
    const human = strandedNoteText({ projectSlug: "p", taskKey: "VIB-1", waiting: "human", quietForMs: 60_000 });
    expect(human).toContain("waiting on a person, and there is nothing here for one to answer");
    // It says what was CHECKED, so a reader can disagree with it.
    for (const fact of ["decision packet", "queued question", "scheduled", "waiting on"]) {
      expect(agent).toContain(fact);
    }
    // And it does not claim the task is paused.
    expect(agent).toContain("it has stopped");
  });
});
