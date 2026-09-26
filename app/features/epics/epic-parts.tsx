import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useFetcher } from "react-router";
import {
  EPIC_COLORS,
  EPIC_STATUS_LABEL,
  EPIC_STATUS_VALUES,
  EPIC_TITLE_MAX,
  type EpicColor,
  type EpicStatus,
} from "~/schemas/epic-file.schema";
import type { EpicProgress, EpicSummary } from "~/server/projections/epic-query.server";
import { StageMeter } from "~/features/home/project-cards";
import { useCsrfToken } from "~/ui/csrf-input";
import { DatePicker } from "~/ui/date-picker";
import { Icon } from "~/ui/icon";
import { Pill, type PillKind } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
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

/**
 * The status as a pill. `in_progress` takes the board's "waiting on you" blue
 * rather than the agents' purple: an epic in progress is a plan being worked,
 * not a run. Paused is amber like everything parked on purpose; done is the
 * accepted green; planned and cancelled are quiet.
 */
const EPIC_STATUS_PILL = {
  planned: "neutral",
  in_progress: "info",
  paused: "input",
  done: "done",
  cancelled: "neutral",
} satisfies Record<EpicStatus, PillKind>;

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
export function epicProgressLine(progress: EpicProgress): string {
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

/** The share of an epic's tasks that are done, as a whole percent. */
export function epicDonePercent(progress: EpicProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

/** The epic fields a create or an edit posts. */
interface EpicDraft {
  title: string;
  description: string;
  status: EpicStatus;
  color: EpicColor | "";
  leadUserId: string;
  startDate: string;
  targetDate: string;
}

function draftOf(epic: EpicSummary | null): EpicDraft {
  return {
    title: epic?.title ?? "",
    description: epic?.description ?? "",
    status: epic?.status ?? "planned",
    // A new epic takes the next colour in the sequence unless one is picked.
    color: epic?.color ?? "",
    leadUserId: epic?.leadUserId ?? "",
    startDate: epic?.startDate ?? "",
    targetDate: epic?.targetDate ?? "",
  };
}

/**
 * Create an epic, or edit what one is: its name, its description, its
 * status, its colour, who leads it and when it is meant to start and land.
 * Membership is not here: tasks join and leave from the epic's page, the task
 * page and the board. The server checks everything again (`manage-epics`,
 * the dates' order, the lead's membership) and a refusal keeps the dialog
 * open beside its sentence.
 */
export function EpicDialog({
  epic,
  members,
  onClose,
  onCreated,
}: {
  /** The epic being edited; null to create one. */
  epic: EpicSummary | null;
  members: EpicMemberView[];
  onClose: () => void;
  /** A create's answer, with the new epic's id. */
  onCreated?: (epicId: string) => void;
}) {
  const [draft, setDraft] = useState<EpicDraft>(() => draftOf(epic));
  const [titleTouched, setTitleTouched] = useState(false);
  const fetcher = useFetcher<EpicActionResult>();
  const csrf = useCsrfToken();
  const push = useToast();
  const { ref, close } = useDialog(onClose);
  const titleRef = useRef<HTMLInputElement>(null);
  const busy = fetcher.state !== "idle";
  const doneRef = useRef(false);
  const valid = draft.title.trim().length > 0;
  const titleError = titleTouched && !valid;
  const datesReversed = draft.startDate !== "" && draft.targetDate !== "" && draft.targetDate < draft.startDate;
  const serverError = fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null;
  const set = <K extends keyof EpicDraft>(key: K, value: EpicDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    // Idle, not just answered: the answer lands while the page's loaders are
    // still reloading for it, and a navigation started then can finish with
    // the new epic's URL over the old page (a React Router race, seen live).
    if (fetcher.state !== "idle" || !fetcher.data?.ok || doneRef.current) return;
    doneRef.current = true;
    if (fetcher.data.toast) push(fetcher.data.toast);
    if (!epic && fetcher.data.epicId) onCreated?.(fetcher.data.epicId);
    close();
  }, [fetcher.state, fetcher.data, close, push, epic, onCreated]);

  const submit = () => {
    setTitleTouched(true);
    if (busy || doneRef.current) return;
    if (!valid || datesReversed) {
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

  const onSwatchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = all.findIndex((el) => el === document.activeElement);
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || at < 0) return;
    e.preventDefault();
    const next = all[(at + step + all.length) % all.length];
    next?.focus();
    next?.click();
  };

  return (
    <dialog
      className="modal-card epic-dialog"
      aria-label={epic ? `Edit ${epic.id}` : "New epic"}
      ref={ref}
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
        <div className="field">
          <label className="flabel" htmlFor="epic-description">
            Description
            <span className="fhint">markdown, optional: the outcome the tasks add up to</span>
          </label>
          <textarea
            id="epic-description"
            rows={5}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What is done when this epic is done, and what is out of scope."
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="flabel" htmlFor="epic-status">
              Status
            </label>
            <select
              id="epic-status"
              value={draft.status}
              onChange={(e) => {
                const next = EPIC_STATUS_VALUES.find((s) => s === e.target.value);
                if (next) set("status", next);
              }}
            >
              {EPIC_STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {EPIC_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="flabel" htmlFor="epic-lead">
              Lead
            </label>
            <select id="epic-lead" value={draft.leadUserId} onChange={(e) => set("leadUserId", e.target.value)}>
              <option value="">Nobody</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <span className="flabel">Start date</span>
            <DatePicker
              label="Start date"
              placeholder="Not set"
              value={draft.startDate || null}
              onChange={(v) => set("startDate", v ?? "")}
            />
          </div>
          <div className="field">
            <span className="flabel">Target date</span>
            <DatePicker
              label="Target date"
              placeholder="Not set"
              value={draft.targetDate || null}
              onChange={(v) => set("targetDate", v ?? "")}
            />
          </div>
        </div>
        <div className="field">
          <span className="flabel" id="epic-color-label">
            Colour
            <span className="fhint">{draft.color ? draft.color : "the next in the sequence"}</span>
          </span>
          <div
            className="epic-swatches"
            role="radiogroup"
            aria-labelledby="epic-color-label"
            onKeyDown={onSwatchKey}
          >
            {EPIC_COLORS.map((color, i) => {
              const checked = draft.color === color;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  // One tab stop: the picked swatch, else the first.
                  tabIndex={checked || (draft.color === "" && i === 0) ? 0 : -1}
                  className="swatch"
                  data-stage-color={color}
                  aria-label={color}
                  title={color}
                  onClick={() => set("color", color)}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <span
          id="epic-dialog-hint"
          className={"foot-hint" + (serverError || titleError || datesReversed ? " err" : "")}
          role={serverError || titleError || datesReversed ? "alert" : undefined}
        >
          {titleError
            ? "An epic needs a name."
            : datesReversed
              ? "The target date is before the start date."
              : serverError
                ? serverError
                : epic
                  ? "Changes are recorded on the epic's history."
                  : "The epic id is assigned automatically."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy} aria-busy={busy}>
            <Icon name={epic ? "check" : "plus"} />
            {epic ? "Save" : "Create epic"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
