import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskClosure } from "./task-closure.server";
import { logger } from "~/server/logging/logger.server";
import type { TaskActionContext } from "./task-action-core.server";
import { toError } from "~/shared/errors";

/**
 * Ruling 122 — nothing watched for the state itself.
 *
 * Every fix before this one closed a CAUSE of a task stopping dead. Rulings
 * 122, 156 and 94 closed three; the owner found a fourth on the same day. The
 * causes are not the point. The point is that a task can arrive in a state
 * where NOTHING is going to move it — no packet, no recommendation, no queued
 * question, no schedule, no running or queued agent, and no hold that explains
 * the quiet — and Viberr could not see that state at all.
 *
 * `settleAbandonedWaits` covers one narrow slice of it (the board claims an
 * agent and no run is live) and runs ONCE, at boot: five firings in the whole
 * life of this board. Nothing covered the rest.
 *
 * HOW A TASK GETS HERE, measured on 940 operator runs of a real project. 111 of
 * them (12%) ended without writing anything, and most of those are RIGHT — the
 * operator reads the task, sees a run already in flight, and correctly declines
 * to duplicate it. But each one ends on the same load-bearing sentence: *"I will
 * be re-invoked when the Code Reviewer reports."*
 *
 * That re-invocation is not guaranteed. `operatorShouldReactToReply` requires
 * the run to finish in state `finished` with a readable reply, so a run that
 * FAILS — quota, credential, crash — re-invokes nobody. The fallback is the
 * stuck-loop packet, which ruling 156 found had been refused for four days
 * straight and ruling 122 found said nothing when it was. Live on SHOP-61: a
 * silent operator turn, then `blocked` (credential rejected), then "the
 * recovery packet could not be opened" — and the operator's last recorded words
 * were that it would be re-invoked when the reviewer reported.
 *
 * So this sweep does not ask why. It asks whether anything is going to happen,
 * and when the answer is no it does what a person ends up doing by hand: it
 * invokes the operator. On SHOP-12 that hand-typed `@operator` comment produced
 * a decision packet 28 seconds later, after the task had sat for 10h45m.
 */

/** How long a task must be untouched before "quiet" means "stopped". */
const STRANDED_AFTER_MS = 15 * 60_000;

/** The sweep's own note. Also its idempotence key: while this is the newest
 *  event on a task, the sweep has already spoken and does not speak again. */
export const STRANDED_NOTE_TITLE = "Nothing is moving this task";

const candidateRow = z.object({
  project_slug: z.string(),
  task_key: z.string(),
  waiting: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export interface StrandedTask {
  projectSlug: string;
  taskKey: string;
  /** What the board CLAIMS is happening, which is the part that misleads. */
  waiting: string | null;
  quietForMs: number;
}

/**
 * Tasks that nothing is going to move.
 *
 * The projection answers the cheap half (open, no packet, no recommendation,
 * no live run, untouched for a while); the task FILE answers the rest, because
 * a hold, a queued question and a pending schedule live there and each of them
 * is a legitimate reason for silence.
 */
function findStrandedTasks(
  db: DatabaseSync,
  ctx: TaskActionContext,
  nowMs: number,
): StrandedTask[] {
  const cutoff = new Date(nowMs - STRANDED_AFTER_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT t.project_slug, t.task_key, t.waiting, t.updated_at
         FROM task_projections t
         JOIN projects p ON p.slug = t.project_slug
        WHERE p.archived = 0
          AND t.archived = 0
          AND (t.packet_json IS NULL OR t.packet_json = '')
          AND t.recommendation_count = 0
          AND t.updated_at IS NOT NULL
          AND t.updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r
             WHERE r.project_slug = t.project_slug
               AND r.task_key = t.task_key
               AND r.state IN ('running', 'queued')
          )
        ORDER BY t.project_slug, t.task_key`,
    )
    .all(cutoff);

  const out: StrandedTask[] = [];
  for (const row of rows) {
    const parsed = candidateRow.safeParse(row);
    if (!parsed.success) continue;
    const { project_slug: projectSlug, task_key: taskKey } = parsed.data;
    // The file is the record; the projection is an index that can lag a write.
    const file = readTaskFile({ projectSlug, taskKey, dataRoot: ctx.dataRoot });
    if (!file) continue;
    const fm = file.parsed.frontmatter;
    if (fm.archived) continue;
    if (file.parsed.packet) continue;
    if ((fm.recommendations ?? []).length > 0) continue;
    // A HOLD is a reason for silence, and the release engine owns it.
    if ((fm.blockedBy ?? []).length > 0) continue;
    // A queued question is put the moment its wait clears (ruling 66), and a
    // pending schedule is a dispatch with a date on it (ruling 157). Both are
    // something happening later, which is not nothing.
    if ((fm.queuedQuestions ?? []).length > 0) continue;
    if ((fm.schedules ?? []).some((s) => s.status === "pending")) continue;
    // A finished task is supposed to be quiet.
    const project = readProjectStages(ctx, projectSlug);
    if (project && taskClosure(fm, project).closed) continue;
    // Already spoken for: while the sweep's own note is newest, the operator it
    // invoked has either not run yet or ran and wrote nothing, and saying it
    // again every tick would be the noise this exists to replace.
    if (file.parsed.timeline[0]?.title === STRANDED_NOTE_TITLE) continue;
    const updatedMs = Date.parse(parsed.data.updated_at ?? "");
    out.push({
      projectSlug,
      taskKey,
      waiting: parsed.data.waiting,
      quietForMs: Number.isFinite(updatedMs) ? nowMs - updatedMs : STRANDED_AFTER_MS,
    });
  }
  return out;
}

/** The project's stages, or null when it cannot be read. */
function readProjectStages(
  ctx: TaskActionContext,
  projectSlug: string,
): Parameters<typeof taskClosure>[1] | null {
  try {
    const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
    return file ? file.parsed.frontmatter.stages : null;
  } catch {
    return null;
  }
}

/** The sentence left on a stranded task, naming what was checked. */
export function strandedNoteText(task: StrandedTask): string {
  const mins = Math.round(task.quietForMs / 60_000);
  const claim =
    task.waiting === "agent"
      ? "The board says an agent is working on it, and no run is live or queued. "
      : task.waiting === "human"
        ? "The board says it is waiting on a person, and there is nothing here for one to answer. "
        : "";
  return (
    `Nothing has happened on this task for ${mins} minutes, and nothing is scheduled to. ` +
    `${claim}` +
    "There is no decision packet, no pending recommendation, no queued question, no scheduled " +
    "run, no agent running or queued, and nothing it is waiting on. Viberr is re-invoking the " +
    "operator to decide what happens next; this note is the record that it had to, because a " +
    "task in this state is not paused, it has stopped."
  );
}

/**
 * Find them and nudge them. Returns how many were nudged.
 *
 * Best-effort per task: one project's unreadable file must not stop the sweep
 * reaching the next. Never throws.
 */
export async function sweepStrandedTasks(
  db: DatabaseSync,
  ctx: TaskActionContext = {},
  nowMs: number = Date.now(),
): Promise<number> {
  let nudged = 0;
  let found: StrandedTask[] = [];
  try {
    found = findStrandedTasks(db, ctx, nowMs);
  } catch (error) {
    logger.warn("stranded sweep could not run its search", {
      err: toError(error),
    });
    return 0;
  }
  if (found.length === 0) return 0;
  const { autoInvokeOperator, noteStranded } = await import("./task-action-core.server");
  for (const task of found) {
    try {
      // The NOTE first, and unconditionally: it is the record that the state
      // existed, and it must survive an operator that refuses, is not deployed,
      // or throws. It is also the idempotence key for the next tick.
      await noteStranded(db, ctx, task);
      nudged += 1;
      logger.info("stranded task nudged", {
        projectSlug: task.projectSlug,
        taskKey: task.taskKey,
        quietMinutes: Math.round(task.quietForMs / 60_000),
        waiting: task.waiting,
      });
      await autoInvokeOperator(db, ctx, task.projectSlug, task.taskKey, "stranded");
    } catch (error) {
      logger.warn("stranded sweep could not nudge a task", {
        taskKey: task.taskKey,
        err: toError(error),
      });
    }
  }
  return nudged;
}
