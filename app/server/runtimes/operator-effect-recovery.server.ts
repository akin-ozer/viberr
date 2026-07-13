import type Database from "better-sqlite3";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { openSystemRecovery } from "~/server/tasks/task-recovery.server";
import { patchRun } from "./run-store.server";
import {
  runMatchesTaskIncarnation,
  withProjectCompletionEffect,
} from "./run-completion-state.server";

interface PendingOperatorEffectRow {
  id: string;
  project_slug: string;
  task_key: string;
  state: "finished" | "error" | "interrupted";
  completion_source_run_id: string | null;
}

/**
 * A provider exit and its governed completion effect are two separate durable
 * boundaries. If the process dies between them, replaying a partially applied
 * Codex plan could duplicate mutations, while silently treating it as applied
 * loses coordination. Boot therefore raises one run-specific human recovery
 * signal and marks the ambiguity resolved without replaying the plan.
 */
export async function recoverUnappliedOperatorEffects(
  db: Database.Database,
  dataRoot?: string,
  options: { openRecovery?: typeof openSystemRecovery } = {},
): Promise<{ recovered: number; skippedMissing: number }> {
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, state, completion_source_run_id
         FROM agent_runs
        WHERE kind = 'operator'
          AND operator_effect_state = 'pending'
          AND state IN ('finished', 'error', 'interrupted')
          AND id NOT LIKE 'run_seed_%'
        ORDER BY rowid ASC`,
    )
    .all() as PendingOperatorEffectRow[];

  let recovered = 0;
  let skippedMissing = 0;
  const openRecovery = options.openRecovery ?? openSystemRecovery;
  for (const row of rows) {
    if (!db.open) break;
    try {
      await withProjectCompletionEffect(db, row.project_slug, async () => {
        const project = readProjectFile({
          projectSlug: row.project_slug,
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        });
        const task = readTaskFile({
          projectSlug: row.project_slug,
          taskKey: row.task_key,
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        });
        const taskIncarnation =
          task?.parsed.frontmatter.createdAt ?? null;
        // Revalidate canonical ownership only after this effect owns an
        // admission slot. Archive/delete revoke the registry before waiting,
        // closing the gap between the boot query and the recovery write.
        if (
          !project ||
          project.parsed.frontmatter.archived ||
          !task ||
          !taskIncarnation ||
          !runMatchesTaskIncarnation(
            db,
            row.id,
            taskIncarnation,
          )
        ) {
          patchRun(db, row.id, { operatorEffectState: "recovery" });
          skippedMissing += 1;
          return;
        }

        const wasBareReactionReservation =
          row.state === "interrupted" && !!row.completion_source_run_id;
        await openRecovery(
          db,
          {
            projectSlug: row.project_slug,
            taskKey: row.task_key,
            code: wasBareReactionReservation
              ? "operator_reaction_interrupted"
              : "operator_effect_unconfirmed",
            occurrenceId: row.id,
            title: wasBareReactionReservation
              ? "Operator reaction was interrupted before launch"
              : "Operator completion needs human confirmation",
            body: wasBareReactionReservation
              ? "The server restarted after reserving this agent-reply reaction but before the operator launched. It was not replayed because doing so could duplicate coordination. Re-run the operator when you are ready."
              : "The operator process ended before Viberr could durably confirm all completion effects. The plan is not replayed because some actions may already have applied. Review the timeline and run the operator again if coordination is still needed.",
            observations: [
              { k: "Operator run", v: row.id, code: true },
              { k: "Terminal state", v: row.state, code: false },
            ],
          },
          {
            ...(dataRoot !== undefined ? { dataRoot } : {}),
            expectedTaskIncarnation: taskIncarnation,
          },
        );
        if (!db.open) return;
        patchRun(db, row.id, { operatorEffectState: "recovery" });
        recovered += 1;
      });
    } catch (error) {
      logger.error("operator completion recovery failed", {
        runId: row.id,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return { recovered, skippedMissing };
}
