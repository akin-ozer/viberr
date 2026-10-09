import type { EpicStatus } from "~/schemas/epic-file.schema";
import type { EpicProgress, EpicSummary } from "~/server/projections/epic-query.server";
import type { PillKind } from "~/ui/pill";

// Lives apart from epic-parts.tsx for react-doctor's only-export-components.
// That file still exports the `useEpicActionToast` and `useArchiveEpicTasks`
// hooks, so it is not a Fast Refresh boundary (see use-command-palette.ts).

/**
 * The status as a pill. `in_progress` takes the board's "waiting on you" blue
 * rather than the agents' purple: an epic in progress is a plan being worked,
 * not a run. Paused is amber like everything parked on purpose; done is the
 * accepted green; planned and cancelled are quiet. The epic page's status
 * select draws its dot in the same tone (ruling 325).
 */
export const EPIC_STATUS_PILL = {
  planned: "neutral",
  in_progress: "info",
  paused: "input",
  done: "done",
  cancelled: "neutral",
} satisfies Record<EpicStatus, PillKind>;

/** Ruling 274: how many tasks "Archive tasks" files away: the epic's live
 *  tasks, when it is Done and every one of them is done; otherwise none. */
export function archivableTasks(epic: Pick<EpicSummary, "status" | "progress">): number {
  const { total, done, archivedDone } = epic.progress;
  const live = total - archivedDone;
  return epic.status === "done" && live > 0 && done === total ? live : 0;
}

/** The share of an epic's tasks that are done, as a whole percent. */
export function epicDonePercent(progress: EpicProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}
