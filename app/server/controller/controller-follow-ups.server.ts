import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Ruling 259: what a controller conversation left itself to do when a task is
 * accepted.
 *
 * A controller turn cannot wait for a task: it ends, and an agent's work on a
 * task takes minutes to hours. Asked to make a board's output template content
 * free, the controller filed the task that strips the example and ended with
 * "tell me when the Estimate Judge approves it, and I'll replace the files":
 * the second half of one request, left for the person to remember. So it
 * writes the next step down here, and the acceptance that moves the task to
 * its last stage starts the conversation's next turn with it.
 *
 * This is the store only. Who may set one is the toolkit's, and what an
 * acceptance does with it is `controller-continuation.server.ts`'s.
 */

/** The longest next step a follow-up carries. It is a sentence or a short
 *  list, read back to the controller as the opening of a turn. */
export const FOLLOW_UP_MAX_CHARS = 2_000;

const followUpRowSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    user_id: z.string(),
    project_slug: z.string(),
    task_key: z.string(),
    text: z.string(),
    created_at: z.string(),
  })
  .transform((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    text: row.text,
    createdAt: row.created_at,
  }));

/** One next step that has not been started yet. */
export type ControllerFollowUp = z.infer<typeof followUpRowSchema>;

const OPEN_COLUMNS = "id, conversation_id, user_id, project_slug, task_key, text, created_at";

/** A task's follow-ups that no acceptance has claimed, oldest first. */
export function openFollowUps(db: DatabaseSync, projectSlug: string, taskKey: string): ControllerFollowUp[] {
  return db
    .prepare(
      `SELECT ${OPEN_COLUMNS} FROM controller_follow_ups
        WHERE project_slug = ? AND task_key = ? AND fired_at IS NULL
        ORDER BY created_at, rowid`,
    )
    .all(projectSlug, taskKey)
    .map((row) => followUpRowSchema.parse(row));
}

/** The steps one conversation has left that no acceptance has claimed. */
export function openFollowUpsOf(db: DatabaseSync, conversationId: string): ControllerFollowUp[] {
  return db
    .prepare(
      `SELECT ${OPEN_COLUMNS} FROM controller_follow_ups
        WHERE conversation_id = ? AND fired_at IS NULL
        ORDER BY created_at, rowid`,
    )
    .all(conversationId)
    .map((row) => followUpRowSchema.parse(row));
}

export interface SetFollowUpInput {
  conversationId: string;
  userId: string;
  projectSlug: string;
  taskKey: string;
  text: string;
}

/**
 * Write a conversation's next step for a task. A conversation holds one open
 * step a task, so setting it again replaces the text: the controller corrects
 * what it will do, it does not queue a second turn. True when one was
 * replaced.
 */
export function setFollowUp(db: DatabaseSync, input: SetFollowUpInput): boolean {
  const replaced = clearFollowUp(db, input);
  db.prepare(
    `INSERT INTO controller_follow_ups (id, conversation_id, user_id, project_slug, task_key, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("cfu"),
    input.conversationId,
    input.userId,
    input.projectSlug,
    input.taskKey,
    input.text,
    new Date().toISOString(),
  );
  return replaced;
}

/** Drop a conversation's open step for a task. Returns whether there was one. */
export function clearFollowUp(
  db: DatabaseSync,
  input: Pick<SetFollowUpInput, "conversationId" | "projectSlug" | "taskKey">,
): boolean {
  const done = db
    .prepare(
      `DELETE FROM controller_follow_ups
        WHERE conversation_id = ? AND project_slug = ? AND task_key = ? AND fired_at IS NULL`,
    )
    .run(input.conversationId, input.projectSlug, input.taskKey);
  return Number(done.changes) > 0;
}

/**
 * Take a follow-up for the acceptance that is about to start its turn. True
 * for exactly one caller: two acceptances landing together start one turn.
 */
export function claimFollowUp(db: DatabaseSync, id: string): boolean {
  const done = db
    .prepare(`UPDATE controller_follow_ups SET fired_at = ? WHERE id = ? AND fired_at IS NULL`)
    .run(new Date().toISOString(), id);
  return Number(done.changes) === 1;
}

/**
 * What became of a claimed follow-up: the turn's state, or why none started,
 * and the message Viberr sent to open the turn when it sent one.
 */
export function recordFollowUpOutcome(
  db: DatabaseSync,
  id: string,
  outcome: string,
  messageId: string | null = null,
): void {
  db.prepare(`UPDATE controller_follow_ups SET outcome = ?, message_id = ? WHERE id = ?`).run(outcome, messageId, id);
}

/**
 * Whether the turn that answers `messageId` was started by a follow-up and has
 * heard from nobody since: the message is the one Viberr sent to open it, and
 * no message was steered into the turn. A follow-up's own message is queued,
 * never steered, so one that was steered in is a person's, or one a person
 * pressed Send now on. A turn opened that way leaves no further step, so no
 * step is ever left by a turn nobody asked for or wrote into. (A person's own
 * turn may leave a step on each of several tasks; each acceptance then starts
 * its own turn, and none of those leaves another.)
 *
 * It asks about the turn, not the conversation: a follow-up that fires while
 * a person's own turn is working is queued behind that turn, and is the
 * conversation's newest message for the rest of it.
 */
export function turnOpenedByFollowUp(db: DatabaseSync, conversationId: string, messageId: string): boolean {
  const opened = db
    .prepare(
      `SELECT 1 FROM controller_follow_ups
        WHERE conversation_id = ? AND message_id = ?
          AND NOT EXISTS (SELECT 1 FROM controller_messages
                           WHERE conversation_id = ? AND steered_into = ?)
        LIMIT 1`,
    )
    .get(conversationId, messageId, conversationId, messageId);
  return opened !== undefined;
}

/**
 * Drop the steps left on a project that is being deleted, as its other
 * app-owned rows are (ruling 249): a project of the same name gives the slug
 * and its task keys back, and an acceptance there must not start a step left
 * for the project that is gone. A step already started stays, with its
 * conversation: it is the record of which message Viberr sent there, which a
 * turn still answering that message is known by. Returns how many were dropped.
 */
export function dropProjectFollowUps(db: DatabaseSync, projectSlug: string): number {
  return Number(
    db.prepare(`DELETE FROM controller_follow_ups WHERE project_slug = ? AND fired_at IS NULL`).run(projectSlug).changes,
  );
}
