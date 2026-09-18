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
 *
 * ## Ruling 234 (F37-52) — the window is a row count, so what fills it decides
 *    what the panel can show
 *
 * The panel above shipped as ONE `ORDER BY occurred_at DESC LIMIT 150` with the
 * "Org-scoped" toggle filtering those rows client-side, which means the toggle
 * can only narrow a window it does not control. Two facts then composed badly.
 *
 * `github.reconcile.task` is written UNCONDITIONALLY, once per delivered task per
 * poller tick — deliberately, and correctly, per F19-22: it is the honest answer
 * to "when did we last look" and must exist whether or not the pass changed
 * anything. Seven delivered tasks on a five-minute tick is 2,016 rows a day that
 * arrive while nobody touches the instance.
 *
 * Measured on pass 37's live instance: 91 of the panel's 150 rows (61%) were that
 * one action, the window spanned 53 minutes, and clicking "Org-scoped" left TWO
 * rows, both `projection.rescan`. Not one sign-in, not one PAT change, not one
 * user-administration event — while 96 such events sat on file, including the
 * instance's only `github.pat.created`. The feature was built to close exactly
 * the gap it still had.
 *
 * So: the heartbeat is excluded from the BROWSE (only here — the table, the
 * retention sweep, the export and `latestTaskReconcileCheckAt` are untouched, so
 * F19-22's guarantee is intact), and the org-scoped list is its own query rather
 * than a filter over whatever the unscoped one happened to return.
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

/**
 * Actions excluded from the BROWSE (ruling 234). A poller heartbeat is a
 * freshness fact, not an event a person reads: `github.reconcile.task` is
 * written on every completed pass per delivered task, changed or not, and it is
 * already rendered where it means something (the GitHub panel's "last checked",
 * via `latestTaskReconcileCheckAt`). Left in the table, the retention sweep and
 * the export, all of which want every row.
 *
 * Listed explicitly, never pattern-matched: hiding a row from an audit browse is
 * a deliberate act, and the next one should have to be argued for by name.
 */
const BROWSE_HIDDEN_ACTIONS = ["github.reconcile.task"] as const;

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
 *
 * `orgOnly` scopes to instance-level events (`project_slug IS NULL`) IN SQL, so
 * the org-scoped view gets its own 150 rows instead of whatever survives a
 * client-side filter of the unscoped window (ruling 234).
 */
export function listRecentAuditEvents(
  db: DatabaseSync,
  opts: { limit?: number; orgOnly?: boolean } = {},
): AuditBrowseRow[] {
  const limit = Math.max(
    1,
    Math.min(AUDIT_BROWSE_MAX_LIMIT, Math.floor(opts.limit ?? AUDIT_BROWSE_DEFAULT_LIMIT)),
  );
  const hidden = BROWSE_HIDDEN_ACTIONS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, occurred_at, actor_label, action, subject_kind, subject_id, project_slug
         FROM audit_events
        WHERE action NOT IN (${hidden})
          ${opts.orgOnly ? "AND project_slug IS NULL" : ""}
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...BROWSE_HIDDEN_ACTIONS, limit);
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
