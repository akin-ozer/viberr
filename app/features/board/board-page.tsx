import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useFetcher,
  useSearchParams,
} from "react-router";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill, ReadinessPill } from "~/ui/pill";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  isBoardFilterId,
  matchesBoardFilter,
  matchesSearch,
  shortBranch,
  type BoardFilterId,
} from "./board-filters";

/**
 * Board view — 1:1 port of design/html-app/app/board.jsx onto the Phase-3
 * projections. No DnD (stage transitions are governed actions elsewhere).
 * Deviations from the mock (documented in the phase report):
 *   - filter/view/search live in URL params (survive refresh/share);
 *   - list view gains a minimal empty state (ruling 16);
 *   - re-scan toasts fire on real action completion, ".viberr" wording
 *     aligned to the real store (contracts §7.3);
 *   - create modal gets Escape/focus-trap/aria-modal and shows server
 *     errors in `foot-hint err` instead of closing.
 */

export interface BoardStage {
  id: string;
  name: string;
  color: string;
}

export interface BoardColumnData {
  stage: BoardStage;
  tasks: TaskSummary[];
}

function WaitTag({ task }: { task: TaskSummary }) {
  if (task.waiting === "agent") {
    return (
      <span className="wait-tag agent">
        <span className="working" />
        agent working
      </span>
    );
  }
  if (task.waiting === "human") {
    return (
      <span className="wait-tag human">
        <Icon name="hand" />
        waiting on you
      </span>
    );
  }
  return null;
}

function OwnerLine({ task }: { task: TaskSummary }) {
  const sp = task.specialist;
  if (sp) {
    return (
      <div className="card-owner">
        <AgentGlyph backend={sp.backend} />
        <span className="nm">{sp.name}</span>
        <span className="lbl">· {sp.role}</span>
      </div>
    );
  }
  const o = task.owner;
  if (o && o.kind === "human") {
    return (
      <div className="card-owner">
        <Avatar person={o} />
        <span className="nm">{o.name.split(" ")[0]}</span>
        <span className="lbl">· owner</span>
      </div>
    );
  }
  return (
    <div className="card-owner">
      <span className="avatar" style={{ opacity: 0.5 }}>
        ?
      </span>
      <span className="lbl">{task.operator ? "awaiting owner" : "unassigned"}</span>
    </div>
  );
}

function ReviewerStack({ task, label }: { task: TaskSummary; label?: boolean }) {
  const o = task.owner;
  if (!o || o.kind !== "human" || !task.specialist) return null;
  return (
    <span
      className="rev-stack"
      title={"Owner · human reviewer & acceptance: " + o.name}
    >
      {label && <span className="rs-lbl">owner</span>}
      <Avatar person={o} />
    </span>
  );
}

function TaskCard({
  task,
  stages,
  canTransition,
  onMove,
  moving,
  arrived,
}: {
  task: TaskSummary;
  stages: BoardStage[];
  canTransition: boolean;
  onMove: (task: TaskSummary, toStageId: string) => void;
  moving: boolean;
  arrived: boolean;
}) {
  const cls = ["card"];
  if (task.waiting === "human") cls.push("wait-human");
  if (task.urgent) cls.push("urgent");
  const wrapCls = ["card-wrap"];
  if (moving) wrapCls.push("is-moving");
  if (arrived) wrapCls.push("just-arrived");
  return (
    <div className={wrapCls.join(" ")}>
      <Link
        className={cls.join(" ")}
        to={`/projects/${task.projectSlug}/tasks/${task.key}`}
      >
        <div className="card-top">
          <span className="key">{task.key}</span>
          <span className="spacer" />
          <ReadinessPill value={task.displayReadiness} sm />
        </div>
        <h3>{task.title}</h3>
        <div className="owner-row">
          <OwnerLine task={task} />
          <ReviewerStack task={task} />
        </div>
        <div className="card-foot">
          {task.branch ? (
            <span className="trace ok">
              <Icon name="branch" />
              {shortBranch(task.branch)}
            </span>
          ) : (
            <span className="trace">
              <Icon name="branch" />
              no branch
            </span>
          )}
          {task.pr && (
            <span className="trace pr">
              <Icon name="pr" />#{task.pr.number}
            </span>
          )}
          <WaitTag task={task} />
        </div>
      </Link>
      {canTransition && (
        // Outside the <Link> (no nested interactives): a compact stage-move
        // control the maintainer uses to move the card to another column.
        <div className="card-stage-move">
          <StageMenu
            stages={stages}
            currentStageId={task.stage}
            onSelect={(to) => onMove(task, to)}
            busy={moving}
            variant="card"
            align="right"
          />
        </div>
      )}
    </div>
  );
}

function Column({
  stage,
  tasks,
  allStages,
  isDone,
  canCreate,
  canTransition,
  onNew,
  onMove,
  movingKey,
  arrivedKey,
}: {
  stage: BoardStage;
  tasks: TaskSummary[];
  /** All project stages — the stage-move menu offers these. */
  allStages: BoardStage[];
  isDone: boolean;
  canCreate: boolean;
  canTransition: boolean;
  onNew: () => void;
  onMove: (task: TaskSummary, toStageId: string) => void;
  movingKey: string | null;
  arrivedKey: string | null;
}) {
  return (
    <section className="column">
      <header className="col-head">
        <span className="col-stage-dot" style={{ background: stage.color }} />
        <span className="nm">{stage.name}</span>
        <span className="ct">{tasks.length}</span>
        {!isDone && canCreate && (
          <button className="add" title="New task in this stage" onClick={onNew}>
            <Icon name="plus" />
          </button>
        )}
      </header>
      <div className="col-body">
        {tasks.length === 0 ? (
          <div className="empty">No tasks</div>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.key}
              task={t}
              stages={allStages}
              canTransition={canTransition}
              onMove={onMove}
              moving={movingKey === t.key}
              arrived={arrivedKey === t.key}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ListView({
  tasks,
  stages,
}: {
  tasks: TaskSummary[];
  stages: BoardStage[];
}) {
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? id;
  return (
    <div
      className="board"
      style={{
        gridAutoFlow: "row",
        gridAutoColumns: "auto",
        display: "block",
        padding: "0 1.4rem 1.4rem",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: ".6rem",
          maxWidth: 920,
        }}
      >
        {tasks.length === 0 && <div className="empty">No tasks</div>}
        {tasks.map((t) => (
          <Link
            key={t.key}
            className="card"
            style={{ flexDirection: "row", alignItems: "center", gap: "1rem" }}
            to={`/projects/${t.projectSlug}/tasks/${t.key}`}
          >
            <span className="key" style={{ width: 64 }}>
              {t.key}
            </span>
            <h3 style={{ flex: 1 }}>{t.title}</h3>
            <span className="pill neutral sm">{stageName(t.stage)}</span>
            <OwnerLine task={t} />
            <ReviewerStack task={t} label />
            <ReadinessPill value={t.displayReadiness} sm />
            <WaitTag task={t} />
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ---------- New task modal (board spec §4.6) ---------- */

function NewTaskModal({
  stages,
  initialStage,
  onClose,
}: {
  /** Project stages EXCLUDING the final (done) stage. */
  stages: BoardStage[];
  initialStage: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [stg, setStg] = useState(initialStage);
  const fetcher = useFetcher<{
    ok: boolean;
    key?: string;
    stageName?: string;
    error?: string;
  }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const panelRef = useDialog(onClose);
  const busy = fetcher.state !== "idle";
  const closedRef = useRef(false);

  const valid = title.trim().length >= 3;
  const serverError = fetcher.data && fetcher.data.ok === false
    ? fetcher.data.error
    : null;

  useEffect(() => {
    if (fetcher.data?.ok && !closedRef.current) {
      closedRef.current = true;
      push(
        fetcher.data.key +
          " created in " +
          fetcher.data.stageName +
          " — its task.md is in the store",
      );
      onClose();
    }
  }, [fetcher.data, onClose, push]);

  const submit = () => {
    if (!valid || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-task");
    fd.set("title", title.trim());
    fd.set("goal", goal.trim());
    fd.set("stage", stg);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <>
      <div className="confirm-scrim" onClick={onClose} />
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        style={{ width: "min(560px, calc(100vw - 2rem))" }}
        ref={panelRef}
      >
        <div className="modal-head">
          <span className="agent-glyph lg">
            <Icon name="plus" />
          </span>
          <div className="mh-main">
            <h2>New task</h2>
            <div className="mh-sub">
              Creates a canonical task file in the store — agents anchor on it
              from the first event.
            </div>
          </div>
          <button
            className="icon-btn modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="flabel">
              Title<span className="req">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Reconcile PR state after force-push"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <div className="field">
            <label className="flabel">Stage</label>
            <div className="pick-chips">
              {stages.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={"pick-chip" + (stg === s.id ? " on" : "")}
                  onClick={() => setStg(s.id)}
                >
                  <span
                    className="sdot"
                    style={stg === s.id ? { background: s.color } : undefined}
                  />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="flabel">
              Goal
              <span className="fhint">
                what done means — the operator and specialists anchor on this
              </span>
            </label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="One or two sentences. Underspecified goals get flagged at the triage quality gate."
            />
          </div>
        </div>
        <div className="modal-foot">
          <span className={"foot-hint" + (valid && !serverError ? "" : " err")}>
            {serverError
              ? serverError
              : valid
                ? "The task key is assigned on create."
                : "A title is required."}
          </span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={submit}
              disabled={!valid || busy}
              style={
                !valid ? { opacity: 0.5, pointerEvents: "none" } : undefined
              }
              aria-busy={busy}
            >
              <Icon name="plus" />
              Create task
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- Board ---------- */

const FILTERS: { id: BoardFilterId; label: string; icon: IconName }[] = [
  { id: "all", label: "All tasks", icon: "board" },
  { id: "human", label: "Waiting on me", icon: "hand" },
  { id: "agent", label: "Agent working", icon: "cpu" },
  { id: "risk", label: "Needs attention", icon: "alert" },
];

export function BoardPage({
  columns,
  orphanTasks,
  canCreate,
  canTransition,
}: {
  columns: BoardColumnData[];
  orphanTasks: TaskSummary[];
  canCreate: boolean;
  /** admin|maintainer — enables the per-card stage-move dropdown. */
  canTransition: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get("filter");
  const filter: BoardFilterId = isBoardFilterId(rawFilter) ? rawFilter : "all";
  const group = searchParams.get("view") === "list" ? "list" : "stage";
  const query = searchParams.get("q") ?? "";
  const [creating, setCreating] = useState<string | null>(null);
  const rescanFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // Manual stage move (per-card dropdown). One fetcher for the board; the source
  // card fades out (`movingKey`) while in flight, and the card pulses in its new
  // column (`arrivedKey`) once revalidation lands it there.
  const transitionFetcher = useFetcher<{
    ok: boolean;
    toast?: string;
    error?: string;
  }>();
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  const moveDone = useRef<unknown>(null);
  const onMove = (task: TaskSummary, toStageId: string) => {
    if (task.stage === toStageId || transitionFetcher.state !== "idle") return;
    setMovingKey(task.key);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "transition");
    fd.set("taskKey", task.key);
    fd.set("to", toStageId);
    transitionFetcher.submit(fd, { method: "post" });
  };
  useEffect(() => {
    if (transitionFetcher.state !== "idle" || !transitionFetcher.data) return;
    if (moveDone.current === transitionFetcher.data) return;
    moveDone.current = transitionFetcher.data;
    const d = transitionFetcher.data;
    if (d.ok && d.toast) push(d.toast);
    else if (!d.ok && d.error) push(d.error);
    const k = movingKey;
    setMovingKey(null);
    if (d.ok && k) {
      setArrivedKey(k);
      window.setTimeout(
        () => setArrivedKey((cur) => (cur === k ? null : cur)),
        1500,
      );
    }
  }, [transitionFetcher.state, transitionFetcher.data, movingKey, push]);

  const stages = columns.map((c) => c.stage);
  const doneStageId = stages[stages.length - 1]?.id;
  const allTasks = useMemo(
    () => [...columns.flatMap((c) => c.tasks), ...orphanTasks],
    [columns, orphanTasks],
  );
  const waitingHuman = allTasks.filter((t) => t.waiting === "human").length;

  const visible = (tasks: TaskSummary[]) =>
    tasks.filter(
      (t) => matchesBoardFilter(t, filter) && matchesSearch(t, query),
    );

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const rescan = () => {
    if (rescanFetcher.state !== "idle") return;
    push("Re-scanning the task store…");
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rescan");
    rescanFetcher.submit(fd, { method: "post" });
  };
  const rescanDone = useRef(false);
  useEffect(() => {
    if (rescanFetcher.state === "submitting") rescanDone.current = false;
    if (rescanFetcher.state === "idle" && rescanFetcher.data?.ok && !rescanDone.current) {
      rescanDone.current = true;
      push("Re-scan complete — board matches the file-native store");
    }
  }, [rescanFetcher.state, rescanFetcher.data, push]);

  return (
    <div className="board-wrap" data-screen-label="Board">
      <div className="board-head">
        <div>
          <h1>Board</h1>
          <div className="sub">
            {allTasks.length} tasks · {waitingHuman} waiting on a human decision
          </div>
        </div>
        <div className="board-tools">
          <div className="seg">
            <button
              className={group === "stage" ? "on" : ""}
              onClick={() => setParam("view", null)}
            >
              <Icon name="board" />
              Board
            </button>
            <button
              className={group === "list" ? "on" : ""}
              onClick={() => setParam("view", "list")}
            >
              <Icon name="review" />
              List
            </button>
          </div>
          <button
            className="btn ghost sm"
            onClick={rescan}
            title="Reconcile the board with the file-native store"
          >
            <Icon name="refresh" />
            Re-scan
          </button>
          {canCreate && (
            <button
              className="btn primary sm"
              onClick={() => setCreating(stages[0]?.id ?? "triage")}
            >
              <Icon name="plus" />
              New task
            </button>
          )}
        </div>
      </div>

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={"fchip" + (filter === f.id ? " on" : "")}
            aria-pressed={filter === f.id}
            onClick={() => setParam("filter", f.id === "all" ? null : f.id)}
          >
            <Icon name={f.icon} />
            {f.label}
            {f.id === "human" && waitingHuman > 0 && (
              <span style={{ opacity: 0.7 }}>· {waitingHuman}</span>
            )}
          </button>
        ))}
      </div>

      {group === "stage" ? (
        <div className="board">
          {columns.map((c) => (
            <Column
              key={c.stage.id}
              stage={c.stage}
              tasks={visible(c.tasks)}
              allStages={stages}
              isDone={c.stage.id === doneStageId}
              canCreate={canCreate}
              canTransition={canTransition}
              onNew={() => setCreating(c.stage.id)}
              onMove={onMove}
              movingKey={movingKey}
              arrivedKey={arrivedKey}
            />
          ))}
        </div>
      ) : (
        <ListView tasks={visible(allTasks)} stages={stages} />
      )}

      {creating && (
        <NewTaskModal
          stages={stages.filter((s) => s.id !== doneStageId)}
          initialStage={creating}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
