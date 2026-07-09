import {
  type DragEvent,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  nextKey,
  canTransition,
  dragging,
  arrived,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  task: TaskSummary;
  /** The key of the card immediately below this one (null when last) — used to
   *  resolve "drop below this card" into an insertion slot. */
  nextKey: string | null;
  /** admin|maintainer — makes the card draggable between stage columns. */
  canTransition: boolean;
  /** This card is the one being dragged (rendered as a faded ghost in place). */
  dragging: boolean;
  /** This card just landed here from a drop (plays the arrival pulse). */
  arrived: boolean;
  onDragStart: (task: TaskSummary, e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (task: TaskSummary, nextKey: string | null, e: DragEvent) => void;
}) {
  const cls = ["card"];
  if (task.waiting === "human") cls.push("wait-human");
  if (task.urgent) cls.push("urgent");
  const wrapCls = ["card-wrap"];
  if (canTransition) wrapCls.push("draggable");
  if (dragging) wrapCls.push("dragging");
  if (arrived) wrapCls.push("just-arrived");
  return (
    <div
      className={wrapCls.join(" ")}
      draggable={canTransition}
      onDragStart={canTransition ? (e) => onDragStart(task, e) : undefined}
      onDragEnd={canTransition ? onDragEnd : undefined}
      onDragOver={
        canTransition ? (e) => onDragOver(task, nextKey, e) : undefined
      }
    >
      <Link
        className={cls.join(" ")}
        to={`/projects/${task.projectSlug}/tasks/${task.key}`}
        // The wrapper carries the drag; the anchor must not start its own
        // (URL) drag, but a plain click still navigates.
        draggable={false}
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
    </div>
  );
}

/**
 * A ghost preview shown at the top of the column a card is being dragged over,
 * so the drop destination reads clearly (mirrors GitHub's board): the source
 * keeps a faded ghost, the target shows where the card will land.
 */
function DropPreview({ task }: { task: TaskSummary }) {
  return (
    <div className="card-drop-preview" aria-hidden="true">
      <span className="key">{task.key}</span>
      <span className="dp-title">{task.title}</span>
    </div>
  );
}

function Column({
  stage,
  tasks,
  count,
  isDone,
  canCreate,
  canTransition,
  onNew,
  draggingKey,
  arrivedKey,
  dropTarget,
  previewTask,
  beforeKey,
  onCardDragStart,
  onCardDragEnd,
  onCardDragOver,
  onColumnDragOver,
  onColumnDrop,
}: {
  stage: BoardStage;
  tasks: TaskSummary[];
  /** Header count — optimistically adjusted during a cross-column drag. */
  count: number;
  isDone: boolean;
  canCreate: boolean;
  canTransition: boolean;
  onNew: () => void;
  draggingKey: string | null;
  arrivedKey: string | null;
  /** This column is the current drop target (highlight + show the preview). */
  dropTarget: boolean;
  previewTask: TaskSummary | null;
  /** Insertion slot: render the preview before this card (null = column end). */
  beforeKey: string | null;
  onCardDragStart: (task: TaskSummary, e: DragEvent) => void;
  onCardDragEnd: () => void;
  onCardDragOver: (task: TaskSummary, nextKey: string | null, e: DragEvent) => void;
  onColumnDragOver: (stageId: string, e: DragEvent) => void;
  onColumnDrop: (stageId: string, e: DragEvent) => void;
}) {
  const showPreview = dropTarget && previewTask !== null;
  const preview = showPreview ? <DropPreview task={previewTask!} /> : null;
  return (
    <section
      className={"column" + (dropTarget ? " drop-over" : "")}
      onDragOver={(e) => onColumnDragOver(stage.id, e)}
      onDrop={(e) => onColumnDrop(stage.id, e)}
    >
      <header className="col-head">
        <span className="col-stage-dot" style={{ background: stage.color }} />
        <span className="nm">{stage.name}</span>
        <span className="ct">{count}</span>
        {!isDone && canCreate && (
          <button
            type="button"
            className="add"
            title="New task in this stage"
            aria-label="New task in this stage"
            onClick={onNew}
          >
            <Icon name="plus" />
          </button>
        )}
      </header>
      <div className="col-body">
        {tasks.length === 0 ? (
          showPreview ? preview : <div className="empty">No tasks</div>
        ) : (
          <>
            {tasks.map((t, i) => (
              <Fragment key={t.key}>
                {showPreview && beforeKey === t.key && preview}
                <TaskCard
                  task={t}
                  nextKey={tasks[i + 1]?.key ?? null}
                  canTransition={canTransition}
                  dragging={draggingKey === t.key}
                  arrived={arrivedKey === t.key}
                  onDragStart={onCardDragStart}
                  onDragEnd={onCardDragEnd}
                  onDragOver={onCardDragOver}
                />
              </Fragment>
            ))}
            {showPreview && beforeKey === null && preview}
          </>
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
      {/* Pointer-only shortcut — Escape (useDialog) and the Close button are
          the accessible paths, so the scrim stays out of the a11y tree. */}
      <div className="confirm-scrim" onClick={onClose} aria-hidden="true" />
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
            type="button"
            className="icon-btn modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="flabel" htmlFor="new-task-title">
              Title<span className="req">*</span>
            </label>
            <input
              id="new-task-title"
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
            {/* A chip-button group has no labelable control for htmlFor, so the
                name is attached via role=group (span.flabel per home-page.tsx). */}
            <span className="flabel" id="new-task-stage-label">
              Stage
            </span>
            <div
              className="pick-chips"
              role="group"
              aria-labelledby="new-task-stage-label"
            >
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
            <label className="flabel" htmlFor="new-task-goal">
              Goal
              <span className="fhint">
                what done means — the operator and specialists anchor on this
              </span>
            </label>
            <textarea
              id="new-task-goal"
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
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
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

  // Drag-and-drop stage moves. `drag` is the card in flight; `overStage` is the
  // column under the cursor. While a card is dragged across columns, the source
  // shows a faded ghost (`dragging`) and the target shows a drop preview + a +1
  // count; a drop fires the governed transition and the card pulses on arrival
  // (`arrivedKey`). One fetcher per board.
  const transitionFetcher = useFetcher<{
    ok: boolean;
    toast?: string;
    error?: string;
  }>();
  const [drag, setDrag] = useState<{ key: string; fromStage: string } | null>(
    null,
  );
  const [overStage, setOverStage] = useState<string | null>(null);
  // The card the dropped card should land immediately BEFORE (null = column end).
  const [beforeKey, setBeforeKey] = useState<string | null>(null);
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  const moveDone = useRef<unknown>(null);

  const onCardDragStart = (task: TaskSummary, e: DragEvent) => {
    setDrag({ key: task.key, fromStage: task.stage });
    setOverStage(task.stage);
    setBeforeKey(null);
    try {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require data to be set for a drag to begin (Firefox).
      e.dataTransfer.setData("text/plain", task.key);
    } catch {
      // dataTransfer unavailable — the drag still works via component state.
    }
  };
  // Fires on both a successful drop and a cancel (drop outside any column) —
  // clears the drag visuals, reverting the optimistic move on cancel.
  const onCardDragEnd = () => {
    setDrag(null);
    setOverStage(null);
    setBeforeKey(null);
  };
  // Per-card: the precise insertion slot from the pointer vs the card's vertical
  // midpoint (top half → before this card; bottom half → before the next one).
  const onCardDragOver = (
    task: TaskSummary,
    nextKey: string | null,
    e: DragEvent,
  ) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation(); // keep the column handler from coarsening the slot
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before =
      e.clientY < rect.top + rect.height / 2 ? task.key : nextKey;
    if (overStage !== task.stage) setOverStage(task.stage);
    if (beforeKey !== before) setBeforeKey(before);
  };
  // Column body / empty space: allow the drop; entering a NEW column defaults to
  // the end until a card refines the slot.
  const onColumnDragOver = (stageId: string, e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overStage !== stageId) {
      setOverStage(stageId);
      setBeforeKey(null);
    }
  };
  const onColumnDrop = (stageId: string, e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const { key, fromStage } = drag;
    const target = beforeKey;
    setDrag(null);
    setOverStage(null);
    setBeforeKey(null);
    // Same-stage no-op: dropped exactly where it already sits (before itself, or
    // before the card that already follows it).
    if (stageId === fromStage) {
      const orderedKeys = visible(
        columns.find((c) => c.stage.id === fromStage)?.tasks ?? [],
      ).map((t) => t.key);
      const di = orderedKeys.indexOf(key);
      const afterDragged = di >= 0 ? (orderedKeys[di + 1] ?? null) : null;
      if (target === key || target === afterDragged) return;
    }
    setArrivedKey(key);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", key);
    fd.set("to", stageId);
    fd.set("beforeKey", target ?? "");
    transitionFetcher.submit(fd, { method: "post" });
  };

  // Toast on completion (and drop the pulse if the move was rejected).
  useEffect(() => {
    if (transitionFetcher.state !== "idle" || !transitionFetcher.data) return;
    if (moveDone.current === transitionFetcher.data) return;
    moveDone.current = transitionFetcher.data;
    const d = transitionFetcher.data;
    if (d.ok && d.toast) push(d.toast);
    else if (!d.ok && d.error) {
      push(d.error);
      setArrivedKey(null);
    }
  }, [transitionFetcher.state, transitionFetcher.data, push]);

  // Retire the arrival pulse after it plays.
  useEffect(() => {
    if (!arrivedKey) return;
    const t = window.setTimeout(() => setArrivedKey(null), 1500);
    return () => window.clearTimeout(t);
  }, [arrivedKey]);

  const stages = columns.map((c) => c.stage);
  const doneStageId = stages[stages.length - 1]?.id;
  const allTasks = useMemo(
    () => [...columns.flatMap((c) => c.tasks), ...orphanTasks],
    [columns, orphanTasks],
  );
  const waitingHuman = allTasks.filter((t) => t.waiting === "human").length;
  // The card in flight (for the drop-preview shown in the hovered column).
  const draggedTask = drag
    ? (allTasks.find((t) => t.key === drag.key) ?? null)
    : null;

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
              type="button"
              className={group === "stage" ? "on" : ""}
              onClick={() => setParam("view", null)}
            >
              <Icon name="board" />
              Board
            </button>
            <button
              type="button"
              className={group === "list" ? "on" : ""}
              onClick={() => setParam("view", "list")}
            >
              <Icon name="review" />
              List
            </button>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={rescan}
            title="Reconcile the board with the file-native store"
          >
            <Icon name="refresh" />
            Re-scan
          </button>
          {canCreate && (
            <button
              type="button"
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
            type="button"
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
          {columns.map((c) => {
            const base = visible(c.tasks);
            // The hovered column is the drop target (same OR different stage).
            // Cross-column also shifts the counts: source −1, target +1.
            const hovered = !!drag && overStage === c.stage.id;
            const crossDrag =
              !!drag && overStage != null && overStage !== drag.fromStage;
            const isSource = crossDrag && c.stage.id === drag!.fromStage;
            const isTarget = crossDrag && c.stage.id === overStage;
            const count = base.length + (isTarget ? 1 : 0) - (isSource ? 1 : 0);
            return (
              <Column
                key={c.stage.id}
                stage={c.stage}
                tasks={base}
                count={count}
                isDone={c.stage.id === doneStageId}
                canCreate={canCreate}
                canTransition={canTransition}
                onNew={() => setCreating(c.stage.id)}
                draggingKey={drag?.key ?? null}
                arrivedKey={arrivedKey}
                dropTarget={hovered}
                previewTask={hovered ? draggedTask : null}
                beforeKey={beforeKey}
                onCardDragStart={onCardDragStart}
                onCardDragEnd={onCardDragEnd}
                onCardDragOver={onCardDragOver}
                onColumnDragOver={onColumnDragOver}
                onColumnDrop={onColumnDrop}
              />
            );
          })}
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
