/**
 * What a task file says about other work, in the spellings the task schema
 * validates: the tasks its `blockedBy` waits on (ruling 55) and the epic its
 * `epic` field puts it in (ruling 272). Client-safe, and it imports nothing.
 *
 * Keep it that way. `task-file.schema.ts` is in the closed controller dock's
 * static closure (`sse-event.schema.ts` takes its `READINESS_VALUES`), which
 * root ships to every page and ruling 11 (FL-1) budgets by module count, so
 * whatever the schema imports, every page loads. Taking these spellings from
 * their vocabularies' homes put those homes on every page too:
 * `shared/dependencies.ts` with its hold sentences, and the epic file's zod
 * schema with the twenty stage colour presets. So the spellings live here, and
 * both homes re-export them.
 *
 * The epic statuses come with the epic id: the board's epic filter and the
 * task page's Epic menu show a named epic's status, and they import it from
 * here so that neither page loads the epic file schema.
 */

// ------------------------------------------------------ blockedBy (ruling 55)

/** One `blockedBy` entry, parsed: a task in the same project. The spelling is
 *  documented with the rest of the vocabulary in `shared/dependencies.ts`. */
export type DependencyRef = { kind: "task"; task: string };

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

// ----------------------------------------------------------- epic (ruling 272)

/** An epic's status, a person's call (what each one means is in
 *  `schemas/epic-file.schema.ts`). */
export const EPIC_STATUS_VALUES = [
  "planned",
  "in_progress",
  "paused",
  "done",
  "cancelled",
] as const;
export type EpicStatus = (typeof EPIC_STATUS_VALUES)[number];

/** How each status reads to a person, in the order a menu offers them. */
export const EPIC_STATUS_LABEL = {
  planned: "Planned",
  in_progress: "In progress",
  paused: "Paused",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<EpicStatus, string>;

/** Open epics are the ones work still lands in; the closed two are history. */
export function isEpicOpen(status: EpicStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

/** `epic-<n>`: minted by the epic writer from a directory scan. */
export const EPIC_ID_RE = /^epic-(\d+)$/;

export function isEpicId(value: string): boolean {
  return EPIC_ID_RE.test(value);
}

/** The number in an epic id, or null for a string that is not one. */
export function epicNumber(id: string): number | null {
  const m = EPIC_ID_RE.exec(id);
  return m ? Number(m[1]) : null;
}
