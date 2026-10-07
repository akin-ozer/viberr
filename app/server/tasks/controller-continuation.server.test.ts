import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { actorOf, baseTaskFrontmatter, writeTask, type TestStore } from "../../../test-support/test-store";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { connectFakeBackend, disconnectFakeBackend } from "../../../test-support/backend-credentials";
import { listAuditEvents } from "../../../test-support/audit-log";
import { flush, pollUntil } from "../../../test-support/polling";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { disableUser } from "~/server/auth/user-admin.server";
import { appendMessage, createConversation } from "~/server/controller/controller-conversations.server";
import { deleteControllerConversation } from "~/server/controller/controller-deletion.server";
import {
  claimFollowUp,
  continuedOnItsOwnLast,
  openFollowUps,
  setFollowUp,
} from "~/server/controller/controller-follow-ups.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { followUpOpening, maybeContinueController } from "./controller-continuation.server";
import { resolvePacket } from "./packet-resolution.server";
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

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupProjectedStore(ctx);
  deployDeliveryOperator(store, "supervised");
  // The turn runs on the asker's own Claude account.
  await connectFakeBackend(store.db, store.users.selin.id, "claude");
  runControllerTurn.mockReset();
  runControllerTurn.mockResolvedValue({ state: "started", runId: "run_ctl", messageId: "msg_follow_up" });
  runOp.mockClear();
});

afterEach(() => ctx.cleanup());

const STEP =
  "Copy proposal-template.html and proposal-template.pdf from VIB-1 into the rulings knowledge base as templates, then write the rule.";

/** The decision an operator opens when a task is ready: accepting is one of its answers. */
const READY_PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "VIB-1 ready to accept",
  body: "",
  observations: [],
  options: [
    { kind: "request_edit", t: "Send back for one fix", d: "", rec: false },
    { kind: "accept_completion", t: "Accept VIB-1", d: "", rec: true },
  ],
};

function taskAt(stage: string, packet: TaskPacket | null = null): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage, ownerUserId: store.users.arda.id }),
    packet,
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
const row = () =>
  store.db.prepare(`SELECT fired_at, outcome, message_id FROM controller_follow_ups WHERE task_key = 'VIB-1'`).get();
const notStarted = (why: string) =>
  `This task was accepted, and the controller was to continue in Selin Test's conversation with: ${STEP} ` +
  `It was not started. ${why} That step is a person's to ask the controller for now.`;

describe("ruling 683: the controller continues when a task it waits on is accepted", () => {
  /** The two writers of a board's last stage: every acceptance is one of them. */
  const doors: [string, () => Promise<void>][] = [
    [
      "a person's Accept or board move",
      async () => {
        await transitionStage(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
          actorOf(store.users.arda),
          hookCtx(),
        );
      },
    ],
    [
      "the decision's accept option",
      async () => {
        await resolvePacket(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
          actorOf(store.users.arda),
          hookCtx(),
        );
      },
    ],
  ];
  it.each(doors)("starts the conversation's next turn once, as the person who asked, through %s", async (_door, accept) => {
    taskAt("review", READY_PACKET);
    const conversationId = selinWaitsOnVib1();

    // Arda accepts, by the door under test.
    // CANARY: call the hook from one writer of the last stage only and an
    // acceptance by the other leaves the step waiting for good, with the task
    // still saying the controller will continue.
    await accept();
    expect(await pollUntil(() => runControllerTurn.mock.calls.length > 0)).toBe(true);
    await flush();

    // CANARY: start it as whoever accepted and the turn runs under another
    // person's permissions, in a conversation that is not theirs.
    // CANARY: let it steer and a reply the person is waiting for is redirected
    // by a message nobody typed.
    // CANARY: give it the task page as its surface and the turn is told a
    // person is looking at that page.
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
    expect(runControllerTurn.mock.calls[0]![1]).toEqual({
      conversationId,
      text: followUpOpening(store.slug, "VIB-1", STEP),
      user: {
        id: store.users.selin.id,
        email: store.users.selin.email,
        name: store.users.selin.name,
        // Selin is a member of the instance, and an admin of nothing.
        orgRole: "member",
      },
      surface: null,
      mode: "queue",
      dataRoot: store.dataRoot,
    });
    // Taken, with what became of it and the message that opened the turn, and
    // nothing said on the task: the conversation carries the turn.
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
    expect(row()).toMatchObject({ outcome: "started", message_id: "msg_follow_up" });
    expect(notes()).toEqual([]);
    expect(listAuditEvents(store.db, { action: "controller.follow_up.started" })[0]).toMatchObject({
      actorUserId: null,
      taskKey: "VIB-1",
      details: { conversationId, forUserId: store.users.selin.id, state: "started" },
    });

    // CANARY: start a turn for every call and two people pressing Accept
    // answer the step twice.
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
  });

  it("opens the turn with a message that says who sent it and which project the task is in", () => {
    // CANARY: leave out who sent it and the transcript shows the person
    // saying something they never typed; leave out the project and a
    // conversation on Home is told a task key with nothing to find it by.
    expect(followUpOpening("aws-cost-calculator", "AWSC-119", "Install the template.")).toBe(
      "AWSC-119 in aws-cost-calculator was accepted. This conversation left a follow-up for that moment, and Viberr started it " +
        "(nobody typed this message):\n\nInstall the template.",
    );
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
    taskAt("review", READY_PACKET);
    selinWaitsOnVib1();
    // The decision's other answer sends the task back: the same door, no acceptance.
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0, note: "Fix the footer." },
      actorOf(store.users.arda),
      hookCtx(),
    );
    await flush();
    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toHaveLength(1);
  });

  /** Why a follow-up cannot start, each said about the asker by name. */
  const stops: [string, () => Promise<void> | void, string][] = [
    [
      "the asker's account is disabled",
      () => {
        disableUser(store.db, store.users.selin.id, { userId: store.users.arda.id, label: "arda" });
      },
      "The person who asked for it has no active account.",
    ],
    [
      "the asker left the project",
      async () => {
        await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (project) => {
          project.frontmatter.members = project.frontmatter.members.filter((m) => m.userId !== store.users.selin.id);
        });
        rebuildAll(store.db, { dataRoot: store.dataRoot });
      },
      "Selin Test is no longer a member of this project.",
    ],
    [
      "Claude is not connected on the asker's account",
      () => disconnectFakeBackend(store.db, store.users.selin.id, "claude"),
      "Claude is not connected on Selin Test's account, and the controller runs on the account of the person who asks it.",
    ],
  ];
  it.each(stops)("starts nothing and says so on the task when %s", async (_label, arrange, why) => {
    // CANARY: drop a check and a turn is started for a person who cannot sign
    // in, who cannot see the project any more, or whose conversation then
    // tells whoever accepted that "your" Claude is not connected.
    // CANARY: drop the note and a step that did not start is recorded nowhere
    // a person looks: the task is Done and nothing came of it.
    taskAt("done");
    const conversationId = selinWaitsOnVib1();
    await arrange();
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => notes().length > 0)).toBe(true);
    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(notes().map((event) => [event.title, event.text])).toEqual([
      ["Controller follow-up not started", notStarted(why)],
    ]);
    expect(row()).toMatchObject({ outcome: `not started: ${why}`, message_id: null });
    expect(listAuditEvents(store.db, { action: "controller.follow_up.not_started" })[0]).toMatchObject({
      taskKey: "VIB-1",
      details: { conversationId, forUserId: store.users.selin.id, why },
    });
    // It is not tried again: the step is a person's now.
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(notes()).toHaveLength(1);
  });

  it("quotes the conversation's own refusal, and goes on to the next follow-up", async () => {
    // Two conversations wait on the task. The first one's queue is full.
    // CANARY: let one failure end the loop and the second person's step is
    // never started, with nothing said.
    taskAt("done");
    selinWaitsOnVib1();
    const second = selinWaitsOnVib1();
    runControllerTurn.mockResolvedValueOnce({
      state: "refused",
      reason: "The controller is still answering and its queue for this conversation is full. Wait for the current reply.",
    });
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => runControllerTurn.mock.calls.length === 2)).toBe(true);
    await flush();
    // The engine's sentence is written to the asker; here it is quoted.
    expect(notes().map((event) => event.text)).toEqual([
      notStarted(
        'Selin Test\'s conversation answered: "The controller is still answering and its queue for this conversation is full. Wait for the current reply."',
      ),
    ]);
    expect(runControllerTurn.mock.calls[1]![1]).toMatchObject({ conversationId: second });
  });

  it("knows a turn it opened from one a person asked for", async () => {
    // CANARY: lose the opening message's id and a conversation that continued
    // on its own may arrange to do it again, with no person in between.
    taskAt("done");
    const conversationId = selinWaitsOnVib1();
    const say = (text: string) =>
      appendMessage(store.db, { conversationId, author: "user", userId: store.users.selin.id, text }).id;
    say("Make the template content-free.");
    expect(continuedOnItsOwnLast(store.db, conversationId)).toBe(false);
    // The engine records Viberr's message and answers with its id.
    runControllerTurn.mockImplementation(async (_db, turn) => ({
      state: "started",
      runId: "run_ctl",
      messageId: say(turn.text),
    }));
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => runControllerTurn.mock.calls.length > 0)).toBe(true);
    await flush();
    expect(continuedOnItsOwnLast(store.db, conversationId)).toBe(true);
    // A person writes: the next turn is theirs again.
    say("Thanks. Now do the same for the summary.");
    expect(continuedOnItsOwnLast(store.db, conversationId)).toBe(false);
  });

  it("goes with its conversation, and the task is told", async () => {
    // CANARY: keep a deleted conversation's step and the acceptance tries to
    // start a turn in a conversation that is gone.
    // CANARY: drop the note and the task goes on saying the controller will
    // continue when it is accepted.
    taskAt("review");
    const conversationId = selinWaitsOnVib1();
    deleteControllerConversation(
      store.db,
      { conversationId, projectSlug: store.slug, dataRoot: store.dataRoot },
      { userId: store.users.selin.id, label: store.users.selin.email },
    );
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
    expect(await pollUntil(() => notes().length > 0)).toBe(true);
    expect(notes().map((event) => [event.title, event.text])).toEqual([
      [
        "Controller follow-up dropped",
        "Selin Test's controller conversation was deleted, so it no longer continues when this task is accepted.",
      ],
    ]);
  });
});
