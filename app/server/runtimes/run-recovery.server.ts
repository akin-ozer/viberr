import type Database from "better-sqlite3";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import { patchRun } from "./run-store.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Crash-loop backstop for the boot recovery re-invoke (F7-BOOT1). A boot that
 * finalizes a real orphan re-fires the operator; if that operator run itself
 * crashes the process, the NEXT boot re-orphans it and re-fires again — a loop
 * that re-runs real, costed operator coordination on every restart. We cap the
 * re-invokes per task inside a rolling window: each actual re-invoke records an
 * audit row, and once `RECOVERY_REINVOKE_CAP` rows exist for a task within
 * `RECOVERY_WINDOW_MS`, further boots still finalize the orphan row but SKIP the
 * operator re-invoke. A restart that lands after the window has elapsed sees a
 * clean count and re-invokes normally (the common single-boot case).
 */
export const RECOVERY_REINVOKE_CAP = 3;
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const RECOVERY_REINVOKE_ACTION = "run.recovery.reinvoked";
/** Same crash-loop backstop for the reply-recovery re-invoke path (below). */
const RECOVERY_REPLAY_ACTION = "run.recovery.reply_replayed";

/**
 * Boot-time finalization of non-terminal runs (F-RUN1 + R6-5).
 *
 * A run row is written `running`/`queued` while its adapter drives it in THIS
 * process. On a fresh boot there is by definition no live handle for any prior
 * run, so a run still in a non-terminal state has no process behind it — a
 * ticking ELAPSED and an "agent working" badge with nothing real running,
 * indistinguishable from live work. Two kinds get finalized:
 *
 *  - REAL runs (simulated = 0) orphaned by a restart → `error`
 *    (interrupted-by-restart), and the operator is re-invoked for each affected
 *    task so it re-coordinates (re-dispatch or a recovery packet) rather than
 *    stalling forever.
 *  - SEED/demo runs (simulated = 1) that the seed wrote as `running` for
 *    walkthrough dressing → `finished` (owner ruling R6-5: simulated runs must
 *    not masquerade as live; Viberr Core goes quiet unless a real agent runs).
 *    NO operator re-invoke — demo tasks must not spawn real coordination on boot.
 *
 * Idempotent: a second boot finds nothing non-terminal.
 */
export function finalizeOrphanedRuns(db: Database.Database): {
  finalized: number;
  simulated: number;
  /** Real orphaned tasks for which the operator was re-invoked this boot. */
  reinvoked: number;
  /** Real orphaned tasks whose re-invoke was skipped by the crash-loop cap. */
  capped: number;
} {
  const orphans = db
    .prepare(
      `SELECT id, project_slug, task_key, kind, simulated
         FROM agent_runs
        WHERE state IN ('running', 'queued')`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    kind: string;
    simulated: number;
  }[];
  if (orphans.length === 0)
    return { finalized: 0, simulated: 0, reinvoked: 0, capped: 0 };

  const now = new Date().toISOString();
  const realTasks = new Map<string, { projectSlug: string; taskKey: string }>();
  let simulatedCount = 0;
  for (const run of orphans) {
    if (run.simulated === 1) {
      // Demo dressing — retire it quietly as a finished historical run.
      patchRun(db, run.id, { state: "finished", finishedAt: now });
      simulatedCount += 1;
    } else {
      patchRun(db, run.id, {
        state: "error",
        finishedAt: now,
        interruptedBy: "restart",
      });
      realTasks.set(`${run.project_slug}/${run.task_key}`, {
        projectSlug: run.project_slug,
        taskKey: run.task_key,
      });
    }
  }
  logger.info("finalized non-terminal runs at boot", {
    total: orphans.length,
    simulated: simulatedCount,
    real: orphans.length - simulatedCount,
  });

  // Re-invoke the operator ONLY for real orphaned tasks (never demo runs), and
  // only for tasks under the crash-loop cap (F7-BOOT1). The gate is resolved
  // synchronously — each pass records its own audit row so the NEXT boot counts
  // it — then the (costly) operator runs fire-and-forget for the survivors.
  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const toReinvoke: { projectSlug: string; taskKey: string }[] = [];
  let capped = 0;
  for (const t of realTasks.values()) {
    const priorReinvokes = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM audit_events
            WHERE action = ?
              AND project_slug = ?
              AND task_key = ?
              AND occurred_at >= ?`,
        )
        .get(
          RECOVERY_REINVOKE_ACTION,
          t.projectSlug,
          t.taskKey,
          windowStart,
        ) as { n: number }
    ).n;
    if (priorReinvokes >= RECOVERY_REINVOKE_CAP) {
      capped += 1;
      logger.warn("recovery re-invoke capped (crash-loop backstop)", {
        taskKey: t.taskKey,
        projectSlug: t.projectSlug,
        priorReinvokes,
        cap: RECOVERY_REINVOKE_CAP,
      });
      continue;
    }
    recordAudit(db, {
      // String literal (not RECOVERY_REINVOKE_ACTION) so the audit-coverage
      // static sweep can parse this call site; the SQL count above still uses
      // the constant. Both must stay in sync with the catalog entry.
      action: "run.recovery.reinvoked",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: t.taskKey,
      projectSlug: t.projectSlug,
      taskKey: t.taskKey,
      details: { attempt: priorReinvokes + 1 },
    });
    toReinvoke.push(t);
  }

  if (toReinvoke.length > 0) {
    void (async () => {
      const { runOperator } = await import("./operator-run.server");
      for (const t of toReinvoke) {
        try {
          await runOperator(db, {
            projectSlug: t.projectSlug,
            taskKey: t.taskKey,
            trigger: "manual",
          });
        } catch (error) {
          logger.warn("operator re-invoke after orphan finalize failed", {
            taskKey: t.taskKey,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    })().catch(() => {});
  }

  return {
    finalized: orphans.length,
    simulated: simulatedCount,
    reinvoked: toReinvoke.length,
    capped,
  };
}

/**
 * Boot-time recovery of dropped agent-reply reactions (NFR17, B9).
 *
 * A finished specialist/reviewer run posts its reply and re-invokes the operator
 * through an IN-PROCESS completion callback (run-service `registerRunCompletion`).
 * If the server restarts after a run finished but before its callback fired, the
 * reply is never posted and the operator never reacts — the task stalls at
 * waiting=agent forever with no error. This reconciler runs once at boot and
 * recovers those runs: for each real (non-simulated) finished specialist/reviewer
 * run whose task is still waiting=agent and which never recorded a
 * `task.agent.replied` audit row, it posts the missing reply and re-invokes the
 * operator to react — exactly what the lost callback would have done.
 *
 * Safe by construction:
 *  - Only `simulated = 0` runs (seeded/demo runs are excluded).
 *  - Only tasks currently `waiting = 'agent'` (a live stall, not old history).
 *  - Idempotent: `postAgentReplyComment` writes the `task.agent.replied` audit
 *    row, so a recovered run is not reprocessed on the next boot.
 *  - Fire-and-forget per run; one failure never blocks the others or boot.
 *  - Crash-loop backstop (mirrors `finalizeOrphanedRuns`): recovery re-invokes
 *    the operator via `applyAgentCompletionEffects`. If the reply-comment write
 *    keeps failing (so the `task.agent.replied` idempotency audit never lands),
 *    the run is re-selected on EVERY boot and re-fires costed operator
 *    coordination — a tight boot→recover→crash loop if that operator run itself
 *    kills the process. Each replay records a `run.recovery.reply_replayed` audit
 *    row BEFORE running the effects; once `RECOVERY_REINVOKE_CAP` rows exist for a
 *    run within `RECOVERY_WINDOW_MS`, further boots SKIP that run (logged) instead
 *    of re-firing. A restart after the window elapses sees a clean count.
 */
export async function recoverUnreactedAgentRuns(
  db: Database.Database,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number; capped: number }> {
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.backend, r.role, r.kind,
              r.agent_profile_id
         FROM agent_runs r
         JOIN task_projections t
           ON t.project_slug = r.project_slug AND t.task_key = r.task_key
        WHERE r.kind IN ('primary', 'reviewer')
          AND r.state = 'finished'
          AND r.simulated = 0
          AND t.waiting = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
             WHERE a.action = 'task.agent.replied'
               AND a.details_json LIKE '%"runId":"' || r.id || '"%'
          )`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    backend: string;
    role: string;
    kind: string;
    agent_profile_id: string | null;
  }[];

  if (rows.length === 0) return { recovered: 0, capped: 0 };
  logger.info("recovering dropped agent-reply reactions after restart", {
    count: rows.length,
  });

  const [{ applyAgentCompletionEffects }, { replyTextForRun }] =
    await Promise.all([
      import("~/server/tasks/task-actions.server"),
      import("~/server/tasks/agent-reply.server"),
    ]);

  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  let recovered = 0;
  let capped = 0;
  for (const row of rows) {
    try {
      const replyText = replyTextForRun(db, row.id);
      if (!replyText) continue;
      // Crash-loop backstop (see docstring): count prior replays for THIS run in
      // the rolling window; once at the cap, skip re-firing costed operator
      // coordination. The count keys on runId (in details_json) so distinct runs
      // on the same task each get their own budget — never a shared task counter.
      const priorReplays = (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM audit_events
              WHERE action = ?
                AND task_key = ?
                AND details_json LIKE '%"runId":"' || ? || '"%'
                AND occurred_at >= ?`,
          )
          .get(RECOVERY_REPLAY_ACTION, row.task_key, row.id, windowStart) as {
          n: number;
        }
      ).n;
      if (priorReplays >= RECOVERY_REINVOKE_CAP) {
        capped += 1;
        logger.warn("agent-reply recovery capped (crash-loop backstop)", {
          runId: row.id,
          taskKey: row.task_key,
          priorReplays,
          cap: RECOVERY_REINVOKE_CAP,
        });
        continue;
      }
      // Record the ATTEMPT before running effects so the next boot counts it even
      // if the effects (or the whole process) die mid-flight. String literal (not
      // RECOVERY_REPLAY_ACTION) so the audit-coverage static sweep can parse this
      // call site; the SQL count above uses the constant. Keep both in sync with
      // the catalog entry.
      recordAudit(db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: row.task_key,
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        details: { runId: row.id, attempt: priorReplays + 1 },
      });
      // Run the SAME completion effects the lost in-process callback would have:
      // reply → workspace-delivery reconcile → (reviewer) verdict → operator
      // REACT (trigger `agent-reply`, fresh chain at depth 0) or stuck-packet/
      // waiting flip. A recovered reviewer run therefore records its verdict and
      // captures its branch/PR exactly like a live one.
      await applyAgentCompletionEffects(
        db,
        ctx,
        {
          projectSlug: row.project_slug,
          taskKey: row.task_key,
          backend: row.backend as RealBackend,
          profileId: row.agent_profile_id ?? null,
          role: row.role,
          kind: row.kind === "reviewer" ? "reviewer" : "primary",
          workdir: null,
          agentHandle: row.role.trim().split(/[\s/&]+/)[0]?.toLowerCase() ?? row.role,
        },
        { id: row.id, state: "finished", simulated: false },
      );
      recovered += 1;
    } catch (error) {
      logger.warn("agent-reply recovery failed for a run", {
        runId: row.id,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  logger.info("agent-reply recovery complete", { recovered, capped });
  return { recovered, capped };
}
