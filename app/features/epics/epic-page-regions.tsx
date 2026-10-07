import { Link } from "react-router";
import { EPIC_STATUS_LABEL, EPIC_STATUS_VALUES, isEpicOpen } from "~/schemas/epic-file.schema";
import { daySections } from "~/shared/dates/day-sections";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { epicsHref } from "~/shared/epic-href";
import { countLabel } from "~/shared/text/plural";
import { Avatar } from "~/ui/avatar";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime, useHydrated } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { RichText } from "~/ui/rich-text";
import { DueDatePill } from "~/ui/task-meta";
import type { EpicTaskRows, useEpicStatus } from "./epic-page-actions";
import { ArchiveEpicTasksButton, EpicProgressBar, EpicStatusPill } from "./epic-parts";
import { EPIC_STATUS_PILL, epicDonePercent } from "./epic-helpers";
import type { EpicPageView, EpicStageView, EpicTaskView } from "./epics-query.server";

/**
 * The epic page's regions (ruling 695(e), the large-component split of
 * `epic-page.tsx`): the head, About, Tasks, History and Details, with the
 * task row and the history feed they draw, moved here unchanged. Each region
 * takes the slot its markup held in the page and calls no hook (the feed
 * keeps the `useHydrated` it always called), so the page's markup, and every
 * id React derives from its place in the tree, are what they were. The page
 * holds every request and dialog and hands them in.
 */

type EpicView = EpicPageView["epic"];

/** History lines shown before "Show all". */
const HISTORY_PREVIEW = 8;

/**
 * The head: the way back to Epics, the title with Edit, and the status line.
 * Ruling 615: the status is said once in it: the select, for someone who may
 * change it, stands where everyone else reads the pill.
 */
export function EpicHead({
  epic,
  projectSlug,
  canManage,
  status,
  onEdit,
}: {
  epic: EpicView;
  projectSlug: string;
  /** `manage-epics`: the status select and Edit. */
  canManage: boolean;
  status: ReturnType<typeof useEpicStatus>;
  onEdit: () => void;
}) {
  return (
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
          <button type="button" className="btn ghost sm" onClick={onEdit}>
            <Icon name="edit" />
            Edit
          </button>
        )}
      </div>
      <div className="epic-sub">
        {canManage ? (
          <label className="epic-status-select" data-tone={EPIC_STATUS_PILL[status.shown]}>
            <span className="vh">Status</span>
            <span className="epic-status-dot" aria-hidden="true" />
            <select
              value={status.shown}
              disabled={status.busy}
              aria-busy={status.busy || undefined}
              onChange={(e) => {
                const next = EPIC_STATUS_VALUES.find((s) => s === e.target.value);
                if (next) status.setStatus(next);
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
          <EpicStatusPill status={status.shown} sm />
        )}
        <span>
          {epic.progress.total > 0
            ? `${epicDonePercent(epic.progress)}% done · ${countLabel(epic.progress.total, "task")}`
            : "No tasks yet"}
        </span>
        {epic.targetDate && isEpicOpen(epic.status) && <DueDatePill dueDate={epic.targetDate} />}
      </div>
    </div>
  );
}

/** About: the epic's markdown description, or the offer to write one. */
export function EpicAbout({
  epic,
  taskLinks,
  canManage,
  onEdit,
}: {
  epic: EpicView;
  taskLinks: EpicPageView["taskLinks"];
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <section className="panel" aria-labelledby="epic-about">
      <div className="panel-head">
        <Icon name="page" />
        <h2 id="epic-about">About</h2>
      </div>
      {epic.description.trim() ? (
        <div className="md-body epic-desc">
          <Markdown text={epic.description} taskLinks={taskLinks} headingBase={2} />
        </div>
      ) : (
        <p className="empty sm">
          No description yet.
          {canManage && (
            <>
              {" "}
              <button type="button" className="linkish" onClick={onEdit}>
                Say what this epic is for
              </button>
              .
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Tasks: Archive tasks, Add tasks and New task in its head, the progress, the
 * live rows, and the archived ones folded under them. One row for both lists
 * (ruling 657): a live task offers Archive and Remove, an archived one
 * Restore.
 */
export function EpicTasks({
  epic,
  stages,
  tasks,
  projectSlug,
  canEditTasks,
  canCreateTask,
  canArchive,
  rows,
  archivable,
  archivingAll,
  onArchiveAll,
  onAdd,
  onCreate,
}: {
  epic: EpicView;
  stages: EpicStageView[];
  tasks: EpicTaskView[];
  projectSlug: string;
  canEditTasks: boolean;
  canCreateTask: boolean;
  canArchive: boolean;
  /** The page's row requests (ruling 651). */
  rows: EpicTaskRows;
  /** Tasks Archive tasks would file away; 0 offers no button. */
  archivable: number;
  archivingAll: boolean;
  onArchiveAll: () => void;
  onAdd: () => void;
  onCreate: () => void;
}) {
  const live = tasks.filter((t) => !t.archived);
  const archived = tasks.filter((t) => t.archived);
  const taskRow = (task: EpicTaskView) => (
    <EpicTaskRow
      key={task.key}
      task={task}
      projectSlug={projectSlug}
      epicId={epic.id}
      stage={rows.stageById.get(task.stageId) ?? null}
      pending={rows.pending?.taskKey === task.key ? rows.pending.intent : null}
      locked={rows.locked}
      onArchive={canArchive && !task.archived ? () => rows.archiveRow(task) : null}
      onRestore={canArchive && task.archived ? () => rows.rowAct("restore-task", task.key) : null}
      onRemove={canEditTasks && !task.archived ? () => rows.rowAct("remove-task", task.key) : null}
    />
  );
  return (
    <section className="panel epic-tasks" aria-labelledby="epic-tasks-head">
      <div className="panel-head">
        <Icon name="board" />
        <h2 id="epic-tasks-head">Tasks</h2>
        <span className="right epic-task-tools">
          {archivable > 0 && <ArchiveEpicTasksButton busy={archivingAll} onClick={onArchiveAll} />}
          {canEditTasks && (
            <button type="button" className="btn ghost sm" onClick={onAdd}>
              <Icon name="plus" />
              Add tasks
            </button>
          )}
          {canCreateTask && (
            <button type="button" className="btn sm" onClick={onCreate}>
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
  );
}

/** History: the newest HISTORY_PREVIEW lines, and Show more for the rest. */
export function EpicHistoryPanel({
  entries,
  taskLinks,
  showAll,
  onToggle,
}: {
  entries: EpicView["history"];
  taskLinks: EpicPageView["taskLinks"];
  showAll: boolean;
  onToggle: () => void;
}) {
  const history = showAll ? entries : entries.slice(0, HISTORY_PREVIEW);
  const olderHistory = entries.length - HISTORY_PREVIEW;
  return (
    <section className="panel" aria-labelledby="epic-history-head">
      <div className="panel-head">
        <Icon name="activity" />
        <h2 id="epic-history-head">History</h2>
      </div>
      {entries.length === 0 ? (
        <p className="empty sm">Nothing recorded yet.</p>
      ) : (
        <EpicHistory entries={history} total={entries.length} taskLinks={taskLinks} />
      )}
      {olderHistory > 0 && (
        <button
          type="button"
          className="btn ghost sm epic-history-more"
          aria-expanded={showAll}
          onClick={onToggle}
        >
          {showAll ? "Show less" : `Show ${olderHistory} more`}
          <Icon name="chevron" className="disc-chev ico-end" />
        </button>
      )}
    </section>
  );
}

/** Details: the status, the lead, the dates, the creator, and the
 *  conversation the epic was planned in. */
export function EpicDetails({
  epic,
  shownStatus,
  plannedIn,
}: {
  epic: EpicView;
  shownStatus: EpicView["status"];
  plannedIn: EpicPageView["plannedIn"];
}) {
  return (
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
          {plannedIn && (
            <div className="kv-row" data-epic-planned>
              <span className="k">Planned in</span>
              <span className="v">
                <span>
                  <Link className="linkish" to={plannedIn.href}>
                    {plannedIn.title}
                  </Link>
                  <span className="dim"> · {plannedIn.scopeLabel}</span>
                </span>
              </span>
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}

/** Ruling 560: the history reads as a feed, the way the shadcn timeline
 *  blocks draw one. Days head their entries, newest first; each entry is a dot
 *  on one rail with its clock at the right, and the tasks it names are the key
 *  chips every other feed links a task with. */
function EpicHistory({
  entries,
  total,
  taskLinks,
}: {
  entries: EpicPageView["epic"]["history"];
  /** The whole history's length; `entries` is its newest-first front slice. */
  total: number;
  taskLinks: EpicPageView["taskLinks"];
}) {
  const local = useHydrated();
  // A new line lands at the head (`updateEpicFile` unshifts), so a row's
  // place moves with every write while its number counted from the oldest
  // stays. Keyed by its place in the day, a line written today re-keyed the
  // rest of today, and a focused task chip in them fell to <body>.
  const rows = entries.map((entry, n) => ({ entry, line: total - n }));
  return (
    <div className="epic-history">
      {daySections(rows, (row) => row.entry.occurredAt, local).map((day) => (
        <div key={day.key}>
          <p className="epic-history-day">{day.day}</p>
          <ol className="epic-history-list">
            {day.rows.map(({ entry, line }) => (
              <li key={line}>
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
