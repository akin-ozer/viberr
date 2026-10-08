import { useRef, useState } from "react";
import { useFetcher } from "react-router";
import { countLabel } from "~/shared/text/plural";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useEpicStatus, useEpicTaskRows } from "./epic-page-actions";
import { EpicAbout, EpicDetails, EpicHead, EpicHistoryPanel, EpicTasks } from "./epic-page-regions";
import { ArchiveEpicTasksConfirm, EpicDialog, useArchiveEpicTasks, type EpicActionResult } from "./epic-parts";
import { archivableTasks } from "./epic-helpers";
import type { EpicPageView } from "./epics-query.server";

/**
 * Ruling 503: one epic, the way Jira opens an epic and Linear a project: what
 * it is for, its tasks with where each stands and what each waits on, its
 * progress, and its history. The tasks are the epic's: a person adds an
 * existing task, makes a new one in it, or takes one out, and each move lands
 * on the task's own timeline and on this history (`setTasksEpic`). Someone
 * who may archive a task archives one from its row and restores one from the
 * fold, and a Done epic's finished tasks all at once (ruling 651).
 *
 * Nothing here starts, orders or holds a task: what a task waits on is its own
 * `blockedBy` (ruling 131), shown as a count beside it. The epic's status is a
 * person's call; when every task is done the history says so and the lead is
 * told, and closing it stays theirs.
 *
 * Ruling 696(e): the page holds its state, its requests (`epic-page-actions.tsx`)
 * and its dialogs; its regions are drawn in `epic-page-regions.tsx`.
 */

export function EpicPage({
  view,
  projectSlug,
  canManage,
  canEditTasks,
  canCreateTask,
  canArchive,
}: {
  view: EpicPageView;
  projectSlug: string;
  /** `manage-epics`: edit what the epic is. */
  canManage: boolean;
  /** `edit-task-meta`: put tasks in the epic and take them out. */
  canEditTasks: boolean;
  /** `create-task`: make a new task in the epic. */
  canCreateTask: boolean;
  /** `approve-transition`: archive a task and restore one (ruling 651). */
  canArchive: boolean;
}) {
  const { epic, stages } = view;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const status = useEpicStatus(epic);
  const rows = useEpicTaskRows(stages);
  const archiveAll = useArchiveEpicTasks();
  const archivable = canArchive ? archivableTasks(epic) : 0;

  return (
    <div className="board-wrap" data-screen-label="Epic">
      {/* Ruling 615: the head scrolls with the page, inside the one scroller,
          so it ends where the panels end whether or not a scrollbar takes
          room beside them. The status is said once in it: the select, for
          someone who may change it, stands where everyone else reads the
          pill. */}
      <div className="policy-wrap">
        <EpicHead
          epic={epic}
          projectSlug={projectSlug}
          canManage={canManage}
          status={status}
          onEdit={() => setEditing(true)}
        />

        <div className="epic-layout">
          <div className="epic-main">
            <EpicAbout
              epic={epic}
              taskLinks={view.taskLinks}
              canManage={canManage}
              onEdit={() => setEditing(true)}
            />
            <EpicTasks
              epic={epic}
              stages={stages}
              tasks={view.tasks}
              projectSlug={projectSlug}
              canEditTasks={canEditTasks}
              canCreateTask={canCreateTask}
              canArchive={canArchive}
              rows={rows}
              archivable={archivable}
              archivingAll={archiveAll.busyEpicId === epic.id}
              onArchiveAll={() => archiveAll.ask(epic.id, archivable)}
              onAdd={() => setAdding(true)}
              onCreate={() => setCreatingTask(true)}
            />
            <EpicHistoryPanel
              entries={epic.history}
              taskLinks={view.taskLinks}
              showAll={showAllHistory}
              onToggle={() => setShowAllHistory((all) => !all)}
            />
          </div>

          <EpicDetails epic={epic} shownStatus={status.shown} plannedIn={view.plannedIn} />
        </div>
      </div>

      {editing && <EpicDialog epic={epic} members={view.members} onClose={() => setEditing(false)} />}
      {archiveAll.asking && (
        <ArchiveEpicTasksConfirm {...archiveAll.asking} onCancel={archiveAll.cancel} onConfirm={archiveAll.confirm} />
      )}
      {rows.confirm}
      {adding && (
        <AddTasksDialog
          epicId={epic.id}
          candidates={view.candidates}
          otherEpics={view.otherEpics}
          onClose={() => setAdding(false)}
        />
      )}
      {creatingTask && (
        <NewTaskInEpicDialog
          epicId={epic.id}
          epicTitle={epic.title}
          entryStageName={stages[0]?.name ?? "the first stage"}
          onClose={() => setCreatingTask(false)}
        />
      )}
    </div>
  );
}

/**
 * Put existing tasks in the epic, several at once. Every live task not
 * already in it is offered; one in another epic says which, and joining this
 * one moves it (a task is in at most one epic).
 */
function AddTasksDialog({
  epicId,
  candidates,
  otherEpics,
  onClose,
}: {
  epicId: string;
  candidates: EpicPageView["candidates"];
  otherEpics: EpicPageView["otherEpics"];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const fetcher = useFetcher<EpicActionResult>();
  const csrf = useCsrfToken();
  const push = useToast();
  const { ref, close } = useDialog(onClose);
  const doneRef = useRef(false);
  const busy = fetcher.state !== "idle";
  const titleOf = new Map(otherEpics.map((e) => [e.id, e.title]));
  const q = query.trim().toLowerCase();
  const shown = candidates.filter(
    (c) => !q || c.key.toLowerCase().includes(q) || c.title.toLowerCase().includes(q),
  );
  const pickedKeys = new Set(picked);
  const moving = picked.filter((key) => candidates.find((c) => c.key === key)?.epicId);
  useFetcherResult(fetcher, (d) => {
    if (!d.ok) {
      if (d.error) push(d.error, "error");
      return;
    }
    if (doneRef.current) return;
    doneRef.current = true;
    if (d.toast) push(d.toast);
    close();
  });
  const toggle = (key: string) =>
    setPicked((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  const submit = () => {
    if (busy || picked.length === 0 || doneRef.current) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "add-tasks");
    fd.set("taskKeys", picked.join(","));
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <dialog
      className="modal-card epic-add-dialog"
      aria-label={`Add tasks to ${epicId}`}
      ref={ref}
      data-screen-label="Add tasks dialog"
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="epic" />
        </span>
        <div className="mh-main">
          <h2>Add tasks to {epicId}</h2>
          <div className="mh-sub">Pick the tasks that belong to this body of work.</div>
        </div>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        <label className="board-filter-input epic-add-filter">
          <Icon name="filter" />
          <input
            type="search"
            value={query}
            placeholder="Filter by key or title…"
            aria-label="Filter tasks"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {candidates.length === 0 ? (
          <p className="empty sm">Every live task in this project is already in this epic.</p>
        ) : shown.length === 0 ? (
          <p className="empty sm">No task matches “{query}”.</p>
        ) : (
          <ul className="epic-add-list" aria-label="Tasks">
            {shown.map((c) => (
              <li key={c.key}>
                <label className="epic-add-row">
                  <input type="checkbox" checked={pickedKeys.has(c.key)} onChange={() => toggle(c.key)} />
                  <span className="epic-task-key">{c.key}</span>
                  <span className="epic-task-title">{c.title}</span>
                  {c.epicId && (
                    <span className="fine dim epic-add-in">
                      in {c.epicId}
                      {titleOf.get(c.epicId) ? ` (${titleOf.get(c.epicId)})` : ""}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal-foot">
        <span className="foot-hint" role="status">
          {picked.length === 0
            ? "A task is in at most one epic."
            : `${countLabel(picked.length, "task")} picked` +
              (moving.length > 0 ? `; ${moving.join(", ")} will move here from ${moving.length === 1 ? "its" : "their"} epic.` : ".")}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy || picked.length === 0}
            aria-busy={busy}
          >
            <Icon name="plus" />
            {picked.length > 1 ? `Add ${picked.length} tasks` : "Add task"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Make a new task in the epic. It starts at the entry stage, like every new
 *  task (R19-14), and is in this epic from its first line. */
function NewTaskInEpicDialog({
  epicId,
  epicTitle,
  entryStageName,
  onClose,
}: {
  epicId: string;
  epicTitle: string;
  entryStageName: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [touched, setTouched] = useState(false);
  const fetcher = useFetcher<EpicActionResult>();
  const csrf = useCsrfToken();
  const push = useToast();
  const { ref, close } = useDialog(onClose);
  const doneRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const busy = fetcher.state !== "idle";
  const valid = title.trim().length >= 3;
  const titleError = touched && !valid;
  const serverError = fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null;
  useFetcherResult(fetcher, (d) => {
    if (!d.ok || doneRef.current) return;
    doneRef.current = true;
    if (d.toast) push(d.toast);
    close();
  });
  const submit = () => {
    setTouched(true);
    if (busy || doneRef.current) return;
    if (!valid) {
      titleRef.current?.focus();
      return;
    }
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-task");
    fd.set("title", title.trim());
    fd.set("goal", goal.trim());
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <dialog
      className="modal-card modal-narrow"
      aria-label={`New task in ${epicId}`}
      ref={ref}
      data-screen-label="New task in epic dialog"
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="plus" />
        </span>
        <div className="mh-main">
          <h2>New task in {epicId}</h2>
          <div className="mh-sub">
            In {epicTitle}. It starts in {entryStageName}, where its goal is refined before work begins.
          </div>
        </div>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        <div className="field">
          <label className="flabel" htmlFor="epic-task-title">
            Title<span className="req">*</span>
            <span className="fhint">at least 3 characters</span>
          </label>
          <input
            id="epic-task-title"
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={(e) => {
              if (e.target.value.trim() !== "") setTouched(true);
            }}
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? "epic-task-hint" : undefined}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="epic-task-goal">
            Goal
            <span className="fhint">what counts as done, for the operator and the agents</span>
          </label>
          <textarea id="epic-task-goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
      </div>
      <div className="modal-foot">
        <span
          id="epic-task-hint"
          className={"foot-hint" + (serverError || titleError ? " err" : "")}
          role={serverError || titleError ? "alert" : undefined}
        >
          {titleError
            ? "A title needs at least 3 characters."
            : (serverError ?? "The task key is assigned automatically.")}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy} aria-busy={busy}>
            <Icon name="plus" />
            Create task
          </button>
        </div>
      </div>
    </dialog>
  );
}
