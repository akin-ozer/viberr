import type Database from "better-sqlite3";
import { readProjectFile } from "~/server/files/project-writer.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  getProjectCredentialHealth,
  type ProjectCredentialHealth,
} from "~/server/secrets/pat-store.server";
import { listMembershipViews, type MembershipView } from "./membership.server";

/**
 * Settings view read model (project-settings spec §3): project identity +
 * stages from the projection, per-stage task counts from task_projections
 * (never the whole task list — spec §3.2), membership with invite status
 * (canonical file), credential health (the ruling-5 single fact, phase 7),
 * and the task-level repo-override policy flag (project.md loose
 * frontmatter key `taskRepoOverride`, default true per the mock).
 */

export interface SettingsViewData {
  project: {
    slug: string;
    name: string;
    prefix: string;
    description: string;
    repo: string | null;
    /** Real store-relative task-file pattern (ruling 3). */
    taskFilePattern: string;
  };
  stages: { id: string; name: string; color: string }[];
  stageCounts: Record<string, number>;
  members: MembershipView[];
  credential: ProjectCredentialHealth;
  repoOverride: boolean;
}

export function getSettingsViewData(
  db: Database.Database,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): SettingsViewData | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;

  const counts = db
    .prepare(
      `SELECT stage, COUNT(*) AS n FROM task_projections
        WHERE project_slug = ? GROUP BY stage`,
    )
    .all(projectSlug) as { stage: string; n: number }[];

  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const overrideRaw = file?.parsed.unknownFrontmatter.taskRepoOverride;

  return {
    project: {
      slug: project.slug,
      name: project.name,
      prefix: project.taskPrefix,
      description: project.description,
      repo: project.repo,
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
    repoOverride: overrideRaw === false ? false : true,
  };
}
