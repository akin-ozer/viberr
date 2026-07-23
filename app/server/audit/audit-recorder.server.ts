import type { DatabaseSync } from "node:sqlite";
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

export function recordAudit(
  db: DatabaseSync,
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
