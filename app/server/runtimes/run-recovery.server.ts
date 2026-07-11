import type Database from "better-sqlite3";
import { logger } from "~/server/logging/logger.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import type { RealBackend } from "./runtime-registry.server";

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
