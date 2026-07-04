import type Database from "better-sqlite3";
import type { DiagnosticSeverity } from "~/schemas/file-diagnostics";
import { isAcceptedDisplayState } from "~/server/interpretation/readiness-policy.server";
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
  observedAt: string;
}

export interface TaskDetail extends TaskSummary {
  /** Newest-first (file order). */
  timeline: TimelineEventRender[];
  diagnostics: DiagnosticRecord[];
  /** Project stage list — the detail view renders stage names/colors. */
  stages: { id: string; name: string; color: string }[];
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
  db: Database.Database,
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
  const stageIds = project ? project.stages.map((s) => s.id) : [];
  const memberIds = new Set(listProjectMembers(db, slug).map((m) => m.userId));
  return mapTaskProjectionRow(row, {
    stageIds,
    owner: resolveTaskOwner(db, row.owner_user_id, memberIds),
    accepted: isAcceptedDisplayState({ stage: row.stage, stageIds }),
  });
}

export function listTaskEvents(
  db: Database.Database,
  slug: string,
  key: string,
): TimelineEventRender[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_events WHERE project_slug = ? AND task_key = ?
       ORDER BY position ASC`,
    )
    .all(slug, key) as TaskEventRow[];
  return rows.map(mapTaskEventRow);
}

export function listTaskDiagnostics(
  db: Database.Database,
  slug: string,
  key: string,
): DiagnosticRecord[] {
  const rows = db
    .prepare(
      `SELECT id, severity, code, path, message, hard_stop, observed_at
       FROM diagnostics WHERE project_slug = ? AND task_key = ?
       ORDER BY id ASC`,
    )
    .all(slug, key) as DiagnosticRow[];
  return rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    code: row.code,
    path: row.path,
    message: row.message,
    hardStop: row.hard_stop === 1,
    observedAt: row.observed_at,
  }));
}

export function getTaskDetail(
  db: Database.Database,
  slug: string,
  key: string,
): TaskDetail | null {
  const summary = getTaskSummary(db, slug, key);
  if (!summary) return null;
  const project = getProject(db, slug);
  return {
    ...summary,
    timeline: listTaskEvents(db, slug, key),
    diagnostics: listTaskDiagnostics(db, slug, key),
    stages: project ? project.stages.map((s) => ({ id: s.id, name: s.name, color: s.color })) : [],
  };
}
