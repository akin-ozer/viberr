import type Database from "better-sqlite3";
import { newId } from "~/shared/ids/new-id.server";
import { logger } from "../logging/logger.server";

/**
 * Minimal audit recorder (phase 2). Every governed action calls recordAudit;
 * phase 10 builds the audit UX on top of the `audit_events` table.
 *
 * Rules:
 * - `details` must be secret-free (ids, emails, field names — never passwords,
 *   tokens or hashes).
 * - Recording must never break the action that triggered it: failures are
 *   logged and swallowed.
 */

export interface AuditActor {
  /** null for anonymous/system actors (e.g. failed logins, bootstrap seed). */
  userId: string | null;
  /** Human-readable label, e.g. "arda@viberr.dev" or "system". */
  label: string;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, label: "system" };

export interface AuditEventInput {
  /** lowercase dot-separated fact, e.g. "auth.login.success". */
  action: string;
  actor: AuditActor;
  subjectKind?: string;
  subjectId?: string;
  projectSlug?: string;
  taskKey?: string;
  details?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  subjectKind: string | null;
  subjectId: string | null;
  projectSlug: string | null;
  taskKey: string | null;
  details: Record<string, unknown> | null;
}

interface AuditEventRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  subject_kind: string | null;
  subject_id: string | null;
  project_slug: string | null;
  task_key: string | null;
  details_json: string | null;
}

export function recordAudit(
  db: Database.Database,
  event: AuditEventInput,
): void {
  try {
    db.prepare(
      `INSERT INTO audit_events
         (id, occurred_at, actor_user_id, actor_label, action,
          subject_kind, subject_id, project_slug, task_key, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("evt"),
      new Date().toISOString(),
      event.actor.userId,
      event.actor.label,
      event.action,
      event.subjectKind ?? null,
      event.subjectId ?? null,
      event.projectSlug ?? null,
      event.taskKey ?? null,
      event.details ? JSON.stringify(event.details) : null,
    );
  } catch (error) {
    logger.error("audit event could not be recorded", {
      action: event.action,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Newest-first listing (tests + phase 10 groundwork). */
export function listAuditEvents(
  db: Database.Database,
  options: { limit?: number; action?: string } = {},
): AuditEventRecord[] {
  const limit = options.limit ?? 100;
  const rows = (
    options.action
      ? db
          .prepare(
            `SELECT * FROM audit_events WHERE action = ?
             ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          )
          .all(options.action, limit)
      : db
          .prepare(
            `SELECT * FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          )
          .all(limit)
  ) as AuditEventRow[];
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    action: row.action,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    details: row.details_json
      ? (JSON.parse(row.details_json) as Record<string, unknown>)
      : null,
  }));
}
