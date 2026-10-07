import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { actorOf, baseTaskFrontmatter, writeTask, type TestStore } from "../../../test-support/test-store";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { flush, pollUntil } from "../../../test-support/polling";
import { createConversation } from "~/server/controller/controller-conversations.server";
import { claimFollowUp, openFollowUps, setFollowUp } from "~/server/controller/controller-follow-ups.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { followUpOpening, maybeContinueController } from "./controller-continuation.server";
import type { TaskActionDeps } from "./task-action-core.server";
import { transitionStage } from "./task-transitions.server";

/**
 * Ruling 683 (owner, 2026-10-07: the controller continues when the task it
 * filed is accepted). Asked for a content-free template, the controller filed
 * the task that makes one and ended with "tell me when it is approved and I'll
 * replace the files": the second half of one request, left for the person to
 * remember.
 *
 * The turn and the operator's hand-off are the only things stubbed, through
 * the task doors' own seam: a real one starts a model on a person's account.
 */
const runControllerTurn = vi.fn<NonNullable<TaskActionDeps["runControllerTurn"]>>();
const runOp = vi.fn<typeof runOperator>(async () => ({
  runId: null,
  queued: true,
  backend: "claude" as const,
  autonomy: "supervised" as const,
}));

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupProjectedStore(ctx);
  deployDeliveryOperator(store, "supervised");
  runControllerTurn.mockReset();
  runControllerTurn.mockResolvedValue({ state: "started", runId: "run_ctl", messageId: "msg_1" });
  runOp.mockClear();
});

afterEach(() => ctx.cleanup());

const STEP =
  "Copy proposal-template.html and proposal-template.pdf from VIB-1 into the rulings knowledge base as templates, then write the rule.";

function taskAt(stage: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage, ownerUserId: store.users.arda.id }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** Selin asked the controller on the board, and it left its next step on VIB-1. */
function selinWaitsOnVib1(): string {
  const conversation = createConversation(store.db, {
    userId: store.users.selin.id,
    userLabel: store.users.selin.email,
    projectSlug: store.slug,
  });
  setFollowUp(store.db, {
    conversationId: conversation.id,
    userId: store.users.selin.id,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    text: STEP,
  });
  return conversation.id;
}

const deps = (): TaskActionDeps => ({ runControllerTurn, runOperator: runOp });
const hookCtx = () => ({ dataRoot: store.dataRoot, deps: deps() });
const notes = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline.filter(
    (event) => event.title?.startsWith("Controller follow-up"),
  );
const outcome = () =>
  store.db.prepare(`SELECT fired_at, outcome FROM controller_follow_ups WHERE task_key = 'VIB-1'`).get();

describe("ruling 683: the controller continues when a task it waits on is accepted", () => {
  it("starts the conversation's next turn once, as the person who asked, when somebody accepts the task", async () => {
    taskAt("review");
    const conversationId = selinWaitsOnVib1();

    // Arda accepts on the board: the door a person's Accept goes through.
    // CANARY: drop `maybeContinueController` from the acceptance and the step
    // waits for a person to remember it, as it did live.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      hookCtx(),
    );
    expect(await pollUntil(() => runControllerTurn.mock.calls.length > 0)).toBe(true);
    await flush();

    // CANARY: start it as whoever accepted and the turn runs under another
    // person's permissions, in a conversation that is not theirs.
    // CANARY: let it steer and a reply the person is waiting for is redirected
    // by a message nobody typed.
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
    expect(runControllerTurn.mock.calls[0]![1]).toEqual({
      conversationId,
      text: followUpOpening("VIB-1", STEP),
      user: {
        id: store.users.selin.id,
        email: store.users.selin.email,
        name: store.users.selin.name,
        // Selin is a member of the instance, and an admin of nothing.
        orgRole: "member",
      },
      surface: `/projects/${store.slug}/tasks/VIB-1`,
      mode: "queue",
      dataRoot: store.dataRoot,
    });
    expect(followUpOpening("VIB-1", STEP)).toBe(
      "VIB-1 was accepted. This conversation left a follow-up for that moment, and Viberr started it " +
        `(nobody typed this message):\n\n${STEP}`,
    );
    // Taken, with what became of it, and nothing said on the task: the
    // conversation carries the turn.
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
    expect(outcome()).toMatchObject({ outcome: "started" });
    expect(notes()).toEqual([]);

    // CANARY: start a turn for every call and the two doors an acceptance
    // passes through (or two people pressing Accept) answer the step twice.
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
  });

  it("hands a follow-up to one caller", () => {
    // The hook reads and claims in one go today; the claim is what keeps it
    // one turn should anything ever wait between the two.
    // CANARY: answer every claim with yes and two callers that both read the
    // step as open each start its turn.
    taskAt("review");
    selinWaitsOnVib1();
    const [waiting] = openFollowUps(store.db, store.slug, "VIB-1");
    expect(claimFollowUp(store.db, waiting!.id)).toBe(true);
    expect(claimFollowUp(store.db, waiting!.id)).toBe(false);
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
  });

  it("starts nothing while the task is anywhere but its last stage", async () => {
    // CANARY: continue on any move and a send-back to an earlier stage, which
    // is the opposite of an acceptance, installs what was not approved.
    taskAt("review");
    selinWaitsOnVib1();
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toHaveLength(1);
  });

  it("says on the task what was to happen when the turn cannot start", async () => {
    // CANARY: drop the note and a step that did not start is recorded nowhere
    // a person looks: the task is Done and nothing came of it.
    taskAt("done");
    selinWaitsOnVib1();
    runControllerTurn.mockResolvedValue({
      state: "refused",
      reason: "Claude is not connected on your account, and the controller runs on the account of the person who asks it",
    });
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => notes().length > 0)).toBe(true);
    expect(notes().map((event) => [event.title, event.text])).toEqual([
      [
        "Controller follow-up not started",
        `This task was accepted, and the controller was to continue with: ${STEP} ` +
          "It was not started: Claude is not connected on your account, and the controller runs on the account of the person who asks it. " +
          "Ask the controller for that step yourself.",
      ],
    ]);
    expect(outcome()).toMatchObject({
      outcome:
        "not started: Claude is not connected on your account, and the controller runs on the account of the person who asks it.",
    });
    // It is not tried again: the step is a person's now.
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
  });

  it("starts nothing for a person whose account is gone, and says so", async () => {
    // CANARY: skip the account check and a turn is started for a person who
    // can no longer sign in, under the permissions they used to hold.
    taskAt("done");
    selinWaitsOnVib1();
    store.db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(store.users.selin.id);
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => notes().length > 0)).toBe(true);
    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(notes()[0]!.text).toContain("It was not started: The person who asked for it has no active account.");
  });
});
