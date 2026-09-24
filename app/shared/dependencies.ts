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
/**
 * F37-63: `cancelled` is its own state, not folded into `failed`.
 *
 * A link on a CANCELLED goal that never acquired a task can never acquire one
 * (`reconcileGoal` early-returns on a terminal chain) and cannot be skipped
 * (every goal-side remedy refuses with "Goal X is cancelled"), so the wait is
 * dead. It resolved as `open` before, which is why nothing noticed it. It is
 * not `failed`, because the surfaces render that as "archived" and a cancelled
 * chain is a different cause a person needs to read correctly.
 */
export type DependencyState = "open" | "done" | "failed" | "missing" | "cancelled";

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

/**
 * The one task-key prefix a project may not take. `goal-1 link 3` names a
 * goal chain's link, so a bare `GOAL-1` is read as a goal reference missing
 * its link (see {@link parseDependencyRef}) — a project keyed `GOAL` could
 * never appear in anyone's `blockedBy`. Every writer of `taskPrefix` refuses
 * it by name instead of shipping a project whose tasks cannot be waited on.
 */
const RESERVED_TASK_PREFIX = "GOAL";

/** Is this prefix the reserved one? Case-insensitive: the writers upper-case
 *  before storing, so `goal` and `Goal` are the same refusal. */
export function isReservedTaskPrefix(prefix: string): boolean {
  return prefix.trim().toUpperCase() === RESERVED_TASK_PREFIX;
}

/** What a writer tells the person who typed it. */
export const RESERVED_TASK_PREFIX_REFUSAL =
  `"${RESERVED_TASK_PREFIX}" is not available as a task prefix: a dependency spelled GOAL-1 reads as a goal chain's reference, so those tasks could never be waited on. Pick another prefix.`;

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
  /** F39-65: every entry was done before the task was created (a chain link
   *  minted by the completion it waits on). Nothing ever held it. */
  atBirth?: boolean;
}

/**
 * Ruling 186 (pass 37, F37-2): ONE spelling of "this task is held".
 *
 * A task with a non-empty `blockedBy` refuses every agent dispatch, the same
 * way ruling 177's closure refuses one — and for the same reason. Before this,
 * the hold was enforced by ASKING the model: `runOperator` refused three
 * triggers (`create`, `transition`, `scheduled`) and every reactive trigger ran
 * on with a prompt paragraph telling it not to "dispatch delivery work", while
 * `startAgentRun` checked nothing at all. Live (pass 37, SHOP-2) Viberr wrote
 * "Held until every entry is done; Viberr releases it then", started a Codex
 * run 1.9 seconds later, and let it design and commit a whole service onto a
 * branch cut from a base that predated the work it waited on.
 *
 * Every door reads the list and refuses with THIS wording: the operator's
 * `run_agent`, the controller's `run_agent`, and the task page's Run-an-agent
 * control (which renders the same sentence before the click, so the words a
 * person meets are the words the server answers with).
 *
 * `verb` completes "…so <verb> is refused", e.g. "running an agent on it".
 */
export function holdRefusal(
  taskKey: string,
  entries: readonly DependencyRender[],
  verb: string,
): string {
  // Ruling 355: the entries that can never complete, by label.
  const dead = deadDependencyLabels(entries);
  // Ruling 356: the entries already done, as done.
  const head =
    `${taskKey} waits on ${holdEntriesSentence(entries)} and Viberr is holding it, ` +
    `so ${verb} is refused. `;
  // Ruling 355 (pass 38, F38-9): "Viberr releases it when every entry is done"
  // is a promise `dependenciesSatisfied` can never keep for a failed, missing
  // or cancelled entry — the release engine writes "can never complete … edit
  // what it waits on" on the same task, and this sentence stood beside it
  // promising the opposite. The states are on the entries; say what they say.
  if (dead.length > 0) {
    return (
      head +
      `${joinDependencyEntries(dead)} can never complete, so Viberr will not release it on ` +
      `its own: edit what it waits on (remove the entry or point it elsewhere) to release it.`
    );
  }
  return head + `Viberr releases it when every entry is done; to release it sooner, change what it waits on.`;
}

/** Ruling 355: the states an entry cannot leave on its own. */
export function isDeadDependencyState(state: DependencyState): boolean {
  return state === "failed" || state === "missing" || state === "cancelled";
}

/** Ruling 355: the labels of the entries that can never complete — client-safe,
 *  so the pre-click control and the server doors read one predicate. */
export function deadDependencyLabels(entries: readonly DependencyRender[]): string[] {
  return entries.filter((e) => isDeadDependencyState(e.state)).map((e) => e.label);
}

/** "A", "A and B", "A, B and C" — the list as a sentence reads it. */
export function joinDependencyEntries(entries: readonly string[]): string {
  if (entries.length === 0) return "other work";
  if (entries.length === 1) return entries[0]!;
  return `${entries.slice(0, -1).join(", ")} and ${entries[entries.length - 1]!}`;
}

/**
 * Ruling 356 (pass 38, F38-10): the hold list as a sentence reads it — what
 * still holds the task, then the entries already done, as done.
 *
 * A hold releases as a whole (`dependenciesSatisfied` is `every(done)`), so
 * `blockedBy` keeps an entry after the task it names is done, and every
 * sentence built from the bare labels said "waits on goal-2 link 1 (BNB-2),
 * goal-2 link 4 and BNB-11" beside a rail marking two of the three done —
 * the refusal at the door, the run control, the hero's "Other work" line and
 * two skipped-schedule notes. Three tests pinned the flattening with a fixture
 * whose JC-3 was `done`. The states are on the entries; say what they say.
 * An all-open list reads as before. An all-done list (the minute between a
 * completion and the release sweep) is listed plainly: the release is on its
 * way and nothing here can promise more than that.
 */
export function holdEntriesSentence(entries: readonly DependencyRender[]): string {
  const done = entries.filter((e) => e.state === "done");
  const pending = entries.filter((e) => e.state !== "done").map((e) => e.label);
  if (done.length === 0 || pending.length === 0) {
    return joinDependencyEntries(entries.map((e) => e.label));
  }
  return joinDependencyEntries([...pending, ...done.map(doneLabel)]);
}

/**
 * F39-44: a done entry carries its OWN tag, never a parenthesis after the list.
 *
 * Ruling 356 said the done entries in a trailing group, `A (B is done)`. But a
 * goal link that has a task already prints its task in a parenthesis, `goal-2
 * link 1 (BNB-2)`, so the group read as the LAST pending entry's annotation:
 * "Other work: goal-1 link 2 (JC-3 is done)" says goal-1 link 2 is done, the
 * opposite of the fact, and "goal-4 link 7 (AX-4, goal-2 link 3 (AX-16) … are
 * done)" named AX-4 as goal-4 link 7's task. Live on ax-clone's Goals rail,
 * nine entries deep. A tag on each done entry cannot attach to a neighbour: the
 * one parenthesis an entry prints is its own, and it now holds the state beside
 * the task key (`goal-2 link 1 (BNB-2, done)`).
 */
function doneLabel(entry: DependencyRender): string {
  const own = entry.taskKey ? ` (${entry.taskKey})` : "";
  return own && entry.label.endsWith(own)
    ? `${entry.label.slice(0, -1)}, done)`
    : `${entry.label} (done)`;
}
