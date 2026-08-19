import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  rebuildAll,
  rebuildProject,
  type RebuildOptions,
  type RescanSummary,
} from "./rebuilder.server";

/**
 * Manual instance-wide rescan — reconciles the whole file-native store with the
 * projections. Org-admin maintenance (home "Re-scan store") and `npm run
 * rescan`. Governed action → audit event.
 */
export function rescanProjections(
  db: DatabaseSync,
  options: { dataRoot?: string; force?: boolean; actor?: AuditActor } = {},
): RescanSummary {
  // `force` is only ever SET when the caller named it — an unasked-for rescan
  // must inherit the rebuilder's own default, not a literal `undefined`.
  const rebuildOptions: RebuildOptions = { dataRoot: options.dataRoot };
  if (options.force !== undefined) rebuildOptions.force = options.force;
  const summary = rebuildAll(db, rebuildOptions);
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
  db: DatabaseSync,
  slug: string,
  options: { dataRoot?: string; force?: boolean; actor?: AuditActor } = {},
): RescanSummary {
  // Same as above: an unset `force` stays absent so the rebuilder decides.
  const rebuildOptions: RebuildOptions = { dataRoot: options.dataRoot };
  if (options.force !== undefined) rebuildOptions.force = options.force;
  const summary = rebuildProject(db, slug, rebuildOptions);
  recordAudit(db, {
    action: "projection.rescan",
    actor: options.actor ?? SYSTEM_ACTOR,
    projectSlug: slug,
    details: { ...summary, scope: "project", slug },
  });
  return summary;
}
