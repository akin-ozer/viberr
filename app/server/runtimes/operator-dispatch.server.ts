import type Database from "better-sqlite3";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import { chainRunCompletion } from "./run-service.server";
import { runOperator } from "./operator-run.server";

export type OperatorDispatchState = "queued" | "running" | "finished" | "failed";

export interface OperatorDispatchStatus {
  state: OperatorDispatchState;
  trigger: "create" | "transition";
  runId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface DispatchRow {
  id: string;
  project_slug: string;
  task_key: string;
  trigger: "create" | "transition";
  state: OperatorDispatchState;
  run_id: string | null;
  estimated_cost_usd: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const DISPATCH_KEY = Symbol.for("viberr.operatorDispatch");
interface DispatchProcessState { draining: boolean }

function processState(): DispatchProcessState {
  const cache = globalThis as unknown as Record<symbol, DispatchProcessState | undefined>;
  return (cache[DISPATCH_KEY] ??= { draining: false });
}

function positiveNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Product defaults: at most two paid automatic assessments at once and no
 * more than one observed/estimated dollar in a rolling hour. Deployments can
 * tighten either without changing project files. */
export function autoOperatorLimits(): {
  concurrency: number;
  hourlyCostBudgetUsd: number;
  estimatedRunCostUsd: number;
} {
  return {
    concurrency: Math.max(
      1,
      Math.floor(positiveNumber("VIBERR_OPERATOR_AUTO_CONCURRENCY", 2)),
    ),
    hourlyCostBudgetUsd: positiveNumber(
      "VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD",
      1,
    ),
    estimatedRunCostUsd: positiveNumber(
      "VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD",
      0.05,
    ),
  };
}

function costCommittedThisHour(db: Database.Database): number {
  const actual = db
    .prepare(
      `SELECT coalesce(sum(total_cost_usd), 0) AS cost
       FROM agent_runs
       WHERE kind = 'operator' AND simulated = 0
         AND created_at >= datetime('now', '-1 hour')`,
    )
    .get() as { cost: number };
  const reserved = db
    .prepare(
      `SELECT coalesce(sum(estimated_cost_usd), 0) AS cost
       FROM operator_dispatches WHERE state = 'running'`,
    )
    .get() as { cost: number };
  return Number(actual.cost ?? 0) + Number(reserved.cost ?? 0);
}

function activeCount(db: Database.Database): number {
  return Number(
    (
      db.prepare(`SELECT count(*) AS c FROM operator_dispatches WHERE state = 'running'`).get() as {
        c: number;
      }
    ).c,
  );
}

/** Enqueue one automatic trigger. The partial unique index coalesces repeated
 * triggers for the same task while one is queued/running. */
export function enqueueAutoOperator(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    trigger: "create" | "transition";
    dataRoot?: string;
  },
): { queued: boolean; dispatchId: string | null } {
  const limits = autoOperatorLimits();
  const id = newId("opd");
  const now = new Date().toISOString();
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO operator_dispatches
         (id, project_slug, task_key, trigger, state, run_id,
          estimated_cost_usd, error_code, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, NULL, NULL)`,
    )
    .run(
      id,
      input.projectSlug,
      input.taskKey,
      input.trigger,
      limits.estimatedRunCostUsd,
      now,
    );
  if (inserted.changes === 0) return { queued: false, dispatchId: null };

  recordAudit(db, {
    action: "task.operator.auto_queued",
    actor: { userId: null, label: "operator-dispatcher" },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { trigger: input.trigger, ...limits },
  });
  void drainAutoOperatorQueue(db, input.dataRoot);
  return { queued: true, dispatchId: id };
}

export async function drainAutoOperatorQueue(
  db: Database.Database,
  dataRoot?: string,
): Promise<void> {
  const state = processState();
  if (state.draining || !db.open) return;
  state.draining = true;
  try {
    const limits = autoOperatorLimits();
    while (activeCount(db) < limits.concurrency) {
      const next = db
        .prepare(
          `SELECT * FROM operator_dispatches
           WHERE state = 'queued'
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get() as DispatchRow | undefined;
      if (!next) break;
      if (
        costCommittedThisHour(db) + next.estimated_cost_usd >
        limits.hourlyCostBudgetUsd
      ) {
        logger.info("automatic operator queue paused at the hourly cost budget", {
          queuedDispatchId: next.id,
          hourlyCostBudgetUsd: limits.hourlyCostBudgetUsd,
        });
        break;
      }

      const startedAt = new Date().toISOString();
      const claimed = db
        .prepare(
          `UPDATE operator_dispatches
           SET state = 'running', started_at = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(startedAt, next.id);
      if (claimed.changes === 0) continue;

      try {
        const launched = await runOperator(db, {
          projectSlug: next.project_slug,
          taskKey: next.task_key,
          trigger: next.trigger,
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        });
        if (launched.runId === "queued") {
          // A manual run acquired the per-task lease in the tiny pre-row
          // window. Leave the durable dispatch queued; its next lifecycle
          // trigger or boot recovery will retry without overlapping the run.
          db.prepare(
            `UPDATE operator_dispatches
             SET state = 'queued', started_at = NULL
             WHERE id = ?`,
          ).run(next.id);
          break;
        }
        db.prepare(`UPDATE operator_dispatches SET run_id = ? WHERE id = ?`).run(
          launched.runId,
          next.id,
        );
        chainRunCompletion(launched.runId, (finished) => {
          if (!db.open) return;
          const terminal = finished.state === "error" ? "failed" : "finished";
          db.prepare(
            `UPDATE operator_dispatches
             SET state = ?, finished_at = ?, error_code = ?
             WHERE id = ?`,
          ).run(
            terminal,
            new Date().toISOString(),
            finished.state === "error" ? "operator_run_error" : null,
            next.id,
          );
          const auditBase = {
            actor: { userId: null, label: "operator-dispatcher" },
            subjectKind: "task" as const,
            subjectId: next.task_key,
            projectSlug: next.project_slug,
            taskKey: next.task_key,
            details: { trigger: next.trigger, runId: finished.id },
          };
          if (terminal === "finished") {
            recordAudit(db, {
              action: "task.operator.auto_finished",
              ...auditBase,
            });
          } else {
            recordAudit(db, {
              action: "task.operator.auto_failed",
              ...auditBase,
            });
          }
          void drainAutoOperatorQueue(db, dataRoot);
        });
      } catch (error) {
        if (!db.open) return;
        db.prepare(
          `UPDATE operator_dispatches
           SET state = 'failed', finished_at = ?, error_code = 'launch_failed'
           WHERE id = ?`,
        ).run(new Date().toISOString(), next.id);
        logger.error("automatic operator dispatch failed", {
          dispatchId: next.id,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  } finally {
    state.draining = false;
  }
}

/** Boot recovery: a process died before a running dispatch could receive its
 * in-memory completion callback. Requeue it and drain under today's limits. */
export function recoverAutoOperatorQueue(db: Database.Database): void {
  db.prepare(
    `UPDATE operator_dispatches
     SET state = 'queued', run_id = NULL, started_at = NULL
     WHERE state = 'running'`,
  ).run();
  void drainAutoOperatorQueue(db);
}

export function getOperatorDispatchStatus(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): OperatorDispatchStatus | null {
  const row = db
    .prepare(
      `SELECT * FROM operator_dispatches
       WHERE project_slug = ? AND task_key = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(projectSlug, taskKey) as DispatchRow | undefined;
  return row
    ? {
        state: row.state,
        trigger: row.trigger,
        runId: row.run_id,
        queuedAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }
    : null;
}

export function resetOperatorDispatchForTests(): void {
  processState().draining = false;
}
