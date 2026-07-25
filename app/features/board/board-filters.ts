/**
 * Pure board filter/search predicates (board spec §3.3, contracts §2.3).
 * Canonical readiness enum values here — the mock's short values live only
 * in pill CSS via app/ui/pill.tsx.
 */

export type BoardFilterId = "all" | "human" | "agent" | "risk" | "archived";

export interface FilterableTask {
  waiting: string;
  /** R8-3: loader-annotated "an open decision here needs THIS viewer's action". */
  waitingOnMe?: boolean;
  readiness: string;
  validation: string;
  urgent: boolean;
  /** WL-03: the review PR's cached state. `closed` = closed WITHOUT merging —
   *  the work was rejected and only a human can decide what happens next. */
  pr?: { state: string } | null;
  /** R14-3: archived tasks are a terminal disposition, not a stage — they leave
   *  every default view and are reachable only through the Archived filter. */
  archived?: boolean;
}

/** Verbatim mock semantics with canonical enum values ("Needs attention" =
 * readiness risk/blocked || validation failing || urgent || a rejected PR). The
 * "Waiting on me" filter is member-scoped (R8-3): a decision the viewer can
 * actually act on, not the project-wide `waiting === "human"` enum.
 *
 * P14-R14-3: archived tasks are excluded from EVERY filter but `archived`, so
 * abandoned work stops occupying the board while its timeline stays intact.
 */
export function matchesBoardFilter(
  task: FilterableTask,
  filter: BoardFilterId,
): boolean {
  if (filter === "archived") return task.archived === true;
  if (task.archived === true) return false;
  if (filter === "human") return task.waitingOnMe === true;
  if (filter === "agent") return task.waiting === "agent";
  if (filter === "risk") {
    return (
      task.readiness === "inconsistency_risk_detected" ||
      task.readiness === "blocked" ||
      task.validation === "failing" ||
      task.urgent ||
      // P14-WL-03: a PR closed without merging is a DIVERGENCE the review queue
      // files under "Decision required" — the work was declined and the task
      // needs a rework/reopen/archive call from a human. It carries none of the
      // four signals above (readiness stays `in_review`, validation stays
      // healthy, urgent is off), so the board's own "Needs attention" filter
      // hid the single class of task that most needs a person.
      task.pr?.state === "closed"
    );
  }
  return true;
}

/** R14-3 archived predicate. Typed on `FilterableTask` so board code can ask it
 *  of a task summary while the flag is loader-annotated (the same shape
 *  `waitingOnMe` already has). */
export function isArchived(task: FilterableTask): boolean {
  return task.archived === true;
}

/** Archived tasks hidden from the current (non-archived) view — the count the
 *  board discloses next to the Archived chip, so the disposition is never a
 *  silent disappearance. */
export function countArchived(tasks: readonly FilterableTask[]): number {
  return tasks.filter(isArchived).length;
}

export interface SearchableTask {
  key: string;
  title: string;
  branch: string | null;
  owner: { name: string } | null;
  specialist: { name: string; role: string } | null;
  reviewers: { name: string; role: string }[];
  operator: { name: string } | null;
}

/** Topbar search: case-insensitive substring over key, title, branch and
 * agent/owner identities ("Search tasks, branches, agents…"). */
export function matchesSearch(task: SearchableTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    task.key,
    task.title,
    task.branch ?? "",
    task.owner?.name ?? "",
    task.specialist ? `${task.specialist.name} ${task.specialist.role}` : "",
    ...task.reviewers.map((c) => `${c.name} ${c.role}`),
    task.operator?.name ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function isBoardFilterId(value: string | null): value is BoardFilterId {
  return (
    value === "all" ||
    value === "human" ||
    value === "agent" ||
    value === "risk" ||
    value === "archived"
  );
}

/** Branch chip truncation — exact mock rule (>16 chars → 15 + "…"). */
export function shortBranch(branch: string): string {
  return branch.length > 16 ? branch.slice(0, 15) + "…" : branch;
}

/**
 * P13-D-34 (UX-4): every column printed the bare string "No tasks" for a
 * filter+search result, so a board hiding 12 tasks behind "Needs attention"
 * read as an empty project. The UX spec asks an empty state to say what is
 * absent, why, and what to do next (ux-design-specification.md:846-847) — the
 * same three-way shape pass 13 shipped on the home grid (UI-21) and the task
 * timeline (UI-40). The clear affordance is the single `Clear` chip in the
 * filter bar (one per board, not one per empty column).
 */
export function boardEmptyCopy({
  total,
  filterLabel,
  query,
}: {
  /** Tasks in this column (or list) BEFORE the filter and search ran. */
  total: number;
  /** Label of the active filter, or null when it is "all". */
  filterLabel: string | null;
  query: string;
}): string {
  if (total === 0) return "No tasks";
  const subject = total === 1 ? "The 1 task here is" : `All ${total} tasks here are`;
  const q = query.trim();
  if (filterLabel && q) {
    return `${subject} hidden by the “${filterLabel}” filter and the search “${q}”.`;
  }
  if (filterLabel) return `${subject} hidden by the “${filterLabel}” filter.`;
  if (q) return `${subject} hidden by the search “${q}”.`;
  // Filter and search both off yet nothing is visible — unreachable, but the
  // honest fallback beats claiming a filter that is not on.
  return "No tasks";
}
