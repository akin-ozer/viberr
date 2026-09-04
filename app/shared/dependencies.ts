/**
 * Task dependencies — the vocabulary of `task.md`'s `blockedBy:` list
 * (ruling 131, pass 34 Q34-11). Client-safe: the board card, the task page
 * and the Details editor render and parse the same two spellings the server
 * validates.
 *
 * Exactly TWO spellings, stored as strings in the file so the YAML stays
 * readable and hand-editable:
 *
 *   JC-6               a task in the same project
 *   goal-1 link 3      a goal chain's link (resolves to that link's task the
 *                      moment the chain creates it)
 *
 * Anything else is refused at write time by name (`DEPENDENCY_GRAMMAR_HINT`).
 * States are resolved at READ time (`app/server/projections/dependencies.server.ts`),
 * never cached, so rebuild order cannot stale them.
 */

export type DependencyRef =
  | { kind: "task"; task: string }
  | { kind: "goal"; goal: string; link: number };

/** The state a reference resolves to at read time. `failed` covers an
 *  archived task and a failed goal link — a wait that can never complete;
 *  `missing` is a reference nothing in the project answers to. */
export type DependencyState = "open" | "done" | "failed" | "missing";

/** One entry as a surface renders it. */
export interface DependencyRender {
  /** The canonical spelling as stored. */
  ref: string;
  /** What to print: the task key, or `goal-1 link 3 (JC-9)` once the link has
   *  a task, or `goal-1 link 3` before it does. */
  label: string;
  state: DependencyState;
  /** The task the entry resolves to, when it resolves to one (a task ref, or
   *  a goal link whose task exists). Links to the task page. */
  taskKey: string | null;
  /** The goal a goal-link ref names (links to the project's Controller page). */
  goalId: string | null;
}

export const DEPENDENCY_GRAMMAR_HINT =
  "a task key like JC-6, or a goal link like goal-1 link 3";

const TASK_REF_RE = /^([A-Za-z]+)-(\d+)$/;
const GOAL_LINK_RE = /^(goal-\d+)\s+link\s+(\d+)$/i;

/** Parse one spelling. Whitespace is trimmed and inner runs collapsed; a task
 *  prefix is upper-cased and a goal id lower-cased so the canonical form is
 *  what {@link formatDependencyRef} prints. Returns null for anything else. */
export function parseDependencyRef(text: string): DependencyRef | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const task = TASK_REF_RE.exec(normalized);
  if (task) {
    // `goal-1` is a goal id, not a task key: every goal id is `goal-<n>`
    // (`nextGoalId`), so a bare one is a goal reference missing its link and
    // is refused rather than read as a task with the prefix GOAL.
    if (task[1]!.toLowerCase() === "goal") return null;
    return { kind: "task", task: `${task[1]!.toUpperCase()}-${Number(task[2])}` };
  }
  const link = GOAL_LINK_RE.exec(normalized);
  if (link) {
    const index = Number(link[2]);
    if (!Number.isInteger(index) || index < 1) return null;
    return { kind: "goal", goal: link[1]!.toLowerCase(), link: index };
  }
  return null;
}

/** The canonical spelling of a reference — what the file stores. */
export function formatDependencyRef(ref: DependencyRef): string {
  return ref.kind === "task" ? ref.task : `${ref.goal} link ${ref.link}`;
}

/** Canonicalize a spelling, or null when it does not parse. */
export function canonicalDependencyRef(text: string): string | null {
  const ref = parseDependencyRef(text);
  return ref ? formatDependencyRef(ref) : null;
}

/** Parse a whole `blockedBy` list, dropping duplicates (after canonicalizing)
 *  and returning the first unparseable spelling so a writer can refuse it by
 *  name. */
export interface ParsedDependencyList {
  /** The canonical spellings, in order, deduplicated. */
  refs: string[];
  /** The first spelling that did not parse, or null when every one did. */
  invalid: string | null;
}

export function parseDependencyList(entries: readonly string[]): ParsedDependencyList {
  const refs: string[] = [];
  for (const entry of entries) {
    const canonical = canonicalDependencyRef(entry);
    if (!canonical) return { refs, invalid: entry };
    if (!refs.includes(canonical)) refs.push(canonical);
  }
  return { refs, invalid: null };
}

/** Split the free-text form the Details editor submits (one entry per line or
 *  comma) into raw entries. */
export function splitDependencyText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Ruling 131(e): what the `dependencies-released` operator trigger carries —
 * the entries the task waited on, and the person who cleared the list by hand
 * when it was not the engine (null for an engine release).
 */
export interface DependencyReleasePayload {
  entries: string[];
  clearedBy: string | null;
}
