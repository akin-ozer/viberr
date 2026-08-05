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

vi.mock("~/server/runtimes/operator-run.server", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("~/server/runtimes/operator-run.server")
  >();
  return {
    ...mod,
    runOperator: vi.fn(async () => ({
      runId: null,
      queued: true,
      backend: "claude" as const,
      autonomy: "full" as const,
    })),
  };
});

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

function seedTask(): void {
  // No delivering engagement → the post-push reconcile block is skipped.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Deliver and proceed",
    }),
    goal: "Prove the operator re-queues after a full-autonomy delivery.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

async function flush(): Promise<void> {
  // autoInvokeOperator is fire-and-forget (`void`) — let its microtasks settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
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
    await flush();
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(runOp.mock.calls[0]![1]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "delivered",
    });
  });

  it("B. supervised does NOT re-trigger, and still delivers", async () => {
    deployOperator("supervised");
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
