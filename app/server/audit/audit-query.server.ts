import type { DatabaseSync } from "node:sqlite";

/**
 * Audit READ layer — the reads that answer "when did this actually happen?"
 * off `audit_events`, kept out of route loaders and UI modules the way
 * `server/provenance/provenance-query.server.ts` keeps the provenance reads
 * (P13-D-16). `audit-recorder.server.ts` next door owns the writes.
 *
 * F19-22, the reason this file exists: the app had exactly ONE freshness fact
 * on screen — `MAX(observed_at)` over `github.reconcile` PROVENANCE — and that
 * row is deliberately NOT written on an unchanged poller tick (DG-3,
 * `github-reconciler.server.ts`: `if (changed || !ctx.skipUnchangedProvenance)`)
 * so the table cannot grow without bound. It is therefore the last pass that
 * CHANGED something, and the surfaces rendering it as "Synced 3m ago" were
 * claiming the last pass that RAN. Live-proven: the task panel read "Synced 1h
 * ago" at 12:42Z while the audit rows below sat at 12:07/12:12/12:21/12:26/
 * 12:31/12:36/12:42 — seven successful passes the human was never shown.
 *
 * The honest "last check" lives here instead, in the per-tick audit row, which
 * is:
 *  - **unconditional** — `recordAudit({action: "github.reconcile.task"})` sits
 *    after every early return in `reconcileTaskUnlocked`, so a row exists iff a
 *    pass completed for that task, changed or not;
 *  - **bounded** — `AUDIT_RETENTION_DAYS` (90) caps it at roughly 26k rows per
 *    task-year (288 ticks/day). `idx_audit_events__task_action` (project_slug,
 *    task_key, action, occurred_at) serves the per-task read from one task's
 *    rows (ruling 11); the action-only index made it walk every task's.
 *
 * DG-3 stays exactly as it is. Nothing here writes.
 */

/** One completed per-task reconcile pass (changed or not). */
const RECONCILE_TASK_AUDIT_ACTION = "github.reconcile.task";
/** One completed project-wide sweep — a HUMAN-triggered one: the poller passes
 *  `skipProjectAudit: true` (reconcile-poller.server.ts) to keep the log
 *  readable, which is why the project-level read below unions both actions
 *  instead of trusting this one alone. */
const RECONCILE_PROJECT_AUDIT_ACTION = "github.reconcile.project";

/** The single aggregate column both reconcile-check reads select. */
interface ReconcileCheckRow {
  latest: string | null;
}

/**
 * ISO of the newest COMPLETED reconcile pass for one task; null when none is on
 * record (never checked, or every pass is older than the retention window).
 *
 * Null is load-bearing and must not be collapsed into "never synced": it says
 * nothing about whether the branch state is right, only that the app cannot
 * prove when it last looked.
 */
export function latestTaskReconcileCheckAt(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string | null {
  // SAFETY: a bare `MAX(...) AS latest` aggregate is a one-row, one-column
  // result — SQLite returns exactly one row whose `latest` is the newest
  // `occurred_at` (a TEXT column) or NULL when no row matched.
  const row = db
    .prepare(
      `SELECT MAX(occurred_at) AS latest FROM audit_events
       WHERE action = ? AND project_slug = ? AND task_key = ?`,
    )
    .get(RECONCILE_TASK_AUDIT_ACTION, projectSlug, taskKey) as
    | ReconcileCheckRow
    | undefined;
  return row?.latest ?? null;
}

/**
 * ISO of the newest completed reconcile pass anywhere in one project; null when
 * none is on record.
 *
 * The UNION of the per-task and project-sweep actions is not belt-and-braces:
 * a background tick writes ONLY per-task rows (`skipProjectAudit: true`), and a
 * human sweep over a project whose tasks are all terminal writes only the
 * project row (a budgeted pass skips terminal tasks entirely). Reading either
 * action alone reports "never checked" for one of those two live cases.
 */
export function latestProjectReconcileCheckAt(
  db: DatabaseSync,
  projectSlug: string,
): string | null {
  // SAFETY: same one-row aggregate as `latestTaskReconcileCheckAt` above.
  const row = db
    .prepare(
      `SELECT MAX(occurred_at) AS latest FROM audit_events
       WHERE project_slug = ? AND action IN (?, ?)`,
    )
    .get(
      projectSlug,
      RECONCILE_TASK_AUDIT_ACTION,
      RECONCILE_PROJECT_AUDIT_ACTION,
    ) as ReconcileCheckRow | undefined;
  return row?.latest ?? null;
}

/** One audit row's time and parsed details, as {@link taskAuditDetails} reads it. */
export interface TaskAuditDetailsRow {
  at: string;
  /** `details_json` parsed; null when absent or not JSON. The caller validates
   *  the shape it needs, because every action records its own. */
  details: unknown;
}

/**
 * Ruling 129: the newest rows of ONE action on ONE task, details parsed. The
 * operator's branch-update door reads its own earlier routing decisions here
 * (was this conflict already handed to the delivering agent once?), the way
 * the operator snapshot reads a person's dismissals. Served by
 * `idx_audit_events__task_action`; bounded by `limit` and by retention.
 */
export function taskAuditDetails(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; action: string; limit: number },
): TaskAuditDetailsRow[] {
  // SAFETY: `occurred_at` is TEXT NOT NULL and `details_json` nullable TEXT
  // (0001_baseline.sql); the two selected columns are exactly those.
  const rows = db
    .prepare(
      `SELECT occurred_at, details_json FROM audit_events
       WHERE project_slug = ? AND task_key = ? AND action = ?
       ORDER BY occurred_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(input.projectSlug, input.taskKey, input.action, input.limit) as {
    occurred_at: string;
    details_json: string | null;
  }[];
  return rows.map((row) => ({ at: row.occurred_at, details: parsedDetails(row.details_json) }));
}

/** A row's `details_json`, parsed; null when absent or not JSON. */
function parsedDetails(json: string | null): TaskAuditDetailsRow["details"] {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
