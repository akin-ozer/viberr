import type Database from "better-sqlite3";
import { isAcceptedDisplayState } from "~/server/interpretation/readiness-policy.server";
import { createActorResolver, type ActorRender } from "~/shared/mapping/actor.server";
import {
  mapProjectMemberRow,
  mapProjectRow,
  type ProjectMemberRecord,
  type ProjectMemberRow,
  type ProjectRecord,
  type ProjectRow,
} from "~/shared/mapping/project.server";
import {
  mapTaskProjectionRow,
  type TaskProjectionRow,
  type TaskSummary,
} from "~/shared/mapping/task.server";

/**
 * Board/home read models (camelCase render shapes via the central mapping
 * layer). Phase 4 loaders call these directly.
 */

export interface BoardColumn {
  stage: { id: string; name: string; color: string };
  tasks: TaskSummary[];
}

export interface BoardData {
  project: ProjectRecord;
  members: (ProjectMemberRecord & { user: ActorRender })[];
  columns: BoardColumn[];
  /** Tasks whose stage id matches no project stage (still listed, flagged
   * by their diagnostics — never silently dropped). */
  orphanTasks: TaskSummary[];
}

export function getProject(
  db: Database.Database,
  slug: string,
): ProjectRecord | null {
  const row = db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as
    | ProjectRow
    | undefined;
  return row ? mapProjectRow(row) : null;
}

export function listProjects(db: Database.Database): ProjectRecord[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY name ASC`)
    .all() as ProjectRow[];
  return rows.map(mapProjectRow);
}

export function listProjectMembers(
  db: Database.Database,
  slug: string,
): ProjectMemberRecord[] {
  const rows = db
    .prepare(`SELECT * FROM project_members WHERE project_slug = ?`)
    .all(slug) as ProjectMemberRow[];
  return rows.map(mapProjectMemberRow);
}

/** Owner render helper shared by board + task queries. */
export function resolveTaskOwner(
  db: Database.Database,
  ownerUserId: string | null,
  memberIds: Set<string>,
): ActorRender | null {
  if (!ownerUserId) return null;
  const resolve = createActorResolver(db, { projectMemberIds: memberIds });
  return resolve({ kind: "human", userId: ownerUserId, nameHint: null });
}

export function listProjectTasks(
  db: Database.Database,
  slug: string,
): TaskSummary[] {
  const project = getProject(db, slug);
  const stageIds = project ? project.stages.map((s) => s.id) : [];
  const memberIds = new Set(listProjectMembers(db, slug).map((m) => m.userId));
  const rows = db
    .prepare(
      `SELECT * FROM task_projections WHERE project_slug = ?
       ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
    )
    .all(slug) as TaskProjectionRow[];
  return rows.map((row) =>
    mapTaskProjectionRow(row, {
      stageIds,
      owner: resolveTaskOwner(db, row.owner_user_id, memberIds),
      accepted: isAcceptedDisplayState({ stage: row.stage, stageIds }),
    }),
  );
}

/** Full board read model: columns in project stage order. */
export function getBoard(db: Database.Database, slug: string): BoardData | null {
  const project = getProject(db, slug);
  if (!project) return null;

  const memberRecords = listProjectMembers(db, slug);
  const memberIds = new Set(memberRecords.map((m) => m.userId));
  const resolve = createActorResolver(db, { projectMemberIds: memberIds });
  const members = memberRecords.map((m) => ({
    ...m,
    user: resolve({ kind: "human", userId: m.userId, nameHint: null }),
  }));

  const tasks = listProjectTasks(db, slug);
  const byStage = new Map<string, TaskSummary[]>();
  for (const stage of project.stages) byStage.set(stage.id, []);
  const orphanTasks: TaskSummary[] = [];
  for (const task of tasks) {
    const bucket = byStage.get(task.stage);
    if (bucket) bucket.push(task);
    else orphanTasks.push(task);
  }

  return {
    project,
    members,
    columns: project.stages.map((stage) => ({
      stage: { id: stage.id, name: stage.name, color: stage.color },
      tasks: byStage.get(stage.id) ?? [],
    })),
    orphanTasks,
  };
}
