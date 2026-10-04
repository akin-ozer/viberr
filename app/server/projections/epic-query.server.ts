import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  EPIC_COLORS,
  EPIC_STATUS_VALUES,
  type EpicColor,
  type EpicStatus,
  type EpicTimelineEntry,
} from "~/schemas/epic-file.schema";
import { readEpicFile } from "~/server/files/epic-writer.server";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { getProject } from "./board-query.server";

/**
 * Epic read models (ruling 503): the Epics pages, the board's epic filter
 * and New task pick, the task page's Epic row, and the controller's and
 * operator's reads all answer from here.
 *
 * An epic's row is its file. Its PROGRESS is counted from the task rows whose
 * `epic_id` names it, at read time, never stored: a task that moves stage, is
 * archived, or leaves the epic changes the count the moment its own row does,
 * with nothing to keep in step.
 */

/** How far an epic's tasks have got. A task archived before it was done is
 *  left out of every count, the way Linear leaves a cancelled issue out of a
 *  project's progress: it is abandoned work, neither done nor still to do. A
 *  task archived at the terminal stage still counts as done (ruling 651):
 *  archiving filed finished work away, it did not undo it. */
export interface EpicProgress {
  /** Tasks in the epic: the live ones and the ones archived when done. */
  total: number;
  /** At the project's terminal stage, archived or not. */
  done: number;
  /** Past the entry stage and not done. */
  started: number;
  /** Still at the entry stage. */
  notStarted: number;
  /** Waiting on other work (ruling 131); counted in the three above too. */
  held: number;
  /** Archived tasks that still name this epic, shown apart. */
  archived: number;
  /** Of those, the ones archived at the terminal stage: counted in `total`
   *  and `done` as well. */
  archivedDone: number;
  /** Per stage, in the project's stage order: the segments of the bar. */
  byStage: { stageId: string; count: number }[];
}

export interface EpicSummary {
  id: string;
  /** The n of `epic-<n>`. */
  number: number;
  title: string;
  status: EpicStatus;
  color: EpicColor;
  leadUserId: string | null;
  /** The lead's display name, read at request time; null when nobody leads
   *  it. */
  leadName: string | null;
  startDate: string | null;
  targetDate: string | null;
  description: string;
  createdBy: string;
  createdByLabel: string;
  /** The controller conversation it was planned in, when a controller turn
   *  created it. */
  conversationId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  progress: EpicProgress;
}

export interface EpicDetail extends EpicSummary {
  /** The epic's own history, newest first, from its file. */
  history: EpicTimelineEntry[];
}

/** An `epic_projections` row as the rebuilder writes it. The two enums are
 *  the file schema's own, so a row can only carry what a file could say. */
const epicRowSchema = z.object({
  epic_id: z.string(),
  epic_number: z.number(),
  title: z.string(),
  status: z.enum(EPIC_STATUS_VALUES),
  color: z.enum(EPIC_COLORS),
  lead_user_id: z.string().nullable(),
  start_date: z.string().nullable(),
  target_date: z.string().nullable(),
  description: z.string(),
  created_by: z.string(),
  created_by_label: z.string(),
  conversation_id: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
type EpicRow = z.infer<typeof epicRowSchema>;

/** One group of the progress count below. `held` is sqlite's 0/1 for the
 *  comparison it selects. */
const epicCountRowSchema = z.object({
  epic_id: z.string(),
  stage: z.string(),
  archived: z.number(),
  held: z.number(),
  n: z.number(),
});

function emptyProgress(): EpicProgress {
  return { total: 0, done: 0, started: 0, notStarted: 0, held: 0, archived: 0, archivedDone: 0, byStage: [] };
}

/**
 * Every epic's progress in a project, from ONE grouped read of the task rows.
 * A task whose stage the project no longer has is counted as started (it is
 * neither at the entry stage nor done) and gets its own segment after the
 * known stages, so the bar never silently drops it.
 */
function progressByEpic(db: DatabaseSync, slug: string): Map<string, EpicProgress> {
  const stages = getProject(db, slug)?.stages.map((s) => ({ id: s.id })) ?? [];
  const entryId = stages[0]?.id ?? null;
  const rows = z.array(epicCountRowSchema).parse(
    db
      .prepare(
        `SELECT epic_id, stage, archived, (blocked_by_json <> '[]') AS held, count(*) AS n
           FROM task_projections
          WHERE project_slug = ? AND epic_id IS NOT NULL
          GROUP BY epic_id, stage, archived, held`,
      )
      .all(slug),
  );
  const out = new Map<string, EpicProgress>();
  const segments = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let progress = out.get(row.epic_id);
    if (!progress) {
      progress = emptyProgress();
      out.set(row.epic_id, progress);
    }
    const terminal = stages.length > 0 && isTerminalStage(row.stage, stages);
    if (row.archived) {
      progress.archived += row.n;
      if (!terminal) continue;
      progress.archivedDone += row.n;
    }
    progress.total += row.n;
    if (row.held && !row.archived) progress.held += row.n;
    if (terminal) progress.done += row.n;
    else if (row.stage === entryId) progress.notStarted += row.n;
    else progress.started += row.n;
    let byStage = segments.get(row.epic_id);
    if (!byStage) {
      byStage = new Map();
      segments.set(row.epic_id, byStage);
    }
    byStage.set(row.stage, (byStage.get(row.stage) ?? 0) + row.n);
  }
  const order = new Map(stages.map((s, i) => [s.id, i]));
  for (const [epicId, byStage] of segments) {
    const progress = out.get(epicId)!;
    progress.byStage = [...byStage]
      .sort(
        ([a], [b]) =>
          (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) ||
          a.localeCompare(b),
      )
      .map(([stageId, count]) => ({ stageId, count }));
  }
  return out;
}

function toSummary(db: DatabaseSync, row: EpicRow, progress: EpicProgress | undefined): EpicSummary {
  return {
    id: row.epic_id,
    number: row.epic_number,
    title: row.title,
    status: row.status,
    color: row.color,
    leadUserId: row.lead_user_id,
    leadName: row.lead_user_id ? userDisplayName(db, row.lead_user_id) : null,
    startDate: row.start_date,
    targetDate: row.target_date,
    description: row.description,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: progress ?? emptyProgress(),
  };
}

const EPIC_COLUMNS = `epic_id, epic_number, title, status, color, lead_user_id, start_date,
  target_date, description, created_by, created_by_label, conversation_id,
  created_at, updated_at`;

/** Every epic of a project, by number, each with its progress. */
export function listEpics(db: DatabaseSync, slug: string): EpicSummary[] {
  const rows = z.array(epicRowSchema).parse(
    db
      .prepare(
        `SELECT ${EPIC_COLUMNS} FROM epic_projections WHERE project_slug = ?
          ORDER BY epic_number ASC, epic_id ASC`,
      )
      .all(slug),
  );
  const progress = progressByEpic(db, slug);
  return rows.map((row) => toSummary(db, row, progress.get(row.epic_id)));
}

/** One epic with its progress, or null when the project has no such epic. */
export function getEpic(db: DatabaseSync, slug: string, epicId: string): EpicSummary | null {
  const raw = db
    .prepare(`SELECT ${EPIC_COLUMNS} FROM epic_projections WHERE project_slug = ? AND epic_id = ?`)
    .get(slug, epicId);
  if (raw === undefined) return null;
  const row = epicRowSchema.parse(raw);
  return toSummary(db, row, progressByEpic(db, slug).get(epicId));
}

/** One epic with its history, which only its file holds. */
export function getEpicDetail(
  db: DatabaseSync,
  slug: string,
  epicId: string,
  options: { dataRoot?: string } = {},
): EpicDetail | null {
  const epic = getEpic(db, slug, epicId);
  if (!epic) return null;
  const file = readEpicFile({ projectSlug: slug, epicId, dataRoot: options.dataRoot });
  return { ...epic, history: file?.parsed.timeline ?? [] };
}

/** The keys of an epic's tasks, archived ones included, by key number. */
export function epicTaskKeys(db: DatabaseSync, slug: string, epicId: string): string[] {
  return z
    .array(z.object({ task_key: z.string() }))
    .parse(
      db
        .prepare(
          `SELECT task_key FROM task_projections WHERE project_slug = ? AND epic_id = ?
            ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
        )
        .all(slug, epicId),
    )
    .map((row) => row.task_key);
}

/** One of an epic's tasks, as the operator's snapshot lists it. */
export interface EpicTaskRow {
  key: string;
  title: string;
  stage: string;
  archived: boolean;
  /** What it waits on, as stored (task keys). */
  blockedBy: string[];
}

const epicTaskRowSchema = z.object({
  task_key: z.string(),
  title: z.string(),
  stage: z.string(),
  archived: z.number(),
  blocked_by_json: z.string(),
});

const blockedByColumnSchema = z.array(z.string()).catch([]);

/** An epic's tasks from their rows alone, by key number: the light read, for
 *  a caller that needs no owner, activity or live dependency state. */
export function epicTaskRows(db: DatabaseSync, slug: string, epicId: string): EpicTaskRow[] {
  return z
    .array(epicTaskRowSchema)
    .parse(
      db
        .prepare(
          `SELECT task_key, title, stage, archived, blocked_by_json FROM task_projections
            WHERE project_slug = ? AND epic_id = ?
            ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
        )
        .all(slug, epicId),
    )
    .map((row) => ({
      key: row.task_key,
      title: row.title,
      stage: row.stage,
      archived: row.archived !== 0,
      blockedBy: blockedByColumnSchema.parse(JSON.parse(row.blocked_by_json)),
    }));
}

/** An epic as a chip or a menu entry draws it (ruling 503). */
export interface EpicChipRow {
  id: string;
  title: string;
  color: EpicColor;
  status: EpicStatus;
}

const epicChipRowSchema = z.object({
  epic_id: z.string(),
  title: z.string(),
  color: z.enum(EPIC_COLORS),
  status: z.enum(EPIC_STATUS_VALUES),
});

/**
 * Every epic of a project as its chip draws it, by number: ONE statement, for
 * the loaders that name epics beside tasks (the board's filter and New task
 * pick, the task page's Epic row) and must not pay for progress they do not
 * show.
 */
export function listEpicChips(db: DatabaseSync, slug: string): EpicChipRow[] {
  return z
    .array(epicChipRowSchema)
    .parse(
      db
        .prepare(
          `SELECT epic_id, title, color, status FROM epic_projections WHERE project_slug = ?
            ORDER BY epic_number ASC, epic_id ASC`,
        )
        .all(slug),
    )
    .map((row) => ({ id: row.epic_id, title: row.title, color: row.color, status: row.status }));
}
