import type { DatabaseSync } from "node:sqlite";
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

/**
 * Sparse-rank base for board ordering. A task's DEFAULT rank is its key number
 * scaled by BASE (so VIB-142 → 142_000_000), leaving ~6 digits of headroom for
 * drag-to-reorder midpoints before any rebalance would be needed.
 */
export const BOARD_RANK_BASE = 1_000_000;

/** Numeric suffix of a task key (VIB-142 → 142), 0 when unparseable. */
export function taskKeyNumber(key: string): number {
  const n = Number.parseInt(key.slice(key.indexOf("-") + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The value a task is ordered by within its stage column: its explicit
 * `boardRank` when set (drag-reordered), else the task-key number scaled by
 * BASE (the pre-reorder default order). Tiebreak on the raw key number.
 */
export function effectiveBoardRank(task: {
  key: string;
  boardRank: number | null;
}): number {
  return task.boardRank ?? taskKeyNumber(task.key) * BOARD_RANK_BASE;
}

/** Board column sort: by effective rank ascending, tiebreak by key number. */
export function compareBoardOrder(a: TaskSummary, b: TaskSummary): number {
  return (
    effectiveBoardRank(a) - effectiveBoardRank(b) ||
    taskKeyNumber(a.key) - taskKeyNumber(b.key)
  );
}

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
  db: DatabaseSync,
  slug: string,
): ProjectRecord | null {
  const row = db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as
    | ProjectRow
    | undefined;
  return row ? mapProjectRow(row) : null;
}

export function listProjects(db: DatabaseSync): ProjectRecord[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY name ASC`)
    .all() as unknown as ProjectRow[];
  return rows.map(mapProjectRow);
}

export function listProjectMembers(
  db: DatabaseSync,
  slug: string,
): ProjectMemberRecord[] {
  const rows = db
    .prepare(`SELECT * FROM project_members WHERE project_slug = ?`)
    .all(slug) as unknown as ProjectMemberRow[];
  return rows.map(mapProjectMemberRow);
}

/** Owner render helper shared by board + task queries. */
export function resolveTaskOwner(
  db: DatabaseSync,
  ownerUserId: string | null,
  memberIds: Set<string>,
): ActorRender | null {
  if (!ownerUserId) return null;
  const resolve = createActorResolver(db, { projectMemberIds: memberIds });
  return resolve({ kind: "human", userId: ownerUserId, nameHint: null });
}

export function listProjectTasks(
  db: DatabaseSync,
  slug: string,
): TaskSummary[] {
  const project = getProject(db, slug);
  const stages = project
    ? project.stages.map((s) => ({ id: s.id, name: s.name }))
    : [];
  const stageIds = stages.map((s) => s.id);
  const memberIds = new Set(listProjectMembers(db, slug).map((m) => m.userId));
  // ONE actor resolver for the whole query — createActorResolver caches user
  // lookups behind a single prepared statement (its own doc: "create one per
  // request/query and map many rows through it"). Previously `resolveTaskOwner`
  // built a fresh resolver + empty cache per owned row inside this map
  // (pass-4 WI-8, the hottest loader path). Output is identical — a shared
  // cache changes only the cost, not the resolved render.
  const resolveActor = createActorResolver(db, { projectMemberIds: memberIds });
  const rows = db
    .prepare(
      `SELECT * FROM task_projections WHERE project_slug = ?
       ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
    )
    .all(slug) as unknown as TaskProjectionRow[];
  return rows.map((row) =>
    mapTaskProjectionRow(row, {
      stages,
      owner: row.owner_user_id
        ? resolveActor({
            kind: "human",
            userId: row.owner_user_id,
            nameHint: null,
          })
        : null,
      accepted: isAcceptedDisplayState({ stage: row.stage, stageIds }),
    }),
  );
}

/** Full board read model: columns in project stage order. */
export function getBoard(db: DatabaseSync, slug: string): BoardData | null {
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
  // Order each column by the persistent drag-to-reorder rank.
  for (const bucket of byStage.values()) bucket.sort(compareBoardOrder);

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
