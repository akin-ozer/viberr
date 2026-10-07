import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { isEpicOpen } from "~/schemas/epic-file.schema";
import type { EpicSummary } from "~/server/projections/epic-query.server";
import { epicHref } from "~/shared/epic-href";
import { countLabel } from "~/shared/text/plural";
import { Icon } from "~/ui/icon";
import { DueDatePill } from "~/ui/task-meta";
import {
  ArchiveEpicTasksButton,
  ArchiveEpicTasksConfirm,
  EpicDialog,
  EpicProgressBar,
  EpicStatusPill,
  useArchiveEpicTasks,
} from "./epic-parts";
import { archivableTasks } from "./epic-helpers";
import type { EpicMemberView, EpicStageView } from "./epics-query.server";

/**
 * Ruling 503: the project's epics, the way Linear lists a team's projects and
 * Jira an epics panel. Each row is its epic's page: its colour and name, its
 * status, its progress in the project's own stage colours, who leads it and
 * when it is meant to land. Open epics first (the default view); the closed
 * ones are one click away and never deleted. A Done epic whose tasks are all
 * done offers Archive tasks, to someone who may archive them (ruling 651).
 */

type Show = "open" | "closed" | "all";

const SHOW_LABEL = { open: "Open", closed: "Closed", all: "All" } satisfies Record<Show, string>;

const SHOW_TABS = (["open", "closed", "all"] as const).map((id) => ({ id, label: SHOW_LABEL[id] }));

function isShow(value: string | null): value is Show {
  return value === "open" || value === "closed" || value === "all";
}

export function EpicsPage({
  projectSlug,
  epics,
  stages,
  members,
  canManage,
  canArchive,
}: {
  projectSlug: string;
  epics: EpicSummary[];
  stages: EpicStageView[];
  members: EpicMemberView[];
  /** `manage-epics` (server-checked again on submit; this only hides a dead
   *  button). */
  canManage: boolean;
  /** `approve-transition`, the grant archiving a task takes (ruling 651). */
  canArchive: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get("show");
  const show: Show = isShow(raw) ? raw : "open";
  const [creating, setCreating] = useState(false);
  const archive = useArchiveEpicTasks();
  const open = epics.filter((e) => isEpicOpen(e.status));
  const shown = show === "all" ? epics : show === "open" ? open : epics.filter((e) => !isEpicOpen(e.status));
  const setShow = (next: Show) => {
    const url = new URLSearchParams(params);
    if (next === "open") url.delete("show");
    else url.set("show", next);
    setParams(url, { replace: true, preventScrollReset: true });
  };

  return (
    <div className="board-wrap" data-screen-label="Epics">
      <div className="board-head">
        <div>
          <h1>Epics</h1>
          {/* Ruling 625: an empty project's count is the hero's heading below
              ("No epics yet"), so the head says nothing rather than say it
              twice. The status region stays, so a count that arrives is read. */}
          <div className="sub">
            <span role="status">
              {epics.length > 0 && `${countLabel(epics.length, "epic")} · ${open.length} open`}
            </span>
          </div>
        </div>
        <div className="board-tools">
          {epics.length > 0 && (
            <div className="seg" role="group" aria-label="Which epics">
              {SHOW_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={show === tab.id ? "on" : ""}
                  aria-pressed={show === tab.id}
                  onClick={() => setShow(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          {/* Ruling 625: one primary New epic — the empty state's own button
              while there are none (as the board keeps one create on a
              virgin board), this one once there is a list. */}
          {canManage && epics.length > 0 && (
            <button type="button" className="btn primary sm" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New epic
            </button>
          )}
        </div>
      </div>

      <div className="policy-wrap">
        {epics.length === 0 ? (
          <div className="empty-hero" data-screen-label="Empty state">
            <span className="glyph">
              <Icon name="epic" />
            </span>
            <h2>No epics yet</h2>
            <p>
              An epic is a body of work in this project, like a Jira epic or a Linear project. Tasks
              join it and leave it one at a time, and its progress is counted from them.
              {canManage
                ? " Create one here, or ask the controller to plan one."
                : " A contributor or a maintainer can create one."}
            </p>
            {canManage && (
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                New epic
              </button>
            )}
          </div>
        ) : (
          <div className="panel epics-panel">
            {shown.length === 0 ? (
              <p className="empty sm">
                {show === "closed" ? "No epic is done or cancelled yet." : "Every epic is done or cancelled."}
              </p>
            ) : (
              <ul className="epic-list" aria-label={`${SHOW_LABEL[show]} epics`}>
                {shown.map((epic) => {
                  const archivable = canArchive ? archivableTasks(epic) : 0;
                  return (
                    <EpicRow
                      key={epic.id}
                      epic={epic}
                      stages={stages}
                      href={epicHref(projectSlug, epic.id)}
                      archivable={archivable}
                      archiving={archive.busyEpicId === epic.id}
                      onArchive={() => archive.ask(epic.id, archivable)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {archive.asking && (
        <ArchiveEpicTasksConfirm {...archive.asking} onCancel={archive.cancel} onConfirm={archive.confirm} />
      )}
      {creating && (
        <EpicDialog
          epic={null}
          members={members}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(epicHref(projectSlug, id))}
        />
      )}
    </div>
  );
}

/**
 * One epic. Its name is the link to its page, and the link's box covers the
 * row, so the whole row still opens it; Archive tasks sits above that box,
 * since a button may not sit inside a link (ruling 651).
 */
function EpicRow({
  epic,
  stages,
  href,
  archivable,
  archiving,
  onArchive,
}: {
  epic: EpicSummary;
  stages: EpicStageView[];
  href: string;
  /** Tasks Archive tasks would file away; 0 offers no button. */
  archivable: number;
  archiving: boolean;
  onArchive: () => void;
}) {
  return (
    <li className="epic-row" data-epic={epic.id}>
      <span className="epic-row-name">
        <span className="epic-dot" data-stage-color={epic.color} aria-hidden="true" />
        <Link className="epic-row-link" to={href}>
          <span className="epic-row-id">{epic.id}</span>
          <span className="epic-row-title">{epic.title}</span>
        </Link>
      </span>
      <span className="epic-row-status">
        <EpicStatusPill status={epic.status} sm />
      </span>
      <span className="epic-row-progress">
        <EpicProgressBar progress={epic.progress} stages={stages} />
      </span>
      <span className="epic-row-meta">
        {epic.leadName && (
          <span className="epic-row-lead" title={`Led by ${epic.leadName}`}>
            <Icon name="user" />
            {epic.leadName}
          </span>
        )}
        {epic.targetDate && isEpicOpen(epic.status) && <DueDatePill dueDate={epic.targetDate} />}
        {archivable > 0 && <ArchiveEpicTasksButton busy={archiving} onClick={onArchive} />}
      </span>
      <Icon name="chevron" className="epic-row-go" />
    </li>
  );
}
