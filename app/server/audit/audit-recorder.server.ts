import type Database from "better-sqlite3";
import { newId } from "~/shared/ids/new-id.server";
import type { ProjectAuthoritySource } from "~/shared/rbac";
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
  /**
   * Internal authorization context. This is never stored as actor identity;
   * recordAudit promotes the emergency fallback into details_json instead.
   * Keeping it on the actor lets a route authorize once and every downstream
   * service audit (run start, GitHub reconciliation, etc.) inherit the same
   * provenance without each service knowing about project RBAC.
   */
  auditAuthoritySource?: "org_admin_override";
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, label: "system" };

/**
 * Carry project authorization provenance through a service call graph.
 * Ordinary project-role authorization returns the actor unchanged, preserving
 * the historical audit details shape. Only the emergency organization-admin
 * fallback is attached and recordAudit serializes it centrally.
 */
export function withProjectAuditAuthority<T extends AuditActor>(
  actor: T,
  source: ProjectAuthoritySource,
): T {
  if (source !== "org_admin_override") {
    if (!actor.auditAuthoritySource) return actor;
    const { auditAuthoritySource: _discarded, ...cleanActor } = actor;
    return cleanActor as T;
  }
  return { ...actor, auditAuthoritySource: source };
}

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
  db: Database.Database,
  event: AuditEventInput,
): void {
  try {
    const details =
      event.actor.auditAuthoritySource === "org_admin_override"
        ? {
            ...(event.details ?? {}),
            authoritySource: "org_admin_override",
          }
        : event.details;
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
      details ? JSON.stringify(details) : null,
    );
  } catch (error) {
    logger.error("audit event could not be recorded", {
      action: event.action,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
