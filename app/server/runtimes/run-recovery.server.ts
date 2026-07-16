import type Database from "better-sqlite3";
import { logger } from "~/server/logging/logger.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import { patchRun } from "./run-store.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Boot-time finalization of runs orphaned by a restart (F-RUN1).
 *
 * A run row is written `running`/`queued` while its adapter drives it in THIS
 * process. If the server dies mid-run, the row keeps that state forever: the UI
 * then shows a perpetual "agent working" / "N runs active" badge and a ticking
 * ELAPSED with no live process behind it — indistinguishable from real work.
 * Nothing else recovers these (run-recovery below only touches `finished`
 * runs). On a fresh boot there is by definition no live handle for any prior
 * run, so every real (non-simulated) run still in a non-terminal state is an
 * orphan; flip it to `error` (interrupted-by-restart) so state is honest, and
 * re-invoke the operator for tasks left waiting on that dead run so they don't
 * stall. Simulated/seed runs are left alone (they carry no live process by
 * design and are handled by the seed layer). Idempotent: a second boot finds
 * nothing running.
 */
export function finalizeOrphanedRuns(db: Database.Database): {
  finalized: number;
} {
  const orphans = db
    .prepare(
      `SELECT id, project_slug, task_key, kind
         FROM agent_runs
        WHERE state IN ('running', 'queued')
          AND simulated = 0`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    kind: string;
  }[];
  if (orphans.length === 0) return { finalized: 0 };

  const now = new Date().toISOString();
  for (const run of orphans) {
    patchRun(db, run.id, {
      state: "error",
      finishedAt: now,
      interruptedBy: "restart",
    });
  }
  logger.info("finalized runs orphaned by restart", {
    count: orphans.length,
  });

  // Re-invoke the operator for each affected task so a task left waiting on a
  // now-dead run gets re-coordinated (re-dispatch or a recovery packet) instead
  // of stalling. Fire-and-forget; never blocks boot.
  const tasks = new Map<string, { projectSlug: string; taskKey: string }>();
  for (const run of orphans) {
    tasks.set(`${run.project_slug}/${run.task_key}`, {
      projectSlug: run.project_slug,
      taskKey: run.task_key,
    });
  }
  void (async () => {
    const { runOperator } = await import("./operator-run.server");
    for (const t of tasks.values()) {
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

  return { finalized: orphans.length };
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
 */
export async function recoverUnreactedAgentRuns(
  db: Database.Database,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number }> {
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.backend, r.role, r.kind
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
  }[];

  if (rows.length === 0) return { recovered: 0 };
  logger.info("recovering dropped agent-reply reactions after restart", {
    count: rows.length,
  });

  const [{ applyAgentCompletionEffects }, { replyTextForRun }] =
    await Promise.all([
      import("~/server/tasks/task-actions.server"),
      import("~/server/tasks/agent-reply.server"),
    ]);

  let recovered = 0;
  for (const row of rows) {
    try {
      const replyText = replyTextForRun(db, row.id);
      if (!replyText) continue;
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
  logger.info("agent-reply recovery complete", { recovered });
  return { recovered };
}
