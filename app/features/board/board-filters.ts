/**
 * Pure board filter/search predicates (board spec §3.3, contracts §2.3).
 * Canonical readiness enum values here — the mock's short values live only
 * in pill CSS via app/ui/pill.tsx.
 */

export type BoardFilterId =
  | "all"
  | "human"
  | "agent"
  | "risk"
  | "quiet"
  | "archived";

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
  /** Gap-10: nothing has been recorded on this task past its threshold and no
   *  run is in flight. Server-derived (`isQuiet`, task-activity.server.ts) — the
   *  board must not re-derive a time-dependent verdict client-side, or the SSR
   *  pass and hydration would disagree about which cards the chip selects. */
  quiet?: boolean;
}

/** "Blocked or waiting" = work that CANNOT PROCEED: readiness blocked /
 * input_required / risk-detected, failing validation, urgent, or a rejected PR.
 * The "Waiting on me" filter is member-scoped (R8-3): a decision the viewer can
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
  // Gap-10. Deliberately its OWN chip rather than a new clause inside "Blocked
  // or waiting": that filter selects work the system KNOWS cannot proceed
  // (blocked, input required, failing validation, a rejected PR) — every member
  // is a state something asserted. Going quiet is an INFERENCE from an absence,
  // and folding it in would have made the one filter people trust for real
  // failures start returning guesses. R16-2's rule — name the chip for what it
  // selects — applies to both.
  if (filter === "quiet") return task.quiet === true;
  if (filter === "risk") {
    return (
      task.readiness === "inconsistency_risk_detected" ||
      task.readiness === "blocked" ||
      // R16-2 (live, pass 16): the board rendered an amber "input required" chip
      // on a card and then matched 0 of 4 tasks under its own attention filter —
      // a task holding for a human answer is the plainest case of work that
      // cannot proceed, and it was the one state the predicate omitted. The chip
      // is named "Blocked or waiting" for the same reason: the filter is about
      // work that is STUCK, not about danger.
      task.readiness === "input_required" ||
      task.validation === "failing" ||
      task.urgent ||
      // P14-WL-03: a PR closed without merging is a DIVERGENCE the review queue
      // files under "Decision required" — the work was declined and the task
      // needs a rework/reopen/archive call from a human. It carries none of the
      // signals above (readiness stays `in_review`, validation stays healthy,
      // urgent is off), so the board's own attention filter hid the single class
      // of task that most needs a person.
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
  specialist: { name: string; role: string; profileId: string } | null;
  reviewers: { name: string; role: string; profileId: string }[];
  operator: { name: string } | null;
}

/**
 * BOARD filter (R15-5: "Filter this board…", not a global search — the ⌘K
 * palette answers that): case-insensitive substring over key, title, branch and
 * the identities on the card.
 *
 * F15-16: an agent's own NAME never matched. `AgentRender.name` is the BACKEND
 * label ("Codex" / "Claude Code") — the profile's name is not projected onto a
 * task summary at all — so typing "reviewer" or "docs writer" hit nothing while
 * the placeholder promised agents. The profile ID is the identity the board
 * does carry, so it joins the haystack, hyphen-normalized on both sides:
 * "docs writer" matches the `docs-writer` deployment.
 */
export function matchesSearch(task: SearchableTask, query: string): boolean {
  const q = normalizeIdentity(query);
  if (!q) return true;
  const haystack = normalizeIdentity(
    [
      task.key,
      task.title,
      task.branch ?? "",
      task.owner?.name ?? "",
      task.specialist
        ? `${task.specialist.name} ${task.specialist.role} ${task.specialist.profileId}`
        : "",
      ...task.reviewers.map((c) => `${c.name} ${c.role} ${c.profileId}`),
      task.operator?.name ?? "",
    ].join(" "),
  );
  return haystack.includes(q);
}

/** Lowercase and treat `-`/`_` as spaces, so a profile id reads as its name. */
function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}

export function isBoardFilterId(value: string | null): value is BoardFilterId {
  return (
    value === "all" ||
    value === "human" ||
    value === "agent" ||
    value === "risk" ||
    value === "quiet" ||
    value === "archived"
  );
}

/** Branch chip truncation — exact mock rule (>16 chars → 15 + "…"). */
export function shortBranch(branch: string): string {
  return branch.length > 16 ? branch.slice(0, 15) + "…" : branch;
}

/**
 * P13-D-34 (UX-4): every column printed the bare string "No tasks" for a
 * filter+search result, so a board hiding 12 tasks behind an active filter
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
  boardTotal,
  isEntryColumn = false,
}: {
  /** Tasks in this column (or list) BEFORE the filter and search ran. */
  total: number;
  /** Label of the active filter, or null when it is "all". */
  filterLabel: string | null;
  query: string;
  /** LIVE (non-archived) tasks on the whole board, before filtering — R15-10.
   *  Live, not total: an archived task is hidden under every filter except
   *  "Archived" (see matchesBoardFilter), so a board whose only task is
   *  archived looks — and for this purpose IS — empty. Counting it made the one
   *  board that most needed the teaching line the one board that never got it.
   *  Omitted → treated as a board that has tasks, i.e. the pre-R15-10 bare
   *  behavior. */
  boardTotal?: number;
  /** True for the entry (first) stage column — the only one allowed to teach. */
  isEntryColumn?: boolean;
}): string {
  // R15-10: a brand-new project showed five columns each saying "No tasks" —
  // the one empty state in the app that did not teach, and the first thing a
  // new user sees. P13-D-34's point stands (do not repeat an explanation five
  // times beside real work), so the teaching line is scoped to the case where
  // there is nothing to repeat beside: the whole board is empty, and only the
  // entry column speaks. The moment ANY task exists, every column is bare again.
  // Keyed on `boardTotal`, NOT on this column's `total`: `total` counts archived
  // tasks, which are invisible here, so an archived-only entry column reads as
  // non-empty and would silently skip the teaching line. A filter or search that
  // is actively hiding something still wins — that message is more informative.
  if (boardTotal === 0 && isEntryColumn && !filterLabel && !query.trim()) {
    return "No tasks yet — create one to start the flow";
  }
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
