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
import type {
  ParsedTaskFile,
  Recommendation,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";

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
 * push-workspace + pr-open are stubbed through `performDelivery`'s ctx `deps`
 * seam so it reaches the `result.status === "ok"` branch without git or GitHub;
 * operator-run is stubbed the same way because R18-2's full-autonomy re-queue
 * reaches `runOperator` through `autoInvokeOperator`, which reads the seam
 * before its dynamic import. Every double is typed against the REAL export, so
 * every `mockResolvedValue` below has to be a member of the actual result
 * union — and the real modules stay loaded for everything the seam doesn't
 * name.
 */
const pushMock = vi.fn<typeof pushWorkspaceBranch>(async () => ({
  status: "pushed",
  branch: "vib-1",
  commits: 1,
  headSha: "a".repeat(40),
  remoteHeadBefore: null,
}));

const openTaskPrMock = vi.fn<typeof openTaskPr>(async () => ({
  status: "ok",
  prNumber: 147,
  created: true,
  url: "http://x/pull/147",
}));

const runOp = vi.fn<typeof runOperator>(async () => ({
  runId: null,
  queued: true,
  backend: "claude" as const,
  autonomy: "full" as const,
}));

const DEPS = {
  pushWorkspaceBranch: pushMock,
  openTaskPr: openTaskPrMock,
  runOperator: runOp,
};

import { performDelivery, OPERATOR_TASK_ACTOR } from "./task-actions.server";

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
    ],
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
  // `recommendations` and `packet` are set only when the case supplies them —
  // an absent key inherits the fixture default, a present one overrides it.
  const frontmatterPatch: Partial<TaskFrontmatter> = {
    stage: patch.stage ?? "impl",
    readiness: "ready",
    ownerUserId: store.users.arda.id,
    title: "Add the KB grounding probe",
  };
  if (patch.recommendations) frontmatterPatch.recommendations = patch.recommendations;
  const file: Partial<ParsedTaskFile> & { frontmatter: TaskFrontmatter } = {
    frontmatter: baseTaskFrontmatter("VIB-1", frontmatterPatch),
    goal: "Prove a delivered task is actionable without the operator volunteering it.",
  };
  if (patch.packet) file.packet = patch.packet;
  writeTask(store.dataRoot, store.slug, file);
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
    { dataRoot: store.dataRoot, operatorAuthorized: true, deps: DEPS },
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

/** Poll a fire-and-forget effect to completion. `autoInvokeOperator` awaits a
 *  dynamic import before it reaches `runOperator`; on a cold module graph that
 *  resolves past a fixed 5ms flush, so a fixed wait reports module-load timing,
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

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  installFakeRuntime();
  runOp.mockClear();
  pushMock.mockClear();
  pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 1, headSha: "a".repeat(40), remoteHeadBefore: null });
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

/**
 * F32-7 (pass 32). The `resolve_remote_collision` decision re-delivers through
 * `manualDeliverForReview` — the HUMAN door — and `performDelivery` records no
 * next step for a human who just clicked Deliver (R18-2/R19-4); the packet kind
 * sits in NO_REQUEUE on the promise that the re-delivery owns the follow-up.
 * Live (VIB-1): after the ceremony the task sat at In Progress, `waiting:
 * human`, an open PR, and nothing to click. The collision arm now mirrors the
 * operator-delivery split: supervised records the server-attributed card,
 * full autonomy re-queues the operator with the `delivered` trigger.
 */
describe("F32-7 — a collision resolution's redelivery leaves a next step", () => {
  const COLLISION_PACKET: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "Branch vib-1 collides with an unrelated remote branch",
    body: "deliver_for_review push-conflicted: the remote branch holds unrelated commits.",
    observations: [],
    options: [
      {
        kind: "resolve_remote_collision",
        t: "Delete the stale remote branch, then redeliver",
        d: "",
        rec: true,
      },
      { kind: "custom", t: "Something else", d: "", rec: false },
    ],
  };

  async function resolveCollision(): Promise<void> {
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const { resolvePacket } = await import("./task-actions.server");
    const patActor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_collision00000000000000000000009" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    const github = fakeGithubFetch({
      // Ruling 128: the delivery reads the base ref before pushing.
      "GET /repos/akin-ozer/viberr/git/ref/heads/main": { body: { object: { sha: "c".repeat(40) } } },
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1": { status: 204, body: "" },
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        waiting: "human",
        readiness: "blocked",
        branch: "vib-1",
        operator: { assignedAtStageId: "ready" },
        workRevision: {
          id: "rev_collision9",
          headSha: "e".repeat(40),
          treeSha: "f".repeat(40),
          branch: "vib-1",
          createdAt: new Date().toISOString(),
          sourceProfileId: "developer",
          kind: "delivered",
        },
        github: { commits: [], changed: null, unownedPr: 232 },
      }),
      packet: COLLISION_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl, deps: DEPS },
    );
    // The redelivery really went out through the injected doors.
    expect(openTaskPrMock).toHaveBeenCalled();
  }

  it("supervised: the server records the Move-to-Review card after the redelivery", async () => {
    deployOperator("supervised");
    await resolveCollision();
    const pending = recs();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "transition", toStageId: "review" });
    expect(pending[0]!.detail).toContain("Recorded by Viberr");
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    // The lift stays delivery-gated (V11) and the block is gone.
    expect(file.parsed.frontmatter.readiness).toBe("ready");
    expect(file.parsed.packet).toBeNull();
  });

  it("full autonomy: the operator is re-queued with the delivered trigger — exactly once, no card", async () => {
    deployOperator("full");
    await resolveCollision();
    await waitFor(() => runOp.mock.calls.length > 0, "the delivered re-queue");
    expect(runOp.mock.calls[0]![1]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "delivered",
    });
    // `performDelivery`'s own R18-2 arm is the ONE re-queue; the collision arm
    // must not add a second operator run on top of it.
    await flush();
    expect(runOp).toHaveBeenCalledTimes(1);
    expect(recs()).toHaveLength(0);
  });
});

/**
 * F33-3 (pass 33) — a delivery that opens the review PR on the task's branch
 * falsifies the collision, and both records of it have to go.
 *
 * Live (VIB-1): the reconciler had recorded `github.unownedPr: 265` and the
 * operator had opened a collision packet. The delivery was then done by hand and
 * PR #270 opened on `vib-1` at the FIRST attempt — yet `unownedPr` stayed 265
 * and the packet stayed open, so its confirm dialog offered to delete "the stale
 * branch `vib-1` … the unrelated one squatting on this task's branch name" and
 * to close "its pull request #265": the task's own live branch, carrying its own
 * commit and its own open PR.
 */
describe("F33-3 — a delivery that links a PR on the branch clears the collision", () => {
  /** The operator's collision packet as VIB-1 carried it: an `input` decision,
   *  not a `blocked` one — the type F29-7's withdrawal predicate required. */
  const COLLISION_PACKET: TaskPacket = {
    type: "input",
    kind: "Blocked decision",
    from: "operator",
    title: "Branch vib-1 collides with an unrelated remote branch",
    body: "An unrelated PR stands on this task's branch name.",
    observations: [],
    options: [
      {
        kind: "resolve_remote_collision",
        t: "Delete the stale remote branch, then redeliver",
        d: "",
        rec: true,
      },
      { kind: "custom", t: "Something else", d: "", rec: false },
    ],
  };

  function seedCollided(): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "human",
        branch: "vib-1",
        ownerUserId: store.users.arda.id,
        github: { commits: [], changed: null, unownedPr: 265 },
      }),
      goal: "Prove the collision record dies with the collision.",
      packet: COLLISION_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /** A HUMAN delivery — no `operatorAuthorized`, so no next-step card competes
   *  for the assertions below. `openTaskPr` returning `ok` is the whole point:
   *  it refuses with `branch_collision` while a foreign PR really holds the ref. */
  async function humanDeliver(): Promise<string> {
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot, deps: DEPS },
      store.slug,
      "VIB-1",
      { userId: store.users.arda.id, label: "Arda" },
    );
    return outcome.status;
  }

  it("clears the stale `github.unownedPr` record", async () => {
    seedCollided();
    expect(await humanDeliver()).toBe("delivered");
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.unownedPr ?? null).toBeNull();
    // The rest of the GitHub cache is untouched — only the falsified fact goes.
    expect(fm.github?.commits).toEqual([]);
  });

  it("withdraws the moot collision packet whatever `type` the operator gave it", async () => {
    seedCollided();
    expect(await humanDeliver()).toBe("delivered");
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.packet).toBeNull();
    expect(
      file.parsed.timeline.some(
        (e) => e.text?.includes("**Packet withdrawn:**") === true,
      ),
    ).toBe(true);
  });

  it("leaves an acceptance packet alone — only the collision kind is moot", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "human",
        branch: "vib-1",
        ownerUserId: store.users.arda.id,
        github: { commits: [], changed: null, unownedPr: 265 },
      }),
      goal: "An acceptance packet survives a delivery.",
      packet: {
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Accept completion?",
        body: "b",
        observations: [],
        options: [
          { kind: "accept_completion", t: "Accept completion", d: "", rec: true },
          {
            kind: "resolve_remote_collision",
            t: "…or clear the collision first",
            d: "",
            rec: false,
          },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(await humanDeliver()).toBe("delivered");
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.packet).not.toBeNull();
    // …and the falsified record still goes: the two are independent.
    expect(file.parsed.frontmatter.github?.unownedPr ?? null).toBeNull();
  });
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
      reason: "remote rejected",
    });
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
      reason: "no commits ahead of the default branch",
      defaultBranchEvidence: { verified: true },
    });
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
    // Ruling 134(b): a reuse re-queues nothing only when the push moved
    // nothing; a moved head is a new review subject (delivery-requeue C2).
    pushMock.mockResolvedValueOnce({ status: "up_to_date", branch: "vib-1", headSha: "a".repeat(40) });
    expect(await deliver()).toBe("delivered");
    await flush();
    // R18-2/R19-4: the guaranteed card is the SUPERVISED safety net only. Under
    // full autonomy the operator drives, so it is never handed a card — and a
    // reuse whose push moved nothing re-queues nothing, so full-autonomy-reuse
    // leaves neither a re-queue nor a card. (A's owner-ruled gate overruled B's
    // broader "card as the safety net" here.)
    expect(runOp).not.toHaveBeenCalled();
    expect(recs()).toHaveLength(0);
  });
});
