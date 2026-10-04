import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { installFakeRuntime, queueFakeRun } from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { settle } from "../../../test-support/polling";
import { getRun } from "./run-store.server";
import {
  drainRunQueue,
  interruptRun,
  reserveRun,
  runConcurrencySnapshot,
  startRun,
} from "./run-service.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import { readTaskFile } from "~/server/files/task-writer.server";

/**
 * The instance run-concurrency cap: `handles.size` (live adapters) is the ground
 * truth, so a run past the cap is parked `queued` and its adapter is not
 * launched until a live slot frees (drainRunQueue on onExit). A run interrupted
 * while queued is dropped, never sprung to life.
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  // Ruling 127: every run here bills VIB-1's owner, so he has to have the
  // backend connected or the cap would never be reached — each run would be
  // refused before it took a slot.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(() => {
  ctx.cleanup();
});

/** A reviewer run that streams a line then STAYS running (handle live) until it
 *  is interrupted — the way to hold a concurrency slot open in a test. Distinct
 *  thread ids AND distinct profile ids so several coexist on one task: only
 *  DIFFERENT supporting profiles stream concurrently — same-profile overlap is
 *  the double-run idx_agent_runs__one_live_per_support forbids atomically
 *  (hunt 2026-08-29), which is not what this file exercises. */
async function startHeldRun(threadId: string): Promise<string> {
  queueFakeRun({
    lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
    keepRunning: true,
  });
  const { runId } = await startRun(store.db, {
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId,
    role: "Reviewer",
    kind: "reviewer",
    backend: "claude",
    model: "claude-sonnet-4-5",
    agentProfileId: `reviewer-${threadId}`,
    credentialUserId: store.users.arda.id,
    prompt: "review VIB-1",
    dataRoot: store.dataRoot,
  });
  return runId;
}

describe("run concurrency cap", () => {
  it("cap 0 (default) launches every run immediately — nothing queued", async () => {
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 0, queued: 0 });
  });

  it("parks a run past the cap as `queued`, launching nothing", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");

    const b = await startHeldRun("r1");
    await settle();
    // b exceeded the cap of 1 → queued, adapter never started.
    expect(getRun(store.db, b)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({
      cap: 1,
      live: 1,
      queued: 1,
    });
  });

  /**
   * Ruling 207(g) (claim audit). The interrupt note said "The thread stays
   * resumable; re-run the agent to continue" for every run. A QUEUED run — and
   * a running row in the minutes-long window `reserveRun` opens before any
   * provider process exists, which is the window a person actually presses Stop
   * in — has no `session_id`, and `latestSessionRun` skips exactly those. The
   * person who stopped a long run believed its reasoning survived and got a
   * fresh agent that re-derived the work and re-spent the budget.
   */
  it("ruling 207(g): interrupting a run with NO provider session says so instead of promising a resume", async () => {
    setMaxConcurrentRuns(store.db, 1);
    await startHeldRun("r0");
    const queued = await startHeldRun("r1");
    await settle();
    expect(getRun(store.db, queued)?.state).toBe("queued");
    expect(getRun(store.db, queued)?.session_id).toBeNull();

    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: queued, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();

    const note = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "note" && e.text.includes(queued));
    // CANARY: emit the single unconditional sentence (the shipped note) and
    // this promises a resume that `latestSessionRun` will never perform.
    expect(note!.text).toContain("there is no thread to resume");
    expect(note!.text).not.toContain("stays resumable");
  });

  /** The timeline note saying `runId` got its slot (ruling 311, the other half). */
  function startedNote(runId: string) {
    return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.timeline.find((e) => e.text.includes(runId) && e.text.includes("got a slot and started"));
  }

  it("drains the oldest queued run when a live run finishes — and the timeline says so", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("queued");
    // Ruling 311, the other half: while b waits, nothing on the record says it started.
    expect(startedNote(b)).toBeUndefined();

    // Interrupt a → its slot frees → b promotes and launches.
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, a)?.state).toBe("interrupted");
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ live: 1, queued: 0 });
    // Canary: drop the note from `drainRunQueue` and the timeline reads "Nothing
    // is streaming yet" for the whole run — the dispatch line's "Queued" with no
    // transition after it. The note names the run and says it is streaming.
    expect(startedNote(b)?.text).toContain(`\`${b}\``);
    // Only the promotion writes it: a was admitted at once and was never "queued".
    expect(startedNote(a)).toBeUndefined();
  });

  it("drops a run interrupted WHILE queued — it never springs to life", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1"); // queued
    const c = await startHeldRun("r2"); // queued behind b
    await settle();
    expect(getRun(store.db, b)?.state).toBe("queued");
    expect(getRun(store.db, c)?.state).toBe("queued");

    // Interrupt b while it waits — it has no live adapter, just a queued row.
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: b, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    expect(getRun(store.db, b)?.state).toBe("interrupted");

    // Now free the live slot: a finishes → the drain skips the interrupted b and
    // promotes c instead.
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, b)?.state).toBe("interrupted"); // stayed dead
    expect(getRun(store.db, c)?.state).toBe("running"); // promoted
  });

  it("cap increase is honored on the next drain (multiple promotions)", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1"); // queued
    const c = await startHeldRun("r2"); // queued
    await settle();
    expect(getRun(store.db, b)?.state).toBe("queued");
    expect(getRun(store.db, c)?.state).toBe("queued");

    // Raise the cap to 3, then free a slot: the drain promotes BOTH waiters.
    setMaxConcurrentRuns(store.db, 3);
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(getRun(store.db, c)?.state).toBe("running");
  });

  /**
   * T11 (pass 31) — UC-25, verified live: cap 1 queued the second run, and
   * setting the cap back to 0 drained it WITHOUT anything finishing. The test
   * above proves the drain re-reads the cap, but it also frees a slot, so it
   * would still pass if raising the cap were a dead end until a run exited.
   * `setMaxConcurrentRuns` deliberately does not drain; the org-settings
   * `set-concurrency` action pairs the two (`app/routes/org.settings.tsx`), and
   * this is that pair with nothing else moving.
   */
  it("T11: raising the cap alone drains the queue — no run has to finish first", async () => {
    // Canary: make `drainRunQueue` read a cap captured at module load (or drop
    // the `drainRunQueue(db)` line from the set-concurrency action) and the
    // queued run stays queued.
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1"); // over the cap
    await settle();
    expect(getRun(store.db, b)?.state).toBe("queued");

    setMaxConcurrentRuns(store.db, 2);
    drainRunQueue(store.db);
    await settle();

    // Nothing exited — a is still holding its slot — and b went live anyway.
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({
      cap: 2,
      live: 2,
      queued: 0,
    });
  });
});

/**
 * T11/F26-1 (pass 31) — the cap end to end, through a REAL specialist dispatch.
 *
 * `reserveRun` never writes a `queued` row: it grants a slot or returns null.
 * The queued state on the dispatch path exists only because the dispatcher
 * falls through to the gated `startRun` when the reservation is declined, and
 * that fallthrough is the entire product-visible half of the pass-26 fix (the
 * cap was COSMETIC because reserveRun bypassed the gate). The reserved-path
 * tests below stop at `reserveRun(...) === null`; nothing asserted that a
 * dispatch actually lands `queued` and later drains.
 */
describe("run concurrency cap — a real specialist dispatch", () => {
  /** Deploy a `dev` specialist with no repo (so the run skips the clone) and
   *  engage it on VIB-1 — the shape a Run-agent click produces. */
  async function deployAndAssignDev(): Promise<void> {
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { assignSpecialist } = await import("~/server/tasks/specialist-assignment.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "developer",
            backends: ["claude"],
            model: "sonnet",
            effort: "",
          },
        },
      ],
    });
    const { rebuildAll: rebuild } = await import("~/server/projections/rebuilder.server");
    rebuild(store.db, { dataRoot: store.dataRoot, force: true });
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
  }

  it("T11/F26-1: a dispatch past the cap lands `queued`, and a raised cap drains it to `running`", async () => {
    // Canary: return a reservation unconditionally from `reserveRun` (drop its
    // cap check) and the dispatched run is `running` immediately — the exact
    // cosmetic-cap regression pass 26 found.
    await deployAndAssignDev();
    setMaxConcurrentRuns(store.db, 1);

    // One live run occupies the single slot.
    const held = await startHeldRun("held");
    await settle();
    expect(getRun(store.db, held)?.state).toBe("running");

    // The real dispatch: its reservation is declined, so it must fall through
    // to the gated path rather than launching anyway.
    const { startAgentRun } = await import("~/server/tasks/specialist-run.server");
    // Held open too, so "it drained" is observable as `running` rather than as
    // a run that already finished (which a never-launched run cannot be either).
    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    });
    const dispatched = await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    await settle();
    expect(getRun(store.db, dispatched.runId)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({
      cap: 1,
      live: 1,
      queued: 1,
    });

    // Raise the cap the way an org admin does, and it drains.
    setMaxConcurrentRuns(store.db, 2);
    drainRunQueue(store.db);
    await settle();
    expect(getRun(store.db, dispatched.runId)?.state).toBe("running");

    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: dispatched.runId, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
  });
});

/**
 * F26-1: the RESERVED path (every specialist dispatch reserves a live row before
 * cloning) used to bypass the cap entirely — `reserveRun` wrote a `running` row
 * with no cap check and `startRun` launched it directly. So N delivering/reviewer
 * runs all went live regardless of the cap. A reservation now COMMITS a slot
 * under the cap: it counts toward the live total, and when no slot is free the
 * reservation is DECLINED (null) so the run flows through the normal `queued`
 * path instead.
 */
describe("run concurrency cap — reserved (specialist) runs", () => {
  // Reviewer kind, DISTINCT profiles: several supporting profiles may coexist
  // on one task (same-profile overlap is atomically refused since hunt
  // 2026-08-29 — idx_agent_runs__one_live_per_support), so the ONLY thing that
  // can decline a reservation here is the cap — which is exactly what these
  // tests isolate.
  let n = 0;
  function reserve(phase = "Preparing workspace") {
    n += 1;
    return reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: `res-${n}`,
      role: "Reviewer",
      kind: "reviewer",
      backend: "claude",
      model: "claude-sonnet-4-5",
      agentProfileId: `reviewer-res-${n}`,
      credentialUserId: store.users.arda.id,
      phase,
    });
  }

  it("a reserved run holds a slot while preparing (counts as live, no adapter yet)", () => {
    setMaxConcurrentRuns(store.db, 1);
    const res = reserve();
    expect(res).not.toBeNull();
    // The reserved row is `running` for the strip, but no adapter launched.
    expect(getRun(store.db, res!.runId)?.state).toBe("running");
    // The cap must SEE it — otherwise a second run would slip past during the clone.
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, live: 1 });
  });

  it("declines a reservation when the cap is full — the bug: it used to grant one anyway", () => {
    setMaxConcurrentRuns(store.db, 1);
    const first = reserve();
    expect(first).not.toBeNull();
    // Second dispatch under cap=1: before the fix this returned a running
    // reservation and the specialist launched immediately (cap bypassed). Now null,
    // so the caller starts it through the gated `queued` path instead.
    const second = reserve();
    expect(second).toBeNull();
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, live: 1 });
  });

  it("two reserved runs fit under cap 2; a third is declined", () => {
    setMaxConcurrentRuns(store.db, 2);
    expect(reserve()).not.toBeNull();
    expect(reserve()).not.toBeNull();
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 2, live: 2 });
    expect(reserve()).toBeNull();
  });

  it("abandoning a reservation frees its slot and drains a queued run into it", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const res = reserve();
    expect(res).not.toBeNull();
    // A normal run now exceeds the cap (the reservation holds the one slot) → queued.
    const held = await startHeldRun("held");
    await settle();
    expect(getRun(store.db, held)?.state).toBe("queued");

    // The reserved run's preparation fails → abandon() releases the slot and the
    // queued run promotes.
    res!.abandon("preparation failed");
    await settle();
    expect(getRun(store.db, res!.runId)?.state).toBe("error");
    expect(getRun(store.db, held)?.state).toBe("running");
  });

  it("cap 0 (unlimited) always grants the reservation", () => {
    setMaxConcurrentRuns(store.db, 0);
    expect(reserve()).not.toBeNull();
    expect(reserve()).not.toBeNull();
    expect(reserve()).not.toBeNull();
  });

  it("F28-R1: INTERRUPTING a still-reserved run frees its slot and drains a queued run", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const res = reserve();
    expect(res).not.toBeNull();
    // A normal run now exceeds the cap (the reservation holds the one slot) → queued.
    const held = await startHeldRun("held");
    await settle();
    expect(getRun(store.db, held)?.state).toBe("queued");

    // The human presses Stop on the "Preparing workspace" strip DURING the clone
    // — before the reservation ever adopts an adapter. Before F28-R1 interruptRun
    // marked the row `interrupted` but LEFT it in `state.reserved`, so the queued
    // run stayed parked until the abandoned clone finished on its own (~15 min).
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: res!.runId, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, res!.runId)?.state).toBe("interrupted");
    // The freed slot promotes the queued run NOW, not 15 minutes from now.
    expect(getRun(store.db, held)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, live: 1 });
  });
});

/**
 * Ruling 152(b) (pass 35, G35-5): under a cap the coordination turns have their
 * own lane. Live, fourteen operator turns waited ten minutes behind six
 * four-minute builds because `admitRun` and `drainRunQueue` were one FIFO with
 * no idea of kind. Now an operator or controller turn is admitted up to
 * `cap + coordinationLane(cap)` (one extra slot per four of the cap, minimum
 * one) and the drain promotes the coordination queue before the delivery one.
 * A delivery run still only ever competes for the cap itself.
 */
describe("run concurrency cap — the coordination lane (ruling 152)", () => {
  /** An operator turn that stays live until interrupted — the coordination
   *  kind. Operator rows carry no single-flight index, so several coexist on
   *  one task under distinct thread ids. */
  async function startHeldCoordinationRun(
    threadId: string,
    kind: "operator" | "controller" = "operator",
  ): Promise<string> {
    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "deciding" }],
      keepRunning: true,
    });
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId,
      role: kind === "operator" ? "Operator" : "Controller",
      kind,
      backend: "claude",
      model: "claude-sonnet-4-5",
      agentProfileId: kind,
      credentialUserId: store.users.arda.id,
      prompt: "decide on VIB-1",
      dataRoot: store.dataRoot,
    });
    return runId;
  }

  function interrupt(runId: string) {
    return interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId, dataRoot: store.dataRoot },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
  }

  it("an operator turn launches in the lane past a full cap; a third delivery run parks", async () => {
    // Canary: admit every kind through the delivery bound (drop the lane from
    // `admissionBound`) and the operator lands `queued` behind the two builds.
    setMaxConcurrentRuns(store.db, 2);
    const a = await startHeldRun("d0");
    const b = await startHeldRun("d1");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("running");

    const op = await startHeldCoordinationRun("op-0");
    const c = await startHeldRun("d2");
    await settle();
    expect(getRun(store.db, op)?.state).toBe("running");
    expect(getRun(store.db, c)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toEqual({
      cap: 2,
      lane: 1,
      live: 3,
      queued: 1,
    });
  });

  it("a controller turn takes the lane the same way", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("d0");
    const ctl = await startHeldCoordinationRun("controller", "controller");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, ctl)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, lane: 1, live: 2 });
  });

  it("a freed cap slot goes back to the parked build once coordination holds its whole lane", async () => {
    // The lane's own slot is unconditional (the test below: a freed lane slot
    // goes to the parked operator turn ahead of the parked build). Past it, a
    // coordination turn is only BORROWING a cap slot, and a parked build wants
    // that slot back. Canary: drop the `state.pending.delivery.length === 0`
    // clause from `canAdmit` and the third operator turn takes the freed slot
    // again while the build keeps waiting under a cap with delivery room.
    setMaxConcurrentRuns(store.db, 2);
    const a = await startHeldRun("d0");
    const b = await startHeldRun("d1");
    const op1 = await startHeldCoordinationRun("op-1");
    await settle();
    expect(getRun(store.db, op1)?.state).toBe("running"); // the lane's one slot
    // The delivery run is queued BEFORE the second operator turn: FIFO order
    // alone would promote it first.
    const c = await startHeldRun("d2");
    const op2 = await startHeldCoordinationRun("op-2");
    await settle();
    expect(getRun(store.db, c)?.state).toBe("queued");
    expect(getRun(store.db, op2)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ live: 3, queued: 2 });

    // A build finishes: the cap has a delivery slot free again and the lane's
    // one slot is already held by op1, so the BUILD launches and the second
    // operator turn keeps waiting. Three live: two under the cap, one in the
    // lane.
    await interrupt(a);
    await settle();
    expect(getRun(store.db, c)?.state).toBe("running");
    expect(getRun(store.db, op2)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 2, lane: 1, live: 3, queued: 1 });

    // The first operator turn ends: the lane is free, so the parked operator
    // turn takes it beside the two builds.
    await interrupt(op1);
    await settle();
    expect(getRun(store.db, op2)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 2, lane: 1, live: 3, queued: 0 });

    await interrupt(op2);
    await settle();
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 2, lane: 1, live: 2, queued: 0 });
  });

  it("a coordination backlog never starves delivery: two borrowed slots, and the build still goes", async () => {
    // The reported deadlock (G35-5 ran fourteen operator turns against six
    // builds): coordination's bound used to contain delivery's, so every freed
    // slot was re-lent to the next parked operator turn and a build waited
    // with the cap's own delivery slot held by coordination.
    setMaxConcurrentRuns(store.db, 1);
    const op1 = await startHeldCoordinationRun("op-1");
    const op2 = await startHeldCoordinationRun("op-2"); // borrows the cap slot
    await settle();
    expect(getRun(store.db, op1)?.state).toBe("running");
    expect(getRun(store.db, op2)?.state).toBe("running");

    const build = await startHeldRun("d0");
    const op3 = await startHeldCoordinationRun("op-3");
    await settle();
    expect(getRun(store.db, build)?.state).toBe("queued");
    expect(getRun(store.db, op3)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 1, lane: 1, live: 2, queued: 2 });

    // One operator turn ends. The lane still holds op2, so the freed slot is
    // the borrowed cap slot: it goes to the build, not to op3.
    await interrupt(op1);
    await settle();
    expect(getRun(store.db, build)?.state).toBe("running");
    expect(getRun(store.db, op3)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 1, lane: 1, live: 2, queued: 1 });
  });

  it("a live operator turn never costs a build its slot: the cap counts delivery runs", async () => {
    // Canary: bound delivery by the TOTAL live count (`liveCount(state) < cap`
    // in `canAdmit`) and the build parks behind the operator turn at cap 1,
    // which is the "capped at 1, 1 run live" an admin would read as a cap
    // that does not hold for builds.
    setMaxConcurrentRuns(store.db, 1);
    const op = await startHeldCoordinationRun("op-0");
    await settle();
    expect(getRun(store.db, op)?.state).toBe("running");
    // The cap's one delivery slot is still free: the build launches.
    const a = await startHeldRun("d0");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    // Cap + lane = 2 slots are now held: a second build (cap full) and a second
    // operator turn (total full) both park.
    const b = await startHeldRun("d1");
    const op2 = await startHeldCoordinationRun("op-1");
    await settle();
    expect(getRun(store.db, b)?.state).toBe("queued");
    expect(getRun(store.db, op2)?.state).toBe("queued");
    expect(runConcurrencySnapshot(store.db)).toEqual({ cap: 1, lane: 1, live: 2, queued: 2 });

    // The operator turn ends: the freed slot goes to the parked operator turn,
    // not to the build (the cap's delivery slot is still taken by `a`).
    await interrupt(op);
    await settle();
    expect(getRun(store.db, op2)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("queued");
  });

  it("an operator's reservation is granted against the lane, and the lane fills too", () => {
    // The operator drive reserves its row before its clone (operator-run);
    // that reservation used to be declined by a full delivery cap, demoting
    // the turn to the stripless queued path. It now commits a lane slot.
    setMaxConcurrentRuns(store.db, 1);
    const build = reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "res-build",
      role: "Reviewer",
      kind: "reviewer",
      backend: "claude",
      model: "claude-sonnet-4-5",
      agentProfileId: "reviewer-res-build",
      credentialUserId: store.users.arda.id,
      phase: "Preparing workspace",
    });
    expect(build).not.toBeNull();
    const reserveOperator = (threadId: string) =>
      reserveRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId,
        role: "Operator",
        kind: "operator",
        backend: "claude",
        model: "claude-sonnet-4-5",
        agentProfileId: "operator",
        credentialUserId: store.users.arda.id,
        phase: "Preparing workspace",
      });
    const op = reserveOperator("res-op-1");
    expect(op).not.toBeNull();
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, lane: 1, live: 2 });
    // The lane is one slot at cap 1: a second operator reservation is declined
    // and falls through to the queued path like any run past its bound.
    expect(reserveOperator("res-op-2")).toBeNull();
  });

  it("cap 0 carries no lane", () => {
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 0, lane: 0 });
  });
});
