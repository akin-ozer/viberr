import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  canonicalDependencyRef,
  formatDependencyRef,
  holdRefusal,
  isDeadDependencyState,
  parseDependencyRef,
  type DependencyRender,
  type DependencyState,
} from "~/shared/dependencies";
import type { DependencyCandidate } from "~/shared/dependency-candidates";
import { isTerminalStage, stageName } from "~/shared/workflow/stage-roles";

/**
 * Ruling 55 (pass 34, Q34-11): the READ model for a task's `blockedBy` list.
 * Every entry is resolved to `open | done | failed | missing` at read time,
 * from the projections, never cached — so rebuild order cannot stale it and a
 * hand-moved or archived task cannot leave a dependent lying.
 *
 * Terminality is derived through `isTerminalStage` over the project's stage
 * list, never a positional "last stage id" guess. A task archived before it
 * was done is `failed`: a wait that can never complete without a person
 * editing the list. One archived at the terminal stage is `done`: archiving
 * filed finished work away, and what waited on it got what it waited for.
 * Every entry names a task (ruling 55).
 */

interface TaskStateRow {
  stage: string;
  archived: number;
}

function projectStages(db: DatabaseSync, slug: string): { id: string; name: string }[] {
  // SAFETY: `stages_json` is TEXT NOT NULL on `projects` and has ONE writer
  // (the rebuilder stores `JSON.stringify(fm.stages)`); every stage carries
  // `id` and `name`.
  const row = db
    .prepare(`SELECT stages_json FROM projects WHERE slug = ?`)
    .get(slug) as { stages_json: string } | undefined;
  if (!row) return [];
  // SAFETY: same writer as above; every parsed stage row carries a string `id`
  // and `name`.
  return (JSON.parse(row.stages_json) as { id: string; name: string }[]).map((s) => ({
    id: s.id,
    name: s.name,
  }));
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
  if (isTerminalStage(row.stage, stages)) return "done";
  return row.archived ? "failed" : "open";
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
    stages ??= projectStages(db, slug);
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
  return resolveWithStages(db, slug, refs, projectStages(db, slug));
}

function resolveWithStages(
  db: DatabaseSync,
  slug: string,
  refs: readonly string[],
  stages: { id: string }[],
): DependencyRender[] {
  return refs.map((raw) => {
    const ref = parseDependencyRef(raw);
    if (!ref) return { ref: raw, label: raw, state: "missing", taskKey: null };
    const canonical = formatDependencyRef(ref);
    return {
      ref: canonical,
      label: ref.task,
      state: taskState(db, slug, ref.task, stages),
      taskKey: ref.task,
    };
  });
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
 * Ruling 58: the hold sentence with the entries' live states read — the
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
  // Ruling 58: the sentence reads the live states of the entries.
  return holdRefusal(taskKey, resolveDependencies(db, slug, held), verb);
}

/** Every task in `slug` whose stored list is non-empty, with the raw list. */
export function listHeldTasks(
  db: DatabaseSync,
  slug: string,
): { taskKey: string; blockedBy: string[] }[] {
  // SAFETY: `blocked_by_json` is TEXT NOT NULL DEFAULT '[]' (ruling 55) and
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
 * Ruling 263: which tasks a task's completion would RELEASE, directly and
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
 * task or a reference nothing answers to is not waiting on this decision, and
 * counting it would inflate the one number a person is meant to order their
 * queue by.
 */
/**
 * Ruling 263: what comes unblocked, split by WHEN.
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
/**
 * Ruling 61: every open task that still WAITS on `taskKey`, in key order.
 *
 * Not `tasksReleasedBy`: that counts only the tasks whose LAST wait this is,
 * which is a release count. This is the question a lease asks before it holds
 * a task back: would anything else be held with it? A wait that can never
 * clear still counts here, because the task is still parked behind this one.
 */
export function tasksWaitingOn(db: DatabaseSync, slug: string, taskKey: string): string[] {
  const out: string[] = [];
  for (const held of listHeldTasks(db, slug)) {
    if (held.taskKey === taskKey) continue;
    const entries = resolveDependencies(db, slug, held.blockedBy);
    if (entries.some((e) => e.state === "open" && e.taskKey === taskKey)) out.push(held.taskKey);
  }
  return out.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

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
    const unmet = entries.filter((e) => e.state === "open").map((e) => e.taskKey ?? e.ref);
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

type CandidateRow = {
  task_key: string;
  title: string;
  stage: string;
  archived: number;
  blocked_by_json: string;
};

/**
 * Ruling 59: every task another task could be set to wait on, as the Blocked
 * by picker lists them: the project's tasks but `taskKey` itself, newest key
 * first, each with the refusal the writer would give it as a new entry
 * (`DependencyCandidateBar`, in the order the writer checks). Null when
 * `taskKey` is not a task in the project.
 *
 * The cycle is the writer's own walk run backwards: a task that already waits
 * on `taskKey`, directly or down the chain, is one a new entry would close a
 * cycle through, and the walk keeps the way back so the picker can name the
 * cycle as the writer does. The stored lists of archived tasks count, as they
 * do there.
 */
export function listDependencyCandidates(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
): DependencyCandidate[] | null {
  // SAFETY: the five selected columns are TEXT NOT NULL (`task_key`, `title`,
  // `stage`, `blocked_by_json`) and INTEGER NOT NULL (`archived`) on
  // `task_projections` (0001 + ruling 55).
  const rows = db
    .prepare(
      `SELECT task_key, title, stage, archived, blocked_by_json FROM task_projections
       WHERE project_slug = ?`,
    )
    .all(slug) as CandidateRow[];
  if (!rows.some((row) => row.task_key === taskKey)) return null;
  // Who lists each task: the stored edges, read backwards.
  const listedBy = new Map<string, string[]>();
  for (const row of rows) {
    for (const raw of parseBlockedByColumn(row.blocked_by_json)) {
      const key = canonicalDependencyRef(raw);
      if (!key) continue;
      const waiters = listedBy.get(key);
      if (waiters) waiters.push(row.task_key);
      else listedBy.set(key, [row.task_key]);
    }
  }
  // Each task that waits on `taskKey`, and the entry of its list the wait
  // runs through.
  const via = new Map<string, string>();
  const queue = [taskKey];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    for (const waiter of listedBy.get(key) ?? []) {
      if (waiter === taskKey || via.has(waiter)) continue;
      via.set(waiter, key);
      queue.push(waiter);
    }
  }
  const chainThrough = (key: string): string[] => {
    const chain = [taskKey, key];
    for (let at = via.get(key); at !== undefined; at = via.get(at)) chain.push(at);
    return chain;
  };
  const stages = projectStages(db, slug);
  return rows
    .filter((row) => row.task_key !== taskKey)
    .sort((a, b) => b.task_key.localeCompare(a.task_key, "en", { numeric: true }))
    .map((row): DependencyCandidate => {
      const candidate = { key: row.task_key, title: row.title, stage: stageName(stages, row.stage) };
      if (row.archived) return { ...candidate, bar: "archived" };
      if (via.has(row.task_key)) return { ...candidate, bar: "cycle", chain: chainThrough(row.task_key) };
      return { ...candidate, bar: isTerminalStage(row.stage, stages) ? "done" : null };
    });
}
