import type { DatabaseSync } from "node:sqlite";
import type { DiagnosticSeverity } from "~/schemas/file-diagnostics";
import type { Readiness } from "~/schemas/task-file.schema";
import { readinessEffectOf } from "~/server/interpretation/diagnostics-policy.server";
import { isAcceptedDisplayState } from "~/server/interpretation/readiness-policy.server";
import {
  createActorRenderOverlay,
  type ActorRender,
} from "~/shared/mapping/actor.server";
import {
  mapTaskEventRow,
  type TaskEventRow,
  type TimelineEventRender,
} from "~/shared/mapping/task-event.server";
import {
  mapTaskProjectionRow,
  withLiveAgentIdentities,
  type TaskProjectionRow,
  type TaskSummary,
} from "~/shared/mapping/task.server";
import { deployedSpecialistIdentities } from "~/server/agents/deployment-view.server";
import {
  getProject,
  listProjectMembers,
  resolveTaskOwner,
} from "./board-query.server";
import { isQuiet, readTaskActivity, type QuietCheck } from "./task-activity.server";
import { parseBlockedByColumn, resolveDependencies } from "./dependencies.server";

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
  /** U36-10 (pass 36): the project's workflow edges, so the run-agent
   *  control resolves stage eligibility with the same predicate the dispatch
   *  gate applies (ruling 181) before the click. */
  workflow: { from: string; to: string }[];
  /** Gap-10: ISO of the newest timeline event; null when the timeline is empty.
   *  Derived from `task_events.occurred_at`, NOT `updated_at` — see the essay in
   *  task-activity.server.ts for why the file-write stamp is not activity. */
  lastActivityAt: string | null;
  /** Gap-10: past its threshold, no run in flight, not archived, not terminal. */
  quiet: boolean;
}

/** The `diagnostics` columns the query below selects. A type alias, not an
 *  interface, so the row assertion is checked against SQLite's output types
 *  instead of having to launder the rows through `unknown` first. */
type DiagnosticRow = {
  id: number;
  severity: DiagnosticSeverity;
  code: string;
  path: string | null;
  message: string;
  hard_stop: 0 | 1;
  observed_at: string;
};

export function getTaskSummary(
  db: DatabaseSync,
  slug: string,
  key: string,
  /** Data root for the live-backend overlay below — tests only (production
   *  reads the env root by default, same as every file accessor). */
  opts: { dataRoot?: string } = {},
): TaskSummary | null {
  // SAFETY: every TaskProjectionRow field is a `task_projections` column with
  // the same nullability, and each of its string-union fields (readiness,
  // waiting, validation, acceptance, continuity) is pinned by that table's own
  // CHECK constraint (0001_baseline.sql) — SQLite rejects any other value.
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
  const summary = mapTaskProjectionRow(row, {
    stages,
    // F19-27: same graph the acceptance writers gate on.
    workflow: project?.workflow ?? [],
    owner: resolveTaskOwner(db, row.owner_user_id, memberIds),
    accepted: isAcceptedDisplayState({
      stage: row.stage,
      stageIds: stages.map((s) => s.id),
    }),
    // Ruling 55: resolved at read time, never cached.
    blockedBy: resolveDependencies(db, slug, parseBlockedByColumn(row.blocked_by_json)),
  });
  // The engaged agents' backend follows the LIVE deployment, not the
  // engage-time snapshot — the run already does (specialist-run.server.ts), so
  // the exec profile's "Run" button must be labeled with what it launches.
  return withLiveAgentIdentities(
    summary,
    deployedSpecialistIdentities(slug, opts.dataRoot),
  );
}

/** Whether the task has a projection row — exactly when {@link getTaskSummary}
 *  answers non-null, without building the summary (ruling 11: the dock asks
 *  this yes/no question on every load). */
export function taskExists(db: DatabaseSync, slug: string, key: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM task_projections WHERE project_slug = ? AND task_key = ?`)
      .get(slug, key) !== undefined
  );
}

export function listTaskEvents(
  db: DatabaseSync,
  slug: string,
  key: string,
  /** Ruling 11: only the newest `limit` events (the task page's window). */
  opts: { limit?: number } = {},
): TimelineEventRender[] {
  const sql = `SELECT * FROM task_events WHERE project_slug = ? AND task_key = ?
       ORDER BY position ASC`;
  const stmt = db.prepare(opts.limit === undefined ? sql : `${sql} LIMIT ?`);
  // SAFETY: every TaskEventRow field is a `task_events` column with the same
  // nullability, `actor_kind` is pinned by that table's CHECK constraint, and
  // `to_agent` is written as 0/1 by the only writer (rebuilder.server.ts).
  const rows = (
    opts.limit === undefined ? stmt.all(slug, key) : stmt.all(slug, key, opts.limit)
  ) as TaskEventRow[];
  // E1: baked actor snapshots go stale on user rename — overlay the CURRENT
  // users-table identity at read time (deleted users keep the snapshot).
  const overlay = createActorRenderOverlay(db);
  return rows.map((row) => {
    const event = mapTaskEventRow(row);
    return { ...event, actor: overlay(event.actor) };
  });
}

/** Producer attribution for one attachment name — the panel's "added by …"
 *  line, sourced from the timeline event that claims the name. */
export interface AttachmentProducer {
  actor: string;
  occurredAt: string;
}

/**
 * Attachment name → who produced it and when, read from the timeline events
 * that claim names (`attachments_json`). Newest claim wins: a file re-saved
 * under the same name belongs to the run that last wrote it. Names that no
 * event claims (pre-attribution files) are simply absent — the panel then
 * shows the file without a producer line rather than guessing.
 */
export function attachmentProducers(db: DatabaseSync, slug: string, key: string) {
  // SAFETY: the three columns are `task_events` columns with the same
  // nullability, and `attachments_json IS NOT NULL` pins the third; all three
  // have one writer (rebuilder.server.ts).
  const rows = db
    .prepare(
      `SELECT occurred_at, actor_json, attachments_json FROM task_events
       WHERE project_slug = ? AND task_key = ? AND attachments_json IS NOT NULL
       ORDER BY position DESC`,
    )
    .all(slug, key) as Array<{
    occurred_at: string;
    actor_json: string;
    attachments_json: string;
  }>;
  const overlay = createActorRenderOverlay(db);
  const producers: Record<string, AttachmentProducer> = {};
  // position DESC iterates oldest-first (0 = newest), so later iterations —
  // newer events — overwrite earlier claims.
  for (const row of rows) {
    // SAFETY: `actor_json` has one writer (rebuilder.server.ts), which
    // stringifies an ActorRender by construction.
    const actor = overlay(JSON.parse(row.actor_json) as ActorRender);
    // SAFETY: same single writer — `attachments_json` is the stringified
    // parsed event's `string[]`.
    const names = JSON.parse(row.attachments_json) as string[];
    for (const name of names) {
      producers[name] = { actor: actor.name, occurredAt: row.occurred_at };
    }
  }
  return producers;
}

function listTaskDiagnostics(
  db: DatabaseSync,
  slug: string,
  key: string,
): DiagnosticRecord[] {
  // SAFETY: the selected columns are DiagnosticRow one-for-one, `severity` is
  // pinned by the `diagnostics` CHECK constraint (0001_baseline.sql), and
  // `hard_stop` is written as 0/1 by the only writer (rebuilder.server.ts).
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
  /** `dataRoot` feeds the live-backend overlay (tests only — production
   *  defaults to the env root). `timelineLimit` (ruling 11): read only the
   *  newest N events, the window the task page ships; the summary's
   *  `eventCount` is the total. */
  opts: { dataRoot?: string; timelineLimit?: number } = {},
): TaskDetail | null {
  const summary = getTaskSummary(
    db,
    slug,
    key,
    opts.dataRoot === undefined ? {} : { dataRoot: opts.dataRoot },
  );
  if (!summary) return null;
  const project = getProject(db, slug);
  const stageIds = project ? project.stages.map((s) => s.id) : [];
  const facts = readTaskActivity(db, slug, key);
  const quietCheck: QuietCheck = {
    lastActivityAt: facts.lastActivityAt,
    waiting: summary.waiting,
    archived: summary.archived,
    terminal: isAcceptedDisplayState({ stage: summary.stage, stageIds }),
    runInFlight: facts.runInFlight,
    held: summary.blockedBy.length > 0,
    // Ruling 45: the clock a schedule-resting task is measured against.
    resumesAt: summary.resumesAt ?? null,
  };
  return {
    ...summary,
    timeline: listTaskEvents(
      db,
      slug,
      key,
      opts.timelineLimit === undefined ? {} : { limit: opts.timelineLimit },
    ),
    diagnostics: listTaskDiagnostics(db, slug, key),
    stages: project ? project.stages.map((s) => ({ id: s.id, name: s.name, color: s.color })) : [],
    workflow: project ? project.workflow.map((w) => ({ from: w.from, to: w.to })) : [],
    lastActivityAt: facts.lastActivityAt,
    quiet: isQuiet(quietCheck),
  };
}
