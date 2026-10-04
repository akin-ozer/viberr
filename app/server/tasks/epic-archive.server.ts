import type { DatabaseSync } from "node:sqlite";
import { EPIC_STATUS_LABEL } from "~/schemas/epic-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { updateEpicFile } from "~/server/files/epic-writer.server";
import { logger } from "~/server/logging/logger.server";
import { epicTaskRows } from "~/server/projections/epic-query.server";
import { rebuildEpicFile } from "~/server/projections/rebuilder.server";
import { toError } from "~/shared/errors";
import { countLabel } from "~/shared/text/plural";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { joinClauses, requireEpicFile } from "./epic-actions.server";
import { requireAction } from "./task-action-core.server";
import { setTaskArchived } from "./task-actions.server";
import { loadProjectContext, type TaskActor, type TaskMutationContext } from "./task-mutation.server";
import { actorProseName } from "./user-display-name.server";

/**
 * Ruling 651: a Done epic's tasks leave the board together.
 *
 * Archiving files a task away (R14-3). A finished epic's tasks are finished
 * work, so one action files them all and the board keeps what is still
 * moving. It is offered for a Done epic whose every live task is done: a task
 * still open in it would be abandoned work, which is archived one at a time,
 * behind the confirmation that names what archiving withdraws.
 *
 * Each task goes through `setTaskArchived`, so its note, its audit row and
 * the hooks after it read as any archive's, and the epic's history gets one
 * line naming them all. A task archived when done still counts as done, to
 * its epic's progress and to what waits on it; Restore brings any one back.
 */
export async function archiveEpicTasks(
  db: DatabaseSync,
  input: { projectSlug: string; epicId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ archived: string[]; message: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "approve-transition", "archive this epic's tasks");
  const epic = requireEpicFile(ctx, input.projectSlug, input.epicId.trim()).parsed.frontmatter;
  if (epic.status !== "done") {
    throw AppError.validation(
      `${epic.id} is ${EPIC_STATUS_LABEL[epic.status]}, not Done. Its tasks are archived together once it is Done; until then, archive one at a time from its page.`,
    );
  }
  const live = epicTaskRows(db, input.projectSlug, epic.id).filter((t) => !t.archived);
  if (live.length === 0) {
    return { archived: [], message: `Every task in ${epic.id} is archived already.` };
  }
  const open = live.filter((t) => !isTerminalStage(t.stage, project.stages)).map((t) => t.key);
  if (open.length > 0) {
    const them = open.length === 1 ? "it" : "them";
    throw AppError.validation(
      `${joinClauses(open)} ${open.length === 1 ? "is" : "are"} still open in ${epic.id}, so nothing was archived. Finish ${them}, or archive ${them} one at a time from the epic's page.`,
    );
  }

  const archived: string[] = [];
  try {
    for (const task of live) {
      await setTaskArchived(db, { projectSlug: input.projectSlug, taskKey: task.key, archived: true }, actor, ctx);
      archived.push(task.key);
    }
  } finally {
    // The history names what was archived, even when a task partway refused.
    if (archived.length > 0) {
      try {
        await updateEpicFile(
          { projectSlug: input.projectSlug, epicId: epic.id, dataRoot: ctx.dataRoot },
          () => `${actorProseName(db, actor)} archived ${joinClauses(archived)}.`,
        );
        rebuildEpicFile(db, input.projectSlug, epic.id, { dataRoot: ctx.dataRoot });
      } catch (error) {
        // The tasks are archived, each with its own note; the epic's history
        // is the record that lags, as at `setTasksEpic`.
        logger.warn("epic history could not record its tasks archived", {
          projectSlug: input.projectSlug,
          epicId: epic.id,
          err: toError(error),
        });
      }
    }
  }
  return {
    archived,
    message: `${countLabel(archived.length, "task")} in ${epic.id} archived. Find ${archived.length === 1 ? "it" : "them"} under Archived on the board.`,
  };
}
