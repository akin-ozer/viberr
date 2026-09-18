import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  deadDependencyLabels,
  holdRefusal,
  isDeadDependencyState,
} from "~/shared/dependencies";
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

/** A resolver for one project with its stage list read ONCE: the board query
 *  maps every row through the same instance, so a project of N held tasks
 *  costs one stage read, not N. Unparseable spellings (a hand edit the
 *  tolerant parser let through as a string) read `missing`. */
export type DependencyResolver = (refs: readonly string[]) => DependencyRender[];

export function dependencyResolver(db: DatabaseSync, slug: string): DependencyResolver {
  let stages: { id: string }[] | null = null;
  return (refs) => {
    if (refs.length === 0) return [];
    stages ??= projectStageIds(db, slug);
    return resolveWithStages(db, slug, refs, stages);
  };
}

/** The projection's verbatim `blocked_by_json` column as a string list. */
export function parseBlockedByColumn(json: string): string[] {
  return z.array(z.string()).catch([]).parse(JSON.parse(json));
}

/** Resolve one project's list of canonical spellings (one-shot form). */
export function resolveDependencies(
  db: DatabaseSync,
  slug: string,
  refs: readonly string[],
): DependencyRender[] {
  if (refs.length === 0) return [];
  return resolveWithStages(db, slug, refs, projectStageIds(db, slug));
}

function resolveWithStages(
  db: DatabaseSync,
  slug: string,
  refs: readonly string[],
  stages: { id: string }[],
): DependencyRender[] {
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
    // SAFETY: `links_json` is TEXT NOT NULL DEFAULT '[]' and `status` TEXT NOT
    // NULL on `goal_projections`.
    const goal = db
      .prepare(
        `SELECT links_json, status FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
      )
      .get(slug, ref.goal) as { links_json: string; status: string } | undefined;
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
    // F37-63: a link with no task, on a goal that has reached a terminal status,
    // can NEVER acquire one — `reconcileGoal` early-returns on a terminal chain,
    // and every goal-side remedy (`skip_link`, `edit_link`, `retry_link`,
    // `remove_pending_link`) refuses with "Goal X is cancelled". Before this it
    // resolved to `open`, indistinguishable from a live wait, so
    // `deadDependencies` never saw it and ruling 131(e)'s note and notification
    // never fired — while `releaseDependents`' own comment claimed the sweep
    // "notices a wait that can NEVER complete, whatever killed it … a cancelled
    // goal, a removed link or a lost task". It did not notice this one.
    const goalTerminal = goal?.status === "cancelled" || goal?.status === "completed";
    const state: DependencyState =
      link.status === "done" || link.status === "skipped"
        ? "done"
        : link.status === "failed"
          ? "failed"
          : goalTerminal
            ? "cancelled"
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
  return entries.filter((e) => isDeadDependencyState(e.state));
}

/**
 * Ruling 355: the hold sentence with the entries' live states read — the
 * server's one door to `holdRefusal`, so every refusal names an entry that can
 * never complete instead of promising a release that cannot come.
 */
export function holdRefusalFor(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
  held: readonly string[],
  verb: string,
): string {
  return holdRefusal(taskKey, held, verb, deadDependencyLabels(resolveDependencies(db, slug, held)));
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
    blockedBy: parseBlockedByColumn(row.blocked_by_json),
  }));
}

/**
 * Ruling 300: which tasks a task's completion would RELEASE, directly and
 * down the chain.
 *
 * The controller asked for this from a decision queue: `list_decisions` gave it
 * three cards, and that five tasks sat behind them (SHOP-46 → SHOP-48;
 * SHOP-41 → SHOP-28; SHOP-49 → SHOP-29 → SHOP-28) it worked out by reading each
 * task's `blockedBy` and walking the chain by hand, across two turns. Its own
 * words: "the one number that should order a decision queue does not exist, so
 * the ordering depends on whoever happens to have walked the graph recently."
 *
 * A wait that can NEVER clear is not counted. A task blocked on an archived
 * task, a cancelled goal or a reference nothing answers to is not waiting on
 * this decision, and counting it would inflate the one number a person is meant
 * to order their queue by. The same goes for an open goal link with no task
 * yet: it is a real wait, and no task key completing satisfies it.
 */
/**
 * Ruling 336: what comes unblocked, split by WHEN.
 *
 * `direct` are the tasks whose last wait is this task — they move the moment it
 * completes. `downstream` are the rest of the transitive closure: each needs
 * one of the `direct` ones to complete FIRST, which is its own review, its own
 * verify and its own acceptance.
 *
 * They were one flat array, and the controller caught the cost by predicting it
 * and naming the check: SHOP-28's acceptance card claimed it released SHOP-41,
 * SHOP-29 and SHOP-49, "but at that moment SHOP-49 waited on SHOP-29, not on
 * SHOP-28." The release rows settle it — SHOP-28 merged at 21:40:32, SHOP-29
 * released at 21:40:34.685 and SHOP-41 at 21:40:34.502 (two seconds), and
 * SHOP-49 at 22:33:53.901, **fifty-three minutes later and two and a half
 * seconds after SHOP-29's own merge**. One click freed two tasks, not three.
 *
 * The old field was not lying — `list_decisions` said "down the chain" — but it
 * is a SORT KEY for a person's decision queue, and its own description had to
 * warn "do not sort by it alone". A number that mixes "frees now" with "frees
 * after another human decision" is wrong for the one job it has.
 */
export interface ReleasedTasks {
  /** Unblocked by this task completing, full stop. */
  direct: string[];
  /** Unblocked only once one of `direct` also completes. */
  downstream: string[];
}

export function tasksReleasedBy(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
): ReleasedTasks {
  const waiting = new Map<string, Set<string>>();
  for (const held of listHeldTasks(db, slug)) {
    const entries = resolveDependencies(db, slug, held.blockedBy);
    if (entries.some((e) => e.state !== "open" && e.state !== "done")) continue;
    const unmet = entries
      .filter((e) => e.state === "open")
      // A goal link with no task yet keeps its own spelling, which no task key
      // can equal, so the wait stands rather than silently clearing.
      .map((e) => e.taskKey ?? e.ref);
    if (unmet.length > 0) waiting.set(held.taskKey, new Set(unmet));
  }

  const direct: string[] = [];
  const downstream: string[] = [];
  // Breadth-first, so "how many hops from the decision" is the queue's own
  // shape: everything freed by the first pass is direct, everything after it
  // needed one of those to complete too.
  let frontier = [taskKey];
  let hop = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const done of frontier) {
      for (const [key, blockers] of waiting) {
        if (!blockers.delete(done)) continue;
        if (blockers.size > 0) continue;
        waiting.delete(key);
        (hop === 0 ? direct : downstream).push(key);
        next.push(key);
      }
    }
    frontier = next;
    hop += 1;
  }
  return { direct, downstream };
}
