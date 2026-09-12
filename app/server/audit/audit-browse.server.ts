import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * PG26-A — an IN-APP browse view of the audit log for an org admin.
 *
 * The project Activity page browses PROJECT-scoped events, and the audit EXPORT
 * (audit-export.server.ts) hands the whole table out as a file — but nothing let
 * an admin READ org/instance-scoped events (`auth.login.*`, `org.user.*`,
 * `org.connection.*`, `github.pat.*`) inside the app: they only existed in a
 * downloaded CSV/JSON. This is the lean read behind the org-settings Audit panel:
 * the most recent events, newest first, with just the columns a browse row shows
 * (no `details` blob — the export carries that). Org-admin gated at the route.
 */

export interface AuditBrowseRow {
  id: string;
  occurredAt: string;
  /** Human label for the actor; "system" for unattributed server actions. */
  actorLabel: string;
  action: string;
  subjectKind: string | null;
  subjectId: string | null;
  /** null = an ORG/instance-scoped event (the class that had no in-app view). */
  projectSlug: string | null;
}

/** Default browse window — recent events, enough to scan without paging. */
export const AUDIT_BROWSE_DEFAULT_LIMIT = 150;
const AUDIT_BROWSE_MAX_LIMIT = 500;

const rowSchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  actor_label: z.string(),
  action: z.string(),
  subject_kind: z.string().nullable(),
  subject_id: z.string().nullable(),
  project_slug: z.string().nullable(),
});

/**
 * The most recent audit events, newest first. `limit` is clamped to a sane range
 * so a hand-built request can neither ask for zero nor try to page the whole
 * table into memory (the export exists for the full dump).
 */
export function listRecentAuditEvents(
  db: DatabaseSync,
  opts: { limit?: number } = {},
): AuditBrowseRow[] {
  const limit = Math.max(
    1,
    Math.min(AUDIT_BROWSE_MAX_LIMIT, Math.floor(opts.limit ?? AUDIT_BROWSE_DEFAULT_LIMIT)),
  );
  const rows = db
    .prepare(
      `SELECT id, occurred_at, actor_label, action, subject_kind, subject_id, project_slug
         FROM audit_events
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(limit);
  return z
    .array(rowSchema)
    .parse(rows)
    .map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorLabel: r.actor_label,
      action: r.action,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      projectSlug: r.project_slug,
    }));
}
