import type { DatabaseSync } from "node:sqlite";
import type { DiagnosticSeverity } from "~/schemas/file-diagnostics";
import type { Readiness } from "~/schemas/task-file.schema";
import { readinessEffectOf } from "~/server/interpretation/diagnostics-policy.server";
import { isAcceptedDisplayState } from "~/server/interpretation/readiness-policy.server";
import { createActorRenderOverlay } from "~/shared/mapping/actor.server";
import {
  mapTaskEventRow,
  type TaskEventRow,
  type TimelineEventRender,
} from "~/shared/mapping/task-event.server";
import {
  mapTaskProjectionRow,
  type TaskProjectionRow,
  type TaskSummary,
} from "~/shared/mapping/task.server";
import {
  getProject,
  listProjectMembers,
  resolveTaskOwner,
} from "./board-query.server";
import { isQuiet, readTaskActivity } from "./task-activity.server";

/**
 * Task-detail read models. Phase 5 loaders call these directly.
 */

export interface DiagnosticRecord {
  id: number;
  severity: DiagnosticSeverity;
  code: string;
  path: string | null;
  message: string;
  hardStop: boolean;
  /**
   * The readiness floor THIS finding imposes, from the canonical
   * {@link readinessEffectOf} policy (hardStop→blocked, error→inconsistency
   * risk, warning→input required, info→none). G2: the Diagnostics panel colors
   * and labels each finding from this — so it speaks the SAME state language as
   * the hero's ReadinessPill instead of painting a soft `error` crimson and a
   * hardStop-`warning` amber. `null` = a heads-up with no readiness effect.
   */
  readinessEffect: Readiness | null;
  observedAt: string;
}

export interface TaskDetail extends TaskSummary {
  /** Newest-first (file order). */
  timeline: TimelineEventRender[];
  diagnostics: DiagnosticRecord[];
  /** Project stage list — the detail view renders stage names/colors. */
  stages: { id: string; name: string; color: string }[];
  /** Gap-10: ISO of the newest timeline event; null when the timeline is empty.
   *  Derived from `task_events.occurred_at`, NOT `updated_at` — see the essay in
   *  task-activity.server.ts for why the file-write stamp is not activity. */
  lastActivityAt: string | null;
  /** Gap-10: past its threshold, no run in flight, not archived, not terminal. */
  quiet: boolean;
}

interface DiagnosticRow {
  id: number;
  severity: DiagnosticSeverity;
  code: string;
  path: string | null;
  message: string;
  hard_stop: 0 | 1;
  observed_at: string;
}

export function getTaskSummary(
  db: DatabaseSync,
  slug: string,
  key: string,
): TaskSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM task_projections WHERE project_slug = ? AND task_key = ?`,
    )
    .get(slug, key) as TaskProjectionRow | undefined;
  if (!row) return null;
  const project = getProject(db, slug);
  const stages = project
    ? project.stages.map((s) => ({ id: s.id, name: s.name }))
    : [];
  const memberIds = new Set(listProjectMembers(db, slug).map((m) => m.userId));
  return mapTaskProjectionRow(row, {
    stages,
    // F19-27: same graph the acceptance writers gate on.
    workflow: project?.workflow ?? [],
    owner: resolveTaskOwner(db, row.owner_user_id, memberIds),
    accepted: isAcceptedDisplayState({
      stage: row.stage,
      stageIds: stages.map((s) => s.id),
    }),
  });
}

export function listTaskEvents(
  db: DatabaseSync,
  slug: string,
  key: string,
): TimelineEventRender[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_events WHERE project_slug = ? AND task_key = ?
       ORDER BY position ASC`,
    )
    .all(slug, key) as unknown as TaskEventRow[];
  // E1: baked actor snapshots go stale on user rename — overlay the CURRENT
  // users-table identity at read time (deleted users keep the snapshot).
  const overlay = createActorRenderOverlay(db);
  return rows.map((row) => {
    const event = mapTaskEventRow(row);
    return { ...event, actor: overlay(event.actor) };
  });
}

export function listTaskDiagnostics(
  db: DatabaseSync,
  slug: string,
  key: string,
): DiagnosticRecord[] {
  const rows = db
    .prepare(
      `SELECT id, severity, code, path, message, hard_stop, observed_at
       FROM diagnostics WHERE project_slug = ? AND task_key = ?
       ORDER BY id ASC`,
    )
    .all(slug, key) as unknown as DiagnosticRow[];
  return rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    code: row.code,
    path: row.path,
    message: row.message,
    hardStop: row.hard_stop === 1,
    readinessEffect: readinessEffectOf({
      severity: row.severity,
      code: row.code,
      message: row.message,
      hardStop: row.hard_stop === 1,
    }),
    observedAt: row.observed_at,
  }));
}

export function getTaskDetail(
  db: DatabaseSync,
  slug: string,
  key: string,
  /** Gap-10: the instant "has this gone quiet?" is asked against (tests only). */
  opts: { now?: Date } = {},
): TaskDetail | null {
  const summary = getTaskSummary(db, slug, key);
  if (!summary) return null;
  const project = getProject(db, slug);
  const stageIds = project ? project.stages.map((s) => s.id) : [];
  const facts = readTaskActivity(db, slug, key);
  return {
    ...summary,
    timeline: listTaskEvents(db, slug, key),
    diagnostics: listTaskDiagnostics(db, slug, key),
    stages: project ? project.stages.map((s) => ({ id: s.id, name: s.name, color: s.color })) : [],
    lastActivityAt: facts.lastActivityAt,
    quiet: isQuiet({
      lastActivityAt: facts.lastActivityAt,
      waiting: summary.waiting,
      archived: summary.archived,
      terminal: isAcceptedDisplayState({ stage: summary.stage, stageIds }),
      runInFlight: facts.runInFlight,
      ...(opts.now ? { now: opts.now } : {}),
    }),
  };
}
