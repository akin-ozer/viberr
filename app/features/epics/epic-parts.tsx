import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { useFetcher } from "react-router";
import { EPIC_STATUS_LABEL, EPIC_TITLE_MAX, type EpicStatus } from "~/schemas/epic-file.schema";
import type { EpicProgress, EpicSummary } from "~/server/projections/epic-query.server";
import { StageMeter } from "~/features/home/project-cards";
import { countLabel } from "~/shared/text/plural";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { datesReversed, draftOf, epicDialogHint, refusalOf, type EpicDraft } from "./epic-dialog-derive";
import { EpicDialogFields, EpicDialogFoot } from "./epic-dialog-regions";
import { EPIC_STATUS_PILL } from "./epic-helpers";
import type { EpicMemberView, EpicStageView } from "./epics-query.server";

/**
 * Ruling 503: the pieces both Epics pages draw: an epic's status pill, its
 * progress, and the one dialog that creates an epic or edits what it is.
 */

/** What an epic action answers: a toast, or the refusal, and for a create
 *  the new epic's id so the page can open it. */
export interface EpicActionResult {
  ok: boolean;
  toast?: string;
  error?: string;
  epicId?: string;
}

/** Toasts an epic action's answer once: its sentence, tinted by `ok`, else
 *  the refusal. */
export function useEpicActionToast(fetcher: ReturnType<typeof useFetcher<EpicActionResult>>) {
  const push = useToast();
  useFetcherResult(fetcher, (d) => {
    if (d.toast) push(d.toast, d.ok ? "success" : "error");
    else if (!d.ok && d.error) push(d.error, "error");
  });
}

export function EpicStatusPill({ status, sm }: { status: EpicStatus; sm?: boolean }) {
  return (
    <span className="epic-status" data-epic-status={status}>
      <Pill kind={EPIC_STATUS_PILL[status]} sm={sm} quiet={status === "planned" || status === "cancelled"}>
        {EPIC_STATUS_LABEL[status]}
      </Pill>
    </span>
  );
}

/** "3 of 7 done", with the held and archived counts when there are any. */
function epicProgressLine(progress: EpicProgress): string {
  if (progress.total === 0) {
    return progress.archived > 0 ? `No open tasks · ${progress.archived} archived` : "No tasks yet";
  }
  const parts = [`${progress.done} of ${progress.total} done`];
  if (progress.held > 0) parts.push(`${progress.held} waiting on other work`);
  if (progress.archived > 0) parts.push(`${progress.archived} archived`);
  return parts.join(" · ");
}

/**
 * The epic's progress: the project's own stage colours in its stage order,
 * one band per stage its tasks stand at (the Home project card's meter, so an
 * epic's bar and its project's read the same way), and the count beside it.
 * Archived tasks are left out, as Linear leaves a cancelled issue out of a
 * project's progress.
 */
export function EpicProgressBar({
  progress,
  stages,
}: {
  progress: EpicProgress;
  stages: EpicStageView[];
}) {
  const dist: Record<string, number> = {};
  for (const band of progress.byStage) dist[band.stageId] = band.count;
  // A stage the project no longer has still gets its band (its tasks are
  // counted as started), after the known ones, so the bar never drops them.
  const known = new Set(stages.map((s) => s.id));
  const unknown = progress.byStage
    .filter((b) => !known.has(b.stageId))
    .map((b) => ({ id: b.stageId, name: b.stageId, color: "gray" }));
  return (
    <div className="epic-progress" data-epic-progress>
      <StageMeter stages={[...stages, ...unknown]} dist={dist} />
      <span className="epic-progress-line">{epicProgressLine(progress)}</span>
    </div>
  );
}

/** Ruling 651: the trigger, on an Epics row and in an epic's Tasks head. */
export function ArchiveEpicTasksButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn sm epic-archive-tasks"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      <GlyphSwap rest="archive" alt="loader" on={busy} spinAlt />
      Archive tasks
    </button>
  );
}

/**
 * Ruling 651: "Archive tasks", held by the page rather than its button. The
 * button leaves with the tasks it archived, and a fetcher that unmounted with
 * it would never deliver the answer's toast.
 */
export function useArchiveEpicTasks() {
  const [asking, setAsking] = useState<{ epicId: string; count: number } | null>(null);
  const fetcher = useFetcher<EpicActionResult>();
  useEpicActionToast(fetcher);
  const csrf = useCsrfToken();
  return {
    /** The epic whose tasks are being archived, while they are. */
    busyEpicId: fetcher.state === "idle" ? null : String(fetcher.formData?.get("epicId") ?? ""),
    asking,
    ask: (epicId: string, count: number) => setAsking({ epicId, count }),
    cancel: () => setAsking(null),
    confirm: () => {
      if (!asking) return;
      const fd = new FormData();
      fd.set("_csrf", csrf);
      fd.set("intent", "archive-epic-tasks");
      fd.set("epicId", asking.epicId);
      fetcher.submit(fd, { method: "post" });
    },
  };
}

/** Ruling 651: the one question before a Done epic's tasks are filed away. */
export function ArchiveEpicTasksConfirm({
  epicId,
  count,
  onCancel,
  onConfirm,
}: {
  epicId: string;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const one = count === 1;
  return (
    <ConfirmDialog
      title={one ? `Archive the task in ${epicId}?` : `Archive the ${count} tasks in ${epicId}?`}
      body={
        one
          ? "It is done. It leaves the board and stays in this epic, still counted as done. Restore brings it back."
          : "They are done. They leave the board and stay in this epic, still counted as done. Restore brings any one back."
      }
      confirmLabel={`Archive ${countLabel(count, "task")}`}
      tone="primary"
      icon="archive"
      confirmIcon="archive"
      screenLabel="Archive epic tasks dialog"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * Create an epic, or edit what one is: its name, its description, its
 * status, its colour, who leads it and when it is meant to start and land.
 * Membership is not here: tasks join and leave from the epic's page, the task
 * page and the board. The server checks everything again (`manage-epics`,
 * the dates' order, the lead's membership) and a refusal keeps the dialog
 * open beside its sentence. An edit's answer is the dialog's own: it toasts
 * and closes. A create's is the page's (ruling 689(c)).
 */
export function EpicDialog({
  epic,
  members,
  onClose,
  fetcher: held,
  ref,
}: {
  /** The epic being edited; null to create one. */
  epic: EpicSummary | null;
  members: EpicMemberView[];
  onClose: () => void;
  /** Ruling 689(c): a create's fetcher, held by the page that acts on its
   *  answer, so the new epic's id never goes up through an effect. */
  fetcher?: ReturnType<typeof useFetcher<EpicActionResult>>;
  /** The dialog's animated close, for the page to play once it has acted. */
  ref?: Ref<{ close: () => void }>;
}) {
  const [draft, setDraft] = useState<EpicDraft>(() => draftOf(epic));
  const [titleTouched, setTitleTouched] = useState(false);
  const own = useFetcher<EpicActionResult>();
  const fetcher = held ?? own;
  const csrf = useCsrfToken();
  const push = useToast();
  const { ref: dialogRef, close } = useDialog(onClose);
  useImperativeHandle(ref, () => ({ close }), [close]);
  const titleRef = useRef<HTMLInputElement>(null);
  const busy = fetcher.state !== "idle";
  const valid = draft.title.trim().length > 0;
  const titleError = titleTouched && !valid;
  const reversed = datesReversed(draft);
  const serverError = refusalOf(fetcher.data);
  const set = <K extends keyof EpicDraft>(key: K, value: EpicDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useFetcherResult(own, (d) => {
    if (!d.ok) return;
    if (d.toast) push(d.toast);
    close();
  });

  const submit = () => {
    setTitleTouched(true);
    // Once made or saved, the dialog is closing: a second Enter posts nothing.
    if (busy || fetcher.data?.ok) return;
    if (!valid || reversed) {
      titleRef.current?.focus();
      return;
    }
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", epic ? "update-epic" : "create-epic");
    fd.set("title", draft.title.trim());
    fd.set("description", draft.description);
    fd.set("status", draft.status);
    if (draft.color) fd.set("color", draft.color);
    fd.set("leadUserId", draft.leadUserId);
    fd.set("startDate", draft.startDate);
    fd.set("targetDate", draft.targetDate);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <dialog
      className="modal-card epic-dialog"
      aria-label={epic ? `Edit ${epic.id}` : "New epic"}
      ref={dialogRef}
      data-screen-label={epic ? "Edit epic dialog" : "New epic dialog"}
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="epic" />
        </span>
        <div className="mh-main">
          <h2>{epic ? `Edit ${epic.id}` : "New epic"}</h2>
          <div className="mh-sub">
            {epic
              ? "What the epic is. Its tasks join and leave on its page."
              : "A body of work in this project. Tasks join it and leave it one at a time, and its progress is counted from them."}
          </div>
        </div>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        <div className="field">
          <label className="flabel" htmlFor="epic-title">
            Name<span className="req">*</span>
          </label>
          <input
            id="epic-title"
            ref={titleRef}
            type="text"
            value={draft.title}
            maxLength={EPIC_TITLE_MAX}
            onChange={(e) => set("title", e.target.value)}
            onBlur={(e) => {
              if (e.target.value.trim() !== "") setTitleTouched(true);
            }}
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? "epic-dialog-hint" : undefined}
            placeholder="e.g. Checkout revamp"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <EpicDialogFields draft={draft} set={set} members={members} />
      </div>
      <EpicDialogFoot
        hint={epicDialogHint({ titleError, reversed, serverError, editing: epic !== null })}
        alert={Boolean(serverError || titleError || reversed)}
        editing={epic !== null}
        busy={busy}
        onCancel={close}
        onSubmit={submit}
      />
    </dialog>
  );
}
