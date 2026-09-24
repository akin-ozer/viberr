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
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import {
  currentCorrelation,
  runWithRequestContext,
  type RequestCorrelation,
} from "~/server/logging/request-context.server";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { getRun } from "./run-store.server";
import { configureRunServiceForTests, startRun } from "./run-service.server";

/**
 * Ruling 458(d): a run's own work (its adapter stream, the sink, the settle and
 * the completion callbacks) logs under its `runId` and `taskKey`, plus the
 * request and user that started it. The logger merges `currentCorrelation()`
 * into every record, so what the adapter's work SEES here is what its records
 * carry.
 *
 * Two traps this pins: every continuation of a request shares ONE correlation
 * object, so a run binding in place would re-stamp the run started before it
 * (and the request's own records); and a run parked behind the concurrency cap
 * is launched from the continuation of whichever run frees the slot, so without
 * carrying its own correlation it would log under that run's request and user.
 */

type Seen = Partial<RequestCorrelation> | undefined;

function snapshot(): Seen {
  const current = currentCorrelation();
  return current ? { ...current } : undefined;
}

interface RecordedRun {
  spec: RunSpec;
  /** What the adapter saw as `start` was called. */
  atStart: Seen;
  /** Lets the run's work go on: it looks again, then exits. Resolves with
   *  what that later look saw. */
  finish(): Promise<Seen>;
}

/** An adapter whose runs wait for the test, and whose later work runs where a
 *  real stream's would: in a continuation made inside `start`. */
class CorrelationProbeAdapter implements RuntimeAdapter {
  readonly backend = "claude" as const;
  readonly runs: RecordedRun[] = [];

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    const atStart = snapshot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const later = gate.then(() => {
      const seen = snapshot();
      callbacks.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: null });
      return seen;
    });
    this.runs.push({
      spec,
      atStart,
      finish: () => {
        release();
        return later;
      },
    });
    return { runId: spec.runId, interrupt() {} };
  }
}

let ctx: TestDbContext;
let store: TestStore;
let adapter: CorrelationProbeAdapter;

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
  resetSseBrokerForTests();
  adapter = new CorrelationProbeAdapter();
  configureRunServiceForTests({ claude: adapter, codex: adapter });
  // Ruling 127: every run here bills VIB-1's owner.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A reviewer run on VIB-1; distinct threads and profiles so several coexist. */
async function start(threadId: string): Promise<string> {
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

function recorded(runId: string): RecordedRun {
  const run = adapter.runs.find((r) => r.spec.runId === runId);
  if (!run) throw new Error(`the adapter never started ${runId}`);
  return run;
}

describe("a run's records name the run and the request behind it (ruling 458(d))", () => {
  it("its work carries runId and taskKey with the request's ids; the request's own records do not", async () => {
    // CANARY: drop the `bindCorrelation` in `launch` and `atStart` has no runId.
    const request = { requestId: "req_start", method: "POST", path: "/x", userId: "u_asker" };
    const { runId, afterStart } = await runWithRequestContext({ ...request }, async () => {
      const id = await start("r0");
      return { runId: id, afterStart: snapshot() };
    });
    const run = recorded(runId);
    const expected = { ...request, runId, taskKey: "VIB-1" };
    expect(run.atStart).toEqual(expected);
    expect(await run.finish()).toEqual(expected);
    expect(afterStart).toEqual(request);
  });

  it("a second run started in the same request does not re-stamp the first", async () => {
    // CANARY: bind in place instead of in `forkCorrelation` and the first run's
    // later work reads the second run's id.
    const [first, second] = await runWithRequestContext(
      { requestId: "req_two", userId: "u_asker" },
      async () => [await start("r0"), await start("r1")],
    );
    expect(await recorded(first).finish()).toMatchObject({ runId: first });
    expect(await recorded(second).finish()).toMatchObject({ runId: second });
  });

  it("a run parked behind the cap launches in its own request's correlation", async () => {
    // CANARY: park `launchThunk` itself (no `carryCorrelation`) and the parked
    // run starts under req_a / u_a, the request of the run that freed the slot.
    setMaxConcurrentRuns(store.db, 1);
    const running = await runWithRequestContext({ requestId: "req_a", userId: "u_a" }, () =>
      start("r0"),
    );
    const parked = await runWithRequestContext({ requestId: "req_b", userId: "u_b" }, () =>
      start("r1"),
    );
    expect(getRun(store.db, parked)?.state).toBe("queued");

    await recorded(running).finish();
    await settle();

    expect(recorded(parked).atStart).toEqual({
      requestId: "req_b",
      userId: "u_b",
      runId: parked,
      taskKey: "VIB-1",
    });
  });

  it("a run started outside any request binds nothing (boot recovery, timers)", async () => {
    const runId = await start("r0");
    expect(recorded(runId).atStart).toBeUndefined();
    expect(await recorded(runId).finish()).toBeUndefined();
  });
});
