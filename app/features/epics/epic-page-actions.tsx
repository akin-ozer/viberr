import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { EPIC_STATUS_VALUES, type EpicStatus } from "~/schemas/epic-file.schema";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { useEpicActionToast, type EpicActionResult } from "./epic-parts";
import type { EpicPageView, EpicStageView, EpicTaskView } from "./epics-query.server";

/**
 * The epic page's posts (ruling 13(b), the large-component split of
 * `epic-page.tsx`), each with its fetcher, toast, local state and confirm: the
 * status the head's select sets, and a task row's Remove, Archive and
 * Restore. The page calls them in the order its fetchers always registered
 * (the status, the rows, then "Archive tasks"), so each fetcher keeps its key,
 * and places the confirm where it always stood. No component lives here (the
 * confirm is an element the page places), so the module is not a Fast Refresh
 * boundary.
 */

/** A row's request: what it does to the task. */
type EpicRowIntent = "remove-task" | "archive-task" | "restore-task";

/** The head's status: what it shows (the status in flight, else the epic's),
 *  whether it is posting, and `setStatus`, which posts update-epic with the
 *  status alone and nothing for the status the epic already has. */
export function useEpicStatus(epic: EpicPageView["epic"]) {
  const statusFetcher = useFetcher<EpicActionResult>();
  useEpicActionToast(statusFetcher);
  const csrf = useCsrfToken();
  const statusBusy = statusFetcher.state !== "idle";
  const pendingStatus = statusBusy ? String(statusFetcher.formData?.get("status") ?? "") : null;
  const shownStatus: EpicStatus = EPIC_STATUS_VALUES.find((s) => s === pendingStatus) ?? epic.status;
  const setStatus = (status: EpicStatus) => {
    if (status === epic.status) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "update-epic");
    fd.set("status", status);
    statusFetcher.submit(fd, { method: "post" });
  };
  return { shown: shownStatus, busy: statusBusy, setStatus };
}

/**
 * Ruling 325: a row's Remove, Archive and Restore are the page's requests,
 * not the row's. Each one moves its row (out of the list, into the fold or
 * back), and a fetcher unmounted with the row never delivered its toast.
 * `pending` names the request in flight and its task, `locked` holds every
 * row while one is; `confirm` is the question an open task's Archive asks
 * first, for the page to place.
 */
export function useEpicTaskRows(stages: EpicStageView[]) {
  const rowFetcher = useFetcher<EpicActionResult>();
  useEpicActionToast(rowFetcher);
  const [archivingOpen, setArchivingOpen] = useState<EpicTaskView | null>(null);
  const csrf = useCsrfToken();
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const rowBusy = rowFetcher.state !== "idle";
  const rowPending = rowBusy
    ? {
        taskKey: String(rowFetcher.formData?.get("taskKey") ?? ""),
        intent: String(rowFetcher.formData?.get("intent") ?? ""),
      }
    : null;
  const rowAct = (intent: EpicRowIntent, taskKey: string) => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", intent);
    fd.set("taskKey", taskKey);
    rowFetcher.submit(fd, { method: "post" });
  };
  // A done task's archive is one click, undone by its Restore; an open one's
  // withdraws its decision and ends its runs, so it asks first.
  const archiveRow = (task: EpicTaskView) => {
    if (isTerminalStage(task.stageId, stages)) rowAct("archive-task", task.key);
    else setArchivingOpen(task);
  };
  const confirm = archivingOpen && (
    <ConfirmDialog
      title={`Archive ${archivingOpen.key}?`}
      body={`It is still open, at ${stageById.get(archivingOpen.stageId)?.name ?? archivingOpen.stageId}. Archiving takes it off the board: an open decision and pending recommendations are withdrawn, and a live run ends. Its record is kept, and Restore hands it back to a person.`}
      confirmLabel={`Archive ${archivingOpen.key}`}
      icon="archive"
      confirmIcon="archive"
      screenLabel="Archive task dialog"
      onCancel={() => setArchivingOpen(null)}
      onConfirm={() => rowAct("archive-task", archivingOpen.key)}
    />
  );
  return { stageById, pending: rowPending, locked: rowBusy, rowAct, archiveRow, confirm };
}

/** What the rows read from the page's row requests. */
export type EpicTaskRows = ReturnType<typeof useEpicTaskRows>;
