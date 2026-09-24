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
 *    after every early return in `reconcileTaskExclusive`, so a row exists iff a
 *    pass completed for that task, changed or not;
 *  - **bounded** — `AUDIT_RETENTION_DAYS` (90) caps it at roughly 26k rows per
 *    task-year (288 ticks/day). `idx_audit_events__task_action` (project_slug,
 *    task_key, action, occurred_at) serves the per-task read from one task's
 *    rows (ruling 457); the action-only index made it walk every task's.
 *
 * DG-3 stays exactly as it is. Nothing here writes.
 */

/** One completed per-task reconcile pass (changed or not). */
export const RECONCILE_TASK_AUDIT_ACTION = "github.reconcile.task";
/** One completed project-wide sweep — a HUMAN-triggered one: the poller passes
 *  `skipProjectAudit: true` (reconcile-poller.server.ts) to keep the log
 *  readable, which is why the project-level read below unions both actions
 *  instead of trusting this one alone. */
export const RECONCILE_PROJECT_AUDIT_ACTION = "github.reconcile.project";

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
