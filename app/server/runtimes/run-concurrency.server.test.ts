import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { installFakeRuntime, queueFakeRun } from "../../../test-support/fake-runtime";
import { getRun } from "./run-store.server";
import {
  interruptRun,
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
 *  thread ids so several coexist on one task (reviewers stream concurrently). */
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
    agentProfileId: "reviewer",
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
});
