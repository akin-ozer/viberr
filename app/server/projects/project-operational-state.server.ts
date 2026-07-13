import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  getDataRoot,
  projectDir,
  projectFilePath,
  storeRelativePath,
} from "~/server/files/file-store-root.server";
import { disposeRunsForProject } from "~/server/runtimes/run-service.server";
import { clearOperatorLeasesForProject } from "~/server/runtimes/operator-run.server";
import { drainAutoOperatorQueue } from "~/server/runtimes/operator-dispatch.server";
import { rawLogPath } from "~/server/runtimes/run-store.server";
import { allowProjectCompletionEffects } from "~/server/runtimes/run-completion-state.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";

export interface ProjectDeletionTombstone {
  projectSlug: string;
  deletionId: string;
  projectName: string;
  actorUserId: string | null;
  actorLabel: string;
  authoritySource: "org_admin_override" | null;
  createdAt: string;
}

interface ProjectDeletionTombstoneRow {
  project_slug: string;
  deletion_id: string;
  project_name: string;
  actor_user_id: string | null;
  actor_label: string;
  authority_source: "org_admin_override" | null;
  created_at: string;
}

function mapDeletionTombstone(
  row: ProjectDeletionTombstoneRow,
): ProjectDeletionTombstone {
  return {
    projectSlug: row.project_slug,
    deletionId: row.deletion_id,
    projectName: row.project_name,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    authoritySource: row.authority_source,
    createdAt: row.created_at,
  };
}

function deletionTrashDir(deletionId: string, dataRoot?: string): string {
  return path.join(
    getDataRoot(dataRoot),
    "state",
    "project-deletions",
    deletionId,
  );
}

export function getProjectDeletionTombstone(
  db: Database.Database,
  projectSlug: string,
): ProjectDeletionTombstone | null {
  const row = db
    .prepare(
      `SELECT project_slug, deletion_id, project_name, actor_user_id,
              actor_label, authority_source, created_at
         FROM project_deletion_tombstones
        WHERE project_slug = ?`,
    )
    .get(projectSlug) as ProjectDeletionTombstoneRow | undefined;
  return row ? mapDeletionTombstone(row) : null;
}

/** Reserve a slug and persist the human attribution needed by boot recovery
 * before the canonical directory can disappear. */
export function stageProjectDeletion(
  db: Database.Database,
  input: {
    projectSlug: string;
    projectName: string;
    actorUserId: string | null;
    actorLabel: string;
    authoritySource?: "org_admin_override" | null;
  },
): ProjectDeletionTombstone {
  const tombstone: ProjectDeletionTombstone = {
    projectSlug: input.projectSlug,
    deletionId: newId("project_delete"),
    projectName: input.projectName,
    actorUserId: input.actorUserId,
    actorLabel: input.actorLabel,
    authoritySource: input.authoritySource ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO project_deletion_tombstones
       (project_slug, deletion_id, project_name, actor_user_id, actor_label,
        authority_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tombstone.projectSlug,
    tombstone.deletionId,
    tombstone.projectName,
    tombstone.actorUserId,
    tombstone.actorLabel,
    tombstone.authoritySource,
    tombstone.createdAt,
  );
  return tombstone;
}

/** The directory rename is the deletion commit point. Keeping the complete
 * tree in a same-volume tomb directory makes that transition atomic and lets
 * recovery distinguish a pre-commit stage from a committed deletion. */
export function commitProjectDirectoryDeletion(
  tombstone: ProjectDeletionTombstone,
  dataRoot?: string,
): void {
  const canonicalDir = projectDir(tombstone.projectSlug, dataRoot);
  const trashDir = deletionTrashDir(tombstone.deletionId, dataRoot);
  if (existsSync(trashDir)) {
    if (existsSync(canonicalDir)) {
      throw new Error(
        `Project deletion ${tombstone.deletionId} has both canonical and tomb directories.`,
      );
    }
    return;
  }
  if (!existsSync(canonicalDir)) return;
  mkdirSync(path.dirname(trashDir), { recursive: true });
  renameSync(canonicalDir, trashDir);
}

export function cancelProjectDeletion(
  db: Database.Database,
  tombstone: ProjectDeletionTombstone,
): void {
  db.prepare(
    `DELETE FROM project_deletion_tombstones
      WHERE project_slug = ? AND deletion_id = ?`,
  ).run(tombstone.projectSlug, tombstone.deletionId);
}

export function assertProjectSlugNotDeleting(
  db: Database.Database,
  projectSlug: string,
): void {
  if (getProjectDeletionTombstone(db, projectSlug)) {
    throw new Error(
      `Project ${projectSlug} deletion is still being finalized.`,
    );
  }
}

/**
 * Permanently remove every operational row/file keyed by a project slug.
 * Project deletion deliberately chooses purge semantics: recreating the same
 * slug starts clean and cannot inherit credentials, runs, policy violations,
 * notifications, provenance, or an earlier project's audit stream.
 */
export function purgeProjectOperationalState(
  db: Database.Database,
  projectSlug: string,
  dataRoot?: string,
  options: { deferDispatchDrain?: boolean } = {},
): void {
  const runs = db
    .prepare(`SELECT id FROM agent_runs WHERE project_slug = ?`)
    .all(projectSlug) as { id: string }[];

  clearOperatorLeasesForProject(projectSlug);
  disposeRunsForProject(db, projectSlug);

  // Remove external run-log effects before their DB ownership rows. If a
  // process dies here, retry can still enumerate every run id from SQLite.
  for (const { id } of runs) {
    for (const backend of ["claude", "codex", "simulated"] as const) {
      const file = rawLogPath(backend, id, dataRoot);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }

  db.transaction(() => {
    db.prepare(
      `DELETE FROM run_log_lines
       WHERE run_id IN (SELECT id FROM agent_runs WHERE project_slug = ?)`,
    ).run(projectSlug);
    db.prepare(`DELETE FROM agent_runs WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM operator_dispatches WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(
      `DELETE FROM operator_pending_triggers WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(`DELETE FROM github_merge_intents WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM github_pr_open_intents WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(
      `DELETE FROM github_pr_open_handoffs WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(
      `DELETE FROM ownership_cleanup_intents WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(
      `DELETE FROM project_lifecycle_intents WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(
      `DELETE FROM task_completion_intents WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(
      `DELETE FROM operator_routing_intents WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(
      `DELETE FROM project_github_credentials WHERE project_slug = ?`,
    ).run(projectSlug);
    db.prepare(`DELETE FROM scope_violations WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM notifications WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM diagnostics WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM task_events WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM task_projections WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM project_members WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM projects WHERE slug = ?`).run(projectSlug);
    db.prepare(`DELETE FROM audit_events WHERE project_slug = ?`).run(
      projectSlug,
    );

    const sourceRoot = storeRelativePath(
      projectDir(projectSlug, dataRoot),
      dataRoot,
    );
    db.prepare(
      `DELETE FROM provenance
       WHERE source_path = ? OR source_path LIKE ?`,
    ).run(sourceRoot, `${sourceRoot}/%`);
  })();

  // Deleting active dispatches frees global automatic-run capacity.
  if (!options.deferDispatchDrain) {
    void drainAutoOperatorQueue(db, dataRoot);
  }
}

/** Finish the DB/file/audit side effects after canonical project removal.
 * Every step is retry-safe. The tombstone is cleared in the same transaction
 * that inserts its stable organization-wide audit fact. */
export function completeProjectDeletion(
  db: Database.Database,
  tombstone: ProjectDeletionTombstone,
  dataRoot?: string,
  options: { deferDispatchDrain?: boolean } = {},
): void {
  if (existsSync(projectFilePath(tombstone.projectSlug, dataRoot))) {
    throw new Error(
      `Project ${tombstone.projectSlug} is still canonical; deletion cannot be finalized.`,
    );
  }

  const trashDir = deletionTrashDir(tombstone.deletionId, dataRoot);
  if (existsSync(trashDir)) {
    rmSync(trashDir, { recursive: true, force: true });
  }
  purgeProjectOperationalState(db, tombstone.projectSlug, dataRoot, options);

  db.transaction(() => {
    const details = {
      name: tombstone.projectName,
      formerProjectSlug: tombstone.projectSlug,
      deletionId: tombstone.deletionId,
      ...(tombstone.authoritySource
        ? { authoritySource: tombstone.authoritySource }
        : {}),
    };
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, occurred_at, actor_user_id, actor_label, action, subject_kind,
          subject_id, project_slug, task_key, details_json)
       VALUES (?, ?, ?, ?, 'project.deleted', 'project', ?, NULL, NULL, ?)`,
    ).run(
      `evt_${tombstone.deletionId}`,
      new Date().toISOString(),
      tombstone.actorUserId,
      tombstone.actorLabel,
      tombstone.projectSlug,
      JSON.stringify(details),
    );
    db.prepare(
      `DELETE FROM project_deletion_tombstones
        WHERE project_slug = ? AND deletion_id = ?`,
    ).run(tombstone.projectSlug, tombstone.deletionId);
  })();
}

/** Converge project deletions before projection rescan at boot. A staged row
 * with an untouched canonical directory never crossed the commit point and is
 * cancelled; a missing canonical directory is finalized. */
export function recoverProjectDeletions(
  db: Database.Database,
  dataRoot?: string,
): { completed: number; cancelled: number; errors: number } {
  const rows = db
    .prepare(
      `SELECT project_slug, deletion_id, project_name, actor_user_id,
              actor_label, authority_source, created_at
         FROM project_deletion_tombstones
        ORDER BY created_at, project_slug`,
    )
    .all() as ProjectDeletionTombstoneRow[];
  const summary = { completed: 0, cancelled: 0, errors: 0 };
  for (const row of rows) {
    const tombstone = mapDeletionTombstone(row);
    try {
      const canonicalExists = existsSync(
        projectFilePath(tombstone.projectSlug, dataRoot),
      );
      const trashExists = existsSync(
        deletionTrashDir(tombstone.deletionId, dataRoot),
      );
      if (canonicalExists && !trashExists) {
        cancelProjectDeletion(db, tombstone);
        allowProjectCompletionEffects(db, tombstone.projectSlug);
        summary.cancelled += 1;
        continue;
      }
      if (canonicalExists && trashExists) {
        throw new Error(
          "canonical and committed deletion trees both exist; refusing to choose one",
        );
      }
      completeProjectDeletion(db, tombstone, dataRoot, {
        deferDispatchDrain: true,
      });
      summary.completed += 1;
    } catch (error) {
      summary.errors += 1;
      logger.error("project deletion recovery failed", {
        projectSlug: tombstone.projectSlug,
        deletionId: tombstone.deletionId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return summary;
}
