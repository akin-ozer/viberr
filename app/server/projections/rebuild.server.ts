import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "~/server/db/transaction.server";
import {
  recordAudit,
  type AuditActor,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  collectProjectionEvents,
  emitProjectionEvent,
} from "~/server/events/projection-events.server";
import { rebuildAll, type RescanSummary } from "./rebuilder.server";

/**
 * Full projection rebuild (Phase 10 recovery): DROP every projection row
 * derived from store files, then re-project the whole tree from disk.
 *
 * Vs. the everyday re-scan (`rescanProjections`): a rescan reconciles by
 * content hash and only touches drifted files; the rebuild is the recovery
 * hammer for a corrupted/suspect projection DB — it discards all derived
 * rows first, so no stale row can survive a hash collision, a partial write,
 * or a projection-schema bug.
 *
 * What is dropped: projects, project_members (cascade), task_projections,
 * task_events, diagnostics — all fully file-derived. Epic rows (ruling 272)
 * stay: `rebuildAll` re-projects every epic file with force and prunes the
 * rows whose file is gone. NOT dropped: users, sessions, notifications,
 * audit_events, provenance, PATs/violations, agent_runs/run_log_lines, org
 * resources (app-owned or historical truth).
 *
 * Atomic: the drop + rebuild run inside one transaction, so readers never
 * observe a half-empty projection. Projection events (per-file updates + the
 * final `projection.rebuilt` broadcast from rebuildAll) are COLLECTED during
 * the transaction and emitted only after commit — an SSE-triggered
 * revalidation must never race a half-built (or rolled-back) projection.
 */
export function rebuildProjections(
  db: DatabaseSync,
  options: { dataRoot?: string; actor?: AuditActor } = {},
): RescanSummary {
  const run = (): RescanSummary =>
    withTransaction(db, () => {
      db.prepare(`DELETE FROM task_events`).run();
      db.prepare(`DELETE FROM diagnostics`).run();
      db.prepare(`DELETE FROM task_projections`).run();
      db.prepare(`DELETE FROM projects`).run(); // project_members cascade
      return rebuildAll(db, {
        force: true,
        dataRoot: options.dataRoot,
      });
    });
  // Buffer every projection event raised inside the transaction; deliver
  // after commit (a throwing transaction rolls back AND drops its events).
  const { result, events } = collectProjectionEvents(run);
  for (const event of events) emitProjectionEvent(event);
  recordAudit(db, {
    action: "projection.rebuild",
    actor: options.actor ?? SYSTEM_ACTOR,
    details: { ...result },
  });
  return result;
}
