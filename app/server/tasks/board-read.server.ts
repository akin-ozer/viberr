import type { DatabaseSync } from "node:sqlite";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import type { TaskMutationContext } from "./task-actions.server";

/**
 * Ruling 281 (pass 37, F37-114) and ruling 282 (F37-115): the board read an
 * agent and an operator share.
 *
 * Neither could see a task other than the one it was working. An agent's whole
 * Viberr toolkit was `post_comment`, `ask_human` and `report_outcome`; the
 * operator's `get_task` takes no arguments at all and answers its OWN task.
 * So a task key either was TOLD about — in a document, a directive, another
 * agent's report — could not be checked, and the operator, which is the only
 * actor that authors a `create_task` option and the only one that writes
 * `blockedBy`, planned across a board it could not read.
 *
 * ONE implementation, because the two readers must not answer the same
 * question differently: "is SHOP-39 real" has one true answer.
 */

/** How much of ANOTHER task's goal a single-task read hands back. Enough to
 *  answer "is this the work I was told about", not enough to make a second
 *  task's whole contract compete with the reader's own prompt. */
export const BOARD_READ_GOAL_CHARS = 2_000;

export interface BoardReadContext {
  db: DatabaseSync;
  ctx: TaskMutationContext;
  projectSlug: string;
}

/**
 * One task as JSON, or the sentence for a key this project does not have.
 * Archived tasks are INCLUDED: "SHOP-8 was archived" is a real answer to "does
 * SHOP-8 exist", and a reader told about a retired key must be able to learn
 * that rather than read it as never having existed.
 */
export function readBoardTask(
  deps: BoardReadContext,
  taskKey: string,
): string {
  const row = boardRows(deps).find((t) => t.key === taskKey);
  if (!row) {
    return (
      `[noop] No task ${taskKey} in this project. If a document, a directive or a ` +
      `report named it, that claim is wrong — say so rather than acting on it.`
    );
  }
  const file = readTaskFile({
    projectSlug: deps.projectSlug,
    taskKey: row.key,
    dataRoot: deps.ctx.dataRoot,
  });
  return JSON.stringify(
    {
      key: row.key,
      title: row.title,
      stage: row.stage,
      readiness: row.readiness,
      waiting: row.waiting,
      archived: row.archived,
      waitsOn: row.blockedBy.map((e) => `${e.label} (${e.state})`),
      goal: file ? file.parsed.goal.slice(0, BOARD_READ_GOAL_CHARS) : null,
    },
    null,
    1,
  );
}

/** Every task in the project, as JSON. */
export function readBoardList(deps: BoardReadContext): string {
  return JSON.stringify(
    boardRows(deps).map((t) => ({
      key: t.key,
      title: t.title,
      stage: t.stage,
      readiness: t.readiness,
      waiting: t.waiting,
      archived: t.archived,
      waitsOn: t.blockedBy.map((e) => `${e.label} (${e.state})`),
    })),
    null,
    1,
  );
}

function boardRows(deps: BoardReadContext) {
  const listOpts: NonNullable<Parameters<typeof listProjectTasks>[2]> = {
    includeArchived: true,
  };
  if (deps.ctx.dataRoot !== undefined) listOpts.dataRoot = deps.ctx.dataRoot;
  return listProjectTasks(deps.db, deps.projectSlug, listOpts);
}
