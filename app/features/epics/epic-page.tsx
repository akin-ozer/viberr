import { useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  EPIC_STATUS_LABEL,
  EPIC_STATUS_VALUES,
  isEpicOpen,
  type EpicStatus,
} from "~/schemas/epic-file.schema";
import { daySections } from "~/shared/dates/day-sections";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { epicsHref } from "~/shared/epic-href";
import { countLabel } from "~/shared/text/plural";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { Avatar } from "~/ui/avatar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime, useHydrated } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { RichText } from "~/ui/rich-text";
import { DueDatePill } from "~/ui/task-meta";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import {
  ArchiveEpicTasksButton,
  ArchiveEpicTasksConfirm,
  EPIC_STATUS_PILL,
  EpicDialog,
  EpicProgressBar,
  EpicStatusPill,
  archivableTasks,
  epicDonePercent,
  useArchiveEpicTasks,
  useEpicActionToast,
  type EpicActionResult,
} from "./epic-parts";
import type { EpicPageView, EpicTaskView } from "./epics-query.server";

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
 */

/** History lines shown before "Show all". */
const HISTORY_PREVIEW = 8;

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
  const statusFetcher = useFetcher<EpicActionResult>();
  useEpicActionToast(statusFetcher);
  // Ruling 651: a row's Remove, Archive and Restore are the page's requests,
  // not the row's. Each one moves its row (out of the list, into the fold or
  // back), and a fetcher unmounted with the row never delivered its toast.
  const rowFetcher = useFetcher<EpicActionResult>();
  useEpicActionToast(rowFetcher);
  const archiveAll = useArchiveEpicTasks();
  const [archivingOpen, setArchivingOpen] = useState<EpicTaskView | null>(null);
  const csrf = useCsrfToken();
  const live = view.tasks.filter((t) => !t.archived);
  const archived = view.tasks.filter((t) => t.archived);
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const rowBusy = rowFetcher.state !== "idle";
  const rowPending = rowBusy
    ? {
        taskKey: String(rowFetcher.formData?.get("taskKey") ?? ""),
        intent: String(rowFetcher.formData?.get("intent") ?? ""),
      }
    : null;
  const rowAct = (intent: "remove-task" | "archive-task" | "restore-task", taskKey: string) => {
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
  // One row for both lists (ruling 657): a live task offers Archive and Remove,
  // an archived one Restore.
  const taskRow = (task: EpicTaskView) => (
    <EpicTaskRow
      key={task.key}
      task={task}
      projectSlug={projectSlug}
      epicId={epic.id}
      stage={stageById.get(task.stageId) ?? null}
      pending={rowPending?.taskKey === task.key ? rowPending.intent : null}
      locked={rowBusy}
      onArchive={canArchive && !task.archived ? () => archiveRow(task) : null}
      onRestore={canArchive && task.archived ? () => rowAct("restore-task", task.key) : null}
      onRemove={canEditTasks && !task.archived ? () => rowAct("remove-task", task.key) : null}
    />
  );
  const archivable = canArchive ? archivableTasks(epic) : 0;
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
  const history = showAllHistory ? epic.history : epic.history.slice(0, HISTORY_PREVIEW);
  const olderHistory = epic.history.length - HISTORY_PREVIEW;

  return (
    <div className="board-wrap" data-screen-label="Epic">
      {/* Ruling 615: the head scrolls with the page, inside the one scroller,
          so it ends where the panels end whether or not a scrollbar takes
          room beside them. The status is said once in it: the select, for
          someone who may change it, stands where everyone else reads the
          pill. */}
      <div className="policy-wrap">
        <div className="epic-head">
          <p className="epic-crumb fine">
            <Link className="linkish" to={epicsHref(projectSlug)}>
              Epics
            </Link>
            <span aria-hidden="true"> / </span>
            {epic.id}
          </p>
          <div className="epic-head-row">
            <h1 className="epic-title">
              <span className="epic-dot lg" data-stage-color={epic.color} aria-hidden="true" />
              {epic.title}
            </h1>
            {canManage && (
              <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>
                <Icon name="edit" />
                Edit
              </button>
            )}
          </div>
          <div className="epic-sub">
            {canManage ? (
              <label className="epic-status-select" data-tone={EPIC_STATUS_PILL[shownStatus]}>
                <span className="vh">Status</span>
                <span className="epic-status-dot" aria-hidden="true" />
                <select
                  value={shownStatus}
                  disabled={statusBusy}
                  aria-busy={statusBusy || undefined}
                  onChange={(e) => {
                    const next = EPIC_STATUS_VALUES.find((s) => s === e.target.value);
                    if (next) setStatus(next);
                  }}
                >
                  {EPIC_STATUS_VALUES.map((s) => (
                    <option key={s} value={s}>
                      {EPIC_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" className="epic-status-chev" />
              </label>
            ) : (
              <EpicStatusPill status={shownStatus} sm />
            )}
            <span>
              {epic.progress.total > 0
                ? `${epicDonePercent(epic.progress)}% done · ${countLabel(epic.progress.total, "task")}`
                : "No tasks yet"}
            </span>
            {epic.targetDate && isEpicOpen(epic.status) && <DueDatePill dueDate={epic.targetDate} />}
          </div>
        </div>

        <div className="epic-layout">
          <div className="epic-main">
            <section className="panel" aria-labelledby="epic-about">
              <div className="panel-head">
                <Icon name="page" />
                <h2 id="epic-about">About</h2>
              </div>
              {epic.description.trim() ? (
                <div className="md-body epic-desc">
                  <Markdown text={epic.description} taskLinks={view.taskLinks} headingBase={2} />
                </div>
              ) : (
                <p className="empty sm">
                  No description yet.
                  {canManage && (
                    <>
                      {" "}
                      <button type="button" className="linkish" onClick={() => setEditing(true)}>
                        Say what this epic is for
                      </button>
                      .
                    </>
                  )}
                </p>
              )}
            </section>

            <section className="panel epic-tasks" aria-labelledby="epic-tasks-head">
              <div className="panel-head">
                <Icon name="board" />
                <h2 id="epic-tasks-head">Tasks</h2>
                <span className="right epic-task-tools">
                  {archivable > 0 && (
                    <ArchiveEpicTasksButton
                      busy={archiveAll.busyEpicId === epic.id}
                      onClick={() => archiveAll.ask(epic.id, archivable)}
                    />
                  )}
                  {canEditTasks && (
                    <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}>
                      <Icon name="plus" />
                      Add tasks
                    </button>
                  )}
                  {canCreateTask && (
                    <button type="button" className="btn sm" onClick={() => setCreatingTask(true)}>
                      <Icon name="plus" />
                      New task
                    </button>
                  )}
                </span>
              </div>
              <EpicProgressBar progress={epic.progress} stages={stages} />
              {live.length === 0 ? (
                <p className="empty sm">
                  {archived.length > 0
                    ? "Every task in this epic is archived."
                    : "No tasks in this epic yet." +
                      (canEditTasks || canCreateTask
                        ? " Add existing tasks or make a new one here; a task can also join from its own page."
                        : "")}
                </p>
              ) : (
                <ul className="epic-task-list" aria-label={`Tasks in ${epic.id}`}>
                  {live.map(taskRow)}
                </ul>
              )}
              {archived.length > 0 && (
                <details className="epic-archived">
                  <summary>
                    {countLabel(archived.length, "archived task")}
                    <Icon name="chevron" className="disc-chev" />
                  </summary>
                  <p className="fine dim">
                    Archived tasks still name this epic. One archived when done still counts as done;
                    one archived unfinished is left out of its progress.
                  </p>
                  <ul className="epic-task-list" aria-label={`Archived tasks in ${epic.id}`}>
                    {archived.map(taskRow)}
                  </ul>
                </details>
              )}
            </section>

            <section className="panel" aria-labelledby="epic-history-head">
              <div className="panel-head">
                <Icon name="activity" />
                <h2 id="epic-history-head">History</h2>
              </div>
              {epic.history.length === 0 ? (
                <p className="empty sm">Nothing recorded yet.</p>
              ) : (
                <EpicHistory entries={history} taskLinks={view.taskLinks} />
              )}
              {olderHistory > 0 && (
                <button
                  type="button"
                  className="btn ghost sm epic-history-more"
                  aria-expanded={showAllHistory}
                  onClick={() => setShowAllHistory((all) => !all)}
                >
                  {showAllHistory ? "Show less" : `Show ${olderHistory} more`}
                  <Icon name="chevron" className="disc-chev ico-end" />
                </button>
              )}
            </section>
          </div>

          <aside className="epic-side">
            <section className="panel" aria-labelledby="epic-props-head">
              <div className="panel-head">
                <Icon name="sliders" />
                <h2 id="epic-props-head">Details</h2>
              </div>
              <div className="kv props">
                <div className="kv-row">
                  <span className="k">Status</span>
                  <span className="v">
                    <EpicStatusPill status={shownStatus} sm />
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Lead</span>
                  <span className="v">{epic.leadName ?? <span className="prop-empty">Nobody</span>}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Start date</span>
                  <span className="v">{epic.startDate ?? <span className="prop-empty">Not set</span>}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Target date</span>
                  <span className="v">{epic.targetDate ?? <span className="prop-empty">Not set</span>}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Created</span>
                  {/* Ruling 520: one run of text, so a value that wraps
                      breaks between words rather than before its " · ". */}
                  <span className="v">
                    <span>
                      {epic.createdByLabel || epic.createdBy}
                      {epic.createdAt && (
                        <span className="dim">
                          {" · "}
                          <LocalDayDotTime iso={epic.createdAt} />
                        </span>
                      )}
                    </span>
                  </span>
                </div>
                {/* Ruling 476(h): the conversation that planned the epic holds
                    the reasoning behind its tasks. Shown only to a viewer who can
                    open it. */}
                {view.plannedIn && (
                  <div className="kv-row" data-epic-planned>
                    <span className="k">Planned in</span>
                    <span className="v">
                      <span>
                        <Link className="linkish" to={view.plannedIn.href}>
                          {view.plannedIn.title}
                        </Link>
                        <span className="dim"> · {view.plannedIn.scopeLabel}</span>
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>

      {editing && <EpicDialog epic={epic} members={view.members} onClose={() => setEditing(false)} />}
      {archiveAll.asking && (
        <ArchiveEpicTasksConfirm {...archiveAll.asking} onCancel={archiveAll.cancel} onConfirm={archiveAll.confirm} />
      )}
      {archivingOpen && (
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
      )}
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

/** Ruling 560: the history reads as a feed, the way the shadcn timeline
 *  blocks draw one. Days head their entries, newest first; each entry is a dot
 *  on one rail with its clock at the right, and the tasks it names are the key
 *  chips every other feed links a task with. */
function EpicHistory({
  entries,
  taskLinks,
}: {
  entries: EpicPageView["epic"]["history"];
  taskLinks: EpicPageView["taskLinks"];
}) {
  const local = useHydrated();
  return (
    <div className="epic-history">
      {daySections(entries, (entry) => entry.occurredAt, local).map((day) => (
        <div key={day.key}>
          <p className="epic-history-day">{day.day}</p>
          <ol className="epic-history-list">
            {day.rows.map((entry, i) => (
              <li key={`${entry.occurredAt}-${i}`}>
                <span className="epic-history-text">
                  <RichText text={entry.text} taskLinks={taskLinks} />
                </span>
                <time className="epic-history-at" dateTime={entry.occurredAt}>
                  {(local ? formatClock : formatClockUTC)(entry.occurredAt)}
                </time>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** One task of the epic: its key and title (its page), its stage, the board
 *  card's status word, what it waits on, its owner, then what may be done to
 *  it: Archive and Remove on a live row, Restore on an archived one (ruling
 *  651). Each action is the page's request; `pending` names the one in flight
 *  on this row, and `locked` holds every row while one is. */
function EpicTaskRow({
  task,
  projectSlug,
  epicId,
  stage,
  pending,
  locked,
  onArchive,
  onRestore,
  onRemove,
}: {
  task: EpicTaskView;
  projectSlug: string;
  epicId: string;
  stage: { id: string; name: string; color: string } | null;
  /** The intent in flight on this row, or null. */
  pending: string | null;
  locked: boolean;
  onArchive: (() => void) | null;
  onRestore: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const href = `/projects/${projectSlug}/tasks/${task.key}`;
  return (
    <li className="epic-task" data-task={task.key} aria-busy={pending !== null || undefined}>
      <Link className="epic-task-link" to={href}>
        <span className="epic-task-key">{task.key}</span>
        <span className="epic-task-title">{task.title}</span>
      </Link>
      <span className="epic-task-props">
        <span className="epic-task-stage">
          <span className="col-stage-dot sm" data-stage-color={stage?.color} aria-hidden="true" />
          {stage?.name ?? task.stageId}
        </span>
        {task.status && (
          <span className={"chip st " + task.status.kind}>
            {task.status.icon === null ? <span className="working" /> : <Icon name={task.status.icon} />}
            {task.status.label}
            {task.status.kind === "scheduled" && task.status.resumesAt && (
              <>
                {" "}
                <LocalDayDotTime iso={task.status.resumesAt} />
              </>
            )}
          </span>
        )}
        {task.waitsOn > 0 && (
          <span className="chip pb" title="What it waits on is on its own page">
            <Icon name="lock" />
            waits on {task.waitsOn}
          </span>
        )}
        {task.owner ? (
          <span className="rev-stack" role="img" aria-label={"Owner: " + task.owner.name} title={"Owner: " + task.owner.name}>
            <Avatar person={task.owner} size="xs" />
          </span>
        ) : (
          <span className="rev-stack" role="img" aria-label="Owner: unassigned" title="Owner: unassigned">
            <span className="avatar xs ghost">?</span>
          </span>
        )}
      </span>
      {(onArchive || onRestore || onRemove) && (
        <span className="epic-task-actions">
          {onArchive && (
            <button
              type="button"
              className="icon-btn"
              disabled={locked}
              aria-label={`Archive ${task.key}`}
              title={`Archive ${task.key}`}
              onClick={onArchive}
            >
              <GlyphSwap rest="archive" alt="loader" on={pending === "archive-task"} spinAlt />
            </button>
          )}
          {onRestore && (
            <button
              type="button"
              className="icon-btn"
              disabled={locked}
              aria-label={`Restore ${task.key}`}
              title={`Restore ${task.key}`}
              onClick={onRestore}
            >
              <GlyphSwap rest="refresh" alt="loader" on={pending === "restore-task"} spinAlt />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="icon-btn"
              disabled={locked}
              aria-label={`Take ${task.key} out of ${epicId}`}
              title={`Take ${task.key} out of ${epicId}`}
              onClick={onRemove}
            >
              <GlyphSwap rest="x" alt="loader" on={pending === "remove-task"} spinAlt />
            </button>
          )}
        </span>
      )}
    </li>
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
                  <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
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
