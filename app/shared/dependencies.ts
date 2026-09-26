/**
 * Task dependencies — the vocabulary of `task.md`'s `blockedBy:` list
 * (ruling 131, pass 34 Q34-11). Client-safe: the board card, the task page
 * and the Details editor render and parse the same spelling the server
 * validates.
 *
 * ONE spelling, stored as a string in the file so the YAML stays readable and
 * hand-editable:
 *
 *   JC-6               a task in the same project
 *
 * Ruling 503 retired the second one, `goal-1 link 3`: goal chains became
 * epics, every task an epic holds exists from the moment it joins, so what a
 * task waits on is always another task. The boot conversion rewrote each
 * stored goal-link entry to the key of the task that carried the link.
 *
 * Anything else is refused at write time by name (`DEPENDENCY_GRAMMAR_HINT`).
 * States are resolved at READ time (`app/server/projections/dependencies.server.ts`),
 * never cached, so rebuild order cannot stale them.
 */

export type DependencyRef = { kind: "task"; task: string };

/** The state a reference resolves to at read time. `failed` is an archived
 *  task, a wait that can never complete; `missing` is a reference nothing in
 *  the project answers to.
 *
 *  F37-63's `cancelled` state (a link on a cancelled goal that could never
 *  acquire a task) left with the goal links it described (ruling 503). */
export type DependencyState = "open" | "done" | "failed" | "missing";

/** One entry as a surface renders it. */
export interface DependencyRender {
  /** The canonical spelling as stored. */
  ref: string;
  /** What to print: the task key. */
  label: string;
  state: DependencyState;
  /** The task the entry resolves to. Links to the task page. */
  taskKey: string | null;
}

export const DEPENDENCY_GRAMMAR_HINT = "a task key like JC-6";

/**
 * The one task-key prefix a project may not take. An epic's id is
 * `epic-<n>` (ruling 503), so a project keyed `EPIC` would have tasks whose
 * keys read as epic ids everywhere a person or an agent reads them: on a
 * card, in a wait, in the controller's replies. Every writer of `taskPrefix`
 * refuses it by name. (Before ruling 503 the reserved prefix was `GOAL`,
 * because `GOAL-1` read as a goal-link reference missing its link.)
 */
const RESERVED_TASK_PREFIX = "EPIC";

/** Is this prefix the reserved one? Case-insensitive: the writers upper-case
 *  before storing, so `epic` and `Epic` are the same refusal. */
export function isReservedTaskPrefix(prefix: string): boolean {
  return prefix.trim().toUpperCase() === RESERVED_TASK_PREFIX;
}

/** What a writer tells the person who typed it. */
export const RESERVED_TASK_PREFIX_REFUSAL =
  `"${RESERVED_TASK_PREFIX}" is not available as a task prefix: an epic's id is spelled epic-1, so tasks keyed EPIC-1 would read as epics everywhere they are named. Pick another prefix.`;

const TASK_REF_RE = /^([A-Za-z]+)-(\d+)$/;

/** Parse one spelling. Whitespace is trimmed and the prefix upper-cased so the
 *  canonical form is what {@link formatDependencyRef} prints. Returns null for
 *  anything else. An epic id is not refused here: it reads as a task key the
 *  store then does not know ("EPIC-1 is not a task in this project"), and a
 *  project keyed EPIC before the prefix was reserved keeps tasks that can be
 *  waited on. */
export function parseDependencyRef(text: string): DependencyRef | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const task = TASK_REF_RE.exec(normalized);
  if (!task) return null;
  return { kind: "task", task: `${task[1]!.toUpperCase()}-${Number(task[2])}` };
}

/** The canonical spelling of a reference — what the file stores. */
export function formatDependencyRef(ref: DependencyRef): string {
  return ref.task;
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
  /** F39-65: every entry was done before the task was created. Nothing ever
   *  held it. */
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
  return state === "failed" || state === "missing";
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
 * sentence built from the bare labels said "waits on BNB-2, BNB-4 and BNB-11"
 * beside a rail marking two of the three done —
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
 * F39-44: a done entry carries its OWN tag, never a parenthesis after the list,
 * so the tag cannot attach to a neighbour (`JC-2 and JC-3 (done)` would say
 * JC-3 alone is done).
 */
function doneLabel(entry: DependencyRender): string {
  return `${entry.label} (done)`;
}
