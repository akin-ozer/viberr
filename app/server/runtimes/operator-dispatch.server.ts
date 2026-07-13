import type Database from "better-sqlite3";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  chainRunCompletionOrInvoke,
  stopRunForLifecycle,
} from "./run-service.server";
import { runOperator } from "./operator-run.server";

export type OperatorDispatchState = "queued" | "running" | "finished" | "failed" | "interrupted";
type DurableOperatorDispatchState =
  | Exclude<OperatorDispatchState, "interrupted">
  | "claiming"
  | "cancelled";

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
  task_incarnation: string;
  trigger: "create" | "transition";
  state: DurableOperatorDispatchState;
  run_id: string | null;
  estimated_cost_usd: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
}

const DISPATCH_KEY = Symbol.for("viberr.operatorDispatch");
interface DispatchProcessState {
  draining: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAt: number | null;
}

function processState(): DispatchProcessState {
  const cache = globalThis as unknown as Record<symbol, DispatchProcessState | undefined>;
  const state = (cache[DISPATCH_KEY] ??= {
    draining: false,
    retryTimer: null,
    retryAt: null,
  });
  // Hot-reload compatibility for a process-global state created by the older
  // dispatcher shape.
  state.retryTimer ??= null;
  state.retryAt ??= null;
  return state;
}

const LEASE_RETRY_MS = 100;
const BUDGET_RETRY_FALLBACK_MS = 1_000;

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
    concurrency: Math.max(1, Math.floor(positiveNumber("VIBERR_OPERATOR_AUTO_CONCURRENCY", 2))),
    hourlyCostBudgetUsd: positiveNumber("VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD", 1),
    estimatedRunCostUsd: positiveNumber("VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD", 0.05),
  };
}

function costCommittedThisHour(db: Database.Database): number {
  const actual = db
    .prepare(
      // created_at is stored as an ISO-8601 string (…T…Z); comparing it against
      // datetime('now', …) (a space-separated, Z-less string) is a lexical
      // mismatch that widens the window to the whole UTC day, so format the
      // boundary the same way the column is written.
      `SELECT coalesce(sum(total_cost_usd), 0) AS cost
       FROM agent_runs
       WHERE kind = 'operator' AND simulated = 0
         AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`,
    )
    .get() as { cost: number };
  const reserved = db
    .prepare(
      `SELECT coalesce(sum(estimated_cost_usd), 0) AS cost
       FROM operator_dispatches WHERE state IN ('claiming', 'running')`,
    )
    .get() as { cost: number };
  return Number(actual.cost ?? 0) + Number(reserved.cost ?? 0);
}

function activeCount(db: Database.Database): number {
  return Number(
    (
      db
        .prepare(
          `SELECT count(*) AS c FROM operator_dispatches
         WHERE state IN ('claiming', 'running')`,
        )
        .get() as {
        c: number;
      }
    ).c,
  );
}

function scheduleDrain(db: Database.Database, dataRoot: string | undefined, at: number): void {
  if (!db.open) return;
  const state = processState();
  if (state.retryTimer && state.retryAt !== null && state.retryAt <= at) return;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryAt = at;
  state.retryTimer = setTimeout(
    () => {
      state.retryTimer = null;
      state.retryAt = null;
      if (db.open) void drainAutoOperatorQueue(db, dataRoot);
    },
    Math.max(0, at - Date.now()),
  );
}

function nextBudgetWakeAt(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT created_at
         FROM agent_runs
        WHERE kind = 'operator' AND simulated = 0
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
          AND coalesce(total_cost_usd, 0) > 0
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { created_at: string } | undefined;
  const created = row ? Date.parse(row.created_at) : Number.NaN;
  return Number.isFinite(created) ? created + 60 * 60 * 1_000 + 25 : Date.now() + BUDGET_RETRY_FALLBACK_MS;
}

type DispatchTargetState = { active: true } | { active: false };

/** Validate both the query projection and canonical files. The second check is
 * important during archive/delete: project.md can change before its projection
 * is rebuilt, while a queued drain is already between lifecycle steps. */
function dispatchTargetState(
  db: Database.Database,
  row: Pick<DispatchRow, "project_slug" | "task_key" | "task_incarnation">,
  dataRoot?: string,
): DispatchTargetState {
  const projected = db.prepare(`SELECT archived FROM projects WHERE slug = ?`).get(row.project_slug) as
    { archived: number } | undefined;
  if (!projected) return { active: false };
  if (projected.archived === 1) {
    return { active: false };
  }
  const project = readProjectFile({
    projectSlug: row.project_slug,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  if (!project) return { active: false };
  if (project.parsed.frontmatter.archived) {
    return { active: false };
  }
  const projectedTask = db
    .prepare(`SELECT 1 FROM task_projections WHERE project_slug = ? AND task_key = ?`)
    .get(row.project_slug, row.task_key);
  if (!projectedTask) return { active: false };
  const task = readTaskFile({
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  return task?.parsed.frontmatter.createdAt === row.task_incarnation
    ? { active: true }
    : { active: false };
}

function cancelDispatch(db: Database.Database, id: string): boolean {
  return (
    db
      .prepare(
        `UPDATE operator_dispatches
            SET state = 'cancelled', finished_at = ?, next_attempt_at = NULL
          WHERE id = ? AND state IN ('queued', 'claiming', 'running')`,
      )
      .run(new Date().toISOString(), id).changes > 0
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
    /** Snapshot captured by the mutation that caused this trigger. A delayed
     * fire-and-forget caller must never retarget a same-key replacement. */
    expectedTaskIncarnation?: string;
    dataRoot?: string;
  },
): { queued: boolean; dispatchId: string | null } {
  const task = readTaskFile({
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });
  const taskIncarnation = task?.parsed.frontmatter.createdAt;
  if (!taskIncarnation) {
    throw new Error(
      `Automatic operator target ${input.projectSlug}/${input.taskKey} has no canonical incarnation.`,
    );
  }
  if (
    input.expectedTaskIncarnation !== undefined &&
    input.expectedTaskIncarnation !== taskIncarnation
  ) {
    return { queued: false, dispatchId: null };
  }
  const limits = autoOperatorLimits();
  const id = newId("opd");
  const now = new Date().toISOString();
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO operator_dispatches
         (id, project_slug, task_key, task_incarnation, trigger, state, run_id,
          estimated_cost_usd, created_at, started_at, finished_at,
          next_attempt_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      id,
      input.projectSlug,
      input.taskKey,
      taskIncarnation,
      input.trigger,
      limits.estimatedRunCostUsd,
      now,
    );
  if (inserted.changes === 0) {
    const existing = db
      .prepare(
        `SELECT id FROM operator_dispatches
          WHERE project_slug = ? AND task_key = ?
            AND task_incarnation = ?
            AND state IN ('queued', 'claiming', 'running')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(input.projectSlug, input.taskKey, taskIncarnation) as
      | { id: string }
      | undefined;
    // A duplicate trigger is still a scheduler wake-up. Previously this early
    // return left a budget/lease-blocked durable row asleep indefinitely.
    void drainAutoOperatorQueue(db, input.dataRoot);
    return { queued: false, dispatchId: existing?.id ?? null };
  }

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

export async function drainAutoOperatorQueue(db: Database.Database, dataRoot?: string): Promise<void> {
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
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get(new Date().toISOString()) as DispatchRow | undefined;
      if (!next) {
        const deferred = db
          .prepare(
            `SELECT min(next_attempt_at) AS retry_at
               FROM operator_dispatches
              WHERE state = 'queued' AND next_attempt_at IS NOT NULL`,
          )
          .get() as { retry_at: string | null };
        const retryAt = deferred.retry_at ? Date.parse(deferred.retry_at) : Number.NaN;
        if (Number.isFinite(retryAt)) scheduleDrain(db, dataRoot, retryAt);
        break;
      }

      const targetBeforeClaim = dispatchTargetState(db, next, dataRoot);
      if (!targetBeforeClaim.active) {
        cancelDispatch(db, next.id);
        continue;
      }
      if (costCommittedThisHour(db) + next.estimated_cost_usd > limits.hourlyCostBudgetUsd) {
        const wakeAt = nextBudgetWakeAt(db);
        db.prepare(
          `UPDATE operator_dispatches SET next_attempt_at = ?
            WHERE id = ? AND state = 'queued'`,
        ).run(new Date(wakeAt).toISOString(), next.id);
        logger.info("automatic operator queue paused at the hourly cost budget", {
          queuedDispatchId: next.id,
          hourlyCostBudgetUsd: limits.hourlyCostBudgetUsd,
          retryAt: new Date(wakeAt).toISOString(),
        });
        scheduleDrain(db, dataRoot, wakeAt);
        break;
      }

      const claimed = db
        .prepare(
          `UPDATE operator_dispatches
           SET state = 'claiming', run_id = NULL, started_at = NULL,
               next_attempt_at = NULL
           WHERE id = ? AND state = 'queued'`,
        )
        .run(next.id);
      if (claimed.changes === 0) continue;

      try {
        // Recheck after claiming. Archive/delete can race the first eligibility
        // read while project.md and its projection move through their lifecycle.
        const targetBeforeLaunch = dispatchTargetState(db, next, dataRoot);
        if (!targetBeforeLaunch.active) {
          cancelDispatch(db, next.id);
          continue;
        }

        const launched = await runOperator(db, {
          projectSlug: next.project_slug,
          taskKey: next.task_key,
          expectedTaskIncarnation: next.task_incarnation,
          trigger: next.trigger,
          dispatchId: next.id,
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        });
        if (launched.disposition !== "started") {
          // A manual/reaction run owns the per-task lease. Do not borrow its run
          // id and do not copy this durable trigger into the process-local
          // pending map. A deterministic retry keeps admission/concurrency/cost
          // accounting attached to this row.
          const retryAt = Date.now() + LEASE_RETRY_MS;
          db.prepare(
            `UPDATE operator_dispatches
             SET state = 'queued', run_id = NULL, started_at = NULL,
                 next_attempt_at = ?
             WHERE id = ? AND state = 'claiming'`,
          ).run(new Date(retryAt).toISOString(), next.id);
          scheduleDrain(db, dataRoot, retryAt);
          continue;
        }

        const startedAt = new Date().toISOString();
        const owned = db
          .prepare(
            `UPDATE operator_dispatches
                SET state = 'running', run_id = ?, started_at = ?,
                    next_attempt_at = NULL
              WHERE id = ? AND state = 'claiming'`,
          )
          .run(launched.runId, startedAt, next.id);
        if (owned.changes === 0) {
          // Project lifecycle cancellation/deletion won after launch began.
          // Its earlier cleanup may have missed this handle while adapter.start
          // was still in flight, so stop this exact run now. Never sweep by
          // slug: that slug may already belong to a recreated project.
          stopRunForLifecycle(db, launched.runId);
          continue;
        }

        chainRunCompletionOrInvoke(db, launched.runId, (finished) => {
          if (!db.open) return;
          if (!dispatchTargetState(db, next, dataRoot).active) {
            cancelDispatch(db, next.id);
            void drainAutoOperatorQueue(db, dataRoot);
            return;
          }
          // The operator completion callback runs before this dispatcher
          // callback. Re-read the durable effect result instead of trusting
          // the provider snapshot: a provider can finish successfully while
          // the governed mutation (and even its recovery packet) fails.
          const durable = db
            .prepare(
              `SELECT state, operator_effect_state
                 FROM agent_runs
                WHERE id = ?`,
            )
            .get(finished.id) as
            | { state: string; operator_effect_state: string | null }
            | undefined;
          const terminal =
            durable?.state === "finished" && durable.operator_effect_state === "applied"
              ? "finished"
              : "failed";
          const updated = db
            .prepare(
              `UPDATE operator_dispatches
                  SET state = ?, finished_at = ?, next_attempt_at = NULL
                WHERE id = ? AND state = 'running' AND run_id = ?`,
            )
            .run(terminal, new Date().toISOString(), next.id, finished.id);
          // Archive/delete may already have cancelled or removed the row. A
          // late provider callback is then intentionally inert: no audit, no
          // terminal-state rewrite, and no task/project mutation.
          if (updated.changes === 0) {
            void drainAutoOperatorQueue(db, dataRoot);
            return;
          }
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
        const targetAfterError = dispatchTargetState(db, next, dataRoot);
        if (!targetAfterError.active) {
          cancelDispatch(db, next.id);
        } else {
          db.prepare(
            `UPDATE operator_dispatches
                SET state = 'failed', finished_at = ?, next_attempt_at = NULL
              WHERE id = ? AND state = 'claiming'`,
          ).run(new Date().toISOString(), next.id);
        }
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

/** Boot recovery owns every non-seed queued/running operator row because no SDK
 * handle survives a process death. Terminalize those zombies first, then
 * requeue claiming/running dispatches for a fresh, owned assessment. */
export function recoverAutoOperatorQueue(
  db: Database.Database,
  dataRoot?: string,
  options: { deferDrain?: boolean } = {},
): void {
  const now = new Date().toISOString();
  // Reconcile the two crash windows before clearing any ownership identity.
  // `operator_dispatch_id` is written into the run row by startRun, before the
  // dispatcher can attach run_id. Therefore a claiming row with no linked run
  // is genuinely pre-launch and safe to requeue; a linked pending/recovery run
  // is ambiguous and belongs to human operator-effect recovery instead.
  const stranded = db
    .prepare(
      `SELECT id, state, run_id FROM operator_dispatches
        WHERE state IN ('claiming', 'running')
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    state: "claiming" | "running";
    run_id: string | null;
  }>;
  let requeuedDispatches = 0;
  let cancelledAmbiguousDispatches = 0;
  let convergedTerminalDispatches = 0;
  db.transaction(() => {
    for (const dispatch of stranded) {
      const linked = db
        .prepare(
          `SELECT id, state, operator_effect_state
             FROM agent_runs
            WHERE kind = 'operator'
              AND (id = ? OR operator_dispatch_id = ?)
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, rowid DESC
            LIMIT 1`,
        )
        .get(dispatch.run_id, dispatch.id, dispatch.run_id) as
        | {
            id: string;
            state: "queued" | "running" | "finished" | "error" | "interrupted";
            operator_effect_state: "pending" | "applied" | "recovery" | null;
          }
        | undefined;

      if (linked?.operator_effect_state === "pending" || linked?.operator_effect_state === "recovery") {
        db.prepare(
          `UPDATE operator_dispatches
              SET state = 'cancelled', run_id = ?, finished_at = ?,
                  next_attempt_at = NULL
            WHERE id = ? AND state IN ('claiming', 'running')`,
        ).run(linked.id, now, dispatch.id);
        cancelledAmbiguousDispatches += 1;
        continue;
      }

      if (linked?.operator_effect_state === "applied") {
        const terminal = linked.state === "error" || linked.state === "interrupted" ? "failed" : "finished";
        db.prepare(
          `UPDATE operator_dispatches
              SET state = ?, run_id = ?, finished_at = ?,
                  next_attempt_at = NULL
            WHERE id = ? AND state IN ('claiming', 'running')`,
        ).run(terminal, linked.id, now, dispatch.id);
        convergedTerminalDispatches += 1;
        continue;
      }

      // No durable run link means the claim died before startRun. Null effect
      // state is retained only for legacy/test rows predating effect markers.
      db.prepare(
        `UPDATE operator_dispatches
            SET state = 'queued', run_id = NULL, started_at = NULL,
                finished_at = NULL, next_attempt_at = NULL
          WHERE id = ? AND state IN ('claiming', 'running')`,
      ).run(dispatch.id);
      requeuedDispatches += 1;
    }
  })();
  const interrupted = db
    .prepare(
      `UPDATE agent_runs
          SET state = 'interrupted', finished_at = ?, phase = NULL, step = NULL,
              updated_at = ?
        WHERE kind = 'operator' AND state IN ('queued', 'running')
          AND id NOT LIKE 'run_seed_%'`,
    )
    .run(now, now);
  // Heal impossible legacy rows too: queued work never owns a run.
  db.prepare(
    `UPDATE operator_dispatches SET run_id = NULL, started_at = NULL
      WHERE state = 'queued' AND run_id IS NOT NULL`,
  ).run();
  if (
    interrupted.changes > 0 ||
    requeuedDispatches > 0 ||
    cancelledAmbiguousDispatches > 0 ||
    convergedTerminalDispatches > 0
  ) {
    logger.warn("recovered orphaned operator work after restart", {
      interruptedRuns: interrupted.changes,
      requeuedDispatches,
      cancelledAmbiguousDispatches,
      convergedTerminalDispatches,
    });
  }
  if (!options.deferDrain) void drainAutoOperatorQueue(db, dataRoot);
}

/** Archive preserves dispatch history as cancelled; delete subsequently purges
 * it. Conditional completion updates make late provider exits harmless. */
export function cancelAutoOperatorDispatchesForProject(
  db: Database.Database,
  projectSlug: string,
  dataRoot?: string,
): number {
  if (!db.open) return 0;
  const cancelled = db
    .prepare(
      `UPDATE operator_dispatches
          SET state = 'cancelled', finished_at = ?, next_attempt_at = NULL
        WHERE project_slug = ?
          AND state IN ('queued', 'claiming', 'running')`,
    )
    .run(new Date().toISOString(), projectSlug).changes;
  // Cancellation releases global capacity just like normal completion.
  void drainAutoOperatorQueue(db, dataRoot);
  return cancelled;
}

export function getOperatorDispatchStatus(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): OperatorDispatchStatus | null {
  const taskIncarnation = readTaskFile({
    projectSlug,
    taskKey,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  })?.parsed.frontmatter.createdAt;
  if (!taskIncarnation) return null;
  const row = db
    .prepare(
      `SELECT * FROM operator_dispatches
       WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(projectSlug, taskKey, taskIncarnation) as DispatchRow | undefined;
  return row
    ? {
        // `claiming` is an internal reservation and still looks queued to the
        // product. Cancellation is the scheduler's equivalent of interrupting
        // a runtime and maps onto the existing client-safe execution status.
        state: row.state === "claiming" ? "queued" : row.state === "cancelled" ? "interrupted" : row.state,
        trigger: row.trigger,
        runId: row.run_id,
        queuedAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }
    : null;
}

export function resetOperatorDispatchForTests(): void {
  const state = processState();
  state.draining = false;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.retryAt = null;
}
