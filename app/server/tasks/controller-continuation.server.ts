import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { findUserById } from "~/server/auth/user-store.server";
import {
  claimFollowUp,
  openFollowUps,
  recordFollowUpOutcome,
  type ControllerFollowUp,
} from "~/server/controller/controller-follow-ups.server";
import { runControllerTurn, type ControllerTurnInput } from "~/server/controller/controller-run.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { toError } from "~/shared/errors";
import { endSentence } from "~/shared/text/sentence";
import type { TaskActionContext } from "./task-action-core.server";
import { appendPolicyNote, taskRef, terminalStageIdFor } from "./task-mutation.server";

/**
 * Ruling 259: the words a follow-up turn opens with. The message stands in the
 * person's conversation as theirs, because the turn runs as them, so it says
 * who sent it; and it names the project, because a conversation on Home or on
 * another board has nothing else that does.
 */
function followUpOpening(projectSlug: string, taskKey: string, text: string): string {
  return (
    `${taskKey} in ${projectSlug} was accepted. This conversation left a follow-up for that moment, and Viberr started it ` +
    `(nobody typed this message):\n\n${text}`
  );
}

type FollowUpStart = { started: true; state: string; messageId: string } | { started: false; why: string };

/**
 * Whether the person may still act in the task's project: a member, or an org
 * admin, as every controller tool would find them. Read plainly. The guard
 * the tools use records a blocked attempt, or an org admin's override, in the
 * person's name, and here they did nothing: somebody else accepted a task.
 */
function stillInProject(db: DatabaseSync, ctx: TaskActionContext, projectSlug: string, userId: string): boolean {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return false;
  return project.parsed.frontmatter.members.some((m) => m.userId === userId) || isOrgAdmin(db, userId);
}

/**
 * Start the conversation's next turn, as the person who asked: a controller
 * turn runs on the asker's own Claude account (ruling 137) and under their
 * permissions, and the acceptance may be somebody else's. So the person is
 * checked as they stand now, before a message is put in their conversation:
 * an account that is gone, a project they no longer belong to and a Claude
 * that is not connected each stop it here, said about them by name. Queued, so
 * a turn already answering in that conversation is not steered by it. No
 * surface: nobody is looking at a page.
 */
async function startFollowUpTurn(
  db: DatabaseSync,
  ctx: TaskActionContext,
  followUp: ControllerFollowUp,
): Promise<FollowUpStart> {
  const user = findUserById(db, followUp.userId);
  if (!user || user.disabled) return { started: false, why: "The person who asked for it has no active account." };
  if (!stillInProject(db, ctx, followUp.projectSlug, user.id)) {
    return { started: false, why: `${user.name} is no longer a member of this project.` };
  }
  const health = ctx.dataRoot
    ? userBackendHealth(db, user.id, "claude", { dataRoot: ctx.dataRoot })
    : userBackendHealth(db, user.id, "claude");
  if (!health.available) {
    return {
      started: false,
      why: `Claude is not connected on ${user.name}'s account, and the controller runs on the account of the person who asks it.`,
    };
  }
  const turn: ControllerTurnInput = {
    conversationId: followUp.conversationId,
    text: followUpOpening(followUp.projectSlug, followUp.taskKey, followUp.text),
    user: { id: user.id, email: user.email, name: user.name, orgRole: user.role },
    surface: null,
    mode: "queue",
  };
  if (ctx.dataRoot) turn.dataRoot = ctx.dataRoot;
  const result = await (ctx.deps?.runControllerTurn ?? runControllerTurn)(db, turn);
  if (result.state === "refused") {
    // The engine's sentence is written to the person in their conversation,
    // where it already stands; here it is quoted, not said to whoever accepted.
    return { started: false, why: `${user.name}'s conversation answered: "${endSentence(result.reason)}"` };
  }
  return { started: true, state: result.state, messageId: result.messageId };
}

/** One follow-up, from the claim to the record of what became of it. */
async function continueWith(db: DatabaseSync, ctx: TaskActionContext, followUp: ControllerFollowUp): Promise<void> {
  if (!claimFollowUp(db, followUp.id)) return;
  let start: FollowUpStart;
  try {
    start = await startFollowUpTurn(db, ctx, followUp);
  } catch (error) {
    logger.warn("controller follow-up could not be started", {
      projectSlug: followUp.projectSlug,
      taskKey: followUp.taskKey,
      err: toError(error),
    });
    start = { started: false, why: "An error stopped it; the server's log has it." };
  }
  // What became of it: the outcome, the audit row, and the id of the message
  // that opened the turn, which is what the one-hop rule knows such a turn by
  // (a turn whose id could not be written here may leave a further step). A
  // failure must not cost the task its note below, which is where a person
  // learns the step is theirs.
  try {
    recordFollowUpOutcome(
      db,
      followUp.id,
      start.started ? start.state : `not started: ${start.why}`,
      start.started ? start.messageId : null,
    );
    recordAudit(db, {
      action: start.started ? "controller.follow_up.started" : "controller.follow_up.not_started",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: followUp.taskKey,
      projectSlug: followUp.projectSlug,
      taskKey: followUp.taskKey,
      details: start.started
        ? { conversationId: followUp.conversationId, forUserId: followUp.userId, state: start.state }
        : { conversationId: followUp.conversationId, forUserId: followUp.userId, why: start.why },
    });
  } catch (error) {
    logger.warn("controller follow-up outcome could not be recorded", {
      projectSlug: followUp.projectSlug,
      taskKey: followUp.taskKey,
      err: toError(error),
    });
  }
  if (start.started) return;
  const asker = findUserById(db, followUp.userId)?.name ?? "a person who is no longer here";
  await appendPolicyNote(db, ctx, followUp.projectSlug, followUp.taskKey, {
    title: "Controller follow-up not started",
    text:
      `This task was accepted, and the controller was to continue in ${asker}'s conversation with: ${endSentence(followUp.text)} ` +
      `It was not started. ${start.why} That step is a person's to ask the controller for now.`,
  });
}

/**
 * Ruling 259, the hook: a task may have been accepted. When it stands at the
 * board's last stage and a controller conversation left a follow-up on it,
 * that conversation's next turn is started with it. It reads the stage itself,
 * so both writers of the last stage call it and nothing else has to decide
 * whether this was an acceptance. Fire-and-forget, like the epic and
 * dependency checks; a task nobody waits on costs one indexed read, made
 * before anything is deferred.
 *
 * A follow-up that cannot start (the asker's account is gone, they left the
 * project, Claude is not connected on their account) is said on the task, with
 * what it was to do, so the step is a person's to take and is not lost. One
 * that fails does not hold back the next.
 */
export function maybeContinueController(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): void {
  let waiting: ControllerFollowUp[];
  try {
    waiting = openFollowUps(db, projectSlug, taskKey);
  } catch (error) {
    logger.warn("controller follow-up read failed", { projectSlug, taskKey, err: toError(error) });
    return;
  }
  if (waiting.length === 0) return;
  void (async () => {
    const task = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter;
    if (!task || task.archived || task.stage !== terminalStageIdFor(ctx, projectSlug)) return;
    for (const followUp of waiting) {
      try {
        await continueWith(db, ctx, followUp);
      } catch (error) {
        logger.warn("controller follow-up failed", { projectSlug, taskKey, err: toError(error) });
      }
    }
  })().catch((error) => {
    logger.warn("controller follow-up failed", { projectSlug, taskKey, err: toError(error) });
  });
}
