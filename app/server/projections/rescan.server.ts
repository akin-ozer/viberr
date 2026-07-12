import type Database from "better-sqlite3";
import { recordAudit, type AuditActor, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { rebuildAll, type RescanSummary } from "./rebuilder.server";

/**
 * Manual rescan — reconciles the file-native store with the projections.
 * Callable from a future UI action (Board "Re-scan" button, Phase 4) and
 * from `npm run rescan`. Governed action → audit event.
 */
export function rescanProjections(
  db: Database.Database,
  options: {
    dataRoot?: string;
    force?: boolean;
    actor?: AuditActor;
    /** Present when the instance-wide rescan was launched from a project UI. */
    projectSlug?: string;
  } = {},
): RescanSummary {
  const summary = rebuildAll(db, {
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });
  recordAudit(db, {
    action: "projection.rescan",
    actor: options.actor ?? SYSTEM_ACTOR,
    ...(options.projectSlug
      ? {
          subjectKind: "project",
          subjectId: options.projectSlug,
          projectSlug: options.projectSlug,
        }
      : {}),
    details: { ...summary },
  });
  return summary;
}
