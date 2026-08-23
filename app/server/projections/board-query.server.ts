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
  parseTaskLabels,
  withLiveAgentBackends,
  type TaskProjectionRow,
  type TaskSummary,
} from "~/shared/mapping/task.server";
// #183: the live-backend overlay is a server module now, so this hot loader no
// longer reaches up into features/agents for it (deployment-view imports only
// node:fs, zod, and ~/server/files/*, with no edge back into projections).
import { deployedSpecialistBackends } from "~/server/agents/deployment-view.server";
import {
  activityFactsFor,
  isQuiet,
  readProjectActivity,
} from "./task-activity.server";

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

/**
 * Gap-10: a task summary carrying its LAST ACTIVITY and whether it has gone
 * quiet. Annotated here rather than projected into a column, because both parts
 * are derived — `lastActivityAt` from `task_events`, `quiet` from that stamp
 * against NOW and the live run registry — and a stored `quiet` flag would be
 * wrong the moment the clock moved past it.
 *
 * `quiet` is resolved SERVER-side on purpose. It is what the board's filter chip
 * selects on and what three surfaces draw, so it has to be one value that is
 * identical in the SSR pass and in hydration; a client-side `Date.now()` would
 * make it differ between the two renders. The board revalidates on every project
 * SSE event and on navigation, and the shortest threshold is an hour, so the
 * answer cannot go stale inside a session in any way a supervisor would notice.
 * The RELATIVE TEXT beside it is a different problem and is solved the way this
 * app already solves it — `LocalRelative` (app/ui/local-time.tsx).
 */
export interface TaskActivitySummary extends TaskSummary {
  /** ISO of the newest timeline event; null when the timeline is empty. */
  lastActivityAt: string | null;
  /** Past its threshold, no run in flight, not archived, not terminal. */
  quiet: boolean;
}

export interface BoardColumn {
  stage: { id: string; name: string; color: string };
  tasks: TaskActivitySummary[];
}

export interface BoardData {
  project: ProjectRecord;
  members: (ProjectMemberRecord & { user: ActorRender; missing: boolean })[];
  columns: BoardColumn[];
  /** Tasks whose stage id matches no project stage (still listed, flagged
   * by their diagnostics — never silently dropped). */
  orphanTasks: TaskActivitySummary[];
}

export function getProject(
  db: DatabaseSync,
  slug: string,
): ProjectRecord | null {
  // SAFETY: ProjectRow mirrors the 15 `projects` columns 0001_baseline
  // declares, so `SELECT *` yields exactly it; a missing slug yields no row.
  const row = db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as
    | ProjectRow
    | undefined;
  return row ? mapProjectRow(row) : null;
}

export function listProjects(db: DatabaseSync): ProjectRecord[] {
  // SAFETY: same `SELECT *` / column-list correspondence as getProject.
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY name ASC`)
    .all() as ProjectRow[];
  return rows.map(mapProjectRow);
}

export function listProjectMembers(
  db: DatabaseSync,
  slug: string,
): ProjectMemberRecord[] {
  // SAFETY: ProjectMemberRow mirrors the three `project_members` columns, all
  // NOT NULL, with `role` CHECK-constrained to the four values it lists.
  const rows = db
    .prepare(`SELECT * FROM project_members WHERE project_slug = ?`)
    .all(slug) as ProjectMemberRow[];
  return rows.map(mapProjectMemberRow);
}

/**
 * LV-04: honest label for a user id that resolves to no account.
 *
 * `createActorResolver` falls back to `nameHint ?? userId`, so a task owned by a
 * since-deleted account rendered the raw `u_RT7-QeTWOwP4` string verbatim in the
 * task-detail Owner widget, the "HUMAN OWNER · REVIEWS & ACCEPTS" panel, the
 * Policy member row and project Settings → Members — indistinguishable from a
 * person's name. THE canonical wording lives here so every surface agrees.
 */
export function removedAccountLabel(userId: string): string {
  const short = userId.length > 10 ? `${userId.slice(0, 10)}…` : userId;
  return `Removed account · ${short}`;
}

/**
 * LV-04: rewrite an actor render whose "name" is really an unresolved user id.
 * The resolver has no row and no name hint in that case, so `name === userId`
 * is the exact signal (both call sites pass `nameHint: null`).
 */
export function labelUnresolvedHuman(render: ActorRender): ActorRender {
  if (render.kind !== "human" || render.name !== render.userId) return render;
  return {
    ...render,
    name: removedAccountLabel(render.userId),
    initials: "?",
  };
}

/** Owner render helper shared by board + task queries. */
export function resolveTaskOwner(
  db: DatabaseSync,
  ownerUserId: string | null,
  memberIds: Set<string>,
): ActorRender | null {
  if (!ownerUserId) return null;
  const resolve = createActorResolver(db, { projectMemberIds: memberIds });
  return labelUnresolvedHuman(
    resolve({ kind: "human", userId: ownerUserId, nameHint: null }),
  );
}

export function listProjectTasks(
  db: DatabaseSync,
  slug: string,
  opts: {
    /** R14-3: include archived tasks — only the board's explicit "Archived"
     *  view asks for them. Every other read model (board columns, review queue,
     *  home counts) inherits the exclusion by going through here. */
    includeArchived?: boolean;
    /** Gap-10: the instant "has this gone quiet?" is asked against. Injectable
     *  for tests only; every caller in the app takes the default. */
    now?: Date;
    /** Data root for the live-backend overlay — tests only (production
     *  defaults to the env root, same as every file accessor). */
    dataRoot?: string;
  } = {},
): TaskActivitySummary[] {
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
  // SAFETY: every member of TaskProjectionRow is a `task_projections` column
  // 0001_baseline declares, so `SELECT *` covers all of them (it also returns
  // `schedules_json`, which this read model has no member for and never reads).
  const rows = db
    .prepare(
      `SELECT * FROM task_projections WHERE project_slug = ?
         ${opts.includeArchived ? "" : "AND archived = 0"}
       ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
    )
    .all(slug) as TaskProjectionRow[];
  // Gap-10: two aggregate queries for the whole project, not one per row — the
  // same shape as the shared actor resolver above, and for the same reason
  // (this is the hottest loader path in the app).
  const activity = readProjectActivity(db, slug);
  // ONE live-backend map for the whole query (a project-file read + one small
  // template read per deployed profile): an engaged agent's displayed backend
  // follows the LIVE deployment, exactly as the run does — the engage-time
  // snapshot in task.md stays only for profiles no longer deployed.
  const liveBackends = deployedSpecialistBackends(slug, opts.dataRoot);
  return rows.map((row) => {
    const accepted = isAcceptedDisplayState({ stage: row.stage, stageIds });
    const facts = activityFactsFor(activity, row.task_key);
    const summary = withLiveAgentBackends(
      mapTaskProjectionRow(row, {
      stages,
      // F19-27: the acceptance-boundary fact is derived from the graph, not the
      // column order — a project whose workflow really allows the edge must not
      // be refused. No project row → no edges, and the mapping resolves the
      // roles positionally, same as the server.
      workflow: project?.workflow ?? [],
      owner: row.owner_user_id
        ? labelUnresolvedHuman(
            resolveActor({
              kind: "human",
              userId: row.owner_user_id,
              nameHint: null,
            }),
          )
        : null,
      accepted,
      }),
      liveBackends,
    );
    const quietAt: Parameters<typeof isQuiet>[0] = {
      lastActivityAt: facts.lastActivityAt,
      waiting: summary.waiting,
      archived: summary.archived,
      terminal: accepted,
      runInFlight: facts.runInFlight,
    };
    // Injected only when a caller supplied it — `isQuiet` reads the CURRENT
    // instant when the key is absent, and a `now: undefined` would not be.
    if (opts.now) quietAt.now = opts.now;
    return {
      ...summary,
      lastActivityAt: facts.lastActivityAt,
      quiet: isQuiet(quietAt),
    };
  });
}

/** The distinct labels used across a project's live tasks, sorted, for label
 *  autocomplete. Reads only the `labels_json` column (no per-row mapping) so it
 *  stays cheap enough for the task-detail loader to call on every view. */
export function listProjectLabels(db: DatabaseSync, slug: string): string[] {
  // SAFETY: the query projects exactly the `labels_json` column, which
  // 0001_baseline declares NOT NULL on `task_projections`, so every returned row
  // has a string `labels_json` and nothing else this shape claims.
  const rows = db
    .prepare(
      `SELECT labels_json FROM task_projections
         WHERE project_slug = ? AND archived = 0`,
    )
    .all(slug) as { labels_json: string }[];
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const label of parseTaskLabels(row.labels_json)) {
      // First spelling wins; a later case-variant of the same label collapses
      // into it, matching the input's case-insensitive de-duplication.
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Full board read model: columns in project stage order. */
export function getBoard(db: DatabaseSync, slug: string): BoardData | null {
  const project = getProject(db, slug);
  if (!project) return null;

  const memberRecords = listProjectMembers(db, slug);
  const memberIds = new Set(memberRecords.map((m) => m.userId));
  const resolve = createActorResolver(db, { projectMemberIds: memberIds });
  const members = memberRecords.map((m) => {
    const resolved = resolve({ kind: "human", userId: m.userId, nameHint: null });
    // LV-04: a membership left behind by a deleted org account resolves to an
    // unresolved id (`name === userId`) — it renders as "Removed account · u_RT7…",
    // never as the raw id. D-4 (pass 24): carry the flag so the rail's member
    // count can drop these ghosts, the way Policy ("N members · M removed") and
    // Settings ("N active") already do — the rail counted the raw rows.
    const missing = resolved.kind === "human" && resolved.name === resolved.userId;
    return { ...m, missing, user: labelUnresolvedHuman(resolved) };
  });

  // R14-3: the BOARD loads archived tasks and hides them client-side, because
  // its "Archived" chip is the only way back to them (`matchesBoardFilter`
  // excludes them from every other filter). Every OTHER read model — the review
  // queue, the decisions inbox, home's counts — takes the default exclusion.
  const tasks = listProjectTasks(db, slug, { includeArchived: true });
  const byStage = new Map<string, TaskActivitySummary[]>();
  for (const stage of project.stages) byStage.set(stage.id, []);
  const orphanTasks: TaskActivitySummary[] = [];
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
