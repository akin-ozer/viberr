import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMutationContext } from "~/server/tasks/task-mutation.server";
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
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { flush, waitFor } from "../../../test-support/polling";

/**
 * R18-2 / F18-10 — a FULL-autonomy delivery re-queues the operator so an
 * autonomous task never strands `waiting:human` after the review PR opens;
 * SUPERVISED delivery deliberately does not (the human is the driver).
 *
 * The re-trigger reaches `runOperator` via `autoInvokeOperator`, which reads
 * the delivery ctx's `deps` seam before its dynamic import — so the stub is
 * injected there rather than by mocking the downstream module. push-workspace +
 * pr-open ride the same seam, driving `performDelivery` straight to the
 * `result.status === "ok"` branch with a NEWLY-opened PR, without git or
 * GitHub. Every double is typed against the REAL export, and the real modules
 * stay loaded for everything the seam doesn't name.
 */
import type { runOperator } from "~/server/runtimes/operator-run.server";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import type { TaskPacket } from "~/schemas/task-file.schema";
import {
  performDelivery,
  OPERATOR_TASK_ACTOR,
} from "./task-actions.server";

const runOp = vi.fn<typeof runOperator>(async () => ({
  runId: null,
  queued: true,
  backend: "claude" as const,
  autonomy: "full" as const,
}));

const pushMock = vi.fn<typeof pushWorkspaceBranch>(async () => ({
  status: "pushed",
  branch: "vib-1",
  commits: 1,
  headSha: "a".repeat(40),
  remoteHeadBefore: null,
workflowFiles: [],
}));

const openTaskPrMock = vi.fn<typeof openTaskPr>(async () => ({
  status: "ok",
  prNumber: 7,
  created: true,
  url: "http://x/pull/7",
}));

const DEPS = {
  pushWorkspaceBranch: pushMock,
  openTaskPr: openTaskPrMock,
  runOperator: runOp,
};

let ctx: TestDbContext;
let store: TestStore;

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

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  installFakeRuntime();
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
    deployDeliveryOperator(store, "full");
    seedTask();
    // Operator-authorized, as the operator's own delivery is, so the missing
    // card below is withheld by the autonomy and not by a missing authorization.
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true, deps: DEPS },
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
    // R19-4: the card is the SUPERVISED safety net; under full autonomy the
    // operator is the next step. CANARY: make the card's `else if` a plain
    // `if` and a card lands beside the re-queue.
    expect(taskFm().recommendations).toHaveLength(0);
  });

  it("C. ruling 357: a LIVE operator drive's own delivery queues no turn; it stamps the drive instead", async () => {
    // CANARY: drop the `ctx.operatorRun` arm before the re-queue (the seam
    // fires once and the stamp is missing).
    deployDeliveryOperator(store, "full");
    seedTask();
    const operatorRun: NonNullable<TaskMutationContext["operatorRun"]> = {
      backend: "claude",
      autonomy: "full",
      reactDepth: 0,
      transitionDepth: 0,
    };
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true, operatorRun, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome).toMatchObject({ status: "delivered", moved: true, operatorRequeued: false });
    await flush();
    expect(runOp).not.toHaveBeenCalled();
    expect(operatorRun.deliveredHeadMoved).toBe(true);
    expect(operatorRun.actedAfterDelivery).toBeUndefined();
  });

  it("B. supervised does NOT re-trigger — but LEAVES an actionable next step (R19-4)", async () => {
    deployDeliveryOperator(store, "supervised");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true, deps: DEPS },
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
    expect(fm.recommendations[0]!.detail).toContain("pull request #7");
    expect(fm.waiting).toBe("human");
  });

  it("C. a PR REUSE whose push pushed NOTHING (`up_to_date`) does not re-trigger, even under full autonomy", async () => {
    // Ruling 134(b): a reuse that pushed nothing moved nothing.
    pushMock.mockResolvedValueOnce({ status: "up_to_date", branch: "vib-1", headSha: "a".repeat(40) });
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 7,
      created: false,
      url: "http://x/pull/7",
    });
    deployDeliveryOperator(store, "full");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome).toMatchObject({ status: "delivered", moved: false, operatorRequeued: false });
    await flush();
    expect(runOp).not.toHaveBeenCalled();
    // A reuse that re-queued nothing still hands full autonomy no card: the
    // card is never the safety net here (R18-2/R19-4).
    expect(taskFm().recommendations).toHaveLength(0);
  });

  it("C2. ruling 134(b): a reuse whose push MOVED the head re-queues exactly once", async () => {
    // Canary: revert the re-queue condition to `if (result.created)` and no run is queued.
    openTaskPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 7,
      created: false,
      url: "http://x/pull/7",
    });
    deployDeliveryOperator(store, "full");
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome).toMatchObject({ status: "delivered", created: false, moved: true, operatorRequeued: true });
    await waitFor(() => runOp.mock.calls.length > 0, "the re-queued operator run");
    await flush();
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(runOp.mock.calls[0]![1]).toMatchObject({ trigger: "delivered" });
  });

  it("D. no operator deployed → no re-trigger, delivery still ok", async () => {
    // A project with a repo but no operator agent.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: "akin-ozer/viberr",
      agents: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedTask();
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
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
 * R20-1 (F20-5) — resolving a failure packet re-queues the operator with the
 * dedicated `packet-resolved` trigger, EXCEPT for the documented NO_REQUEUE set
 * (`hold_runtime_debug` asked for no run). Reuses the same `runOperator` mock.
 */
/**
 * Ruling 240 (F37-61, owner): a HELD task refuses delivery, the same way ruling
 * 186 made every dispatch door refuse it.
 *
 * Ruling 186's own live case is the argument: SHOP-2 was marked "Held until
 * every entry is done" and a run "pushed a branch cut from a base that predated
 * the foundation it waited on". Publishing that branch to a review PR is
 * `performDelivery`, which had no `blockedBy` check at all — while the
 * operator's turn instruction told it the server refused this door.
 */
describe("ruling 240 — a held task refuses delivery", () => {
  it("refuses before anything is pushed, in the same words the dispatch gate uses", async () => {
    deployDeliveryOperator(store, "full");
    seedTask({ blockedBy: ["VIB-2", "VIB-3"] });
    const pushesBefore = pushMock.mock.calls.length;

    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );

    // CANARY: delete the hold block at the top of `performDelivery` and this
    // reads "delivered" — the branch is pushed and the PR opened on a base that
    // predates the work the task is waiting for.
    expect(outcome.status).toBe("failed");
    // Narrowed before reading `message`: only the failed variant carries one.
    const failed = outcome.status === "failed" ? outcome : null;
    expect(failed?.message).toContain("VIB-1 waits on VIB-2 and VIB-3");
    expect(failed?.message).toContain("delivering it for review is refused");

    // Nothing reached the remote. Counted from a baseline rather than asserted
    // as "never called": `pushMock` is NOT cleared in this file's beforeEach
    // (only `runOp` and `openTaskPrMock` are), so a bare not.toHaveBeenCalled()
    // passes alone and fails after any sibling test — and its failure output
    // formats the recorded `db` handle, which is closed by then, so the real
    // assertion is buried under "database is not open".
    expect(pushMock.mock.calls.length).toBe(pushesBefore);
    expect(openTaskPrMock).not.toHaveBeenCalled();
    // And the refusal is on the record, not just in the return value.
    const events = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!
      .parsed.timeline.map((e) => e.text)
      .join("\n");
    expect(events).toContain("delivering it for review is refused");
  });

  it("delivers normally the moment nothing is held", async () => {
    // The gate keys on the list being non-empty, so an empty one must not cost
    // a delivery. CANARY: gate on the key's presence rather than its length.
    deployDeliveryOperator(store, "full");
    seedTask({ blockedBy: [] });
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    expect(outcome.status).toBe("delivered");
  });
});

describe("R20-1 — a settled recovery decision re-queues the operator", () => {
  const FAILURE_PACKET: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "Operator run failed — pick a recovery path",
    body: "",
    observations: [],
    options: [
      { kind: "block_on_policy", t: "Unblock and re-run", d: "", rec: true },
      { kind: "hold_runtime_debug", t: "Hold", d: "", rec: false },
    ],
  };

  it("block_on_policy re-queues runOperator with trigger 'packet-resolved'", async () => {
    deployDeliveryOperator(store, "supervised");
    seedTask({ stage: "impl", waiting: "human", readiness: "blocked" }, FAILURE_PACKET);
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot, deps: DEPS },
    );
    await waitFor(() => runOp.mock.calls.length > 0, "the re-queued operator run");
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(runOp.mock.calls[0]![1]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "packet-resolved",
      resolvedOption: { kind: "block_on_policy" },
    });
  });

  /**
   * Ruling 224 (F37-44). The decision IS that nothing runs until the window
   * reopens; the schedule the resolution writes is what brings the operator
   * back. Live on SHOP-18 the re-invoke fired seven seconds after the decision
   * was recorded, was refused by the very quota the human had just chosen to
   * wait out, and opened a NEW packet asking the same question — so answering
   * the decision re-created it, in a loop.
   */
  it("wait_for_window does NOT re-queue: the schedule is what comes back (ruling 224)", async () => {
    deployDeliveryOperator(store, "supervised");
    seedTask(
      { stage: "impl", waiting: "agent", readiness: "blocked" },
      {
        ...FAILURE_PACKET,
        options: [
          {
            kind: "wait_for_window",
            t: "Wait for the window and pick the task back up automatically",
            d: "",
            rec: true,
            dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    );
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot, deps: DEPS },
    );
    await flush();
    // The wait really was recorded, so "no run" cannot pass because nothing
    // happened at all.
    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.schedules).toHaveLength(1);

    // Settled far longer than a re-queue needs: the sibling test above resolves
    // `block_on_policy` on this same harness and sees its call, so a call here
    // would be observable — "not called" is a real absence, not a race won by
    // being too fast.
    await new Promise((r) => setTimeout(r, 1_000));
    // CANARY: remove `wait_for_window` from NO_REQUEUE and this fires — a run
    // against the very quota the decision exists to wait out, which live on
    // SHOP-18 was refused and opened a NEW packet asking the same question.
    expect(runOp).not.toHaveBeenCalled();
  });

  /**
   * Ruling 230 (F37-50). The decision IS the wait, so the same rule as
   * `wait_for_window`: re-invoking the operator would pay a drive to rediscover
   * the hold it was just told about (JC-9's five runs), and ruling 131(d)
   * refuses the held triggers at the door anyway.
   *
   * What makes this worth its own test rather than a line in a list: the hold
   * has to be REAL. Before this ruling the nearest option was
   * `block_on_policy`, whose resolution sets `readiness: ready` and
   * `waiting: agent` — so an option titled "Hold SHOP-11 while…" produced the
   * record "SHOP-11 is unblocked", measured live at 04:12 UTC.
   */
  it("block_on_dependencies records a REAL hold and does NOT re-queue (ruling 230)", async () => {
    deployDeliveryOperator(store, "supervised");
    seedTask(
      { stage: "impl", waiting: "agent", readiness: "blocked" },
      {
        ...FAILURE_PACKET,
        options: [
          {
            kind: "block_on_dependencies",
            t: "Hold until the gateway work lands",
            d: "",
            rec: true,
            blockedBy: ["VIB-2"],
          },
        ],
      },
    );
    // The hold's target has to EXIST: `setTaskDependencies` validates the refs,
    // and a hold on a task that is not there would be a hold nothing can ever
    // release. Discovered by this test failing exactly that way first.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "The gateway work this one waits on",
      }),
      goal: "Stand in for the blocking task.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot, deps: DEPS },
    );
    await flush();

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.packet).toBeNull();
    // The hold is on the file, written through the same door every other
    // dependency edit uses — not a sentence in an event.
    expect(parsed.frontmatter.blockedBy).toEqual(["VIB-2"]);
    // And the record says wait, not "unblocked".
    const decision = parsed.timeline.find((e) => e.type === "transition")!;
    expect(decision.text).toContain("waits on VIB-2");
    expect(decision.text).not.toContain("unblocked");

    await new Promise((r) => setTimeout(r, 1_000));
    // CANARY: remove `block_on_dependencies` from NO_REQUEUE.
    expect(runOp).not.toHaveBeenCalled();
  });

  it("ruling 230: a hold that cannot be written says so and never un-resolves the decision", async () => {
    // Found by accident — the test above failed this way first, because its
    // target did not exist. `setTaskDependencies` validates the refs, which is
    // right: a hold on a task that is not there releases on nothing. What must
    // not happen is the decision being thrown away because its side effect
    // failed, which is why the write is best-effort and narrated.
    //
    // Canary: make the post-write effect throw instead of narrating.
    deployDeliveryOperator(store, "supervised");
    seedTask(
      { stage: "impl", waiting: "agent", readiness: "blocked" },
      {
        ...FAILURE_PACKET,
        options: [
          {
            kind: "block_on_dependencies",
            t: "Hold until the missing task lands",
            d: "",
            rec: true,
            blockedBy: ["VIB-404"],
          },
        ],
      },
    );
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot, deps: DEPS },
    );
    await flush();

    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    // The human's decision stands.
    expect(parsed.packet).toBeNull();
    // The hold did not land, and the record says so in words a person can act
    // on rather than leaving them to infer it from an empty list.
    expect(parsed.frontmatter.blockedBy).toEqual([]);
    const note = parsed.timeline.find((e) => /was \*\*not\*\* recorded as waiting on/.test(e.text));
    expect(note).toBeTruthy();
    expect(note!.text).toContain("set what it waits on from the task page");
    // And still no run: the decision was "do not run", and a failed side effect
    // does not turn that into a dispatch.
    await new Promise((r) => setTimeout(r, 300));
    expect(runOp).not.toHaveBeenCalled();
  });

  it("hold_runtime_debug does NOT re-queue (the human asked for no run)", async () => {
    deployDeliveryOperator(store, "supervised");
    seedTask({ stage: "impl", waiting: "human", readiness: "blocked" }, FAILURE_PACKET);
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot, deps: DEPS },
    );
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
  it("G. a HUMAN delivery gets no card — the person who clicked Deliver is present", async () => {
    // R15-2's human escape hatch reaches performDelivery WITHOUT
    // `operatorAuthorized`, and a human who just clicked the button needs no
    // "here is your next step" card.
    deployDeliveryOperator(store, "supervised");
    seedTask();
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
      store.slug,
      "VIB-1",
      { userId: store.users.arda.id, label: store.users.arda.email },
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
    deployDeliveryOperator(store, "supervised");
    seedTask();
    await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true, deps: DEPS },
      store.slug,
      "VIB-1",
      OPERATOR_TASK_ACTOR,
    );
    await flush();
    expect(taskFm().recommendations).toHaveLength(1);
    expect(taskFm().recommendations[0]!.toStageId).toBe("review");
  });
});
