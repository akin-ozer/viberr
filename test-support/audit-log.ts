import type { DatabaseSync } from "node:sqlite";

/**
 * Raw `audit_events` reader for tests. Production reads audit rows through
 * the project-scoped display query (`listAuditLog` in
 * app/server/projections/activity-feed.server.ts), which whitelists actions
 * and templates them into display text — tests instead assert on the raw
 * recorded facts (action, actor, subject, details), so they read the table
 * directly here.
 */

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

/** Newest-first, optionally filtered to one action. */
export function listAuditEvents(
  db: DatabaseSync,
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
  ) as unknown as AuditEventRow[];
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
