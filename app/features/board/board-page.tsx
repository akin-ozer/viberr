import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
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
import {
  archivedTaskBlockedReason,
  closedPrBlockedReason,
  coercePriority,
  conflictingPrBlockedReason,
  PRIORITY_VALUES,
  type TaskPriority,
} from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { DatePicker } from "~/ui/date-picker";
import { Icon, type IconName } from "~/ui/icon";
import { LabelInput } from "~/ui/label-input";
import { AgentGlyph } from "~/ui/identity";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import {
  DueDatePill,
  LabelChips,
  PriorityFlag,
  hasVisibleMeta,
} from "~/ui/task-meta";
import {
  checksPill,
  prStatePill,
  reviewPill,
} from "~/features/github/github-pills";
import { AcceptConfirm } from "~/features/task-detail/accept-confirm";
import {
  acceptanceDisclosureFields,
  type AcceptanceDisclosure,
} from "~/shared/acceptance-disclosure";
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
  matchesLabelFilter,
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
 *   - P13-D-10: failure toasts carry `kind: "error"`;
 *   - D19 (ruling R19-10): arrow-key traversal over the cards, on a roving tab
 *     stop, in both layouts — see `onCardKeyDown` in `BoardPage`.
 */

export interface BoardStage {
  id: string;
  name: string;
  color: string;
}

/** D9: visually-hidden style for the board's `aria-live` announcement region.
 *  Inline for the same reason `skip-link.tsx` is — `app/app.css` carries no
 *  visually-hidden utility (and its stylesheet is another cluster's to change),
 *  so the region ships its own hiding. It must stay in the DOM (not `display:
 *  none`) for a screen reader to read updates into it. */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

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
type CardDragData = {
  nextKey: string | null;
};

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

/**
 * D19 (ruling R19-10) — the roving tab stop has to cover the card's Move
 * trigger, not only the card face.
 *
 * Every movable card and list row renders a `StageMenu` button, so the board
 * held 2N tab stops. Roving only the card faces would still leave N: Tab would
 * walk the Move buttons of cards the human never focused, and those are
 * `opacity: 0` until `:focus-within` (app.css), so the ring would appear on a
 * control that had been invisible a keystroke earlier. `StageMenu` is shared
 * with task detail and exposes no `tabIndex` prop, so the card wrapper sets it
 * on the one trigger it owns.
 *
 * Deliberately no dependency array: `StageMenu` re-renders its trigger on
 * open/busy/stage change, and React never writes `tabIndex` on that button, so
 * re-applying on every render is both necessary and free of any tug-of-war with
 * React's own attribute reconciliation.
 */
function useRovingStageMenu(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const btn = ref.current?.querySelector<HTMLButtonElement>(
      "button.stage-menu-btn",
    );
    if (btn) btn.tabIndex = active ? 0 : -1;
  });
  return ref;
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
 * F19-13 — the ACTIONABLE state block, drawn identically by BOTH board views.
 *
 * The card foot and the list row each hand-rolled their own subset: the card
 * drew the PR-state pill (R16-6 "merge pending" and the closed-PR risk pill),
 * the failing-checks pill and GitHub's "changes requested"; the list row drew
 * none of them. So a full-autonomy task whose Done still owes a human merge
 * read "merge pending" on the board and looked finished in the list — the same
 * stored state under two vocabularies, on one screen, one toggle apart. Ruling
 * 40 asks for exactly the opposite ("the difference must be visible on the board
 * card AND the review queue"), and rulings 12/14 say a mapping is never forked
 * per surface. One component, one answer, both views.
 *
 * F19-8: it is also the single place archived work goes quiet. Every signal here
 * asserts an OBLIGATION — a merge nobody will run, a verdict nobody owes, an
 * agent that is not working — and an archived task is abandoned work kept for
 * the record, under a banner that says so. The task hero made the same cut for
 * the same reason (UXO-1). The traceability chips beside this block (branch, PR
 * number) stay: "how far did this get?" is still a true question about an
 * archived task, exactly as the hero keeps its stage pill.
 *
 * Gap-10: the "gone quiet" cue lives here too, rendered between validation and
 * the wait tag. Putting it INSIDE this block means the archived-null return
 * above guards it for free — an archived task is a terminal disposition and is
 * never "quiet".
 */
function StateSignals({ task }: { task: BoardTask }) {
  if (isArchived(task)) return null;
  // C2 (⇄ N20-14 / UXO-1): the validation pill asserts a LIVE obligation
  // ("awaiting verdict" / "validation failing"). UXO-1 withdrew it on archived
  // cards (the early return above) because abandoned work owes nobody a verdict;
  // the same is true of any TERMINAL task — an accepted/merged completion owes
  // none either, and a force-accepted one would otherwise read
  // "accepted · gate bypassed" (or the stale "awaiting verdict") beside a Done
  // card. The task hero makes exactly this cut with the same predicate
  // (task-main-sections.tsx `terminal`); the board card matches it. The PR-state
  // pill below STAYS on a terminal task — "merge pending" is a real outstanding
  // action (R16-6), not a live verdict claim — as does the readiness pill in the
  // card top, whose value IS the terminal status.
  const terminal =
    task.displayReadiness === "accepted" || task.displayReadiness === "merged";
  return (
    <>
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

          Both earn a pill under this block's density rule (only ACTIONABLE
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
          mirrors the review queue's `.rq-meta` (PR → validation → wait).
          C2: withdrawn once the task is terminal — see `terminal` above. */}
      {!terminal && task.validation !== "none" && (
        <ValidationPill value={task.validation} sm />
      )}
      {/* D4: the continuity cue sits with the other supervision signals, before
          the quiet/wait tags. Same component the list row shares (below). */}
      <ContinuityTag task={task} />
      {/* Gap-10: the quiet cue sits after validation and before the wait tag,
          the order both board views share. */}
      <QuietTag task={task} />
      <WaitTag task={task} />
    </>
  );
}

/** F19-8: the archived card's replacement for the readiness pill — the task
 *  hero's exact vocabulary (lock glyph + "archived"), so one word describes the
 *  state on both surfaces. */
function ArchivedPill() {
  return (
    <Pill kind="neutral" sm>
      <Icon name="lock" />
      archived
    </Pill>
  );
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

/**
 * D4 — the runtime-continuity cue, and the whole point of projecting the state:
 * "degraded continuity" existed only on the task page's Continuity Recovery
 * panel, so a supervisor scanning the board could not see which tasks lost their
 * provider session. It now carries the SAME state onto the card (UX spec §State
 * Semantics: "Every state must mean the same thing everywhere it appears").
 *
 * Warning tone (`risk`), matching how the panel draws the same state — a lost
 * conversation the agent had to re-anchor around is a real supervision signal,
 * not a neutral fact like "no activity". The refresh glyph is the panel heading's
 * own icon, so the cue reads as the same thing on both surfaces. It is a coarse
 * "a break happened" flag; the panel still owns the recovery detail (which agent,
 * whether it recovered), which lives in the run projection this card cannot see.
 */
function ContinuityTag({ task }: { task: BoardTask }) {
  if (task.continuity !== "degraded") return null;
  return (
    <Pill kind="risk" sm>
      <Icon name="refresh" />
      degraded continuity
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
      // The Avatar renders initials only; expose the real name to keyboard/
      // touch/SR users too (title alone is a weak accessible name), matching
      // MemberStack's aria-label convention.
      aria-label={"Owner: " + o.name}
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
  roving,
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
  /** D19: this card holds the board's single tab stop (see `onCardKeyDown`). */
  roving: boolean;
}) {
  const moveRef = useRovingStageMenu(roving);
  // F19-8: an ARCHIVED task is abandoned work kept for the record — it is out
  // of the flow, out of the review queue and owes nobody anything. The card is
  // inert for it: no live pills, no drag, no Move menu (see the render below).
  // UXO-1 removed the live readiness/validation pills from the task hero for the
  // same reason; before this the board kept drawing them, so a task archived
  // mid-review still read "ready · awaiting verdict · waiting on a human"
  // directly beneath the banner calling it abandoned, with a working Move
  // control besides.
  const archived = isArchived(task);
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
    disabled: !canTransition || archived,
    plugins: (defaults) => [
      ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
      Feedback.configure({ feedback: "clone" }),
    ],
  });
  const cls = ["card"];
  if (task.waiting === "human" && !archived) cls.push("wait-human");
  if (task.urgent && !archived) cls.push("urgent");
  const wrapCls = ["card-wrap"];
  if (canTransition && !archived) wrapCls.push("draggable");
  if (isDragSource) wrapCls.push("dragging");
  if (arrived) wrapCls.push("just-arrived");
  return (
    /* D19: the lane is a list (see `Column`), so each card is one of its items —
       that is what makes a screen reader say "3 of 7" as the arrows move. */
    <div className={wrapCls.join(" ")} ref={ref} role="listitem">
      <Link
        className={cls.join(" ")}
        to={`/projects/${task.projectSlug}/tasks/${task.key}`}
        // The wrapper carries the drag; the anchor must not start its own
        // (URL) drag, but a plain click still navigates.
        draggable={false}
        /* D19: the board's roving tab stop. Exactly one card face is tabbable;
           the arrows on the board container move it (`onCardKeyDown`), and the
           app-wide `:focus-visible` ring (app.css) draws where it landed —
           `a[href]` is in that selector list regardless of tabindex, so a
           programmatically focused resting card still paints the ring. */
        tabIndex={roving ? 0 : -1}
        data-board-card={task.key}
        data-board-lane={task.stage}
      >
        <div className="card-top">
          <span className="key">{task.key}</span>
          <span className="spacer" />
          {/* R21-8 (supersedes C3's both-pills arrangement): "input required"
              claims a human is needed RIGHT NOW — false while an agent is
              actively carrying the work (`waiting === "agent"`), so the pill
              yields for that state and the foot's WaitTag ("agent working")
              speaks alone. F15-09's rule still holds: the claim is made ONCE —
              this slot never duplicates the wait tag. The moment a packet
              flips `waiting` to "human", input-required reasserts here. The
              task hero makes the identical yield (task-main-sections.tsx), so
              the two surfaces keep agreeing mid-run — C3's actual complaint.
              Blocked / inconsistency-risk never yield.

              F19-8: an archived card says "archived" here instead — the same
              swap UXO-1 made in the task hero, for the same reason. Readiness
              is an ACTIONABLE claim ("ready · awaiting verdict" = someone owes
              a verdict); on abandoned work nobody does, and the board drew that
              claim directly under a banner calling the work abandoned. */}
          {archived ? (
            <ArchivedPill />
          ) : task.waiting === "agent" &&
            task.displayReadiness === "input_required" ? null : (
            <ReadinessPill value={task.displayReadiness} sm />
          )}
        </div>
        <h3>{task.title}</h3>
        <div className="owner-row">
          <OwnerLine task={task} />
          <ReviewerStack task={task} />
        </div>
        {!archived && hasVisibleMeta(task) && (
          <div className="card-meta">
            <PriorityFlag priority={task.priority} sm />
            <LabelChips labels={task.labels} />
            <DueDatePill dueDate={task.dueDate} sm />
          </div>
        )}
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
          <StateSignals task={task} />
        </div>
      </Link>
      {/* F10-25: keyboard-accessible stage move (drag is pointer-only). Sibling
          of the Link so it never triggers navigation; opens the same
          keyboard-navigable StageMenu the task-detail panel uses.

          F19-8: not on an archived card. The menu MOVES the task through the
          workflow — and into the terminal stage, where the same click runs the
          full acceptance contract and a real merge (R18-7) — on work the archive
          banner calls abandoned. Dragging is already off above; leaving the
          keyboard path live would make the two disagree about whether an
          archived task is still in the flow. Restoring the task from its own
          page is the way back in (the banner says so). */}
      {canTransition && !archived && (
        <div className="card-move" ref={moveRef}>
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
  isEntry,
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
  rovingKey,
}: {
  stage: BoardStage;
  tasks: BoardTask[];
  /** D19: the key of the one card holding the board's tab stop (may be in
   *  another lane, in which case no card here is tabbable). */
  rovingKey: string | null;
  /** Header count — optimistically adjusted during a cross-column drag. */
  count: number;
  /** P13-D-34: filter/search-aware empty copy for this column. */
  emptyCopy: string;
  isDone: boolean;
  /** R19-14: first stage — the only lane allowed to offer task creation. */
  isEntry: boolean;
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
        {/* R19-14: new tasks are created at the entry stage only, so only the
            entry lane offers the affordance (isDone guards the degenerate
            single-stage board where entry IS done). */}
        {isEntry && !isDone && canCreate && (
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
      {/* D19: a lane is a LIST of cards. That role plus its name is how a
          screen reader announces where the roving focus landed when Left/Right
          crosses into another lane ("In Progress tasks, list, 4 items") — the
          board has no other spoken cue for the column boundary.

          The role is dropped when the lane draws no cards, because then the
          only child is the empty-state sentence and a `list` whose child is not
          a `listitem` is precisely what axe's aria-required-children fails on.
          Nothing is lost: an empty lane holds no traversal target either (see
          `onCardKeyDown`), and the column header still names and counts it.

          `tabIndex=0` on a non-empty lane keeps the scrollable column reachable
          by keyboard (WCAG 2.2 / axe `scrollable-region-focusable`): D19's roving
          focus leaves only the active card at tabIndex 0, so every OTHER lane's
          cards are tabIndex -1 and a tall column would otherwise have no way to
          scroll without a mouse. Tab lands on the column to scroll it; the card
          handler still owns the arrow keys once a card is focused. */}
      <div
        className="col-body"
        role={tasks.length > 0 ? "list" : undefined}
        aria-label={tasks.length > 0 ? `${stage.name} tasks` : undefined}
        tabIndex={tasks.length > 0 ? 0 : undefined}
      >
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
                  roving={rovingKey === t.key}
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

/** D19: extracted from `ListView`'s map so the row can hold the roving-tab-stop
 *  hook — a hook cannot be called inside a `.map` callback. */
function ListRow({
  task,
  stages,
  canTransition,
  onMoveTask,
  roving,
}: {
  task: BoardTask;
  stages: BoardStage[];
  canTransition: boolean;
  onMoveTask: (taskKey: string, toStageId: string) => void;
  roving: boolean;
}) {
  const archived = isArchived(task);
  const rowRef = useRovingStageMenu(roving);
  const stageName =
    stages.find((s) => s.id === task.stage)?.name ?? task.stage;
  const to = `/projects/${task.projectSlug}/tasks/${task.key}`;
  return (
    <div className="card list-row" role="listitem" ref={rowRef}>
      {/* D19: the key and the title are two links to the SAME task page, so the
          key was a duplicate tab stop on every row. It stays a mouse target and
          keeps its accessible link semantics; the title is the row's roving
          stop, and no destination becomes unreachable by keyboard. */}
      <Link className="key" to={to} tabIndex={-1}>
        {task.key}
      </Link>
      <h3>
        <Link
          to={to}
          tabIndex={roving ? 0 : -1}
          data-board-card={task.key}
          /* One lane: Up/Down walks the rows and Left/Right has nowhere to go,
             which is what the list layout actually is. */
          data-board-lane="list"
        >
          {task.title}
        </Link>
      </h3>
      {/* UI-58: the same StageMenu the cards use — the list view's
          keyboard equivalent for drag-and-drop. F19-8: and off for the
          same reason on an archived row, which falls back to the same
          static stage pill a viewer who cannot move tasks sees. */}
      {canTransition && !archived ? (
        <StageMenu
          stages={stages}
          currentStageId={task.stage}
          onSelect={(stageId) => onMoveTask(task.key, stageId)}
        />
      ) : (
        <span className="pill neutral sm">{stageName}</span>
      )}
      <OwnerLine task={task} />
      <ReviewerStack task={task} label />
      {/* F15-09: same duplicate as the card — the row's own WaitTag
          below already says "agent working". F19-8: and the same
          readiness → "archived" swap the card makes. R21-8: and the same
          input-required-yields-while-an-agent-works rule — the card top's
          comment carries the reasoning. */}
      {archived ? (
        <ArchivedPill />
      ) : task.waiting === "agent" &&
        task.displayReadiness === "input_required" ? null : (
        <ReadinessPill value={task.displayReadiness} sm />
      )}
      {/* F19-13: the card's state block verbatim — the row used to draw
          validation and the wait tag alone, so the PR-state, checks and
          review pills existed on one board layout and not the other. */}
      <StateSignals task={task} />
    </div>
  );
}

function ListView({
  tasks,
  stages,
  canTransition,
  onMoveTask,
  emptyCopy,
  rovingKey,
  onCardKeyDown,
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
  /** D19: the roving tab stop and the traversal handler, shared with the stage
   *  layout — the list is simply a board with one lane. */
  rovingKey: string | null;
  onCardKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="board list">
      <div
        className="board-list"
        role={tasks.length > 0 ? "list" : undefined}
        aria-label={tasks.length > 0 ? "All tasks" : undefined}
        onKeyDown={onCardKeyDown}
      >
        {tasks.length === 0 && <div className="empty">{emptyCopy}</div>}
        {tasks.map((t) => (
          <ListRow
            key={t.key}
            task={t}
            stages={stages}
            canTransition={canTransition}
            onMoveTask={onMoveTask}
            roving={rovingKey === t.key}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- New task modal (board spec §4.6) ---------- */

/**
 * D3 (rulings 14 + 53) — as much of `acceptanceRefusalReason`
 * (task-actions.server.ts) as a board SUMMARY can answer, composed into the one
 * `blockedReason` the shared ceremony renders.
 *
 * `blockReason` alone is not "the" refusal: it is the projected revision gate
 * (`acceptanceBlockReason`, rebuilder.server.ts), whose own docstring names the
 * refusals it leaves OUT because they are per-reader state its consumers filter
 * on first — the ARCHIVED task and the STAGE boundary. This dialog can rely on
 * neither filter (it re-reads its task from the live payload, and the Move menu
 * offers the terminal stage from ANY stage), so it asks them here, through the
 * server's own shared predicates so the sentence cannot drift:
 *   - `archivedTaskBlockedReason` — the SAME function the server calls;
 *   - `closedPrBlockedReason` — asked ahead of `blockReason` only for R16-3
 *     precedence (a terminal GitHub fact outranks every process gate);
 *   - the STAGE gate — `acceptanceStageBlockedReason`, the one the task file
 *     cannot answer (it turns on the PROJECT's workflow edges). Not guessed from
 *     column ORDER (rulings 12/14): `TaskSummary.atAcceptanceBoundary` carries
 *     the graph's answer, derived server-side through the same `resolveStageRoles`;
 *   - the blocked-packet and conflicting-PR gates — belt-and-braces so a stale
 *     projection fails CLOSED rather than opening a confident dialog on a click
 *     the server refuses.
 *
 * A refusal shown here is final — the board has no force-accept to bypass it.
 */
function boardAcceptRefusal(
  task: TaskSummary,
  fromStageName: string,
  terminalName: string,
): string | null {
  return (
    archivedTaskBlockedReason(task, task.key) ??
    closedPrBlockedReason(task, task.key) ??
    (task.atAcceptanceBoundary
      ? null
      : // The server's own sentence names the resolved review stage; a summary
        // holds no stage roles, and "the boundary" is the truer phrasing anyway
        // for a graph with several edges into the terminal stage.
        `${task.key} is at ${fromStageName}, not the boundary the workflow puts before ${terminalName}. A completion can only be accepted from there. Move the task through the workflow first.`) ??
    task.blockReason ??
    (task.readiness === "blocked" && task.packet?.type === "blocked"
      ? "An open blocked decision is holding this task."
      : null) ??
    conflictingPrBlockedReason(task, task.key)
  );
}

/**
 * D3 (rulings 14 + 53) — the board's acceptance ceremony.
 *
 * A human moving a card into the FINAL stage is not a bare move: the server
 * routes it through the full acceptance contract, which attempts a real PR
 * merge (`reorderTask` → `acceptCompletion`, task-actions.server.ts). Ruling 53
 * (R18-7) required this confirmation to "match the task-detail dialog"; ruling
 * 14 forbids forking a shared surface per screen. The board nonetheless carried
 * `AcceptOnBoardConfirm`, its OWN dialog, disclosing LESS than the task page:
 * no merge target, no delivered-revision row, no verdict attribution, no
 * no-change disposition.
 *
 * This renders the ONE shared `AcceptConfirm` (task-detail/accept-confirm), in
 * its `stage-move` ceremony mode — the mode written for exactly this path (a
 * human move into the terminal stage IS accepting completion, F19-37). The board
 * maps its projection summary onto the component's structural `task` shape and
 * supplies the stage list from its columns. The task-FILE facts a board summary
 * does not carry are passed honestly rather than invented:
 *   - `defaultBranch` → the merge target, threaded from the project record —
 *     the fact the fork could not name and sent people to the task page for;
 *   - `noChanges` / `noPullRequest: false` → the board cannot run the accept-time
 *     branch re-probe the task-detail loader drives, so it keeps the plain no-PR
 *     sentence rather than promising an auto-detect it can't perform.
 * The refusals a board summary CAN answer are composed by `boardAcceptRefusal`.
 *
 * The delivered REVISION used to be in that list — hardcoded `null`, so the
 * ceremony always drew "No delivered revision recorded." — and once ruling 88
 * made the confirmed click echo its own disclosure back, that hardcoded absence
 * stopped being merely a thinner disclosure and became a dead door: the server
 * compares the echo against the live task, so every board drop onto the terminal
 * stage of a task that had actually DELIVERED was refused as stale. The revision
 * is projected now (`TaskSummary.workRevisionSha`) and disclosed like every
 * other fact — which is also what ruling 53 asked for. `?? null` keeps the
 * honest-absence row for a task with nothing delivered.
 */
function AcceptOnBoardConfirm({
  task,
  stages,
  fromStageName,
  defaultBranch,
  busy,
  onCancel,
  onConfirm,
}: {
  task: TaskSummary;
  /** Project stages in order — supplies the shared ceremony's stage list and
   *  names the terminal (merge) stage. */
  stages: BoardStage[];
  /** The stage the card is leaving — named in the ceremony's Moving row. */
  fromStageName: string;
  /** The merge target (project default branch) — the fact a board summary lacks
   *  and the fork could not name. */
  defaultBranch: string;
  busy: boolean;
  onCancel: () => void;
  /** Ruling 88: the shared ceremony hands the confirmed click its own
   *  disclosure — the board POSTs it, exactly like the task page. */
  onConfirm: (disclosure: AcceptanceDisclosure) => void;
}) {
  const terminalName = stages[stages.length - 1]?.name ?? "Done";
  return (
    <AcceptConfirm
      task={{
        key: task.key,
        title: task.title,
        stage: task.stage,
        stages: stages.map((s) => ({ id: s.id, name: s.name })),
        validation: task.validation,
        branch: task.branch,
        pr: task.pr,
      }}
      workRevisionSha={task.workRevisionSha ?? null}
      noChanges={false}
      noPullRequest={false}
      defaultBranch={defaultBranch}
      // The STAGE gate the summary CAN answer (F19-27). The board never
      // force-accepts, so this jumps no stage on its own — the off-boundary
      // sentence rides `blockedReason` below — but it keeps the shared
      // component's own boundary reasoning honest.
      atBoundary={task.atAcceptanceBoundary}
      ceremony={{
        mode: "stage-move",
        label: `${fromStageName} → ${terminalName}`,
      }}
      verdictSatisfiedBy={null}
      blockedReason={boardAcceptRefusal(task, fromStageName, terminalName)}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function NewTaskModal({
  entryStageName,
  labelSuggestions,
  onClose,
}: {
  /** R19-14: every task is created at the entry stage — the modal names it. */
  entryStageName: string;
  /** Labels already used across the board, offered as label autocomplete. */
  labelSuggestions: string[];
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [labels, setLabels] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
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
          ". Its task.md is in the store",
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
    if (priority !== "normal") fd.set("priority", priority);
    if (labels.length > 0) fd.set("labels", labels.join(","));
    if (dueDate) fd.set("dueDate", dueDate);
    // R19-14: no stage field — the server creates at the entry stage.
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
            Creates the task as a single file in the store. Agents read that
            file and work from it.
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
          {/* R19-14: the stage picker is gone — creation lands at the entry
              stage only, so the modal states where instead of offering a
              choice the server would refuse. */}
          <span className="flabel">Stage</span>
          <span className="fine sm">
            Starts in {entryStageName}. The goal gets refined at triage before
            any work begins.
          </span>
        </div>
        <div className="field">
          <label className="flabel" htmlFor="new-task-goal">
            Goal
            <span className="fhint">
              what counts as done, for the operator and the agents
            </span>
          </label>
          <textarea
            id="new-task-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="One or two sentences. A vague goal gets flagged by the operator at triage."
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="flabel" htmlFor="new-task-priority">
              Priority
            </label>
            <select
              id="new-task-priority"
              value={priority}
              onChange={(e) => setPriority(coercePriority(e.target.value) ?? "normal")}
            >
              {PRIORITY_VALUES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="flabel" htmlFor="new-task-due">
              Due date
            </label>
            <DatePicker
              id="new-task-due"
              value={dueDate || null}
              onChange={(v) => setDueDate(v ?? "")}
            />
          </div>
        </div>
        <div className="field">
          <span className="flabel">
            Labels
            <span className="fhint">type and press Enter, optional</span>
          </span>
          <LabelInput
            value={labels}
            onChange={setLabels}
            suggestions={labelSuggestions}
          />
        </div>
      </div>
      <div className="modal-foot">
        <span
          className={
            "foot-hint" + (serverError || (titleTouched && !valid) ? " err" : "")
          }
          // UX-coherence: announce the server/validation error to screen
          // readers — the same role=alert idiom the Home "New project" modal
          // got in the Pass-19 audit; this modal (same fetcher/serverError
          // shape) was missed. Condition mirrors the className ternary above so
          // the announce state can never desync from the visible error.
          role={serverError || (titleTouched && !valid) ? "alert" : undefined}
        >
          {serverError
            ? serverError
            : titleTouched && !valid
              ? "A title is required."
              : "The task key is assigned automatically."}
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
  { id: "quiet", label: "No activity", icon: "clock" },
  // D4: the UX spec names "degraded continuity" a default filter, so a supervisor
  // scanning the board can find the tasks whose provider session was lost — the
  // Murat journey the spec tests begins "a continuity warning appears on the task
  // OR board". Named for what it selects (R16-2). Like the Archived chip it only
  // renders when the project has any such task (or the filter is active), because
  // degraded continuity is rare and an always-empty chip on every board is the
  // clutter the board's density rules fight (see FilterBar).
  { id: "continuity", label: "Degraded continuity", icon: "refresh" },
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
  scanning,
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
  scanning: boolean;
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
            one of them now names its scope.
            C4: the phrase itself is the project-scope canonical "waiting on a
            human" — the trailing "decision" was one of five near-duplicate
            phrasings this pass collapsed to one-per-scope (the viewer-scope card
            tag reads "waiting on you"). "in this project" keeps the scope. */}
        <div className="sub">
          {countLine} · {waitingHuman} waiting on a human in this project
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
            disabled={scanning}
            aria-busy={scanning || undefined}
            title="Reconcile the board with the file-native store"
          >
            {/* Busy state matches the Home StoreStrip twin: spin the icon and
                swap the label while the rescan fetcher is in flight. */}
            <Icon name="refresh" className={scanning ? "spin" : ""} />
            {scanning ? "Scanning…" : "Re-scan"}
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
  labelFilter,
  projectLabels,
  waitingOnMe,
  quiet,
  continuity,
  archived,
  setParam,
  onClear,
}: {
  filter: BoardFilterId;
  /** F26-12 / R26-2: the active label filter (`?label=`), and the project's label
   *  vocabulary offered as filter chips. */
  labelFilter: string | null;
  projectLabels: string[];
  /** Board filter term (`?q=`) — it hides cards exactly like the chips do. */
  query: string;
  /** R8-3: member-scoped count for the "Waiting on me" chip. */
  waitingOnMe: number;
  /** Gap-10: live tasks with no recorded activity — the "No activity" chip's
   *  tally. Deliberately NOT "quiet": the home project card already uses that
   *  word for `running === 0`, i.e. a perfectly healthy project with nothing in
   *  flight. Two meanings one click apart is the vocabulary drift this pass has
   *  been removing; the chip now matches the pill it selects ("no activity"). */
  quiet: number;
  /** D4: tasks whose runtime continuity is degraded — the "Degraded continuity"
   *  chip's tally, and (like `archived`) whether the chip shows at all. */
  continuity: number;
  /** R14-3: archived tasks in this project — the chip is the only way back to
   *  them, so it renders only when there are any (and always while it is on). */
  archived: number;
  setParam: (key: string, value: string | null) => void;
  onClear: () => void;
}) {
  return (
    <div className="filter-bar">
      {FILTERS.filter(
        (f) =>
          (f.id !== "archived" || archived > 0 || filter === "archived") &&
          // D4: same rarity gate as Archived — surface the continuity chip only
          // when there is a degraded task to find (or the filter is already on).
          (f.id !== "continuity" || continuity > 0 || filter === "continuity"),
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
          {f.id === "continuity" && continuity > 0 && (
            <span className="tally">· {continuity}</span>
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
      {/* F26-12 / R26-2: one chip per label the project actually uses (the same
          vocabulary the New-task modal offers). Single-select: clicking a label
          narrows the board to its tasks; clicking the active one clears it. They
          AND with the readiness chips and the term, and only render when the
          project has labels — a board that never tagged anything stays clean. */}
      {projectLabels.map((l) => {
        const active = labelFilter?.toLowerCase() === l.toLowerCase();
        return (
          <button
            type="button"
            key={l}
            className={"fchip lbl" + (active ? " on" : "")}
            aria-pressed={active}
            onClick={() => setParam("label", active ? null : l)}
            title={active ? `Showing only “${l}”. Click to clear.` : `Show only tasks labelled “${l}”`}
          >
            {l}
          </button>
        );
      })}
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
          control that resets both (and the label filter — F26-12). One chip per
          board, not one per column. */}
      {(filter !== "all" || query.trim() !== "" || labelFilter) && (
        <button
          type="button"
          className="fchip"
          onClick={onClear}
          title="Show every task again. Clears the board filter, the label filter and the search"
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
        {orphanTasks.length === 1 ? "task" : "tasks"}: the stage in the file
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
  rovingKey,
  onCardKeyDown,
}: {
  columns: BoardColumnData[];
  /** D19: the one card holding the board's tab stop, and the arrow handler that
   *  moves it. Delegated on the board container so every lane shares it. */
  rovingKey: string | null;
  onCardKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  visible: (tasks: BoardTask[]) => BoardTask[];
  /** P13-D-34: per-column empty copy, given that column's UNFILTERED total. */
  emptyCopyFor: (total: number, isEntryColumn?: boolean) => string;
  doneStageId: string | undefined;
  canCreate: boolean;
  canTransition: boolean;
  /** R19-14: creation lands at the entry stage, so no stage argument here. */
  onNew: () => void;
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
  if (columns.length === 0) {
    // A project whose project.md `stages:` was emptied by an external edit
    // (in-app actions can't remove the locked entry/terminal stages) would
    // otherwise render a blank board with no explanation. Disclose it, the
    // same way the OrphanBanner / archived-filter notices in this file do.
    return (
      <div className="board-orphans" role="status">
        <Icon name="alert" />
        <span className="board-orphans-label">
          This project has no workflow stages yet. Add a stage in project
          settings before tasks can be created or shown here.
        </span>
      </div>
    );
  }
  return (
    <div className="board" onKeyDown={onCardKeyDown}>
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
            isEntry={columnIndex === 0}
            canCreate={canCreate}
            canTransition={canTransition}
            onNew={onNew}
            arrivedKey={arrivedKey}
            dropTarget={hovered}
            previewTask={hovered ? draggedTask : null}
            beforeKey={beforeKey}
            allStages={allStages}
            onMoveTask={onMoveTask}
            rovingKey={rovingKey}
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
  defaultBranch = "main",
}: {
  columns: BoardColumnData[];
  orphanTasks: BoardTask[];
  canCreate: boolean;
  /** admin|maintainer — enables the per-card stage-move dropdown. */
  canTransition: boolean;
  /** Holders of `rescan-project` (admin|maintainer) — the server-checked gate
   *  for Re-scan; kept distinct from canTransition so the two can't drift. */
  canRescan: boolean;
  /** D3: the project's default branch — the merge target the shared acceptance
   *  ceremony names when a board move into the terminal stage is confirmed.
   *  Defaults to "main" (the same fallback the task-detail page uses) so the
   *  ceremony always names a real target even before the loader wires it. */
  defaultBranch?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get("filter");
  const filter: BoardFilterId = isBoardFilterId(rawFilter) ? rawFilter : "all";
  const group = searchParams.get("view") === "list" ? "list" : "stage";
  const query = searchParams.get("q") ?? "";
  // F26-12 / R26-2: the active label filter (`?label=`), or null when off.
  const labelFilter = searchParams.get("label");
  // R19-14: creation always lands at the entry stage, so this is a plain
  // open/closed flag — no per-lane stage rides along any more.
  const [creating, setCreating] = useState(false);
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
  /** D19: the card the roving tab stop sits on. Null until an arrow moves it —
   *  the resting stop is then the first card the layout draws (`rovingKey`). */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** B1: a move into the final stage waits here for an explicit confirmation. */
  const [pendingAccept, setPendingAccept] = useState<{
    taskKey: string;
    to: string;
    beforeKey: string;
  } | null>(null);
  const finalStageId = columns[columns.length - 1]?.stage.id;
  const moveDone = useRef<unknown>(null);
  /**
   * D9 (WCAG 2.2 / UX spec §Accessibility Strategy) — the board's polite
   * announcement region. Board drag is pointer-only and keyboard users move via
   * the StageMenu (ruling 64 built the traversal half), but nothing ever spoke
   * a requested move, a completed one, or a server refusal — including the 409
   * the server answers an off-boundary move with, since the board is
   * authoritative and never commits a move client-side. `announceMove` speaks
   * the request; the transition-fetcher effect below speaks the outcome, reusing
   * the server's own honest sentence (`d.toast` / `d.error`).
   */
  const [announce, setAnnounce] = useState("");
  const announceMove = (taskKey: string, toStageId: string) => {
    const name =
      columns.find((c) => c.stage.id === toStageId)?.stage.name ?? toStageId;
    setAnnounce(`Move requested: ${taskKey} to ${name}.`);
  };

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
    // SAFETY: dnd-kit types every droppable's `data` as its own open bag, but
    // the only card droppables on this board are the `useSortable<CardDragData>`
    // above — which passes `{ nextKey }` and nothing else. Stage droppables,
    // the one other kind, returned two lines up. `Partial` + `?.` still cover a
    // sortable that has not been given its data yet.
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
    announceMove(active.key, resolution.to); // D9
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", active.key);
    fd.set("to", resolution.to);
    fd.set("beforeKey", resolution.beforeKey ?? "");
    transitionFetcher.submit(fd, { method: "post" });
  };

  /** Commit a confirmed board acceptance (B1). */
  const submitReorder = (
    taskKey: string,
    to: string,
    beforeKey: string,
    // Ruling 88 (F21-2): set ONLY for a move onto the FINAL column, which the
    // server reads as an acceptance (`reorderTask` → `transitionStage` →
    // `acceptCompletion` — the real merge). It is the echo of what the ceremony
    // above just displayed; without it the server refuses the acceptance.
    disclosure?: AcceptanceDisclosure,
  ) => {
    setArrivedKey(taskKey);
    announceMove(taskKey, to); // D9
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", taskKey);
    fd.set("to", to);
    fd.set("beforeKey", beforeKey);
    if (disclosure) {
      for (const [field, value] of Object.entries(
        acceptanceDisclosureFields(disclosure),
      )) {
        fd.set(field, value);
      }
    }
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
    if (d.ok && d.toast) {
      push(d.toast);
      setAnnounce(d.toast); // D9: the completed move, in the server's own words.
    } else if (!d.ok && d.error) {
      // P13-D-10: a REJECTED stage transition is the worst place to render a
      // success tick — the card snaps back and the toast said "done".
      push(d.error, "error");
      setArrivedKey(null);
      // D9: the refusal (incl. the server's 409 on an off-boundary move) is a
      // consequential state change a screen-reader user must hear, not only see.
      setAnnounce(`Move refused: ${d.error}`);
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
  // Distinct labels already used on this board, sorted, as New-task
  // autocomplete — so a project's label vocabulary stays consistent instead of
  // every task inventing its own spelling of the same tag.
  //
  // F26-15: mirror the server's `listProjectLabels` contract EXACTLY — exclude
  // archived tasks (`allTasks` carries them; they are hidden only per-filter) and
  // dedupe case-insensitively, first spelling wins — so the New-task modal and the
  // task Details panel (which reads `listProjectLabels`) offer the SAME vocabulary
  // rather than two subtly different lists.
  const labelSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of allTasks) {
      if (t.archived) continue;
      for (const l of t.labels) {
        const key = l.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [allTasks]);
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
  // D4: counted over LIVE tasks, like the chips above — an archived task's
  // continuity break is part of its record but it is out of every default view,
  // so it neither draws the chip nor feeds its tally.
  const continuityCount = liveTasks.filter(
    (t) => t.continuity === "degraded",
  ).length;
  const archivedCount = countArchived(allTasks);
  // The card in flight (for the drop-preview shown in the hovered column).
  const draggedTask = drag
    ? (allTasks.find((t) => t.key === drag.key) ?? null)
    : null;
  // F19-27: the summary the acceptance confirm discloses from. Resolved here
  // rather than captured into `pendingAccept` so it re-reads on every
  // revalidation — a stale snapshot is exactly the failure ruling 42 is about.
  const pendingAcceptTask = pendingAccept
    ? (allTasks.find((t) => t.key === pendingAccept.taskKey) ?? null)
    : null;
  // …and the price of resolving it late: a revalidation between the gesture and
  // the render can drop the task from the payload (someone archived it, the
  // task file was deleted, a rescan reprojected it away), and the dialog then
  // renders NOTHING while `pendingAccept` stays set — no dialog, no toast, no
  // cancel, the human's drag simply gone, and the state wedged until they drag
  // again. A gesture that cannot be completed is abandoned OUT LOUD: the same
  // rule P13-D-10 applies to a refused transition, which is what this is (the
  // acceptance did not happen), so it carries the same error kind.
  useEffect(() => {
    if (!pendingAccept || pendingAcceptTask) return;
    setPendingAccept(null);
    push(
      `${pendingAccept.taskKey} left the board before its acceptance was confirmed. Nothing was accepted.`,
      "error",
    );
  }, [pendingAccept, pendingAcceptTask, push]);

  const visible = (tasks: BoardTask[]) =>
    tasks.filter(
      (t) =>
        matchesBoardFilter(t, filter) &&
        matchesLabelFilter(t, labelFilter) &&
        matchesSearch(t, query),
    );
  // The all-tasks filter feeds the roving tab stop, the "N shown" count and the
  // list view; run it once per render rather than three times (each pass
  // rebuilds a per-task search haystack).
  const visibleAllTasks = visible(allTasks);

  /* ---------- D19 / ruling R19-10: arrow-key traversal ----------
   *
   * The UX spec put full arrow traversal on the Task Status Card and it was
   * never built: before this the board's ONLY `onKeyDown` was the new-task
   * dialog's Enter, and a keyboard user met one tab stop per card face plus one
   * per Move trigger — 2N stops to cross a five-lane board, with no way to move
   * sideways at all. INTENT §4 asks for "keyboard access to every packet
   * action" on the grounds that inaccessible state is untrustworthy state.
   *
   * The model is the standard roving tab stop: ONE card is tabbable
   * (`rovingKey`), the arrows move it, and Tab leaves the board rather than
   * walking it. The lanes are read back off the DOM (`data-board-lane` /
   * `data-board-card`) rather than recomputed here, so the traversal order is
   * by construction the order the human SEES — filters, the archived view, the
   * list layout and any future ordering all come along for free, and an empty
   * lane simply is not in the model, which is what makes Left/Right unable to
   * strand focus on one.
   *
   * How this coexists with the dnd-kit drag (@dnd-kit/dom 0.5.0, verified in
   * `index.js`, not assumed):
   *   - `KeyboardSensor.bind` puts its keydown listener on `source.handle ??
   *     source.element` — here the `.card-wrap` div `useSortable` refs — and its
   *     default `preventActivation` is `event.target !== target`. The roving
   *     focus lands on the card's `<a>` FACE, a descendant, so Space/Enter here
   *     can never start a keyboard drag: the two never contend for the same key
   *     on the same element.
   *   - The sensor's own arrow handling does not exist until a drag is running;
   *     `handleStart` binds it on `document` in the CAPTURE phase and
   *     `handleMove` calls `preventDefault()`. Capture on document runs before
   *     React's root listener, so the `defaultPrevented` guard below hands the
   *     arrows to a drag in flight without either side knowing about the other.
   */
  const visibleKeys =
    group === "stage"
      ? columns.flatMap((c) => visible(c.tasks).map((t) => t.key))
      : visibleAllTasks.map((t) => t.key);
  // Re-anchors when the card the stop was on leaves the layout (filtered away,
  // archived, reprojected off the board) — a tab stop pinned to a card that is
  // no longer drawn is a board with no way in.
  const rovingKey =
    focusKey && visibleKeys.includes(focusKey)
      ? focusKey
      : (visibleKeys[0] ?? null);

  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A keyboard drag in flight owns the arrows (see the note above); a
    // modifier means the human is asking the browser for something else.
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Anything that is not a card face — the Move trigger (whose own menu owns
    // Arrow Up/Down), the filter box, the header — is not traversal.
    const from = target.closest<HTMLElement>("[data-board-card]");
    if (!from) return;

    if (event.key === "Enter" || event.key === " ") {
      // The card face is an anchor, so Enter would activate natively but Space
      // would only scroll. Both are answered the same way instead of one each:
      // suppress the default and re-issue the activation as a click, which is
      // the event `Link` navigates on.
      event.preventDefault();
      from.click();
      return;
    }

    // Lanes in DOM order, cards in visual order within each.
    const lanes = new Map<string, HTMLElement[]>();
    for (const el of event.currentTarget.querySelectorAll<HTMLElement>(
      "[data-board-card]",
    )) {
      const lane = el.dataset.boardLane ?? "";
      const bucket = lanes.get(lane);
      if (bucket) bucket.push(el);
      else lanes.set(lane, [el]);
    }
    const laneList = [...lanes.values()];
    const laneIndex = laneList.findIndex((lane) => lane.includes(from));
    if (laneIndex < 0) return;
    const lane = laneList[laneIndex]!;
    const index = lane.indexOf(from);

    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = lane[index + 1];
        break;
      case "ArrowUp":
        next = lane[index - 1];
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        const neighbour =
          laneList[laneIndex + (event.key === "ArrowRight" ? 1 : -1)];
        // Nearest by index, and the lane's FIRST card when that lane is
        // shorter — never a dead end, and never a landing the human has to
        // scroll to find.
        next = neighbour ? (neighbour[index] ?? neighbour[0]) : undefined;
        break;
      }
      default:
        return;
    }
    // Claimed even at the edges of the board: an ArrowDown on the last card of
    // a lane must not fall through to scrolling the column out from under the
    // focus ring.
    event.preventDefault();
    if (!next) return;
    next.focus();
    setFocusKey(next.dataset.boardCard ?? null);
  };

  // P13-D-34: what the board actually draws, and why anything is missing.
  const shownCount = visibleAllTasks.length;
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
        next.delete("label"); // F26-12: Clear resets the label filter too.
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
          ? "Re-scan complete. The board matches the file-native store"
          : (rescanFetcher.data.error ?? "Re-scan failed."),
        // P13-D-10: same handler, both outcomes — the failure branch used to
        // borrow the success glyph.
        rescanFetcher.data.ok ? "success" : "error",
      );
    }
  }, [rescanFetcher.state, rescanFetcher.data, push]);

  return (
    <div className="board-wrap" data-screen-label="Board">
      {/* D9: the board's polite announcement region — pickup/drop requests and
          the server's own move outcome (including a refusal) spoken to assistive
          tech, which the pointer-only drag and the toast never gave a keyboard
          user. Visually hidden but kept in the DOM (see SR_ONLY). */}
      <div style={SR_ONLY} role="status" aria-live="polite">
        {announce}
      </div>
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
        scanning={rescanFetcher.state !== "idle"}
        setParam={setParam}
        onRescan={rescan}
        // UI-58: `?? "triage"` was a magic literal for a project with no stages
        // — a create that could only fail server-side. With no stages there is
        // nothing to create INTO. D3 (pass 23): a silent no-op broke the
        // refusal-must-never-be-silence rule — the button rendered enabled and
        // the click did nothing; now it says why and points at the fix.
        onNew={() => {
          if (stages[0]) {
            setCreating(true);
          } else {
            push(
              "Add a stage in project settings before creating tasks: there is no stage to create into.",
              "error",
            );
          }
        }}
      />

      <FilterBar
        filter={filter}
        query={query}
        labelFilter={labelFilter}
        projectLabels={labelSuggestions}
        waitingOnMe={waitingOnMe}
        quiet={quietCount}
        continuity={continuityCount}
        archived={archivedCount}
        setParam={setParam}
        onClear={clearFilters}
      />

      {filter === "archived" && (
        <div className="board-orphans" role="status">
          <Icon name="lock" />
          <span className="board-orphans-label">
            Archived tasks: abandoned work kept for the record. Their timelines
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
            onNew={() => setCreating(true)}
            drag={drag}
            overStage={overStage}
            beforeKey={beforeKey}
            arrivedKey={arrivedKey}
            draggedTask={draggedTask}
            onMoveTask={onMoveTask}
            rovingKey={rovingKey}
            onCardKeyDown={onCardKeyDown}
          />
        </DragDropProvider>
      ) : (
        <ListView
          tasks={visibleAllTasks}
          stages={stages}
          canTransition={canTransition}
          onMoveTask={onMoveTask}
          emptyCopy={emptyCopyFor(allTasks.length, true)}
          rovingKey={rovingKey}
          onCardKeyDown={onCardKeyDown}
        />
      )}

      {creating && stages[0] && (
        <NewTaskModal
          entryStageName={stages[0].name}
          labelSuggestions={labelSuggestions}
          onClose={() => setCreating(false)}
        />
      )}

      {/* B1 / D3: the acceptance a board move really performs, confirmed
          through the ONE shared ceremony. F19-27: the card's own summary is what
          the dialog discloses from — looked up fresh so a revalidation between
          the gesture and the confirmation shows the CURRENT PR head, not the one
          the drag started on. A lookup that MISSES is handled by the effect
          above (clear + toast), never by this silent `&&`. */}
      {pendingAccept && pendingAcceptTask && (
        <AcceptOnBoardConfirm
          task={pendingAcceptTask}
          stages={stages}
          fromStageName={
            stages.find((s) => s.id === pendingAcceptTask.stage)?.name ??
            pendingAcceptTask.stage
          }
          defaultBranch={defaultBranch}
          busy={transitionFetcher.state !== "idle"}
          onCancel={() => setPendingAccept(null)}
          onConfirm={(disclosure) => {
            const p = pendingAccept;
            setPendingAccept(null);
            // Ruling 88: the drop commits with the ceremony's own echo of what
            // it disclosed — the same acknowledgment the task page's stage move
            // sends, on the same server contract.
            submitReorder(p.taskKey, p.to, p.beforeKey, disclosure);
          }}
        />
      )}
    </div>
  );
}
