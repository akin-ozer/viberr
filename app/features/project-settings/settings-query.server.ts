import type { DatabaseSync } from "node:sqlite";
import { getProject } from "~/server/projections/board-query.server";
import {
  getProjectCredentialHealth,
  type ProjectCredentialHealth,
} from "~/server/secrets/pat-store.server";
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
import { repoFootprintTasks } from "./settings-actions.server";
import { listMembershipViews, type MembershipView } from "./membership.server";

/**
 * Settings view read model (project-settings spec §3): project identity +
 * stages from the projection, per-stage task counts from task_projections
 * (never the whole task list — spec §3.2), membership with invite status
 * (canonical file), and credential health (the ruling-5 single fact, phase 7).
 *
 * P13-D-5: the task-level repo-override flag (`taskRepoOverride`) used to be
 * read here for a toggle that gated nothing. One project, one repository.
 */

export interface SettingsViewData {
  project: {
    slug: string;
    name: string;
    prefix: string;
    description: string;
    repo: string | null;
    archived: boolean;
    /** Real store-relative task-file pattern (ruling 3). */
    taskFilePattern: string;
  };
  stages: { id: string; name: string; color: string }[];
  stageCounts: Record<string, number>;
  members: MembershipView[];
  credential: ProjectCredentialHealth;
  /** Tasks whose GitHub records (linked PR / pushed commits) point at the
   * current repo — drives the repair dialog's footprint acknowledgment. */
  repoFootprintTasks: number;
  /** R15-6: delete a task's branch on GitHub once its PR merges (default on). */
  branchCleanupOnMerge: boolean;
}

export function getSettingsViewData(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): SettingsViewData | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;

  const counts = db
    .prepare(
      // R14-3: archived tasks are off the board, so the stage rows here must not
      // still count them — Settings said "Ready · 1 task" for a column the board
      // drew empty (P14-RV-03).
      `SELECT stage, COUNT(*) AS n FROM task_projections
        WHERE project_slug = ? AND archived = 0 GROUP BY stage`,
    )
    .all(projectSlug) as { stage: string; n: number }[];

  return {
    project: {
      slug: project.slug,
      name: project.name,
      prefix: project.taskPrefix,
      description: project.description,
      repo: project.repo,
      archived: project.archived,
      taskFilePattern: `projects/${project.slug}/tasks/<key>/task.md`,
    },
    stages: project.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    })),
    stageCounts: Object.fromEntries(counts.map((c) => [c.stage, c.n])),
    members: listMembershipViews(db, projectSlug, ctx),
    credential: getProjectCredentialHealth(db, projectSlug),
    repoFootprintTasks: repoFootprintTasks(db, projectSlug),
    branchCleanupOnMerge: branchCleanupOnMerge(db, projectSlug),
  };
}
