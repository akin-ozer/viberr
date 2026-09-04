import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  formatDependencyRef,
  parseDependencyRef,
  type DependencyRender,
  type DependencyState,
} from "~/shared/dependencies";
import { isTerminalStage } from "~/shared/workflow/stage-roles";

/**
 * Ruling 131 (pass 34, Q34-11): the READ model for a task's `blockedBy` list.
 * Every entry is resolved to `open | done | failed | missing` at read time,
 * from the projections, never cached — so rebuild order cannot stale it and a
 * hand-moved or archived task cannot leave a dependent lying.
 *
 * Terminality is derived through `isTerminalStage` over the project's stage
 * list, never a positional "last stage id" guess. A goal-link entry whose link
 * names a `taskKey` takes that task's own state (and renders the key); a link
 * without a task yet is `open` until the chain creates it, `done` when the
 * link was completed or skipped, `failed` when the link failed. An archived
 * task is `failed`: a wait that can never complete without a person editing
 * the list (ruling 131(e)).
 */

const goalLinkRowSchema = z
  .object({
    index: z.number().int(),
    taskKey: z.string().nullable().default(null),
    status: z.string().default("pending"),
  })
  .loose();

interface TaskStateRow {
  stage: string;
  archived: number;
}

function projectStageIds(db: DatabaseSync, slug: string): { id: string }[] {
  // SAFETY: `stages_json` is TEXT NOT NULL on `projects` and has ONE writer
  // (the rebuilder stores `JSON.stringify(fm.stages)`); every stage carries `id`.
  const row = db
    .prepare(`SELECT stages_json FROM projects WHERE slug = ?`)
    .get(slug) as { stages_json: string } | undefined;
  if (!row) return [];
  // SAFETY: same writer as above; every parsed stage row carries a string `id`.
  return (JSON.parse(row.stages_json) as { id: string }[]).map((s) => ({ id: s.id }));
}

function taskState(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
  stages: { id: string }[],
): DependencyState {
  // SAFETY: the two selected columns are `stage` TEXT NOT NULL and `archived`
  // INTEGER NOT NULL DEFAULT 0 on `task_projections`.
  const row = db
    .prepare(`SELECT stage, archived FROM task_projections WHERE project_slug = ? AND task_key = ?`)
    .get(slug, taskKey) as TaskStateRow | undefined;
  if (!row) return "missing";
  if (row.archived) return "failed";
  return isTerminalStage(row.stage, stages) ? "done" : "open";
}

/** Resolve one project's list of canonical spellings. Unparseable spellings
 *  (a hand edit the tolerant parser let through as a string) read `missing`. */
export function resolveDependencies(
  db: DatabaseSync,
  slug: string,
  refs: readonly string[],
): DependencyRender[] {
  if (refs.length === 0) return [];
  const stages = projectStageIds(db, slug);
  const out: DependencyRender[] = [];
  for (const raw of refs) {
    const ref = parseDependencyRef(raw);
    if (!ref) {
      out.push({ ref: raw, label: raw, state: "missing", taskKey: null, goalId: null });
      continue;
    }
    const canonical = formatDependencyRef(ref);
    if (ref.kind === "task") {
      out.push({
        ref: canonical,
        label: ref.task,
        state: taskState(db, slug, ref.task, stages),
        taskKey: ref.task,
        goalId: null,
      });
      continue;
    }
    // SAFETY: `links_json` is TEXT NOT NULL DEFAULT '[]' on `goal_projections`.
    const goal = db
      .prepare(`SELECT links_json FROM goal_projections WHERE project_slug = ? AND goal_id = ?`)
      .get(slug, ref.goal) as { links_json: string } | undefined;
    const links = goal
      ? z.array(goalLinkRowSchema).catch([]).parse(JSON.parse(goal.links_json))
      : null;
    const link = links?.find((l) => l.index === ref.link) ?? null;
    if (!link) {
      out.push({ ref: canonical, label: canonical, state: "missing", taskKey: null, goalId: ref.goal });
      continue;
    }
    if (link.taskKey) {
      out.push({
        ref: canonical,
        label: `${canonical} (${link.taskKey})`,
        state: taskState(db, slug, link.taskKey, stages),
        taskKey: link.taskKey,
        goalId: ref.goal,
      });
      continue;
    }
    const state: DependencyState =
      link.status === "done" || link.status === "skipped"
        ? "done"
        : link.status === "failed"
          ? "failed"
          : "open";
    out.push({ ref: canonical, label: canonical, state, taskKey: null, goalId: ref.goal });
  }
  return out;
}

/** Every entry is done (an empty list is trivially satisfied, which is what
 *  makes the release engine convergent). */
export function dependenciesSatisfied(entries: readonly DependencyRender[]): boolean {
  return entries.every((e) => e.state === "done");
}

/** The entries that can never complete on their own. */
export function deadDependencies(entries: readonly DependencyRender[]): DependencyRender[] {
  return entries.filter((e) => e.state === "failed" || e.state === "missing");
}

/** Every task in `slug` whose stored list is non-empty, with the raw list. */
export function listHeldTasks(
  db: DatabaseSync,
  slug: string,
): { taskKey: string; blockedBy: string[] }[] {
  // SAFETY: `blocked_by_json` is TEXT NOT NULL DEFAULT '[]' (ruling 131) and
  // `task_key` TEXT NOT NULL on `task_projections`; only the held rows are read.
  const rows = db
    .prepare(
      `SELECT task_key, blocked_by_json FROM task_projections
       WHERE project_slug = ? AND blocked_by_json != '[]' AND archived = 0`,
    )
    .all(slug) as { task_key: string; blocked_by_json: string }[];
  return rows.map((row) => ({
    taskKey: row.task_key,
    blockedBy: z.array(z.string()).catch([]).parse(JSON.parse(row.blocked_by_json)),
  }));
}
