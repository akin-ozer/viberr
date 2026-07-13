import type Database from "better-sqlite3";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import type { ProjectAuthoritySource } from "~/shared/rbac";

/** Canonical proof that an archive/restore intent crossed the project.md
 * commit boundary. Keeping the marker in preserved frontmatter lets recovery
 * reject a staged-but-never-written row without guessing from a boolean. */
export const PROJECT_LIFECYCLE_INTENT_MARKER =
  "_viberrLifecycleIntent" as const;

export interface ProjectLifecycleIntent {
  id: string;
  projectSlug: string;
  operation: "archive" | "restore";
  expectedArchived: boolean;
  targetArchived: boolean;
  projectName: string;
  actorUserId: string;
  actorLabel: string;
  authoritySource: Exclude<ProjectAuthoritySource, "denied">;
  stoppedRuns: number;
  cancelledDispatches: number;
  cancelledPendingTriggers: number;
  createdAt: string;
}

interface ProjectLifecycleIntentRow {
  id: string;
  project_slug: string;
  operation: "archive" | "restore";
  expected_archived: 0 | 1;
  target_archived: 0 | 1;
  project_name: string;
  actor_user_id: string;
  actor_label: string;
  authority_source: "project_role" | "org_admin_override";
  stopped_runs: number;
  cancelled_dispatches: number;
  cancelled_pending_triggers: number;
  created_at: string;
}

function mapLifecycleIntent(
  row: ProjectLifecycleIntentRow,
): ProjectLifecycleIntent {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    operation: row.operation,
    expectedArchived: row.expected_archived === 1,
    targetArchived: row.target_archived === 1,
    projectName: row.project_name,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    authoritySource: row.authority_source,
    stoppedRuns: row.stopped_runs,
    cancelledDispatches: row.cancelled_dispatches,
    cancelledPendingTriggers: row.cancelled_pending_triggers,
    createdAt: row.created_at,
  };
}

export function getProjectLifecycleIntent(
  db: Database.Database,
  projectSlug: string,
): ProjectLifecycleIntent | null {
  const row = db
    .prepare(`SELECT * FROM project_lifecycle_intents WHERE project_slug = ?`)
    .get(projectSlug) as ProjectLifecycleIntentRow | undefined;
  return row ? mapLifecycleIntent(row) : null;
}

/** Journal attribution and the intended lifecycle edge before project.md is
 * allowed to change. There is exactly one serial lifecycle operation per
 * project, matching the in-process archive/restore/delete mutex. */
export function stageProjectLifecycleIntent(
  db: Database.Database,
  input: Omit<ProjectLifecycleIntent, "id" | "createdAt">,
): ProjectLifecycleIntent {
  const intent: ProjectLifecycleIntent = {
    ...input,
    id: newId("project_lifecycle"),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO project_lifecycle_intents
       (id, project_slug, operation, expected_archived, target_archived,
        project_name, actor_user_id, actor_label, authority_source,
        stopped_runs, cancelled_dispatches, cancelled_pending_triggers,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    intent.id,
    intent.projectSlug,
    intent.operation,
    intent.expectedArchived ? 1 : 0,
    intent.targetArchived ? 1 : 0,
    intent.projectName,
    intent.actorUserId,
    intent.actorLabel,
    intent.authoritySource,
    intent.stoppedRuns,
    intent.cancelledDispatches,
    intent.cancelledPendingTriggers,
    intent.createdAt,
  );
  return intent;
}

function cancelProjectLifecycleIntent(
  db: Database.Database,
  intent: ProjectLifecycleIntent,
): void {
  db.prepare(
    `DELETE FROM project_lifecycle_intents
      WHERE id = ? AND project_slug = ?`,
  ).run(intent.id, intent.projectSlug);
}

export type ProjectLifecycleConvergence = "completed" | "cancelled";

/** Restore the projection and one stable audit fact only when project.md
 * carries this exact intent's marker and target value. A row without that
 * proof never crossed the file boundary and is cancelled without mutating the
 * project lifecycle. */
export function convergeProjectLifecycleIntent(
  db: Database.Database,
  intent: ProjectLifecycleIntent,
  ctx: { dataRoot?: string; beforeProjectionForTests?: () => void } = {},
): ProjectLifecycleConvergence {
  const project = readProjectFile({
    projectSlug: intent.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const marker =
    project?.parsed.unknownFrontmatter[PROJECT_LIFECYCLE_INTENT_MARKER];
  if (
    !project ||
    marker !== intent.id ||
    Boolean(project.parsed.frontmatter.archived) !== intent.targetArchived
  ) {
    cancelProjectLifecycleIntent(db, intent);
    return "cancelled";
  }

  ctx.beforeProjectionForTests?.();
  rebuildPath(
    db,
    projectFilePath(intent.projectSlug, ctx.dataRoot),
    ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
  );
  const details = {
    name: intent.projectName,
    stoppedRuns: intent.stoppedRuns,
    cancelledDispatches: intent.cancelledDispatches,
    cancelledPendingTriggers: intent.cancelledPendingTriggers,
    lifecycleIntentId: intent.id,
    authoritySource: intent.authoritySource,
  };
  db.transaction(() => {
    const auditInsert =
      intent.operation === "archive"
        ? db.prepare(
            `INSERT OR IGNORE INTO audit_events
               (id, occurred_at, actor_user_id, actor_label, action,
                subject_kind, subject_id, project_slug, task_key, details_json)
             VALUES (?, ?, ?, ?, 'project.archived', 'project', ?, ?, NULL, ?)`,
          )
        : db.prepare(
            `INSERT OR IGNORE INTO audit_events
               (id, occurred_at, actor_user_id, actor_label, action,
                subject_kind, subject_id, project_slug, task_key, details_json)
             VALUES (?, ?, ?, ?, 'project.unarchived', 'project', ?, ?, NULL, ?)`,
          );
    auditInsert.run(
      `evt:${intent.id}`,
      intent.createdAt,
      intent.actorUserId,
      intent.actorLabel,
      intent.projectSlug,
      intent.projectSlug,
      JSON.stringify(details),
    );
    db.prepare(
      `DELETE FROM project_lifecycle_intents
        WHERE id = ? AND project_slug = ?`,
    ).run(intent.id, intent.projectSlug);
  })();
  return "completed";
}

/** Boot convergence runs before the general projection rescan. It never
 * performs an archive or restore; only exact canonical markers can restore
 * the side effects and attribution of an already-committed operation. */
export function recoverProjectLifecycleIntents(
  db: Database.Database,
  dataRoot?: string,
): { completed: number; cancelled: number; errors: number } {
  const rows = db
    .prepare(`SELECT * FROM project_lifecycle_intents ORDER BY created_at, id`)
    .all() as ProjectLifecycleIntentRow[];
  const summary = { completed: 0, cancelled: 0, errors: 0 };
  for (const row of rows) {
    const intent = mapLifecycleIntent(row);
    try {
      const result = convergeProjectLifecycleIntent(db, intent, {
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      summary[result] += 1;
    } catch (error) {
      summary.errors += 1;
      logger.error("project lifecycle recovery failed", {
        projectSlug: intent.projectSlug,
        intentId: intent.id,
        operation: intent.operation,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return summary;
}

/** Reject every mutation against archived history until the project is restored. */
export function assertProjectActive(
  _db: Database.Database,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): void {
  // project.md is canonical; the projects row is a rebuildable projection and
  // can legitimately lag a just-written archive/restore after a crash.
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) throw AppError.notFound(`Project ${projectSlug} not found.`);
  if (project.parsed.frontmatter.archived) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This project is archived and read-only. Restore it in Settings before making changes or running agents.",
      kind: "user",
    });
  }
}
