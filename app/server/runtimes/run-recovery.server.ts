import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import { reapRunProcesses, type ReapRunProcesses } from "./run-processes.server";
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
 * The audit fact `executeCodexPlan` writes before it takes up a plan
 * (operator-run). Its absence on a FINISHED codex operator run is what marks
 * that turn as stranded (P14-RT-08).
 */
const OPERATOR_PLAN_EXECUTED_ACTION = "runtime.operator.plan_executed";
/**
 * How long after a codex operator run finished its plan may still be replayed.
 * The stranding window is seconds (finish → in-process callback); a boot that
 * happens hours later is not recovering a dropped turn, it is re-deciding an old
 * one against state that has moved.
 */
const STRANDED_PLAN_MAX_AGE_MS = 60 * 60 * 1000;

/** What one boot's orphan sweep did. */
export interface OrphanFinalization {
  /** Non-terminal run rows moved to `interrupted` with reason `restart`. */
  finalized: number;
  /** Orphaned tasks for which the operator was re-invoked this boot. */
  reinvoked: number;
  /** Orphaned tasks whose re-invoke was skipped by the crash-loop cap. */
  capped: number;
  /**
   * The re-invokes this sweep LAUNCHED, joinable.
   *
   * A re-invoked operator drive clones `<taskDir>/workspace/<repo>`, and boot's
   * workspace reclaim deletes exactly those directories on the claim that no
   * run of this process holds a working tree — a claim only a caller that can
   * WAIT for these can honour. Already settled when nothing was re-invoked, and
   * it never rejects: each re-invoke is caught per task.
   */
  reinvokes: Promise<void>;
  /**
   * Ruling 174: the sweep of whatever the orphans' processes left alive,
   * joinable for the same reason. A run's Claude CLI leads its own process
   * group, so a server that died without shutting down does not take it along,
   * and a survivor could still be writing the working tree the reclaim
   * deletes. Never rejects.
   */
  reaped: Promise<void>;
}

export interface FinalizeOrphanedRunsDeps {
  /** The sweep (default: the real one), injectable so a test can see which
   *  runs it was asked to reap. */
  reapProcesses?: ReapRunProcesses;
}

/**
 * Boot-time finalization of non-terminal runs.
 *
 * A run row is written `running`/`queued` while its adapter drives it in THIS
 * process. On a fresh boot there is by definition no live handle for any prior
 * run, so a run still in a non-terminal state has no process behind it — a
 * ticking ELAPSED and an "agent working" badge with nothing real running,
 * indistinguishable from live work. Every orphan becomes `interrupted` with
 * `interrupted_reason: 'restart'` (pass 35 U35-7: the state the human-interrupt
 * path already uses, and a reason rather than a pseudo-user in
 * `interrupted_by`, which stays a user id or null), and the operator is
 * re-invoked for each affected task so it can recover instead of stalling
 * forever. The run projection reads the reason as "interrupted by a restart";
 * Insights keeps such a run out of the error count, and a queued one that never
 * executed a turn out of the completion denominator.
 *
 * Idempotent: a second boot finds nothing non-terminal.
 *
 * "No process behind it" is made true rather than assumed (ruling 174): every
 * process an orphan started carries its run id, and the sweep signals what is
 * still alive, so a CLI the dead server left running stops before its row is
 * reported interrupted and its workspace reclaimed.
 */
export function finalizeOrphanedRuns(
  db: DatabaseSync,
  deps: FinalizeOrphanedRunsDeps = {},
): OrphanFinalization {
  // SAFETY: every column named here is declared NOT NULL TEXT on `agent_runs`
  // (db/migrations/0001_baseline.sql), so each row carries exactly these four
  // string fields.
  const orphans = db
    .prepare(
      `SELECT id, project_slug, task_key, kind
         FROM agent_runs
        WHERE state IN ('running', 'queued')`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    kind: string;
  }[];
  if (orphans.length === 0) {
    return {
      finalized: 0,
      reinvoked: 0,
      capped: 0,
      reinvokes: Promise.resolve(),
      reaped: Promise.resolve(),
    };
  }

  const reapProcesses = deps.reapProcesses ?? reapRunProcesses;
  const reaped = reapProcesses({ runIds: orphans.map((run) => run.id) }).then(
    () => {},
    (error) => {
      logger.warn("reaping the orphaned runs' processes failed", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
    },
  );

  const now = new Date().toISOString();
  const realTasks = new Map<string, { projectSlug: string; taskKey: string }>();
  for (const run of orphans) {
    patchRun(db, run.id, {
      state: "interrupted",
      finishedAt: now,
      interruptedReason: "restart",
      phase: null,
      step: null,
    });
    // Ruling 99: a controller conversation turn carries no task — there is no
    // operator to re-invoke for it. Its own recovery (an honest "interrupted
    // by a restart" note on the conversation) lives in controller-run.
    if (run.kind === "controller") continue;
    realTasks.set(`${run.project_slug}/${run.task_key}`, {
      projectSlug: run.project_slug,
      taskKey: run.task_key,
    });
  }
  logger.info("finalized non-terminal runs at boot", {
    total: orphans.length,
  });

  // Re-invoke the operator only for tasks under the crash-loop cap. The gate is resolved
  // synchronously — each pass records its own audit row so the NEXT boot counts
  // it — then the (costly) operator runs fire-and-forget for the survivors.
  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const toReinvoke: { projectSlug: string; taskKey: string }[] = [];
  let capped = 0;
  for (const t of realTasks.values()) {
    // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
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

  let reinvokes: Promise<void> = Promise.resolve();
  if (toReinvoke.length > 0) {
    reinvokes = (async () => {
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
    reinvoked: toReinvoke.length,
    capped,
    reinvokes,
    reaped,
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
 * recovers those runs: for each finished specialist/reviewer
 * run whose task is still waiting=agent and which never recorded a
 * `task.agent.replied` audit row, it posts the missing reply and re-invokes the
 * operator to react — exactly what the lost callback would have done.
 *
 * Safe by construction:
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
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number; capped: number }> {
  // SAFETY: every selected column but `outcome_key` and the two `dispatched_by_*`
  // columns is NOT NULL on `agent_runs`, and `backend` carries
  // `CHECK (backend IN ('claude', 'codex'))` — the two members of `RealBackend`
  // (db/migrations/0001_baseline.sql).
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.backend, r.role, r.kind,
              r.agent_profile_id, r.outcome_key,
              r.dispatched_by_name, r.dispatched_by_user_id
         FROM agent_runs r
         JOIN task_projections t
           ON t.project_slug = r.project_slug AND t.task_key = r.task_key
        WHERE r.kind IN ('primary', 'reviewer')
          AND r.state = 'finished'
          AND r.agent_profile_id IS NOT NULL
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
    backend: RealBackend;
    role: string;
    kind: string;
    agent_profile_id: string;
    outcome_key: string | null;
    dispatched_by_name: string | null;
    dispatched_by_user_id: string | null;
  }[];

  if (rows.length === 0) return { recovered: 0, capped: 0 };
  logger.info("recovering dropped agent-reply reactions after restart", {
    count: rows.length,
  });

  const [{ applyAgentCompletionEffects }, { agentMentionHandle, replyTextForRun }] =
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
      // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
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
      const completion: Parameters<typeof applyAgentCompletionEffects>[2] = {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        backend: row.backend,
        profileId: row.agent_profile_id,
        role: row.role,
        delivers: row.kind === "primary",
        workdir: null,
        // P14-RT-12: the ONE handle derivation every writer shares. The
        // role's first word ("Senior Developer" → `@senior`) resolved to no
        // agent at all, so a recovered run's stuck-packet observation named a
        // handle nobody could reply to.
        agentHandle: agentMentionHandle({ profileId: row.agent_profile_id }),
      };
      // AO-1: re-supply the staging key so the staged report_outcome envelope
      // (persisted in staged_outcomes) is consumed on recovery — a Claude
      // verdict survives a restart instead of falling back to the prose regex.
      // Left ABSENT, not undefined, when the run stored none.
      if (row.outcome_key) completion.outcomeKey = row.outcome_key;
      // C02-R11 (pass 32): the dispatch-completion contract survives the
      // restart too — the dispatcher is re-supplied from the row, so the
      // recovered report still carries its cc line and the operator is
      // re-invoked exactly as the lost in-process callback would have done.
      if (row.dispatched_by_name) {
        completion.dispatchedByName = row.dispatched_by_name;
        if (row.dispatched_by_user_id) {
          completion.dispatchedByUserId = row.dispatched_by_user_id;
        }
      }
      await applyAgentCompletionEffects(db, ctx, completion, {
        id: row.id,
        state: "finished",
      });
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

/**
 * Boot-time recovery of stranded CODEX operator plans (P14-RT-08).
 *
 * A Codex operator run does its coordination AFTER the provider run finishes:
 * the completion callback parses the structured plan and executes it through the
 * gated operator actions. That callback lives in the process, so a restart in
 * the window between `finished` and the plan running lost the entire turn with
 * no trace — the finished row is outside `finalizeOrphanedRuns` (running/queued
 * only) AND outside `recoverUnreactedAgentRuns` (primary/reviewer only), and the
 * task kept sitting at waiting=agent.
 *
 * Selection mirrors the reply reconciler: a finished codex operator run on a
 * task still waiting on an agent, with no `runtime.operator.plan_executed` audit
 * row. That row is written before the first governed action, so a plan that
 * merely CRASHED mid-execution is never re-run here — re-applying half a plan is
 * worse than leaving it, and the escalation paths inside the executor already
 * cover a plan that fails on its own terms.
 *
 * Bounded by `STRANDED_PLAN_MAX_AGE_MS`, because a plan is a decision ABOUT a
 * state: executing a day-old one against a task that has since moved would
 * duplicate an engagement or transition rather than recover anything. The window
 * this exists for is seconds long. Anything older is reported, never replayed.
 */
export async function recoverStrandedOperatorPlans(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number; stale: number }> {
  // SAFETY: the three id columns are NOT NULL TEXT on `agent_runs`;
  // `finished_at` is the one nullable column of the four.
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.finished_at
         FROM agent_runs r
         JOIN task_projections t
           ON t.project_slug = r.project_slug AND t.task_key = r.task_key
        WHERE r.kind = 'operator'
          AND r.backend = 'codex'
          AND r.state = 'finished'
          AND t.waiting = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
             WHERE a.action = ?
               AND a.subject_id = r.id
          )`,
    )
    .all(OPERATOR_PLAN_EXECUTED_ACTION) as {
    id: string;
    project_slug: string;
    task_key: string;
    finished_at: string | null;
  }[];
  if (rows.length === 0) return { recovered: 0, stale: 0 };

  const cutoff = Date.now() - STRANDED_PLAN_MAX_AGE_MS;
  const fresh = rows.filter((r) => {
    const at = r.finished_at ? Date.parse(r.finished_at) : NaN;
    return Number.isFinite(at) && at >= cutoff;
  });
  const stale = rows.length - fresh.length;
  if (stale > 0) {
    logger.warn("stranded codex operator plans are too old to replay safely", {
      stale,
      maxAgeMs: STRANDED_PLAN_MAX_AGE_MS,
      taskKeys: rows
        .filter((r) => !fresh.includes(r))
        .map((r) => r.task_key),
    });
  }
  if (fresh.length === 0) return { recovered: 0, stale };

  logger.info("recovering stranded codex operator plans after restart", {
    count: fresh.length,
  });
  const { executeStrandedCodexPlan } = await import("./operator-run.server");
  let recovered = 0;
  for (const row of fresh) {
    try {
      const executed = await executeStrandedCodexPlan(db, ctx, {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        runId: row.id,
      });
      if (executed) recovered += 1;
    } catch (error) {
      logger.warn("codex operator plan recovery failed for a run", {
        runId: row.id,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  logger.info("codex operator plan recovery complete", { recovered, stale });
  return { recovered, stale };
}
