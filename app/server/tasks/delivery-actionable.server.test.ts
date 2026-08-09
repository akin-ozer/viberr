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
import { decisionsRequiring } from "~/server/projections/decisions.server";
import { listNotifications } from "~/server/projections/notifications.server";
import type { Recommendation, TaskPacket } from "~/schemas/task-file.schema";

/**
 * F19-1 — a SUCCESSFUL delivery must leave the task with an actionable next
 * step, and that guarantee must not depend on the operator model volunteering
 * one.
 *
 * Live evidence (pass 19, one project, one Supervised policy, three runs):
 * VC-1's operator pushed the branch, opened PR #147 and narrated *"the task will
 * move to Review; no further action needed this turn"* — which was FALSE
 * (`impl → review` is an `approval` boundary and its `stage-transitions`
 * capability is `recommend`, so nothing moved). It recorded no recommendation and
 * no packet: the task sat `waiting: human` with an open PR and nothing on any
 * surface pointing at it. VC-4 and VC-5, same operator and same policy, DID
 * record "Move the task to Review".
 *
 * `performDelivery` now records that transition recommendation itself when
 * nothing else made the task actionable. The default test project IS VC-1's
 * shape: `impl → review` at an `approval` boundary (GOVERNED_TEMPLATE).
 *
 * push-workspace + pr-open are mocked so `performDelivery` reaches the
 * `result.status === "ok"` branch without git or GitHub; operator-run is mocked
 * because R18-2's full-autonomy re-queue reaches `runOperator` through
 * `autoInvokeOperator`'s dynamic import.
 */

// NO `importOriginal()` spread here. `autoInvokeOperator` reaches `runOperator`
// through a DYNAMIC import, and spreading the real module let that import race
// the mock registry — on a cold module graph it resolved the REAL function while
// the test held the mocked one, so G/H measured which module instance won a
// cache, not whether delivery re-queued. Declaring every export the code under
// test needs keeps one instance (same reasoning as delivery-requeue's mock).
vi.mock("~/server/runtimes/operator-run.server", () => ({
  runOperator: vi.fn(async () => ({
    runId: null,
    queued: true,
    backend: "claude" as const,
    autonomy: "full" as const,
  })),
  resetOperatorLeasesForTests: () => {},
}));

const pushMock = vi.fn(async () => ({ status: "pushed", branch: "vib-1" }));
vi.mock("~/server/github/push-workspace.server", () => ({
  pushWorkspaceBranch: (...args: unknown[]) => pushMock(...(args as [])),
}));

const openTaskPrMock = vi.fn(async () => ({
  status: "ok" as const,
  prNumber: 147,
  created: true,
  url: "http://x/pull/147",
}));
vi.mock("~/server/github/pr-open.server", () => ({
  openTaskPr: (...args: unknown[]) => openTaskPrMock(...(args as [])),
}));

import { runOperator } from "~/server/runtimes/operator-run.server";
import { performDelivery, OPERATOR_TASK_ACTOR } from "./task-actions.server";

const runOp = vi.mocked(runOperator);

let ctx: TestDbContext;
let store: TestStore;

/** Deploy the operator with a parameterized autonomy (as delivery-requeue does). */
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

/** VC-1's task: mid-flow at `impl`, owned, nothing pending. */
function seedTask(
  patch: {
    stage?: string;
    recommendations?: Recommendation[];
    packet?: TaskPacket | null;
  } = {},
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: patch.stage ?? "impl",
      readiness: "ready",
      ownerUserId: store.users.arda.id,
      title: "Add the KB grounding probe",
      ...(patch.recommendations ? { recommendations: patch.recommendations } : {}),
    }),
    goal: "Prove a delivered task is actionable without the operator volunteering it.",
    ...(patch.packet ? { packet: patch.packet } : {}),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

async function deliver(): Promise<string> {
  // R19-4/A's owner-ruled gate (2026-08-06): the delivered next-step card is
  // recorded ONLY for an operator-authorized SUPERVISED delivery. `deliver()`
  // stands in for the OPERATOR delivering (OPERATOR_TASK_ACTOR), whose real path
  // (`operatorDeliverForReview`) sets `operatorAuthorized: true`; a human who
  // clicks Deliver reaches `performDelivery` without it and gets no card.
  const outcome = await performDelivery(
    store.db,
    { dataRoot: store.dataRoot, operatorAuthorized: true },
    store.slug,
    "VIB-1",
    OPERATOR_TASK_ACTOR,
  );
  return outcome.status;
}

function recs(): Recommendation[] {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed.frontmatter.recommendations;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

/** Poll a fire-and-forget effect to completion. `autoInvokeOperator` awaits two
 *  dynamic imports before it reaches `runOperator`; on a cold module graph those
 *  resolve past a fixed 5ms flush, so a fixed wait reports module-load timing,
 *  not behaviour. Poll instead, with a ceiling that still fails loudly. */
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
  pushMock.mockClear();
  pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1" });
  openTaskPrMock.mockClear();
  openTaskPrMock.mockResolvedValue({
    status: "ok",
    prNumber: 147,
    created: true,
    url: "http://x/pull/147",
  });
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("F19-1 — a successful delivery leaves an actionable next step", () => {
  it("A. the VC-1 strand: a supervised delivery records exactly one transition recommendation to Review", async () => {
    deployOperator("supervised");
    seedTask();
    expect(await deliver()).toBe("delivered");

    const pending = recs();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "transition",
      toStageId: "review",
      label: "Move the task to Review",
    });
    // Honest attribution: never dressed up as the model's own reasoning.
    expect(pending[0]!.detail).toContain("Recorded by Viberr");
    expect(pending[0]!.detail).toContain("not the operator agent's judgement");
    expect(pending[0]!.detail).toContain("#147");

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.waiting).toBe("human");
    // The system authored it — the timeline says so.
    const note = file.parsed.timeline.find((e) => e.type === "note");
    expect(note?.actor).toMatchObject({ kind: "system", systemId: "delivery" });

    // …and the task now reaches every "waiting on you" surface (decisionsRequiring
    // is the single source the bell, Home, the board chip and the queue share).
    const mine = decisionsRequiring(store.db, store.users.arda.id).mine;
    expect(mine).toEqual([
      { projectSlug: store.slug, taskKey: "VIB-1", kind: "recommendation", stage: "impl" },
    ]);

    // The bell rings, and the notice is NOT signed by the operator (the default
    // sender) — the agent must never appear to have written it.
    const inbox = listNotifications(store.db, store.users.arda.id).filter(
      (n) => n.taskKey === "VIB-1",
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      kind: "approval",
      title: "Next step recorded: Move the task to Review",
      waitingOnYou: true,
    });
    expect(inbox[0]!.from).toMatchObject({ kind: "system", name: "Delivery" });
  });

  it("B. an operator that ALREADY recommended the move gets no duplicate", async () => {
    deployOperator("supervised");
    seedTask({
      recommendations: [
        {
          id: "rec_operator",
          kind: "transition",
          toStageId: "review",
          label: "Move the task to Review",
          detail: "The implementation is complete and the tests pass.",
        },
      ],
    });
    expect(await deliver()).toBe("delivered");

    const pending = recs();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("rec_operator");
    expect(pending[0]!.detail).toBe(
      "The implementation is complete and the tests pass.",
    );
  });

  it("C. a FAILED delivery records nothing", async () => {
    deployOperator("supervised");
    seedTask();
    pushMock.mockResolvedValue({
      status: "push_failed",
      branch: "vib-1",
      reason: "remote rejected",
    } as never);
    expect(await deliver()).toBe("push_failed");
    expect(recs()).toHaveLength(0);
  });

  it("C2. a no-commits delivery keeps the R19-8 no-change path, not a move card", async () => {
    deployOperator("supervised");
    seedTask();
    // A's DefaultBranchEvidence gate: `no_commits` is a verified zero-diff only
    // when push-workspace confirmed a clean tree on the default branch — without
    // it the outcome is a genuine failure, not the no-change path.
    pushMock.mockResolvedValue({
      status: "no_commits",
      branch: "vib-1",
      defaultBranchEvidence: { verified: true },
    } as never);
    expect(await deliver()).toBe("nothing_to_review");
    expect(recs()).toHaveLength(0);
  });

  it("D. a SECOND delivery does not add a second card (NFR16)", async () => {
    deployOperator("supervised");
    seedTask();
    expect(await deliver()).toBe("delivered");
    const first = recs();
    expect(first).toHaveLength(1);

    // A retry re-opens/reuses the same PR.
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 147,
      created: false,
      url: "http://x/pull/147",
    });
    expect(await deliver()).toBe("delivered");
    const second = recs();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("E. an OPEN decision packet is already the actionable surface", async () => {
    deployOperator("supervised");
    seedTask({
      packet: {
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Which base branch should this target?",
        body: "",
        observations: [],
        options: [],
      },
    });
    expect(await deliver()).toBe("delivered");
    expect(recs()).toHaveLength(0);
  });

  it("F. a task already AT the review stage gets no move card", async () => {
    deployOperator("supervised");
    seedTask({ stage: "review" });
    expect(await deliver()).toBe("delivered");
    expect(recs()).toHaveLength(0);
  });

  it("G. R18-2 is untouched: full autonomy re-queues the operator and records NO card", async () => {
    deployOperator("full");
    seedTask();
    expect(await deliver()).toBe("delivered");
    await waitFor(() => runOp.mock.calls.length > 0, "the re-queued operator run");
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(runOp.mock.calls[0]![1]).toMatchObject({ trigger: "delivered" });
    expect(recs()).toHaveLength(0);
  });

  it("H. full autonomy that REUSES a PR re-queues nothing and records NO card", async () => {
    deployOperator("full");
    seedTask();
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 147,
      created: false,
      url: "http://x/pull/147",
    });
    expect(await deliver()).toBe("delivered");
    await flush();
    // R18-2/R19-4: the guaranteed card is the SUPERVISED safety net only. Under
    // full autonomy the operator drives, so it is never handed a card — and a
    // reuse (created:false) re-queues nothing, so full-autonomy-reuse leaves
    // neither a re-queue nor a card. (A's owner-ruled gate overruled B's broader
    // "card as the safety net" here.)
    expect(runOp).not.toHaveBeenCalled();
    expect(recs()).toHaveLength(0);
  });
});
