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
import {
  appendMessage,
  createConversation,
  getConversation,
  markSteered,
} from "~/server/controller/controller-conversations.server";
import { deleteControllerConversation } from "~/server/controller/controller-deletion.server";
import {
  claimFollowUp,
  openFollowUps,
  setFollowUp,
  turnOpenedByFollowUp,
} from "~/server/controller/controller-follow-ups.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { maybeContinueController } from "./controller-continuation.server";
import { resolvePacket } from "./packet-resolution.server";
import type { TaskActionDeps } from "./task-action-core.server";
import { transitionStage } from "./task-transitions.server";

/**
 * Ruling 684 (owner, 2026-10-07: the controller continues when the task it
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

/** A person asked the controller on the board, and it left its next step on VIB-1. */
function waitsOnVib1(user: { id: string; email: string }): string {
  const conversation = createConversation(store.db, {
    userId: user.id,
    userLabel: user.email,
    projectSlug: store.slug,
  });
  setFollowUp(store.db, {
    conversationId: conversation.id,
    userId: user.id,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    text: STEP,
  });
  return conversation.id;
}
const selinWaitsOnVib1 = () => waitsOnVib1(store.users.selin);
/** Take a person off the project's members. */
async function leavesTheProject(userId: string): Promise<void> {
  await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (project) => {
    project.frontmatter.members = project.frontmatter.members.filter((m) => m.userId !== userId);
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}
/** The rows the audited project guard writes in a person's name. */
const guardRows = () => [
  ...listAuditEvents(store.db, { action: "project.authority.denied" }),
  ...listAuditEvents(store.db, { action: "project.org_admin.override" }),
];

const deps = (): TaskActionDeps => ({ runControllerTurn, runOperator: runOp });
const hookCtx = () => ({ dataRoot: store.dataRoot, deps: deps() });
const notesOn = (taskKey: string) =>
  readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })!.parsed.timeline.filter((event) =>
    event.title?.startsWith("Controller follow-up"),
  );
const notes = () => notesOn("VIB-1");
const row = () =>
  store.db.prepare(`SELECT fired_at, outcome, message_id FROM controller_follow_ups WHERE task_key = 'VIB-1'`).get();
const notStarted = (why: string) =>
  `This task was accepted, and the controller was to continue in Selin Test's conversation with: ${STEP} ` +
  `It was not started. ${why} That step is a person's to ask the controller for now.`;

describe("ruling 684: the controller continues when a task it waits on is accepted", () => {
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
    // CANARY: leave out who sent the message and the transcript shows the
    // person saying something they never typed; leave out the project and a
    // conversation on Home is told a task key with nothing to find it by.
    expect(runControllerTurn).toHaveBeenCalledTimes(1);
    expect(runControllerTurn.mock.calls[0]![1]).toEqual({
      conversationId,
      text:
        "VIB-1 in viberr-core was accepted. This conversation left a follow-up for that moment, and Viberr started it " +
        `(nobody typed this message):\n\n${STEP}`,
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
    ["the asker left the project", () => leavesTheProject(store.users.selin.id), "Selin Test is no longer a member of this project."],
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
    // CANARY: check the asker with the guard their own actions go through and
    // the board's Activity says "Blocked: Selin tried to continue on this
    // task", at the moment somebody else accepted it.
    expect(guardRows()).toEqual([]);
    // It is not tried again: the step is a person's now.
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    await flush();
    expect(notes()).toHaveLength(1);
  });

  it("starts an org admin's step though they are no member of the project, with nothing recorded in their name", async () => {
    // Every controller tool lets an org admin act in any project, and records
    // the override when they do. Here they did nothing yet: the turn's own
    // calls record what it does.
    // CANARY: ask the member list alone and an org admin is told they left a
    // project their turn could have worked in.
    taskAt("done");
    await connectFakeBackend(store.db, store.users.arda.id, "claude");
    const conversationId = waitsOnVib1(store.users.arda);
    await leavesTheProject(store.users.arda.id);
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => runControllerTurn.mock.calls.length > 0)).toBe(true);
    await flush();
    expect(runControllerTurn.mock.calls[0]![1]).toMatchObject({ conversationId, user: { id: store.users.arda.id, orgRole: "admin" } });
    expect(guardRows()).toEqual([]);
  });

  /** A start that fails: what the engine did, and what the task is told. */
  const failures: [string, () => void, string][] = [
    [
      "its conversation refuses the message",
      () => {
        runControllerTurn.mockResolvedValueOnce({
          state: "refused",
          reason: "The controller is still answering and its queue for this conversation is full. Wait for the current reply.",
        });
      },
      // The engine's sentence is written to the asker; here it is quoted.
      'Selin Test\'s conversation answered: "The controller is still answering and its queue for this conversation is full. Wait for the current reply."',
    ],
    [
      "starting the turn throws",
      () => {
        runControllerTurn.mockRejectedValueOnce(new Error("the session could not be resumed"));
      },
      "An error stopped it; the server's log has it.",
    ],
  ];
  it.each(failures)("says so on the task when %s, and goes on to the next conversation's step", async (_label, arrange, why) => {
    // Two of Selin's conversations wait on the task, and the first cannot start.
    // CANARY: let a refusal read as a start and a step that never ran is
    // recorded as running, with nothing said on the task.
    // CANARY: let a throw leave the function and the step is claimed, never
    // started and said nowhere but the server's log.
    taskAt("done");
    selinWaitsOnVib1();
    const second = selinWaitsOnVib1();
    arrange();
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => runControllerTurn.mock.calls.length === 2)).toBe(true);
    await flush();
    expect(notes().map((event) => event.text)).toEqual([notStarted(why)]);
    expect(runControllerTurn.mock.calls[1]![1]).toMatchObject({ conversationId: second });
  });

  it("knows the turn it opened from one a person asked for", async () => {
    taskAt("done");
    const conversationId = selinWaitsOnVib1();
    const say = (text: string) =>
      appendMessage(store.db, { conversationId, author: "user", userId: store.users.selin.id, text }).id;
    const asked = say("Make the template content-free.");
    // The engine records Viberr's message and answers with its id.
    let opened = "";
    runControllerTurn.mockImplementation(async (_db, turn) => {
      opened = say(turn.text);
      return { state: "queued", messageId: opened };
    });
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => runControllerTurn.mock.calls.length > 0)).toBe(true);
    await flush();
    // CANARY: lose the opening message's id and a conversation that continued
    // on its own may arrange to do it again, with no person in between.
    expect(turnOpenedByFollowUp(store.db, conversationId, opened)).toBe(true);
    // CANARY: ask the conversation's newest message and Selin's own turn,
    // still working when the task was accepted, is refused a step because of
    // a message it has not read.
    expect(turnOpenedByFollowUp(store.db, conversationId, asked)).toBe(false);
    // A message of hers waiting behind the turn Viberr opened is answered in
    // its own turn: it does not make this one hers.
    const later = say("Thanks. Now do the same for the summary.");
    expect(turnOpenedByFollowUp(store.db, conversationId, opened)).toBe(true);
    expect(turnOpenedByFollowUp(store.db, conversationId, later)).toBe(false);
    // Sent into the turn while it works, it does: a person is in it now.
    markSteered(store.db, getConversation(store.db, conversationId)!, [later], opened);
    expect(turnOpenedByFollowUp(store.db, conversationId, opened)).toBe(false);
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

  it("writes nothing into an archived task when its conversation is deleted", async () => {
    // CANARY: note every task and deleting a conversation changes a file a
    // read-only task holds, which no deletion does.
    for (const [key, archived] of [["VIB-1", true], ["VIB-2", false]] as const) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "review", ownerUserId: store.users.arda.id, archived }),
        packet: null,
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // One conversation waits on both: the archived task, then the open one.
    const conversationId = selinWaitsOnVib1();
    setFollowUp(store.db, {
      conversationId,
      userId: store.users.selin.id,
      projectSlug: store.slug,
      taskKey: "VIB-2",
      text: STEP,
    });
    deleteControllerConversation(
      store.db,
      { conversationId, projectSlug: store.slug, dataRoot: store.dataRoot },
      { userId: store.users.selin.id, label: store.users.selin.email },
    );
    // The open task is told, and by then the archived one would have been.
    expect(await pollUntil(() => notesOn("VIB-2").length > 0)).toBe(true);
    await flush();
    expect(notesOn("VIB-1")).toEqual([]);
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
  });

  it("writes nothing into an archived project when a conversation there is deleted", async () => {
    // CANARY: ask the task alone and a frozen project's task takes a note.
    taskAt("review");
    const conversationId = selinWaitsOnVib1();
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (project) => {
      project.frontmatter.archived = true;
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    deleteControllerConversation(
      store.db,
      { conversationId, projectSlug: store.slug, dataRoot: store.dataRoot },
      { userId: store.users.selin.id, label: store.users.selin.email },
    );
    await flush();
    await flush();
    expect(notes()).toEqual([]);
    expect(openFollowUps(store.db, store.slug, "VIB-1")).toEqual([]);
  });

  it("still tells the task when what became of the step cannot be recorded", async () => {
    // The write of the outcome fails, as it would on a full disk.
    // CANARY: let that failure leave the function and a step that could not
    // start is claimed and said nowhere: the task is Done and nothing came of it.
    taskAt("done");
    selinWaitsOnVib1();
    disableUser(store.db, store.users.selin.id, { userId: store.users.arda.id, label: "arda" });
    store.db.exec(
      `CREATE TRIGGER outcome_cannot_be_written BEFORE UPDATE OF outcome ON controller_follow_ups
       BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
    );
    maybeContinueController(store.db, hookCtx(), store.slug, "VIB-1");
    expect(await pollUntil(() => notes().length > 0)).toBe(true);
    expect(notes().map((event) => event.text)).toEqual([notStarted("The person who asked for it has no active account.")]);
    expect(row()).toMatchObject({ outcome: null });
  });
});
