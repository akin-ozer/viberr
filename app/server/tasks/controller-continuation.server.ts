import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "~/server/auth/user-store.server";
import {
  claimFollowUp,
  openFollowUps,
  recordFollowUpOutcome,
  type ControllerFollowUp,
} from "~/server/controller/controller-follow-ups.server";
import { runControllerTurn, type ControllerTurnInput } from "~/server/controller/controller-run.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { errorMessage, toError } from "~/shared/errors";
import { endSentence } from "~/shared/text/sentence";
import type { TaskActionContext } from "./task-action-core.server";
import { appendPolicyNote, taskRef, terminalStageIdFor } from "./task-mutation.server";

/**
 * Ruling 683: the words a follow-up turn opens with. The message stands in the
 * person's conversation as theirs, because the turn runs as them, so it says
 * who sent it.
 */
export function followUpOpening(taskKey: string, text: string): string {
  return (
    `${taskKey} was accepted. This conversation left a follow-up for that moment, and Viberr started it ` +
    `(nobody typed this message):\n\n${text}`
  );
}

type FollowUpStart = { started: true; state: string } | { started: false; why: string };

/**
 * Start the conversation's next turn, as the person who asked: a controller
 * turn runs on the asker's own Claude account (ruling 127) and under their
 * permissions, and the acceptance may be somebody else's. Queued, so a turn
 * already answering in that conversation is not steered by it.
 */
async function startFollowUpTurn(
  db: DatabaseSync,
  ctx: TaskActionContext,
  followUp: ControllerFollowUp,
): Promise<FollowUpStart> {
  const user = findUserById(db, followUp.userId);
  if (!user || user.disabled) return { started: false, why: "The person who asked for it has no active account." };
  const turn: ControllerTurnInput = {
    conversationId: followUp.conversationId,
    text: followUpOpening(followUp.taskKey, followUp.text),
    user: { id: user.id, email: user.email, name: user.name, orgRole: user.role },
    surface: `/projects/${followUp.projectSlug}/tasks/${followUp.taskKey}`,
    mode: "queue",
  };
  if (ctx.dataRoot) turn.dataRoot = ctx.dataRoot;
  try {
    const result = await (ctx.deps?.runControllerTurn ?? runControllerTurn)(db, turn);
    if (result.state === "refused") return { started: false, why: endSentence(result.reason) };
    return { started: true, state: result.state };
  } catch (error) {
    return { started: false, why: endSentence(errorMessage(error)) };
  }
}

/**
 * Ruling 683, the hook: a task was accepted. When it stands at the board's
 * last stage and a controller conversation left a follow-up on it, that
 * conversation's next turn is started with it. Fire-and-forget from the
 * acceptance write, like the epic and dependency checks beside it; a task
 * nobody waits on costs one indexed read, made before anything is deferred.
 *
 * A follow-up that cannot start (the asker's account is gone, Claude is not
 * connected on it) is said on the task, with what it was to do, so the step is
 * a person's to take and is not lost.
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
      if (!claimFollowUp(db, followUp.id)) continue;
      const start = await startFollowUpTurn(db, ctx, followUp);
      recordFollowUpOutcome(db, followUp.id, start.started ? start.state : `not started: ${start.why}`);
      if (start.started) continue;
      await appendPolicyNote(db, ctx, projectSlug, taskKey, {
        title: "Controller follow-up not started",
        text:
          `This task was accepted, and the controller was to continue with: ${endSentence(followUp.text)} ` +
          `It was not started: ${start.why} Ask the controller for that step yourself.`,
      });
    }
  })().catch((error) => {
    logger.warn("controller follow-up failed", { projectSlug, taskKey, err: toError(error) });
  });
}
