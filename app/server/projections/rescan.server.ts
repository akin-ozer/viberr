import type Database from "better-sqlite3";
import { recordAudit, type AuditActor, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { rebuildAll, rebuildProject, type RescanSummary } from "./rebuilder.server";

/**
 * Manual instance-wide rescan — reconciles the whole file-native store with the
 * projections. Org-admin maintenance (home "Re-scan store") and `npm run
 * rescan`. Governed action → audit event.
 */
export function rescanProjections(
  db: Database.Database,
  options: { dataRoot?: string; force?: boolean; actor?: AuditActor } = {},
): RescanSummary {
  const summary = rebuildAll(db, {
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });
  recordAudit(db, {
    action: "projection.rescan",
    actor: options.actor ?? SYSTEM_ACTOR,
    details: { ...summary },
  });
  return summary;
}

/**
 * Project-scoped rescan — reconciles ONE project's files with the projections.
 * Backs the Board "Re-scan" action so its effect matches its project-scoped
 * `rescan-project` gate (F20): a maintainer of project A can't rebuild every
 * other project. Governed action → audit event carrying the project slug.
 */
export function rescanProject(
  db: Database.Database,
  slug: string,
  options: { dataRoot?: string; force?: boolean; actor?: AuditActor } = {},
): RescanSummary {
  const summary = rebuildProject(db, slug, {
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });
  recordAudit(db, {
    action: "projection.rescan",
    actor: options.actor ?? SYSTEM_ACTOR,
    projectSlug: slug,
    details: { ...summary, scope: "project", slug },
  });
  return summary;
}
