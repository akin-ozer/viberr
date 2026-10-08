import type { EpicOption } from "~/ui/epic-chip";
import type { IconName } from "~/ui/icon";
import {
  boardEmptyCopy,
  EPIC_FILTER_NONE,
  isBoardFilterId,
  matchesBoardFilter,
  matchesEpicFilter,
  matchesLabelFilter,
  matchesSearch,
  type BoardFilterId,
} from "./board-filters";
import type { BoardColumnData, BoardTask } from "./board-page";

/**
 * What the board page reads off its props and its URL before it draws (ruling
 * 700(e), the task-page recipe rolled out to `board-page.tsx`): the view the
 * URL asks for, which tasks that view shows, the label vocabulary, the empty
 * copy, whether the filter bar stands, and where a new task starts. Pure
 * functions of the loader data and the search params, no React.
 */

export const FILTERS: { id: BoardFilterId; label: string; icon: IconName }[] = [
  { id: "all", label: "All tasks", icon: "board" },
  { id: "human", label: "Waiting on me", icon: "hand" },
  { id: "agent", label: "Agent working", icon: "cpu" },
  // R16-2: "Needs attention" read as a danger filter and matched only alarming
  // states; the owner ruling renames it to what it selects — work that cannot
  // proceed (blocked, waiting on an answer, failing validation, urgent, or a
  // rejected PR). See matchesBoardFilter.
  { id: "risk", label: "Blocked or waiting", icon: "alert" },
  // Gap-10: the board is a triage console whose job is to say what needs a
  // human, and a task that stopped producing events looked exactly like one
  // being worked — right down to the pulsing "agent working" dot. This chip is
  // the way to ask for them. Named for what it selects (R16-2), and named
  // "quiet" rather than "stalled" because the detector observes an absence of
  // events; it does not diagnose a fault.
  { id: "quiet", label: "No activity", icon: "clock" },
  // D4: the UX spec names "degraded continuity" a default filter, so a supervisor
  // scanning the board can find the tasks whose provider session was lost — the
  // Murat journey the spec tests begins "a continuity warning appears on the task
  // OR board". Named for what it selects (R16-2). Like the Archived chip it only
  // renders when the project has any such task (or the filter is active), because
  // degraded continuity is rare and an always-empty chip on every board is the
  // clutter the board's density rules fight (see FilterBar).
  { id: "continuity", label: "Degraded continuity", icon: "refresh" },
  // R14-3: archived tasks are out of every other view; this is the way back to
  // them. The chip only renders when the project has any (see FilterBar).
  { id: "archived", label: "Archived", icon: "archive" },
];

/** The board's view as the URL carries it: filter, layout and search live in
 *  URL params, so they survive a refresh and a shared link. */
export interface BoardView {
  filter: BoardFilterId;
  group: "stage" | "list";
  query: string;
  /** F26-12 / R26-2: the active label filter (`?label=`), or null when off. */
  labelFilter: string | null;
  /** Ruling 503: the active epic filter (`?epic=`), or null when off. */
  epicFilter: string | null;
}

export function readBoardView(searchParams: URLSearchParams): BoardView {
  const rawFilter = searchParams.get("filter");
  return {
    filter: isBoardFilterId(rawFilter) ? rawFilter : "all",
    group: searchParams.get("view") === "list" ? "list" : "stage",
    query: searchParams.get("q") ?? "",
    labelFilter: searchParams.get("label"),
    epicFilter: searchParams.get("epic"),
  };
}

/** The tasks of `tasks` the view shows: the readiness chip, the label, the
 *  epic and the search, all four at once. */
export function visibleIn(view: BoardView): (tasks: BoardTask[]) => BoardTask[] {
  return (tasks) =>
    tasks.filter(
      (t) =>
        matchesBoardFilter(t, view.filter) &&
        matchesLabelFilter(t, view.labelFilter) &&
        matchesEpicFilter(t, view.epicFilter) &&
        matchesSearch(t, view.query),
    );
}

/** The task the board holds under `key`, or null: no key asked for, or the
 *  payload no longer carries it. */
export function findTask(tasks: readonly BoardTask[], key: string | undefined): BoardTask | null {
  return key === undefined ? null : (tasks.find((t) => t.key === key) ?? null);
}

/** A stage's name on this board, or its id when no column carries it. */
export function stageNameIn(columns: readonly BoardColumnData[], stageId: string): string {
  return columns.find((c) => c.stage.id === stageId)?.stage.name ?? stageId;
}

/**
 * Distinct labels already used on this board, sorted, as New-task autocomplete
 * — so a project's label vocabulary stays consistent instead of every task
 * inventing its own spelling of the same tag.
 *
 * F26-15: mirror the server's `listProjectLabels` contract EXACTLY — exclude
 * archived tasks (`allTasks` carries them; they are hidden only per-filter) and
 * dedupe case-insensitively, first spelling wins — so the New-task modal and the
 * task Details panel (which reads `listProjectLabels`) offer the SAME vocabulary
 * rather than two subtly different lists.
 */
export function labelVocabulary(allTasks: readonly BoardTask[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of allTasks) {
    if (t.archived) continue;
    for (const l of t.labels) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** P13-D-34: what is hiding cards, for the empty copy to name — the readiness
 *  chip and (ruling 503) the epic filter, or null when neither is on. */
function filterLabelOf(view: BoardView, epics: readonly EpicOption[]): string | null {
  const readinessFilterLabel =
    view.filter === "all" ? null : (FILTERS.find((f) => f.id === view.filter)?.label ?? null);
  // Ruling 503: an epic filter hides cards too, so the empty copy names it.
  const epicFilterLabel = !view.epicFilter
    ? null
    : view.epicFilter === EPIC_FILTER_NONE
      ? "No epic"
      : `Epic: ${epics.find((e) => e.id === view.epicFilter)?.title ?? view.epicFilter}`;
  return [readinessFilterLabel, epicFilterLabel].filter((l) => l !== null).join(" · ") || null;
}

/**
 * P13-D-34: a column's empty copy, given that column's UNFILTERED total. R15-10:
 * `boardTotal` lets the copy tell "this column is empty" apart from "this
 * project has nothing yet"; only the latter teaches, and only once.
 */
export function emptyCopyIn(
  view: BoardView,
  epics: readonly EpicOption[],
  boardTotal: number,
): (total: number, isEntryColumn?: boolean) => string {
  const filterLabel = filterLabelOf(view, epics);
  return (total, isEntryColumn = false) =>
    boardEmptyCopy({ total, filterLabel, query: view.query, boardTotal, isEntryColumn });
}

/** A brand-new board has nothing to filter or search — the machinery renders
 *  once there is anything for it to act on (the Archived chip is the only road
 *  back, so any archived count keeps the bar). */
export function showsFilterBar(view: BoardView, taskCount: number, archivedCount: number): boolean {
  return (
    taskCount > 0 ||
    archivedCount > 0 ||
    view.filter !== "all" ||
    view.query !== "" ||
    view.labelFilter != null ||
    view.epicFilter != null
  );
}

/** Pass 30: a board with no live task and nothing filtering it — the virgin
 *  board whose entry lane teaches with a call to action. */
export function isVirginBoard(view: BoardView, liveCount: number): boolean {
  return (
    liveCount === 0 &&
    view.filter === "all" &&
    view.query === "" &&
    view.labelFilter == null &&
    view.epicFilter == null
  );
}

/** Ruling 503: the epic a new task starts in — the one the board is filtered
 *  to, while that epic is open. */
export function newTaskEpic(
  epicFilter: string | null,
  openEpics: readonly EpicOption[],
): string | null {
  return epicFilter && epicFilter !== EPIC_FILTER_NONE && openEpics.some((e) => e.id === epicFilter)
    ? epicFilter
    : null;
}
