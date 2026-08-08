import {
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
import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import {
  Accessibility,
  defaultPreset,
  Feedback,
  PointerActivationConstraints,
} from "@dnd-kit/dom";
import { resolveBoardDrop } from "./board-dnd";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import {
  checksPill,
  prStatePill,
  reviewPill,
} from "~/features/github/github-pills";
import { LocalRelative } from "~/ui/local-time";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  boardEmptyCopy,
  countArchived,
  isArchived,
  isBoardFilterId,
  matchesBoardFilter,
  matchesSearch,
  shortBranch,
  type BoardFilterId,
} from "./board-filters";

/**
 * Board view over the task projections. Stage transitions are governed
 * actions rather than drag and drop.
 *   - filter/view/search live in URL params (survive refresh/share);
 *   - list view gains a minimal empty state (ruling 16);
 *   - re-scan toasts fire on real action completion, ".viberr" wording
 *     aligned to the real store (contracts §7.3);
 *   - create modal gets Escape/focus-trap/aria-modal and shows server
 *     errors in `foot-hint err` instead of closing;
 *   - P13-D-6: the card and the list row draw validation status (FR24) — the
 *     board used to filter on a signal it refused to render;
 *   - P13-D-34: empty states name the filter/search that is hiding tasks, the
 *     header count agrees with the columns, and one `Clear` chip resets both;
 *   - P13-D-10: failure toasts carry `kind: "error"`.
 */

export interface BoardStage {
  id: string;
  name: string;
  color: string;
}

/**
 * Gap-10: a board card's task, plus the two activity fields `listProjectTasks`
 * annotates every summary with (`TaskActivitySummary` in board-query.server.ts).
 *
 * They are OPTIONAL here for one reason only: `routes/project.tsx` re-types the
 * columns through `annotate: (t: TaskSummary): TaskSummary`, which erases them
 * from the type while the spread carries the values through at runtime. The
 * one-line patch that restores the type is in this pass's report; until it
 * lands, `undefined` means "no loader annotated this" and reads as "not quiet",
 * which is the safe direction — a missing signal must never invent a cue.
 */
export interface BoardTask extends TaskSummary {
  lastActivityAt?: string | null;
  quiet?: boolean;
}

export interface BoardColumnData {
  stage: BoardStage;
  tasks: BoardTask[];
}

/** Data carried by every card sortable so the drag handlers can refine the
 *  insertion slot without global lookups. */
interface CardDragData {
  nextKey: string | null;
  [key: string]: unknown;
}

/* Drag-and-drop configuration (dnd-kit).
 *
 * The whole card stays the drag surface — no grip handle. A small pointer
 * distance keeps plain clicks navigating to the task; touch requires a short
 * press so column scrolling is not hijacked. Escape cancels a lifted drag. */
const BOARD_SENSORS = [
  PointerSensor.configure({
    // The card face is a Link, and the sensor's default refuses to lift from
    // inside interactive elements — which would demand a grip handle. Only
    // real controls (the StageMenu button) opt out of dragging.
    preventActivation: (event: PointerEvent) => {
      const target = event.target;
      return (
        target instanceof Element &&
        Boolean(target.closest("button, input, select, textarea"))
      );
    },
    // Mouse is distance-only (the default's hold-to-lift delay would swallow
    // a slow press-and-release on the link, which must stay a navigation);
    // touch keeps the long-press so column scrolling is never hijacked.
    activationConstraints: (event: PointerEvent) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];

/* No ARIA decoration on the cards: the plugin's role="button" on the card
 * wrapper nests the task link and StageMenu inside an interactive control
 * (axe: nested-interactive, serious). The board's accessible move path is,
 * and stays, the StageMenu (F10-25 — drag is pointer-only); dragging is a
 * pointer/touch enhancement on top of it. */
const BOARD_PLUGINS = defaultPreset.plugins.filter(
  (plugin) => plugin !== Accessibility,
);

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
    // R8-3: only the viewer who can act on the decision sees "waiting on you";
    // everyone else sees the honest project-wide "waiting on a human".
    return (
      <span className="wait-tag human">
        <Icon name="hand" />
        {task.waitingOnMe ? "waiting on you" : "waiting on a human"}
      </span>
    );
  }
  return null;
}

/**
 * Gap-10 — the "gone quiet" cue, and the board's only last-activity display.
 *
 * TONE, deliberately: a NEUTRAL pill, the same grey the `archived` chip uses,
 * and copy that states a fact rather than reaching a verdict. The board spends
 * its loud colours on states something asserted — blocked, inconsistency risk,
 * failing checks, a rejected PR. Going quiet is inferred from an ABSENCE of
 * events, so it earns a place on the card but not a colour that competes with a
 * real failure. The thresholds carry the "don't cry wolf" weight instead: a task
 * waiting on a human gets three days, so an overnight wait never draws this at
 * all (see task-activity.server.ts).
 *
 * It renders ONLY past the threshold. A relative stamp on every card would be
 * history on a surface whose principle is "status before history"; here the
 * elapsed time IS the status, and only when it has become one.
 */
function QuietTag({ task }: { task: BoardTask }) {
  if (!task.quiet || !task.lastActivityAt) return null;
  return (
    <Pill kind="neutral" sm>
      {/* LocalRelative, not a bare format call: relative text depends on NOW,
          so the SSR pass and hydration can straddle a minute boundary. It
          renders a non-breaking space for one frame and fills in after
          hydration (app/ui/local-time.tsx). */}
      no activity · <LocalRelative iso={task.lastActivityAt} />
    </Pill>
  );
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
      <span className="avatar ghost">
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
  index,
  canTransition,
  arrived,
  allStages,
  onMoveTask,
}: {
  task: BoardTask;
  /** The key of the card immediately below this one (null when last) — used to
   *  resolve "drop below this card" into an insertion slot. */
  nextKey: string | null;
  /** Visible position within the column (sortable registration). */
  index: number;
  /** admin|maintainer — makes the card draggable between stage columns. */
  canTransition: boolean;
  /** This card just landed here from a drop (plays the arrival pulse). */
  arrived: boolean;
  /** F10-25: all stages, for the keyboard-accessible "Move to stage" menu. */
  allStages: BoardStage[];
  onMoveTask: (taskKey: string, toStageId: string) => void;
}) {
  // F19-8: an archived task is abandoned work kept for the record — it owes
  // nobody a verdict and nobody is waiting on it. UXO-1 removed the live
  // readiness/validation pills from the task hero for exactly that reason, but
  // the board kept drawing them, so a task archived mid-review still read
  // "ready · awaiting verdict · waiting on a human" directly beneath the banner
  // calling it abandoned. It also kept a working Move control. Archived cards
  // now say only that they are archived, and they do not move.
  const archived = task.archived === true;
  const movable = canTransition && !archived;
  // The card is both drag source and drop target (insert-before-this-card).
  // Clone feedback keeps today's model: the original stays as a faded ghost
  // (`.dragging`) while a visual clone follows the pointer. Optimistic
  // sorting is OFF — the board never reorders client-side; the DropPreview
  // shows the requested slot and the server's answer is the only commit.
  const { ref, isDragSource } = useSortable<CardDragData>({
    id: task.key,
    group: task.stage,
    index,
    data: { nextKey },
    disabled: !movable,
    plugins: (defaults) => [
      ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
      Feedback.configure({ feedback: "clone" }),
    ],
  });
  const cls = ["card"];
  if (task.waiting === "human" && !archived) cls.push("wait-human");
  if (task.urgent && !archived) cls.push("urgent");
  const wrapCls = ["card-wrap"];
  if (movable) wrapCls.push("draggable");
  if (isDragSource) wrapCls.push("dragging");
  if (arrived) wrapCls.push("just-arrived");
  return (
    <div className={wrapCls.join(" ")} ref={ref}>
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
          {/* F15-09: this slot used to swap in a second "agent working" pill
              whenever the card's foot was ALREADY drawing one via WaitTag —
              the same claim twice, at the cost of the readiness the slot
              exists for. Readiness here, wait state in the foot, once each. */}
          {archived ? (
            <Pill kind="neutral" sm>
              archived
            </Pill>
          ) : (
            <ReadinessPill value={task.displayReadiness} sm />
          )}
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
          {/* R16-6 (owner ruling, 2026-08-04): merge stays human-only, so a
              full-autonomy task reaches the done stage with its PR still open —
              `pr.state: "accepted"` is exactly "a human accepted the completion
              but the real merge is still pending". The card drew that as the
              green "accepted" readiness pill and a stateless "#124" chip, which
              is what a merged task looks like too. Done meant two things and the
              card showed one.

              The closed case is the same omission from the other side (live
              finding H10): closing PR #124 unmerged produced a decision packet,
              a "PR closed" badge and a divergence notification on the DETAIL
              page, while the card still read "ready · awaiting verdict".

              Both earn a pill under this card's density rule (only ACTIONABLE
              state, per the checks/review pills below): each names work that
              cannot finish without a human. `merged` and `review` stay silent —
              the readiness pill and the PR chip already carry those.

              The vocabulary comes from `prStatePill`, the one PR-state → pill
              mapping the GitHub view and the task branch panel already read.
              Restating it here is how "merge pending" would come to mean one
              thing on the card and another two screens away. */}
          {(task.pr?.state === "accepted" || task.pr?.state === "closed") && (
            <Pill kind={prStatePill(task.pr.state).kind} sm>
              {prStatePill(task.pr.state).label}
            </Pill>
          )}
          {/* P13-D-28: CI health, but only when it is ACTIONABLE. The card is
              already dense and "N checks passing" is not news; a failing build
              on a task sitting in Review is. The full passing/running/failing
              set renders on the task page and the GitHub view. */}
          {task.prChecks?.state === "failing" && (
            <Pill kind={checksPill(task.prChecks).kind} sm>
              {checksPill(task.prChecks).label}
            </Pill>
          )}
          {/* Same rule for GitHub's own review state — a teammate asking for
              changes on the PR is the case a supervisor needs off the board. */}
          {task.prReview === "changes_requested" && (
            <Pill kind={reviewPill(task.prReview).kind} sm>
              {reviewPill(task.prReview).label}
            </Pill>
          )}
          {/* P13-D-6 (FR24): the card drew stage, agent and waiting state but
              NOT validation — while the "Blocked or waiting" filter matched on it.
              A reviewer's request_changes sets validation:"failing" and the card
              was pixel-identical to a healthy one. Deliberate departure from the
              HTML mock (design/html-app/app/board.jsx), which omits it too.
              "none" stays silent so the card keeps its density; placement
              mirrors the review queue's `.rq-meta` (PR → validation → wait). */}
          {task.validation !== "none" && !archived && (
            <ValidationPill value={task.validation} sm />
          )}
          {/* Gap-10. Archived is already excluded server-side (`isQuiet` refuses
              archived and terminal tasks outright — R14-3 / F19-8 / UXO-1), and
              `!archived` here is the same second belt the pills above use. */}
          {!archived && <QuietTag task={task} />}
          {!archived && <WaitTag task={task} />}
        </div>
      </Link>
      {/* F10-25: keyboard-accessible stage move (drag is pointer-only). Sibling
          of the Link so it never triggers navigation; opens the same
          keyboard-navigable StageMenu the task-detail panel uses. */}
      {movable && (
        <div className="card-move">
          <StageMenu
            stages={allStages}
            currentStageId={task.stage}
            onSelect={(stageId) => onMoveTask(task.key, stageId)}
          />
        </div>
      )}
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
  arrivedKey,
  dropTarget,
  previewTask,
  beforeKey,
  allStages,
  onMoveTask,
  emptyCopy,
}: {
  stage: BoardStage;
  tasks: BoardTask[];
  /** Header count — optimistically adjusted during a cross-column drag. */
  count: number;
  /** P13-D-34: filter/search-aware empty copy for this column. */
  emptyCopy: string;
  isDone: boolean;
  canCreate: boolean;
  canTransition: boolean;
  onNew: () => void;
  arrivedKey: string | null;
  /** This column is the current drop target (highlight + show the preview). */
  dropTarget: boolean;
  previewTask: BoardTask | null;
  /** Insertion slot: render the preview before this card (null = column end). */
  beforeKey: string | null;
  allStages: BoardStage[];
  onMoveTask: (taskKey: string, toStageId: string) => void;
}) {
  // Explicit column target so empty stages (and the blank space under the
  // cards) accept drops. Priority 1 (Low) — an over-card collision (Normal, 2)
  // always wins over the containing column.
  const { ref } = useDroppable({
    id: `stage:${stage.id}`,
    collisionPriority: 1,
  });
  const showPreview = dropTarget && previewTask !== null;
  const preview = showPreview ? <DropPreview task={previewTask!} /> : null;
  return (
    <section
      className={"column" + (dropTarget ? " drop-over" : "")}
      ref={ref}
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
          showPreview ? preview : <div className="empty">{emptyCopy}</div>
        ) : (
          <>
            {tasks.map((t, i) => (
              <Fragment key={t.key}>
                {showPreview && beforeKey === t.key && preview}
                <TaskCard
                  task={t}
                  nextKey={tasks[i + 1]?.key ?? null}
                  index={i}
                  canTransition={canTransition}
                  arrived={arrivedKey === t.key}
                  allStages={allStages}
                  onMoveTask={onMoveTask}
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
  canTransition,
  onMoveTask,
  emptyCopy,
}: {
  tasks: BoardTask[];
  stages: BoardStage[];
  /** P13-D-34: filter/search-aware empty copy (the list has ONE empty state). */
  emptyCopy: string;
  /** UI-58: the list view rendered NO move control at all, so drag-and-drop had
   *  no keyboard equivalent here — the StageMenu (the board's accessible move
   *  affordance) only existed on cards. */
  canTransition: boolean;
  onMoveTask: (taskKey: string, toStageId: string) => void;
}) {
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="board list">
      <div className="board-list">
        {tasks.length === 0 && <div className="empty">{emptyCopy}</div>}
        {tasks.map((t) => {
          // F19-8: same archived contract as the card — an archived row states
          // that it is archived and nothing else, and it does not move.
          const archived = t.archived === true;
          const movable = canTransition && !archived;
          return (
          <div
            key={t.key}
            className="card list-row"
          >
            <Link
              className="key"
              to={`/projects/${t.projectSlug}/tasks/${t.key}`}
            >
              {t.key}
            </Link>
            <h3>
              <Link to={`/projects/${t.projectSlug}/tasks/${t.key}`}>
                {t.title}
              </Link>
            </h3>
            {/* UI-58: the same StageMenu the cards use — the list view's
                keyboard equivalent for drag-and-drop. */}
            {movable ? (
              <StageMenu
                stages={stages}
                currentStageId={t.stage}
                onSelect={(stageId) => onMoveTask(t.key, stageId)}
              />
            ) : (
              <span className="pill neutral sm">{stageName(t.stage)}</span>
            )}
            <OwnerLine task={t} />
            <ReviewerStack task={t} label />
            {archived ? (
              <Pill kind="neutral" sm>
                archived
              </Pill>
            ) : (
              <>
                {/* F15-09: same duplicate as the card — the row's own WaitTag
                    below already says "agent working". */}
                <ReadinessPill value={t.displayReadiness} sm />
                {/* F19-13: the row dropped the merge-pending / closed-PR pills
                    the card carries, so the SAME task read "needs a human to
                    merge" on the board and said nothing in the list. One board,
                    two views, one vocabulary — `prStatePill` again. */}
                {(t.pr?.state === "accepted" || t.pr?.state === "closed") && (
                  <Pill kind={prStatePill(t.pr.state).kind} sm>
                    {prStatePill(t.pr.state).label}
                  </Pill>
                )}
                {/* UXV19-6: the unfinished half of F19-13. The card foot draws
                    two more pills under its ACTIONABLE-state rule — a failing
                    build (P13-D-28) and GitHub's `changes_requested` — and the
                    list row drew neither, so the same task read "3/5 checks
                    failing · changes requested" in Board view and said nothing
                    one click later in List. Nothing else on the row can stand
                    in: `validation` is task-row state with no CI input, and the
                    "Blocked or waiting" filter does not select on prChecks or
                    prReview either. The row's deliberate reductions stay
                    reduced (no branch chip, no `#124` PR chip) — trace is not
                    actionable state; these two are. Card order throughout:
                    PR state → checks → review → validation → wait. */}
                {t.prChecks?.state === "failing" && (
                  <Pill kind={checksPill(t.prChecks).kind} sm>
                    {checksPill(t.prChecks).label}
                  </Pill>
                )}
                {t.prReview === "changes_requested" && (
                  <Pill kind={reviewPill(t.prReview).kind} sm>
                    {reviewPill(t.prReview).label}
                  </Pill>
                )}
                {/* P13-D-6: same omission in the list row — readiness cannot
                    stand in for validation (deriveReadiness folds only parse
                    diagnostics). Ordered readiness → validation, as task
                    detail. */}
                {t.validation !== "none" && (
                  <ValidationPill value={t.validation} sm />
                )}
                {/* Gap-10: same order as the card (PR state → checks → review →
                    validation → quiet → wait). UXV19-6's rule — one board, two
                    views, one vocabulary — is why this is not card-only. */}
                <QuietTag task={t} />
                <WaitTag task={t} />
              </>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- New task modal (board spec §4.6) ---------- */

/**
 * B1 — the board's acceptance confirm.
 *
 * A human moving a card into the FINAL stage is not a bare move: the server
 * routes it through the full acceptance contract, which attempts a real **PR
 * merge** (`reorderTask` → `acceptCompletion`, task-actions.server.ts). Task
 * detail has always confirmed that ("Merging is one-way"), but the board's drag
 * and its keyboard Move menu committed it straight from the gesture, so the
 * most irreversible action in the product was also its most casual one. Ruling
 * 20 / FR27 want the dialog on EVERY acceptance path.
 *
 * The board doesn't hold the PR/verdict detail the task-detail dialog shows, so
 * this states what it can promise honestly and points at the task for the rest.
 */
function AcceptOnBoardConfirm({
  taskKey,
  stageName,
  onCancel,
  onConfirm,
}: {
  taskKey: string;
  stageName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  return (
    <dialog className="modal-card modal-narrow" aria-label="Accept completion" ref={panelRef}>
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="check" />
        </span>
        <div className="mh-main">
          <h2>Accept {taskKey}?</h2>
          <div className="mh-sub">
            Moving a task into {stageName} accepts its completion — Viberr
            merges the review pull request when GitHub is reachable, and records
            the acceptance on the timeline. Merging is one-way.
          </div>
        </div>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-foot">
        <span className="fine xs dim">
          Open {taskKey} to see the pull request, revision and verdict first.
        </span>
        <button type="button" className="btn ghost" onClick={close}>
          Not yet
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          Accept → {stageName}
        </button>
      </div>
    </dialog>
  );
}

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
  const { ref: panelRef, close } = useDialog(onClose);
  const busy = fetcher.state !== "idle";
  const closedRef = useRef(false);

  const valid = title.trim().length >= 3;
  // The dialog opened on an empty title, so `!valid` was true from first paint
  // and the footer greeted every new task with "A title is required." — an error
  // for something the person had not had a chance to do yet. The requirement is
  // only *unmet* once they have left the field or tried to submit.
  const [titleTouched, setTitleTouched] = useState(false);
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
    setTitleTouched(true);
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
    <dialog
      className="modal-card modal-narrow"
      aria-label="New task"
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
          onClick={close}
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
            onBlur={() => setTitleTouched(true)}
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
                aria-pressed={stg === s.id}
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
        <span
          className={
            "foot-hint" + (serverError || (titleTouched && !valid) ? " err" : "")
          }
        >
          {serverError
            ? serverError
            : titleTouched && !valid
              ? "A title is required."
              : "The task key is assigned on create."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
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
    </dialog>
  );
}

/* ---------- Board ---------- */

const FILTERS: { id: BoardFilterId; label: string; icon: IconName }[] = [
  { id: "all", label: "All tasks", icon: "board" },
  { id: "human", label: "Waiting on me", icon: "hand" },
  { id: "agent", label: "Agent working", icon: "cpu" },
  // R16-2: "Needs attention" read as a danger filter and matched only alarming
  // states; the owner ruling renames it to what it selects — work that cannot
  // proceed (blocked, waiting on an answer, failing validation, urgent, or a
  // rejected PR). See matchesBoardFilter.
  { id: "risk", label: "Blocked or waiting", icon: "alert" },
  // Gap-10: the board is a triage console whose job is to say what needs a
  // human, and a task that stopped producing events looked exactly like one
  // being worked — right down to the pulsing "agent working" dot. This chip is
  // the way to ask for them. Named for what it selects (R16-2), and named
  // "quiet" rather than "stalled" because the detector observes an absence of
  // events; it does not diagnose a fault.
  { id: "quiet", label: "Gone quiet", icon: "clock" },
  // R14-3: archived tasks are out of every other view; this is the way back to
  // them. The chip only renders when the project has any (see FilterBar).
  { id: "archived", label: "Archived", icon: "lock" },
];

function BoardHeader({
  shownCount,
  taskCount,
  waitingHuman,
  group,
  canCreate,
  canRescan,
  setParam,
  onRescan,
  onNew,
}: {
  /** P13-D-34: tasks the columns actually draw (filter + search applied). */
  shownCount: number;
  taskCount: number;
  waitingHuman: number;
  group: "stage" | "list";
  canCreate: boolean;
  canRescan: boolean;
  setParam: (key: string, value: string | null) => void;
  onRescan: () => void;
  onNew: () => void;
}) {
  // P13-D-34: this count was the UNFILTERED total while the column heads were
  // filtered, so the page could read "12 tasks · 3 waiting on a human decision"
  // above five columns all saying "No tasks". Filtered → "N of M"; the total
  // stays on screen so the filter never looks like data loss. The
  // "waiting on a human decision" stat stays project-wide and unscoped
  // (deliberate — see the `waitingHuman` comment below).
  const countLine =
    shownCount === taskCount
      ? `${taskCount} task${taskCount === 1 ? "" : "s"}`
      : `${shownCount} of ${taskCount} task${taskCount === 1 ? "" : "s"}`;
  return (
    <div className="board-head">
      <div>
        <h1>Board</h1>
        {/* P14-WL-04: three surfaces counted "waiting" at three different
            scopes and none said which — Home said "5 decisions waiting on you"
            (org-wide, viewer-scoped), this line said "4 waiting on a human
            decision" (project-wide, anyone) and Agents said "6 threads waiting
            on a human" (engagements, not tasks). Each number was right; the
            reader had no way to know they answered different questions. Every
            one of them now names its scope. */}
        <div className="sub">
          {countLine} · {waitingHuman} waiting on a human decision in this
          project
        </div>
      </div>
      <div className="board-tools">
        {/* UI-58: selection was carried by the `on` class alone — the board's
            own filter chips already use `aria-pressed`, so this was an
            omission, not a convention. */}
        <div className="seg" role="group" aria-label="Board layout">
          <button
            type="button"
            className={group === "stage" ? "on" : ""}
            aria-pressed={group === "stage"}
            onClick={() => setParam("view", null)}
          >
            <Icon name="board" />
            Board
          </button>
          <button
            type="button"
            className={group === "list" ? "on" : ""}
            aria-pressed={group === "list"}
            onClick={() => setParam("view", "list")}
          >
            <Icon name="review" />
            List
          </button>
        </div>
        {canRescan && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={onRescan}
            title="Reconcile the board with the file-native store"
          >
            <Icon name="refresh" />
            Re-scan
          </button>
        )}
        {canCreate && (
          <button type="button" className="btn primary sm" onClick={onNew}>
            <Icon name="plus" />
            New task
          </button>
        )}
      </div>
    </div>
  );
}

function FilterBar({
  filter,
  query,
  waitingOnMe,
  quiet,
  archived,
  setParam,
  onClear,
}: {
  filter: BoardFilterId;
  /** Board filter term (`?q=`) — it hides cards exactly like the chips do. */
  query: string;
  /** R8-3: member-scoped count for the "Waiting on me" chip. */
  waitingOnMe: number;
  /** Gap-10: live tasks that have gone quiet — the "Gone quiet" chip's tally. */
  quiet: number;
  /** R14-3: archived tasks in this project — the chip is the only way back to
   *  them, so it renders only when there are any (and always while it is on). */
  archived: number;
  setParam: (key: string, value: string | null) => void;
  onClear: () => void;
}) {
  return (
    <div className="filter-bar">
      {FILTERS.filter(
        (f) => f.id !== "archived" || archived > 0 || filter === "archived",
      ).map((f) => (
        <button
          type="button"
          key={f.id}
          className={"fchip" + (filter === f.id ? " on" : "")}
          aria-pressed={filter === f.id}
          onClick={() => setParam("filter", f.id === "all" ? null : f.id)}
        >
          <Icon name={f.icon} />
          {f.label}
          {f.id === "human" && waitingOnMe > 0 && (
            <span className="tally">· {waitingOnMe}</span>
          )}
          {f.id === "quiet" && quiet > 0 && (
            <span className="tally">· {quiet}</span>
          )}
          {f.id === "archived" && archived > 0 && (
            <span className="tally">· {archived}</span>
          )}
        </button>
      ))}
      {/* R15-5: the term input lives on the BOARD now. The topbar's box read
          "Search tasks, branches, agents…" while only ever filtering the open
          board; the global question moved to the ⌘K palette and this one says
          exactly what it does. */}
      <label className="board-filter-input">
        <Icon name="filter" />
        <input
          type="search"
          value={query}
          placeholder="Filter this board…"
          aria-label="Filter this board"
          onChange={(e) => setParam("q", e.target.value || null)}
        />
      </label>
      {/* P13-D-34: the board's clear-filter affordance. "All tasks" resets the
          filter but NOT `?q=`, so a board hidden by a stale term needs one
          control that resets both. One chip per board, not one per column. */}
      {(filter !== "all" || query.trim() !== "") && (
        <button
          type="button"
          className="fchip"
          onClick={onClear}
          title="Show every task again — clears the board filter and the search"
        >
          <Icon name="x" />
          Clear
        </button>
      )}
    </div>
  );
}

function OrphanBanner({ orphanTasks }: { orphanTasks: TaskSummary[] }) {
  return (
    <div className="board-orphans" role="region" aria-label="Unstaged tasks">
      <Icon name="alert" />
      <span className="board-orphans-label">
        {orphanTasks.length} unstaged{" "}
        {orphanTasks.length === 1 ? "task" : "tasks"} — the stage in the file
        doesn't match any board column. Fix the task file to place it.
      </span>
      <span className="board-orphans-keys">
        {orphanTasks.map((t) => (
          <Link
            key={t.key}
            to={`tasks/${t.key}`}
            className="board-orphan-key"
            title={t.title}
          >
            {t.key}
          </Link>
        ))}
      </span>
    </div>
  );
}

function StageBoard({
  columns,
  visible,
  doneStageId,
  canCreate,
  canTransition,
  onNew,
  drag,
  overStage,
  beforeKey,
  arrivedKey,
  draggedTask,
  onMoveTask,
  emptyCopyFor,
}: {
  columns: BoardColumnData[];
  visible: (tasks: BoardTask[]) => BoardTask[];
  /** P13-D-34: per-column empty copy, given that column's UNFILTERED total. */
  emptyCopyFor: (total: number, isEntryColumn?: boolean) => string;
  doneStageId: string | undefined;
  canCreate: boolean;
  canTransition: boolean;
  onNew: (stageId: string) => void;
  drag: { key: string; fromStage: string } | null;
  overStage: string | null;
  beforeKey: string | null;
  arrivedKey: string | null;
  draggedTask: BoardTask | null;
  /** F10-25: the StageMenu move — the always-available non-drag path. */
  onMoveTask: (taskKey: string, toStageId: string) => void;
}) {
  // All stages, for the per-card keyboard "Move to stage" menu (F10-25).
  const allStages = columns.map((c) => c.stage);
  return (
    <div className="board">
      {columns.map((c, columnIndex) => {
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
            emptyCopy={emptyCopyFor(c.tasks.length, columnIndex === 0)}
            isDone={c.stage.id === doneStageId}
            canCreate={canCreate}
            canTransition={canTransition}
            onNew={() => onNew(c.stage.id)}
            arrivedKey={arrivedKey}
            dropTarget={hovered}
            previewTask={hovered ? draggedTask : null}
            beforeKey={beforeKey}
            allStages={allStages}
            onMoveTask={onMoveTask}
          />
        );
      })}
    </div>
  );
}

export function BoardPage({
  columns,
  orphanTasks,
  canCreate,
  canTransition,
  canRescan,
}: {
  columns: BoardColumnData[];
  orphanTasks: BoardTask[];
  canCreate: boolean;
  /** admin|maintainer — enables the per-card stage-move dropdown. */
  canTransition: boolean;
  /** Holders of `rescan-project` (admin|maintainer) — the server-checked gate
   *  for Re-scan; kept distinct from canTransition so the two can't drift. */
  canRescan: boolean;
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
  /** B1: a move into the final stage waits here for an explicit confirmation. */
  const [pendingAccept, setPendingAccept] = useState<{
    taskKey: string;
    to: string;
    beforeKey: string;
  } | null>(null);
  const finalStageId = columns[columns.length - 1]?.stage.id;
  const finalStageName = columns[columns.length - 1]?.stage.name ?? "Done";
  const moveDone = useRef<unknown>(null);

  // dnd-kit event flow → the same drag state machine the visuals always used.
  // A card target proposes "insert before that card"; onDragMove refines it
  // against the pointer's vertical midpoint (top half → before it, bottom
  // half → before the next one). Keyboard drags get no move events, so the
  // card-target proposal stands as-is — deterministic and announced.
  const onDragStart = (event: DragStartEvent) => {
    const key = String(event.operation.source?.id ?? "");
    const t = allTasks.find((x) => x.key === key);
    if (!t) return;
    setDrag({ key, fromStage: t.stage });
    setOverStage(t.stage);
    setBeforeKey(null);
  };
  const onDragOver = (event: DragOverEvent) => {
    const target = event.operation.target;
    if (!target) {
      setOverStage(null);
      setBeforeKey(null);
      return;
    }
    const id = String(target.id);
    if (id.startsWith("stage:")) {
      // Column body / empty space: default to the end until a card refines it.
      setOverStage(id.slice("stage:".length));
      setBeforeKey(null);
      return;
    }
    const t = allTasks.find((x) => x.key === id);
    if (!t) return;
    setOverStage(t.stage);
    setBeforeKey(id);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const target = event.operation.target;
    if (!target || String(target.id).startsWith("stage:")) return;
    const element = target.element;
    const y = event.operation.position.current.y;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const key = String(target.id);
    const nextKey =
      (target.data as Partial<CardDragData> | undefined)?.nextKey ?? null;
    const before = y < rect.top + rect.height / 2 ? key : nextKey;
    setBeforeKey((prev) => (prev === before ? prev : before));
  };
  // Fires on drop AND cancel (Escape, released outside a column). The server
  // stays authoritative: nothing commits client-side; a resolved drop submits
  // the governed reorder and revalidation applies the server's order.
  const onDragEnd = (event: DragEndEvent) => {
    const active = drag;
    setDrag(null);
    setOverStage(null);
    setBeforeKey(null);
    if (!active || event.canceled) return;
    const resolution = resolveBoardDrop({
      dragKey: active.key,
      fromStage: active.fromStage,
      overStage,
      beforeKey,
      columns: columns.map((c) => ({
        stageId: c.stage.id,
        keys: visible(c.tasks).map((t) => t.key),
      })),
    });
    if (!resolution) return;
    // B1: landing in the FINAL stage is an acceptance (real merge attempt), not
    // a move — confirm before committing it, like every other acceptance path.
    if (resolution.to === finalStageId && active.fromStage !== finalStageId) {
      setPendingAccept({
        taskKey: active.key,
        to: resolution.to,
        beforeKey: resolution.beforeKey ?? "",
      });
      return;
    }
    setArrivedKey(active.key);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", active.key);
    fd.set("to", resolution.to);
    fd.set("beforeKey", resolution.beforeKey ?? "");
    transitionFetcher.submit(fd, { method: "post" });
  };

  /** Commit a confirmed board acceptance (B1). */
  const submitReorder = (taskKey: string, to: string, beforeKey: string) => {
    setArrivedKey(taskKey);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", taskKey);
    fd.set("to", to);
    fd.set("beforeKey", beforeKey);
    transitionFetcher.submit(fd, { method: "post" });
  };

  // F10-25: keyboard-accessible move — the SAME governed transition the drop
  // uses, appending to the end of the target stage. A no-op when unchanged.
  const onMoveTask = (taskKey: string, toStageId: string) => {
    const fromStage = columns.find((c) =>
      c.tasks.some((t) => t.key === taskKey),
    )?.stage.id;
    if (fromStage === toStageId) return;
    // B1: the keyboard path reaches the same acceptance the drag does.
    if (toStageId === finalStageId) {
      setPendingAccept({ taskKey, to: toStageId, beforeKey: "" });
      return;
    }
    submitReorder(taskKey, toStageId, "");
  };

  // Toast on completion (and drop the pulse if the move was rejected).
  useEffect(() => {
    if (transitionFetcher.state !== "idle" || !transitionFetcher.data) return;
    if (moveDone.current === transitionFetcher.data) return;
    moveDone.current = transitionFetcher.data;
    const d = transitionFetcher.data;
    if (d.ok && d.toast) push(d.toast);
    else if (!d.ok && d.error) {
      // P13-D-10: a REJECTED stage transition is the worst place to render a
      // success tick — the card snaps back and the toast said "done".
      push(d.error, "error");
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
  // Subtitle stat: project-wide "waiting on a human decision" (the subtitle
  // labels that scope — P14-WL-04). Archived tasks are a terminal disposition
  // and never wait on anyone, so they are out of both counts (R14-3).
  const liveTasks = allTasks.filter((t) => !isArchived(t));
  const waitingHuman = liveTasks.filter((t) => t.waiting === "human").length;
  // R8-3: the "Waiting on me" chip is member-scoped — decisions THIS viewer can act on.
  const waitingOnMe = liveTasks.filter((t) => t.waitingOnMe).length;
  // Gap-10: counted over LIVE tasks for the same reason the two above are —
  // `isQuiet` already refuses archived and terminal tasks, and this keeps the
  // chip's tally reading the same population its filter draws.
  const quietCount = liveTasks.filter((t) => t.quiet === true).length;
  const archivedCount = countArchived(allTasks);
  // The card in flight (for the drop-preview shown in the hovered column).
  const draggedTask = drag
    ? (allTasks.find((t) => t.key === drag.key) ?? null)
    : null;

  const visible = (tasks: BoardTask[]) =>
    tasks.filter(
      (t) => matchesBoardFilter(t, filter) && matchesSearch(t, query),
    );

  // P13-D-34: what the board actually draws, and why anything is missing.
  const shownCount = visible(allTasks).length;
  const filterLabel =
    filter === "all"
      ? null
      : (FILTERS.find((f) => f.id === filter)?.label ?? null);
  // R15-10: `boardTotal` lets the copy tell "this column is empty" apart from
  // "this project has nothing yet"; only the latter teaches, and only once.
  const emptyCopyFor = (total: number, isEntryColumn = false) =>
    boardEmptyCopy({
      total,
      filterLabel,
      query,
      // LIVE, not all: archived tasks render on no column under any normal
      // filter, so counting them makes an empty board look occupied — which is
      // exactly what a strict project holding one archived task did.
      boardTotal: liveTasks.length,
      isEntryColumn,
    });

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

  // P13-D-34: reset BOTH hiding mechanisms in one history entry.
  const clearFilters = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("filter");
        next.delete("q");
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
    if (rescanFetcher.state === "idle" && rescanFetcher.data && !rescanDone.current) {
      rescanDone.current = true;
      // Surface BOTH outcomes — a swallowed {ok:false} (e.g. a role 403) used to
      // leave the "Re-scanning…" toast as the last word (MU-3).
      push(
        rescanFetcher.data.ok
          ? "Re-scan complete — board matches the file-native store"
          : (rescanFetcher.data.error ?? "Re-scan failed."),
        // P13-D-10: same handler, both outcomes — the failure branch used to
        // borrow the success glyph.
        rescanFetcher.data.ok ? "success" : "error",
      );
    }
  }, [rescanFetcher.state, rescanFetcher.data, push]);

  return (
    <div className="board-wrap" data-screen-label="Board">
      <BoardHeader
        shownCount={shownCount}
        // R14-3: the denominator follows the view. On the Archived filter the
        // population IS the archived set, so "2 of 2" reads true instead of
        // measuring archived cards against a live-task total they left.
        taskCount={filter === "archived" ? archivedCount : liveTasks.length}
        waitingHuman={waitingHuman}
        group={group}
        canCreate={canCreate}
        canRescan={canRescan}
        setParam={setParam}
        onRescan={rescan}
        // UI-58: `?? "triage"` was a magic literal for a project with no stages
        // — a create that could only fail server-side. With no stages there is
        // nothing to create INTO, so the header hides the control instead.
        onNew={() => {
          const entry = stages[0]?.id;
          if (entry) setCreating(entry);
        }}
      />

      <FilterBar
        filter={filter}
        query={query}
        waitingOnMe={waitingOnMe}
        quiet={quietCount}
        archived={archivedCount}
        setParam={setParam}
        onClear={clearFilters}
      />

      {filter === "archived" && (
        <div className="board-orphans" role="status">
          <Icon name="lock" />
          <span className="board-orphans-label">
            Archived tasks — abandoned work kept for the record. Their timelines
            and audit are intact, they are out of the review queue, and a
            maintainer can restore one from its task page.
          </span>
        </div>
      )}

      {orphanTasks.length > 0 && <OrphanBanner orphanTasks={orphanTasks} />}

      {group === "stage" ? (
        <DragDropProvider
          sensors={BOARD_SENSORS}
          plugins={BOARD_PLUGINS}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        >
          <StageBoard
            columns={columns}
            visible={visible}
            emptyCopyFor={emptyCopyFor}
            doneStageId={doneStageId}
            canCreate={canCreate}
            canTransition={canTransition}
            onNew={(stageId) => setCreating(stageId)}
            drag={drag}
            overStage={overStage}
            beforeKey={beforeKey}
            arrivedKey={arrivedKey}
            draggedTask={draggedTask}
            onMoveTask={onMoveTask}
          />
        </DragDropProvider>
      ) : (
        <ListView
          tasks={visible(allTasks)}
          stages={stages}
          canTransition={canTransition}
          onMoveTask={onMoveTask}
          emptyCopy={emptyCopyFor(allTasks.length, true)}
        />
      )}

      {creating && (
        <NewTaskModal
          stages={stages.filter((s) => s.id !== doneStageId)}
          initialStage={creating}
          onClose={() => setCreating(null)}
        />
      )}

      {/* B1: the acceptance a board move really performs, confirmed. */}
      {pendingAccept && (
        <AcceptOnBoardConfirm
          taskKey={pendingAccept.taskKey}
          stageName={finalStageName}
          onCancel={() => setPendingAccept(null)}
          onConfirm={() => {
            const p = pendingAccept;
            setPendingAccept(null);
            submitReorder(p.taskKey, p.to, p.beforeKey);
          }}
        />
      )}
    </div>
  );
}
