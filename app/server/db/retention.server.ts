import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";

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
 * Called best-effort at boot AND on the periodic maintenance interval
 * (`app/server/ops/maintenance.server.ts`); safe to call repeatedly (idempotent
 * — each pass only deletes rows already past the window). Gap 15: it used to
 * run at boot ONLY, which coupled the policy to the restart a stable
 * deployment avoids — the longer the uptime, the more it grew. Nothing here
 * needs an in-flight guard: every delete is age-windowed at 30/90 days, and the
 * two rows boot recovery reads as idempotency keys are exempt outright
 * (IDEMPOTENCY_AUDIT_ACTIONS below), so a mid-flight pass is safe by
 * construction.
 *
 * ## Export before purge (owner decision, 2026-08-31)
 *
 * FR33's audit purge used to hard-delete: past 90 days the only surviving record
 * was whatever the S3 backup schedule happened to have captured, and the
 * org-scoped events with no file counterpart (sign-ins, user administration,
 * connection and PAT changes) were simply gone. The owner's ruling is that the
 * purge must leave a durable record of what it removed, so every expiring row is
 * appended to `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl` FIRST
 * and only then deleted. The two halves are ordered and coupled: a failure to
 * write the export skips the delete for that pass (see
 * `exportExpiringAuditEvents`), because a purge deferred by six hours costs
 * disk the next pass reclaims while a purge without a record is irreversible.
 *
 * The rows go out exactly as the table stores them, one JSON object per line.
 * `audit/audit-export.server.ts` is deliberately NOT reused: it serializes a
 * camelCased projection into a single JSON ARRAY (or CSV) under a 100k row cap
 * with `details` re-parsed, which is the right shape for an admin download and
 * the wrong one for an append-only machine record of deleted rows.
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

export interface RetentionOptions {
  /** Data root the pre-purge audit export is written under. Production leaves it
   *  off and takes the configured root; tests and scripts pass their own, the
   *  same shape `pruneRuntimeTranscripts` and `reclaimTerminalTaskWorkspaces`
   *  take. */
  dataRoot?: string;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** The store folder the purge parks expiring audit rows in, one file per day. */
const AUDIT_EXPORT_DIRNAME = "audit-exports";

/**
 * One file per purge DAY, APPENDED to. A day sees several passes (boot, the
 * six-hour interval, a disk-pressure sweep), and each carries different rows, so
 * they accumulate in one file instead of the last one overwriting the record of
 * the others.
 */
function auditPurgeExportPath(now: Date, dataRoot: string | undefined): string {
  return path.join(
    getDataRoot(dataRoot),
    AUDIT_EXPORT_DIRNAME,
    `audit-events-${now.toISOString().slice(0, 10)}.jsonl`,
  );
}

/**
 * The `audit_events` row as the table stores it — snake_case column names, raw
 * `details_json` string, nothing renamed or reshaped, so the export line and the
 * deleted row are the same object.
 *
 * `looseObject`, not `object`: a column added by a later migration rides through
 * to the export rather than being silently stripped by a schema nobody
 * remembered to widen. The test pins the declared keys against the live table so
 * the addition is still noticed.
 */
const auditRowSchema = z.looseObject({
  id: z.string(),
  occurred_at: z.string(),
  actor_user_id: z.string().nullable(),
  actor_label: z.string(),
  action: z.string(),
  subject_kind: z.string().nullable(),
  subject_id: z.string().nullable(),
  project_slug: z.string().nullable(),
  task_key: z.string().nullable(),
  details_json: z.string().nullable(),
});

/** The purge predicate, built once so the export and the DELETE cannot disagree
 *  about which rows are expiring. Values are bound through placeholders. */
interface AuditPurgePredicate {
  where: string;
  params: string[];
}

function expiringAuditRows(now: Date): AuditPurgePredicate {
  return {
    where: `WHERE occurred_at < ?
              AND action NOT IN (${IDEMPOTENCY_AUDIT_ACTIONS.map(() => "?").join(", ")})`,
    params: [isoDaysAgo(now, AUDIT_RETENTION_DAYS), ...IDEMPOTENCY_AUDIT_ACTIONS],
  };
}

/**
 * Write the rows this purge is about to delete, then answer whether the DELETE
 * may proceed.
 *
 * FAIL CLOSED. Every way the record can fail to reach disk — rows that will not
 * parse, a directory that cannot be created, a write error — answers `false`,
 * and the caller leaves the rows in the table for the next pass to retry. There
 * is no such thing as a partially-exported purge here: the append is one call
 * carrying every line.
 *
 * An empty result is a vacuous success: no file is created for a pass with
 * nothing to purge, and the DELETE that follows reports zero.
 */
function exportExpiringAuditEvents(
  db: DatabaseSync,
  expiring: AuditPurgePredicate,
  now: Date,
  dataRoot: string | undefined,
): boolean {
  try {
    const rows = z
      .array(auditRowSchema)
      .parse(
        db
          .prepare(`SELECT * FROM audit_events ${expiring.where}`)
          .all(...expiring.params),
      );
    if (rows.length === 0) return true;
    const file = auditPurgeExportPath(now, dataRoot);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(
      file,
      rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
      "utf8",
    );
    logger.info("audit rows exported before purge", {
      rows: rows.length,
      file,
    });
    return true;
  } catch (error) {
    logger.warn("audit purge skipped: expiring rows could not be exported", {
      err: toError(error),
    });
    return false;
  }
}

export function applyRetention(
  db: DatabaseSync,
  now: Date = new Date(),
  options: RetentionOptions = {},
): RetentionResult {
  const runLogLines = Number(
    db
      .prepare(`DELETE FROM run_log_lines WHERE occurred_at < ?`)
      .run(isoDaysAgo(now, RUN_LOG_RETENTION_DAYS)).changes,
  );

  // Nothing can land between the export's SELECT and this DELETE: node:sqlite is
  // synchronous, and B-FD1 holds the data root to a single writing process — so
  // the same predicate over the same params names the same rows twice.
  const expiring = expiringAuditRows(now);
  const auditEvents = exportExpiringAuditEvents(db, expiring, now, options.dataRoot)
    ? Number(
        db
          .prepare(`DELETE FROM audit_events ${expiring.where}`)
          .run(...expiring.params).changes,
      )
    : 0;

  // Keep only the newest N notifications per user (window function — SQLite
  // 3.25+, which Node's SQLite build includes).
  const notifications = Number(
    db
      .prepare(
        `DELETE FROM notifications WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY user_id ORDER BY occurred_at DESC, rowid DESC
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
