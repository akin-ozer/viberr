import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { installFakeRuntime } from "../../../test-support/fake-runtime";

/**
 * R18-2 / F18-10 — a FULL-autonomy delivery re-queues the operator so an
 * autonomous task never strands `waiting:human` after the review PR opens;
 * SUPERVISED delivery deliberately does not (the human is the driver).
 *
 * The re-trigger reaches `runOperator` via `autoInvokeOperator`'s dynamic import,
 * so we mock the downstream operator-run module (mocking task-actions itself would
 * not intercept the same-module internal call). push-workspace + pr-open are mocked
 * to drive `performDelivery` straight to the `result.status === "ok"` branch with a
 * NEWLY-opened PR, without git or GitHub.
 */

// NO `importOriginal()` here. Spreading the real module made its evaluation
// race the mock registry: `autoInvokeOperator` reaches `runOperator` through a
// DYNAMIC import, and on some module-graph orders that import resolved the REAL
// function while the test file held the mocked one — so the assertion measured
// which module instance won a cache, not whether delivery re-queued the
// operator. Declaring every export the code under test needs keeps one instance.
vi.mock("~/server/runtimes/operator-run.server", () => ({
  runOperator: vi.fn(async () => ({
    runId: null,
    queued: true,
    backend: "claude" as const,
    autonomy: "full" as const,
  })),
  resetOperatorLeasesForTests: () => {},
}));

vi.mock("~/server/github/push-workspace.server", () => ({
  pushWorkspaceBranch: vi.fn(async () => ({ status: "pushed", branch: "vib-1" })),
}));

const openTaskPrMock = vi.fn(async () => ({
  status: "ok" as const,
  prNumber: 7,
  created: true,
  url: "http://x/pull/7",
}));
vi.mock("~/server/github/pr-open.server", () => ({
  openTaskPr: (...args: unknown[]) => openTaskPrMock(...(args as [])),
}));

import { runOperator } from "~/server/runtimes/operator-run.server";
import {
  performDelivery,
  OPERATOR_TASK_ACTOR,
} from "./task-actions.server";

const runOp = vi.mocked(runOperator);

let ctx: TestDbContext;
let store: TestStore;

/** Deploy ONLY the operator, with a parameterized autonomy on its definition. */
function deployOperator(autonomy: "full" | "supervised"): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: "akin-ozer/viberr",
    agents: [
      {
        profileId: "operator",
        capabilities: [{ capabilityId: "deliver-review-pr", mode: "direct" }],
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: ["claude"],
          model: "sonnet",
          autonomy,
        },
      },
    ] as never,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function seedTask(
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
  packet: Parameters<typeof writeTask>[2]["packet"] = null,
): void {
  // No delivering engagement → the post-push reconcile block is skipped.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Deliver and proceed",
      ...patch,
    }),
    goal: "Prove the operator re-queues after a full-autonomy delivery.",
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function taskFm() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed.frontmatter;
}

async function flush(): Promise<void> {
  // autoInvokeOperator is fire-and-forget (`void`) — let its microtasks settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

/**
 * Wait for a fire-and-forget effect to actually land.
 *
 * A fixed `flush()` cannot express this: `autoInvokeOperator` awaits TWO
 * dynamic imports before it ever reaches `runOperator`, and on a cold module
 * graph those resolve well past a 5ms timer — so the fixed wait passed or
 * failed depending on what the rest of the suite had already imported. That is
 * a test that reports module-load timing, not behavior. Poll the condition
 * instead, with a ceiling that still fails loudly if the effect never happens.
 */
async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  installFakeRuntime();
  const { resetOperatorLeasesForTests } = await import(
    "~/server/runtimes/operator-run.server"
  );
  resetOperatorLeasesForTests();
  runOp.mockClear();
  openTaskPrMock.mockClear();
  openTaskPrMock.mockResolvedValue({
    status: "ok",
    prNumber: 7,
    created: true,
    url: "http://x/pull/7",
  });
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("R18-2 — a full-autonomy delivery re-queues the operator", () => {
  it("A. full autonomy enqueues exactly one follow-up operator run with the `delivered` trigger", async () => {
    deployOperator("full");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome.status).toBe("delivered");
    await waitFor(() => runOp.mock.calls.length > 0, "the re-queued operator run");
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(runOp.mock.calls[0]![1]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "delivered",
    });
  });

  it("B. supervised does NOT re-trigger — but LEAVES an actionable next step (R19-4)", async () => {
    deployOperator("supervised");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome.status).toBe("delivered");
    await flush();
    expect(runOp).not.toHaveBeenCalled();
    // R19-4 (F19-1): VC-1 delivered and settled `waiting:human` with NOTHING to
    // act on. The server now guarantees the card.
    const fm = taskFm();
    expect(fm.recommendations).toHaveLength(1);
    expect(fm.recommendations[0]).toMatchObject({
      kind: "transition",
      toStageId: "review",
      label: "Move the task to Review",
    });
    expect(fm.recommendations[0]!.detail).toContain("PR #7");
    expect(fm.waiting).toBe("human");
  });

  it("C. a PR REUSE (created:false) does not re-trigger, even under full autonomy", async () => {
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 7,
      created: false,
      url: "http://x/pull/7",
    });
    deployOperator("full");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome.status).toBe("delivered");
    await flush();
    expect(runOp).not.toHaveBeenCalled();
  });

  it("D. no operator deployed → no re-trigger, delivery still ok", async () => {
    // A project with a repo but no operator agent.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: "akin-ozer/viberr",
      agents: [] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome.status).toBe("delivered");
    await flush();
    expect(runOp).not.toHaveBeenCalled();
  });
});

/**
 * R19-4 (F19-1, owner ruling 2026-08-06) — after a SUPERVISED operator delivery
 * the server GUARANTEES an actionable next step. Live: VC-1 was left
 * `waiting:human` with no recommendation, no packet and no chip while the
 * operator narrated "the task will move to Review; no further action needed".
 */
describe("R19-4 — a supervised delivery always leaves something to act on", () => {
  it("E. the operator's OWN 'Move to Review' card dedupes with the guaranteed one", async () => {
    deployOperator("supervised");
    seedTask({
      recommendations: [
        {
          id: "rec_model",
          kind: "transition",
          toStageId: "review",
          label: "Move the task to Review",
          detail: "The operator recorded this itself.",
        },
      ],
    });
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    await flush();
    const recs = taskFm().recommendations;
    expect(recs).toHaveLength(1);
    // The operator's own card survives — the guarantee is a floor, not a rewrite.
    expect(recs[0]!.id).toBe("rec_model");
  });

  it("F. an OPEN packet is already the next step — no card is stacked on it", async () => {
    deployOperator("supervised");
    seedTask(
      { readiness: "input_required", waiting: "human" },
      {
        id: "pkt_1",
        type: "input",
        kind: "Decision required",
        from: "operator",
        title: "Which API shape?",
        body: "Two options.",
        observations: [],
        options: [{ kind: "redirect", t: "Take option A", d: "", rec: true }],
      },
    );
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    await flush();
    expect(taskFm().recommendations).toHaveLength(0);
    expect(readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.packet).not.toBeNull();
  });

  it("G. a HUMAN delivery gets no card — the person who clicked Deliver is present", async () => {
    // R15-2's human escape hatch reaches performDelivery WITHOUT
    // `operatorAuthorized`, and a human who just clicked the button needs no
    // "here is your next step" card.
    deployOperator("supervised");
    seedTask();
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await flush();
    expect(taskFm().recommendations).toHaveLength(0);
  });

  it("H. a task already AT the review stage gets no redundant move card", async () => {
    deployOperator("supervised");
    seedTask({ stage: "review" });
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    await flush();
    expect(taskFm().recommendations).toHaveLength(0);
  });

  it("I. a PR REUSE still gets the guarantee (the human's next step is the same)", async () => {
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 7,
      created: false,
      url: "http://x/pull/7",
    });
    deployOperator("supervised");
    seedTask();
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    await flush();
    expect(taskFm().recommendations).toHaveLength(1);
    expect(taskFm().recommendations[0]!.toStageId).toBe("review");
  });
});
