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
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { installFakeRuntime, queueFakeRun } from "../../../test-support/fake-runtime";
import { getRun } from "./run-store.server";
import {
  drainRunQueue,
  interruptRun,
  reserveRun,
  runConcurrencySnapshot,
  startRun,
} from "./run-service.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";

/**
 * The instance run-concurrency cap: `handles.size` (live adapters) is the ground
 * truth, so a run past the cap is parked `queued` and its adapter is not
 * launched until a live slot frees (drainRunQueue on onExit). A run interrupted
 * while queued is dropped, never sprung to life.
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  installFakeRuntime();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

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

  it("drains the oldest queued run when a live run finishes", async () => {
    setMaxConcurrentRuns(store.db, 1);
    const a = await startHeldRun("r0");
    const b = await startHeldRun("r1");
    await settle();
    expect(getRun(store.db, a)?.state).toBe("running");
    expect(getRun(store.db, b)?.state).toBe("queued");

    // Interrupt a → its slot frees → b promotes and launches.
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, a)?.state).toBe("interrupted");
    expect(getRun(store.db, b)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ live: 1, queued: 0 });
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
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: b },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    expect(getRun(store.db, b)?.state).toBe("interrupted");

    // Now free the live slot: a finishes → the drain skips the interrupted b and
    // promotes c instead.
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a },
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
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: a },
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
    const { assignSpecialist } = await import("~/server/tasks/specialist-run.server");
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

    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: dispatched.runId },
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
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: res!.runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(getRun(store.db, res!.runId)?.state).toBe("interrupted");
    // The freed slot promotes the queued run NOW, not 15 minutes from now.
    expect(getRun(store.db, held)?.state).toBe("running");
    expect(runConcurrencySnapshot(store.db)).toMatchObject({ cap: 1, live: 1 });
  });
});
