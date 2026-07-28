import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";

/**
 * Data-retention / compaction policy (F10-29).
 *
 * Run logs and audit events accumulate without bound, and notifications were
 * only ever LIMITed at read time (the table still grew forever). This applies a
 * simple, explicit, age/count-based retention so a long-lived deployment does
 * not grow the SQLite file without limit. It is intentionally conservative: the
 * windows are generous (a full audit trail is a governance requirement, so audit
 * events are kept far longer than raw logs), and canonical Markdown task files —
 * the source of truth — are NEVER touched here; this only compacts the
 * rebuildable SQLite projection/log tables.
 *
 * Called best-effort at boot; safe to call repeatedly (idempotent — each pass
 * only deletes rows already past the window).
 */

/** Raw run log lines: high-volume, low durability value — kept 30 days. */
export const RUN_LOG_RETENTION_DAYS = 30;
/** Audit events: governance record — kept much longer (90 days). */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * B-FD10: audit actions that double as IDEMPOTENCY KEYS, exempt from the window
 * above. Boot recovery decides whether an effect already happened by asking
 * whether its audit row exists (`NOT EXISTS (SELECT 1 FROM audit_events …)`),
 * so deleting one of these rows does not merely lose history — it makes the
 * next boot redo the work. A >90-day-old task still sitting at `waiting=agent`
 * would have its finished run's reply posted a second time.
 *
 * Explicitly listed, not pattern-matched, so adding a recovery marker is a
 * deliberate act. Readers (app/server/runtimes/run-recovery.server.ts):
 *  - `task.agent.replied`            → recoverUnreactedAgentRuns
 *  - `runtime.operator.plan_executed`→ recoverStrandedOperatorPlans
 *
 * The rolling-window recovery counters (`run.recovery.reinvoked`,
 * `run.recovery.reply_replayed`) are deliberately NOT here: they are counted
 * inside a 30-minute window, so a 90-day-old row can never affect a budget.
 */
export const IDEMPOTENCY_AUDIT_ACTIONS = [
  "task.agent.replied",
  "runtime.operator.plan_executed",
] as const;
/** Notifications: keep the newest N per user (the UI reads far fewer). */
export const NOTIFICATION_MAX_PER_USER = 500;

export interface RetentionResult {
  runLogLines: number;
  auditEvents: number;
  notifications: number;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function applyRetention(
  db: DatabaseSync,
  now: Date = new Date(),
): RetentionResult {
  const runLogLines = Number(
    db
      .prepare(`DELETE FROM run_log_lines WHERE occurred_at < ?`)
      .run(isoDaysAgo(now, RUN_LOG_RETENTION_DAYS)).changes,
  );

  const auditEvents = Number(
    db
      .prepare(
        `DELETE FROM audit_events
          WHERE occurred_at < ?
            AND action NOT IN (${IDEMPOTENCY_AUDIT_ACTIONS.map(() => "?").join(", ")})`,
      )
      .run(isoDaysAgo(now, AUDIT_RETENTION_DAYS), ...IDEMPOTENCY_AUDIT_ACTIONS)
      .changes,
  );

  // Keep only the newest N notifications per user (window function — SQLite
  // 3.25+, which Node's SQLite build includes).
  const notifications = Number(
    db
      .prepare(
        `DELETE FROM notifications WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY user_id ORDER BY occurred_at DESC, id DESC
             ) AS rn
             FROM notifications
           ) WHERE rn > ?
         )`,
      )
      .run(NOTIFICATION_MAX_PER_USER).changes,
  );

  const result = { runLogLines, auditEvents, notifications };
  if (runLogLines + auditEvents + notifications > 0) {
    logger.info("retention pass complete", result);
  }
  return result;
}
