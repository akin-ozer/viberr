import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import {
  Link,
  useFetcher,
  useParams,
} from "react-router";
import {
  DragDropProvider,
  useDroppable,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import {
  Accessibility,
  defaultPreset,
  Feedback,
  type DropAnimationFunction,
} from "@dnd-kit/dom";
import { DRAG_SENSORS } from "~/ui/drag-sensors";
import { resolveBoardDrop } from "./board-dnd";
import { FiledFiles } from "./filed-files";
import { FILING_BATCH } from "~/shared/attachment-kinds";
import { addPickedFiles, filesFromPaste } from "~/ui/picked-files";
import { cardProblems, cardStatus, PROBLEM_CAP } from "./card-status";
import type { BoardCard } from "./board-card";
import {
  coercePriority,
  PRIORITY_VALUES,
  type TaskPriority,
} from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import type { EpicOption } from "~/ui/epic-chip";
import { EPIC_STATUS_LABEL, isEpicOpen } from "~/shared/task-refs";
import { createVelocityTracker, springFrames, springProgress, type Spring } from "~/ui/spring";
import { useCsrfToken } from "~/ui/csrf-input";
import { DatePicker } from "~/ui/date-picker";
import { Icon } from "~/ui/icon";
import { LabelInput } from "~/ui/label-input";
import { LocalDayDotTime } from "~/ui/local-time";
import { AgentBadge, AgentGlyph } from "~/ui/identity";
import { connectionPill } from "~/features/github/github-pills";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";
import { stageLabel } from "~/shared/workflow/stage-label";
import { countLabel } from "~/shared/text/plural";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useStableRows } from "~/ui/use-stable-rows";
import {
  countArchived,
  isArchived,
  EPIC_FILTER_NONE,
  type BoardFilterId,
} from "./board-filters";
import {
  useBoardDrag,
  useBoardKeyboard,
  useBoardMoves,
  useBoardQuery,
  useMoveConfirms,
  useRescan,
  useRescanAnswer,
} from "./board-page-actions";
import {
  emptyCopyIn,
  FILTERS,
  isVirginBoard,
  labelVocabulary,
  newTaskEpic,
  showsFilterBar,
  visibleIn,
} from "./board-page-derive";

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
 *     stop, in both layouts — see `onCardKeyDown` in `useBoardKeyboard`
 *     (board-page-actions.tsx).
 *
 * Ruling 696(e) split the page along the task-page recipe: its state and posts
 * are hooks in `board-page-actions.tsx`, what it derives from its props and
 * URL is `board-page-derive.ts`, and the acceptance ceremony is
 * `board-accept-confirm.tsx`.
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
 * A board card's task: the board card projection (ruling 457, BOARD-3,
 * `board-card.ts`), which carries the Gap-10 `quiet` annotation and the
 * loader's viewer annotations beside the fields the card, its filters and the
 * acceptance ceremony read.
 */
export type BoardTask = BoardCard;

export interface BoardColumnData {
  stage: BoardStage;
  tasks: BoardTask[];
}

/* No ARIA decoration on the cards: the plugin's role="button" on the card
 * wrapper nests the task link and StageMenu inside an interactive control
 * (axe: nested-interactive, serious). The board's accessible move path is,
 * and stays, the StageMenu (F10-25 — drag is pointer-only); dragging is a
 * pointer/touch enhancement on top of it. */
const BOARD_PLUGINS = defaultPreset.plugins.filter(
  (plugin) => plugin !== Accessibility,
);

/**
 * Where a dropped card flies (owner, 2026-09-08: the move "is not smooth").
 *
 * dnd-kit's default drop animation returns the lifted card to the placeholder
 * it left — the OLD lane — and the card then jumped to the new lane when the
 * server answered: a fly-back, a pause, a teleport. The board still commits
 * nothing client-side (§UI porting rules: no optimistic UI for governed
 * state), so instead the card flies to the slot it asked for, where the
 * landing preview already stands as the request, and the source stays hidden
 * (`.in-flight`) until the server's answer renders the real card there — or
 * refuses, and the card comes back with the toast. A reorder within one lane
 * lands the same way (2026-09-11: it had no landing preview, so the card flew
 * home and then vanished for the whole round trip). A cancelled drag, or a
 * drop that changes nothing, has no landing preview and flies home as before.
 */
/** Critically damped: the card lands in a slot between two others, where an
 *  overshoot would draw it over its neighbour. The response is the low end of
 *  the default UI range, so the flight stays quick. */
const DROP_SPRING: Spring = { dampingRatio: 1, response: 0.3 };
/** The pointer's velocity through the drag, read by the flight at release.
 *  One board drags at a time, so one tracker serves the module; the page hands
 *  it to the drag that samples it (`useBoardDrag`). */
const dragVelocity = createVelocityTracker();
const boardDropAnimation: DropAnimationFunction = async ({ feedbackElement, placeholder }) => {
  // Only the card that was lifted flies. When the server's answer re-renders
  // the card in its new lane while the drop is still settling, dnd-kit adopts
  // the new element as the operation's source and runs this again for it —
  // against a placeholder it has already removed, whose rect is the viewport
  // origin (observed: the landed card shot 400px up and snapped back). A
  // detached placeholder means the flight already happened.
  if (!placeholder?.isConnected) return;
  const landing = document.querySelector(".drop-preview.landing");
  const target = landing ?? placeholder;
  if (!(feedbackElement instanceof HTMLElement)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const from = feedbackElement.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  // A reorder leaves its hole in the landing's own lane, and dnd-kit takes the
  // hole out once this resolves: every block after it moves up by the hole's
  // share of the flow (its height and the gap after it) — the landing too, when
  // the card moves down its lane. So the hole closes while the card flies, and
  // the card flies to where the landing will stand once it has. The hole keeps
  // its box while it closes (a negative margin, not a height): a ResizeObserver
  // sizes the flying card from it.
  const closes = landing !== null && landing.parentElement === placeholder.parentElement;
  const next = closes ? placeholder.nextElementSibling : null;
  const share = next
    ? next.getBoundingClientRect().top - placeholder.getBoundingClientRect().top
    : 0;
  const landsBelow =
    closes && (placeholder.compareDocumentPosition(landing) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const rise = landsBelow ? share : 0;
  const dx = to.left - from.left;
  const dy = to.top - rise - from.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  // dnd-kit positions the lifted card with `translate: var(--dnd-translate)
  // !important`, which no animation can override — its own drop animation
  // marks the element `data-dnd-dropping` to switch that rule off. Read the
  // current translate while the rule still applies, then release it.
  const m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(getComputedStyle(feedbackElement).translate);
  const tx = m ? Number(m[1]) : 0;
  const ty = m ? Number(m[2]) : 0;
  feedbackElement.setAttribute("data-dnd-dropping", "");
  // The flight is a spring that leaves at the pointer's release velocity
  // (spring.ts says why a fixed curve could not): a card let go of at rest
  // eases off instead of lurching, and one let go of mid-throw carries on
  // at the throw's speed instead of stopping dead first.
  const { frames, duration } = springFrames(
    DROP_SPRING,
    { x: tx, y: ty },
    { x: tx + dx, y: ty + dy },
    dragVelocity.velocity(performance.now()),
  );
  const timing: KeyframeAnimationOptions = { duration, easing: "linear", fill: "forwards" };
  const flight = feedbackElement.animate(
    { translate: frames.map((f) => `${f.x}px ${f.y}px 0`) },
    timing,
  );
  // The hole closes on the same frames, from rest, so the landing stops
  // moving on the frame the card reaches it.
  const progress = springProgress(DROP_SPRING, frames.length);
  const closing = closes
    ? placeholder.animate(
        {
          marginBlockEnd: progress.map((p) => `${-share * p}px`),
          opacity: progress.map((p) => 1 - p),
        },
        timing,
      )
    : null;
  try {
    await flight.finished;
  } catch {
    /* cancelled mid-flight: nothing to hold */
  }
  // dnd-kit's cleanup runs in the microtask after this resolves: it restores
  // the card to its DOM slot and removes the hole, already closed, so nothing
  // after it moves. The forward fills are released a frame later, when the
  // in-flight card is already hidden (or, cancelled, already home). The
  // dropping mark goes with them: dnd-kit's own path removes it, and a card
  // that kept it would not follow the pointer on its next lift (the translate
  // lock is `:not([data-dnd-dropping])`).
  requestAnimationFrame(() => {
    flight.cancel();
    closing?.cancel();
    feedbackElement.removeAttribute("data-dnd-dropping");
  });
};

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
 * React's own attribute reconciliation. Ruling 457: it writes only a value
 * that differs, because an unconditional write is a DOM mutation on every
 * card each time the board renders (40 per revalidation).
 */
function useRovingStageMenu(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const btn = ref.current?.querySelector<HTMLButtonElement>(
      "button.stage-menu-btn",
    );
    const tabIndex = active ? 0 : -1;
    if (btn && btn.tabIndex !== tabIndex) btn.tabIndex = tabIndex;
  });
  return ref;
}

/**
 * Ruling 365: the trace mark in the card's head — the PR number when a PR
 * exists (the stronger trace; it implies the branch, ruling 171(d)), else the
 * branch glyph alone with the branch name as its tooltip and accessible name,
 * else nothing. The chip used to print the branch name, which at the board's
 * 218px lanes cut to "shop-6…" and told nobody anything the key beside it had
 * not; the task page's GitHub trace prints both in full.
 */
function TraceMark({ task }: { task: BoardTask }) {
  if (task.pr) {
    return (
      <span className="trace" title={"Pull request #" + task.pr.number}>
        {/* Interface review 2026-09-24 (acce-5): the title is the pointer's
            extra; the words reach the accessibility tree through `.vh`. */}
        <Icon name="pr" />
        <span className="vh">Pull request </span>#{task.pr.number}
      </span>
    );
  }
  if (task.branch) {
    return (
      <span
        className="trace br"
        role="img"
        aria-label={"Branch " + task.branch}
        title={"Branch " + task.branch}
      >
        <Icon name="branch" />
      </span>
    );
  }
  return null;
}

/**
 * Ruling 365: the card's two seats as one stack at the head's right end — the
 * agent's badge, when an agent carries the task (ruling 171(a)'s carrier seat,
 * its profile name now the badge's tooltip and accessible name rather than
 * printed text), then the owner's avatar (ruling 171(b), unchanged). Nobody
 * carrying the task draws nothing: the ghost owner avatar and a "ready" status
 * already say so, and "no agent" on every Triage card was noise.
 */
function WhoStack({ task }: { task: BoardTask }) {
  const sp = task.specialist;
  return (
    <span className="who">
      {sp && <AgentBadge backend={sp.backend} name={sp.profileName ?? sp.role} />}
      <OwnerSeat task={task} />
    </span>
  );
}

/**
 * Ruling 365: the status chip — the ONE tinted chip on a card, whose tint is
 * its meaning (`cardStatus`, card-status.ts). "agent working" keeps the live
 * pulse for its mark (R21-8); a clock rest names its instant (ruling 225) and
 * falls back to "on its own" for a schedule the read boundary could not parse.
 */
function StatusChip({ task }: { task: BoardTask }) {
  const s = cardStatus(task);
  if (!s) return null;
  return (
    <span className={"chip st " + s.kind}>
      {s.icon === null ? <span className="working" /> : <Icon name={s.icon} />}
      {s.label}
      {s.kind === "scheduled" &&
        (s.resumesAt ? (
          <>
            {" "}
            <LocalDayDotTime iso={s.resumesAt} />
          </>
        ) : (
          " on its own"
        ))}
    </span>
  );
}

/**
 * Ruling 365: the problems, most severe first (`cardProblems`). Two draw at
 * full strength and the rest fold into one "+N" whose title lists them — the
 * pass-30 rule, with the cap at two now that the chips are outlined objects
 * rather than filled pills. Every fact stays visible, on hover here and in
 * full on the task page (rulings 40/12/14).
 */
function ProblemChips({ task }: { task: BoardTask }) {
  const problems = cardProblems(task);
  const shown = problems.slice(0, PROBLEM_CAP);
  const folded = problems.slice(PROBLEM_CAP);
  return (
    <>
      {shown.map((p) => (
        <span key={p.key} className={"chip pb" + (p.tone ? " " + p.tone : "")}>
          <Icon name={p.icon} />
          {p.label}
        </span>
      ))}
      {folded.length > 0 && (
        <span className="chip more" title={folded.map((p) => p.label).join(" · ")}>
          +{folded.length}
          {/* Interface review 2026-09-24 (acce-5): the folded problems by name
              for touch, keyboard and screen readers, as `LabelChips` does. */}
          <span className="vh">{" " + folded.map((p) => p.label).join(", ")}</span>
        </span>
      )}
    </>
  );
}

/** The card's property row: the status chip, then the problems. Drawn by the
 *  card and the list row alike (F19-13: one state block, both layouts), and
 *  absent when there is nothing to say. Ruling 503 keeps the epic off it, as
 *  ruling 172 kept the goal link off it: the board's epic filter and the task
 *  page say which epic a task is in. */
function CardChips({ task }: { task: BoardTask }) {
  if (cardStatus(task) === null && cardProblems(task).length === 0) return null;
  return (
    <div className="card-props">
      <StatusChip task={task} />
      <ProblemChips task={task} />
    </div>
  );
}

/** The list row's agent: the badge and the name — the row has the room the
 *  card does not, and ruling 168(c)'s name stays printed here. Ruling 625: a
 *  row with no agent keeps the empty seat, so the chips before it hold one
 *  column instead of sliding 7rem right. */
function ListAgent({ task }: { task: BoardTask }) {
  const sp = task.specialist;
  if (!sp) return <span className="list-agent" aria-hidden="true" />;
  return (
    <span className="list-agent">
      <AgentGlyph backend={sp.backend} decorative />
      <span className="nm">{sp.profileName ?? sp.role}</span>
    </span>
  );
}

/**
 * Ruling 171: the OWNER seat — the row's right end, on every card. The human
 * owner's avatar (initials; the name is the accessible label and the title),
 * or the empty seat when nobody owns the task yet: "awaiting owner" while an
 * operator is assigned and will be asked to find one, "unassigned" before
 * that — the two words the old left-seat fallback used. It used to render
 * only beside an engaged agent, which is what left a human-owned card without
 * one with a bare right end.
 */
function OwnerSeat({ task }: { task: BoardTask }) {
  const o = task.owner;
  const human = o && o.kind === "human" ? o : null;
  const name = human ? human.name : task.operator ? "awaiting owner" : "unassigned";
  return (
    <span
      className="rev-stack"
      title={human ? "Owner · human reviewer & acceptance: " + human.name : "Owner: " + name}
      // The Avatar renders initials only; expose the real name to keyboard/
      // touch/SR users too (title alone is a weak accessible name), matching
      // MemberStack's convention. `role="img"` is what makes the label count:
      // ARIA prohibits `aria-label` on a role-less span and readers drop it,
      // so without the role the owner read as bare initials.
      role="img"
      aria-label={"Owner: " + name}
    >
      {human ?<Avatar person={human} size="xs" /> : <span className="avatar xs ghost">?</span>}
    </span>
  );
}

/**
 * The card's sortable plugins, made once (ruling 457). dnd-kit compares the
 * option by reference and re-resolves it whenever it changes, so an inline
 * function rebuilt the card's plugins on every render of every card.
 */
const cardPlugins = ((defaults) => [
  ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
  Feedback.configure({ feedback: "clone", dropAnimation: boardDropAnimation }),
]) satisfies NonNullable<Parameters<typeof useSortable>[0]["plugins"]>;

/** Row keys for `useStableRows` (stable, module-level). */
const taskKeyOf = (task: BoardTask) => task.key;
const stageIdOf = (stage: BoardStage) => stage.id;

/**
 * Ruling 457: memoised, so a revalidation or a drag renders only the cards
 * whose props changed. Its lanes hand it the task object the page already held
 * when the task is unchanged (`useStableRows`), and the board keeps the stage
 * list and the move callback stable; before this every live update rendered
 * all forty cards of the demo board and ran their sixteen effects each.
 */
const TaskCard = memo(function TaskCard({
  task,
  index,
  canTransition,
  arrived,
  inFlight,
  allStages,
  onMoveTask,
  onNudgeTask,
  canMoveUp,
  canMoveDown,
  roving,
}: {
  task: BoardTask;
  /** A move for this card is awaiting the server: the card hides here and the
   *  landing preview stands in the requested slot (see `boardDropAnimation`). */
  inFlight: boolean;
  /** Visible position within the column (sortable registration). */
  index: number;
  /** admin|maintainer — makes the card draggable between stage columns. */
  canTransition: boolean;
  /** This card just landed here from a drop (plays the arrival pulse). */
  arrived: boolean;
  /** F10-25: all stages, for the keyboard-accessible "Move to stage" menu. */
  allStages: BoardStage[];
  onMoveTask: (taskKey: string, toStageId: string) => void;
  /** acce-17: Move up / Move down within the lane; the edges say whether this
   *  card has a neighbour on that side. */
  onNudgeTask: (taskKey: string, stageId: string, dir: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** D19: this card holds the board's single tab stop (see `onCardKeyDown`,
   *  board-page-actions.tsx). */
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
  // The card is the drag source (and a sortable droppable, which dnd-kit needs
  // for its own events — the board's slot comes from `slotInLane`, not from
  // which card dnd-kit names as the target).
  // With clone feedback dnd-kit moves THIS element under the pointer and leaves
  // a placeholder clone (`[data-dnd-placeholder]`) in its slot, mirroring the
  // element's attributes — so the two are styled by dnd-kit's attributes, never
  // by a React class (a class lands on both). Optimistic sorting is OFF — the
  // board never reorders client-side; the DropPreview shows the requested slot
  // and the server's answer is the only commit.
  const { ref } = useSortable({
    id: task.key,
    group: task.stage,
    index,
    disabled: !canTransition || archived,
    // No index-change transition either: the only re-layouts here are the
    // server's, and dnd-kit animated a card that arrived by revalidation from
    // the rect it last measured in the OLD lane — a 600px excursion off-screen
    // and back, right after the flight landed it (observed frame by frame).
    transition: null,
    plugins: cardPlugins,
  });
  const wrapCls = ["card-wrap"];
  if (canTransition && !archived) wrapCls.push("draggable");
  if (inFlight) wrapCls.push("in-flight");
  if (arrived) wrapCls.push("just-arrived");
  return (
    /* D19: the lane is a list (see `Column`), so each card is one of its items —
       that is what makes a screen reader say "3 of 7" as the arrows move. */
    <div
      className={wrapCls.join(" ")}
      ref={ref}
      role="listitem"
      /* The slot rule reads the lane's flow from the DOM (`laneBlocks`,
         board-page-actions.tsx): this names the card each block stands for.
         dnd-kit's placeholder — the hole a lifted card leaves — is a clone of
         this element, so it carries the key too and stands in the flow for
         the card. */
      data-card-key={task.key}
    >
      <Link
        className="card"
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
        <CardFace task={task} />
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
            onReorder={(dir) => onNudgeTask(task.key, task.stage, dir)}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
          />
        </div>
      )}
    </div>
  );
});

/**
 * The card's face — everything inside the link. Rendered by the card itself
 * and, faded, by the drop preview, so a preview stands exactly as tall as the
 * card that will replace it.
 *
 * Ruling 365 — the anatomy, top to bottom: the head (the key and the trace
 * mark in secondary ink, the seats as a stack at the right), the title (the
 * only primary text on the card), and the property row (the one tinted status
 * chip, then the problems). The old top pill / owner row / two-cell foot, and
 * the `readinessYields` dance that decided which of three seats got to speak,
 * are gone: `cardStatus` answers once.
 */
function CardFace({ task }: { task: BoardTask }) {
  return (
    <>
      <div className="card-head">
        <span className="key">{task.key}</span>
        <TraceMark task={task} />
        <span className="card-sp" />
        <WhoStack task={task} />
      </div>
      <h3>{task.title}</h3>
      <CardChips task={task} />
    </>
  );
}

/**
 * The requested slot, drawn as the card's own face — faded, in a blue dashed
 * frame — at the card's own height, so the moment the server confirms the move
 * the real card takes the exact pixels the preview held. Shown while a drag
 * hovers a slot that would change something (never the card's own slot), and
 * kept as the LANDING stand-in between the drop and the server's answer: the
 * board never commits a move client-side, so this is the request, not the
 * result (owner, 2026-09-08).
 */
/** Where a move's landing preview stands in a lane drawn as `keys`: before the
 *  card the drop asked for — or at the lane's end once that card has left the
 *  lane, which is where the server appends the move then (`reorderTask`). */
function landingSlot(keys: readonly string[], beforeKey: string | null): string | null {
  return beforeKey !== null && keys.includes(beforeKey) ? beforeKey : null;
}

/** A reorder within one lane has landed once the lane, drawn as `keys`, holds
 *  the card right before the slot it asked for (last, for the lane's end). */
function reorderLanded(keys: readonly string[], key: string, beforeKey: string | null): boolean {
  const at = keys.indexOf(key);
  return at >= 0 && (keys[at + 1] ?? null) === landingSlot(keys, beforeKey);
}

function DropPreview({ task, landing = false }: { task: BoardTask; landing?: boolean }) {
  return (
    <div className={"card-wrap drop-preview" + (landing ? " landing" : "")} aria-hidden="true">
      <div className="card card-drop-preview">
        <CardFace task={task} />
      </div>
    </div>
  );
}

/**
 * An empty lane's one child (ruling 696(e), split out of `Column`): the drop
 * preview while a drag hovers the lane, else the landing of a move awaiting the
 * server, else the empty copy — with, in a virgin board's entry lane, its call
 * to action. `Column` renders it only while its lane draws no cards.
 */
function EmptyLane({
  preview,
  landing,
  emptyCopy,
  createCta,
  isEntry,
  canCreate,
  onNew,
}: {
  /** The drop preview, while a drag hovers this lane. */
  preview: ReactElement | null;
  /** The landing preview of a move into this lane awaiting the server. */
  landing: ReactElement | null;
  emptyCopy: string;
  createCta: boolean;
  isEntry: boolean;
  canCreate: boolean;
  onNew: () => void;
}) {
  if (preview) return preview;
  if (landing) return landing;
  return (
    <div className="empty">
      {emptyCopy}
      {/* Pass 30: the teaching moment gets its call to action IN the
          empty lane (diagnose: headline + emphasized CTA), not only up
          in the header. Virgin boards only — a busy board already has
          two create affordances. */}
      {createCta && isEntry && canCreate && (
        <button
          type="button"
          className="btn primary sm empty-cta"
          onClick={onNew}
        >
          <Icon name="plus" />
          New task
        </button>
      )}
    </div>
  );
}

/** D19: a lane drawing cards is a list of them, named for its stage and
 *  reachable by Tab; a lane drawing none is none of the three (the lane body's
 *  comment in `Column` says why each). */
function laneList(stageName: string, cardCount: number) {
  return cardCount > 0
    ? { role: "list", label: `${stageName} tasks`, tabIndex: 0 }
    : { role: undefined, label: undefined, tabIndex: undefined };
}

function Column({
  stage,
  tasks: laneTasks,
  count,
  isDone,
  isEntry,
  canCreate,
  createCta,
  canTransition,
  onNew,
  arrivedKey,
  dropTarget,
  previewTask,
  beforeKey,
  landing,
  inFlightKey,
  allStages,
  onMoveTask,
  onNudgeTask,
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
  /** Pass 30: the virgin-board teaching CTA in the entry lane. */
  createCta: boolean;
  canTransition: boolean;
  onNew: () => void;
  arrivedKey: string | null;
  /** This column is the current drop target (highlight + show the preview). */
  dropTarget: boolean;
  previewTask: BoardTask | null;
  /** Insertion slot: render the preview before this card (null = column end). */
  beforeKey: string | null;
  /** A move awaiting the server lands HERE: the landing preview stands before
   *  `beforeKey` (null = column end) until the answer renders the real card. */
  landing: { task: BoardTask; beforeKey: string | null } | null;
  /** The card in this lane whose move is awaiting the server (hidden). */
  inFlightKey: string | null;
  allStages: BoardStage[];
  onMoveTask: (taskKey: string, toStageId: string) => void;
  onNudgeTask: (taskKey: string, stageId: string, dir: -1 | 1) => void;
}) {
  // The lane is a droppable for two reasons that are not its collisions: the
  // slot rule (`refineSlot`, `useBoardDrag`) finds the lanes' live rectangles
  // through dnd-kit's registry by this id, and `dragover` fires when the
  // pointer crosses into an empty lane. Which droppable dnd-kit calls the target no longer decides
  // anything — the lane comes from the pointer (`laneAt`), the slot from the
  // lane's flow (`slotInLane`). Priority 1 (Low) keeps dnd-kit's own target
  // sensible: an over-card collision (Normal, 2) wins over its column.
  const { ref } = useDroppable({
    id: `stage:${stage.id}`,
    collisionPriority: 1,
  });
  // Ruling 457: the task objects this lane already drew, wherever a
  // revalidation brought the same task back, so the memoised cards skip.
  const tasks = useStableRows(laneTasks, taskKeyOf);
  const showPreview = dropTarget && previewTask !== null;
  const preview = showPreview ? <DropPreview task={previewTask!} /> : null;
  const landingEl = landing ? <DropPreview task={landing.task} landing /> : null;
  // Ruling 661: a lane takes the dock reserve (`.col-body.overflows`) only
  // while its cards overflow it, so a lane whose cards fit does not scroll.
  // The read leaves the reserve out (the lane's own foot matches its top):
  // counted in, it would keep a lane scrolling once its cards fit again,
  // which is what a `scroll-state(scrollable)` query would do. Measured after
  // layout, as `Collapsible` measures its height.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      const style = getComputedStyle(body);
      const reserve = body.classList.contains("overflows")
        ? parseFloat(style.paddingBottom) - parseFloat(style.paddingTop)
        : 0;
      setOverflows(body.scrollHeight - reserve > body.clientHeight);
    };
    measure();
    // No guard: dnd-kit needs a ResizeObserver wherever the board renders
    // (jsdom's is the stub in setup-dom.ts).
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    for (const block of body.children) ro.observe(block);
    return () => ro.disconnect();
  }, [tasks, showPreview, beforeKey, landing]);
  const list = laneList(stage.name, tasks.length);
  return (
    <section
      className={"column" + (dropTarget ? " drop-over" : "")}
      ref={ref}
    >
      <header className="col-head">
        <span className="col-stage-dot" data-stage-color={stage.color} />
        <h2 className="nm">{stage.name}</h2>
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
        ref={bodyRef}
        className={"col-body" + (overflows ? " overflows" : "")}
        role={list.role}
        aria-label={list.label}
        tabIndex={list.tabIndex}
      >
        {tasks.length === 0 ? (
          <EmptyLane
            preview={preview}
            landing={landingEl}
            emptyCopy={emptyCopy}
            createCta={createCta}
            isEntry={isEntry}
            canCreate={canCreate}
            onNew={onNew}
          />
        ) : (
          <>
            {tasks.map((t, i) => (
              <Fragment key={t.key}>
                {showPreview && beforeKey === t.key && preview}
                {landing && landing.beforeKey === t.key && landingEl}
                <TaskCard
                  task={t}
                  index={i}
                  canTransition={canTransition}
                  arrived={arrivedKey === t.key}
                  inFlight={inFlightKey === t.key}
                  allStages={allStages}
                  onMoveTask={onMoveTask}
                  onNudgeTask={onNudgeTask}
                  canMoveUp={i > 0}
                  canMoveDown={i < tasks.length - 1}
                  roving={rovingKey === t.key}
                />
              </Fragment>
            ))}
            {showPreview && beforeKey === null && preview}
            {landing && landing.beforeKey === null && landingEl}
          </>
        )}
      </div>
    </section>
  );
}

/** D19: extracted from `ListView`'s map so the row can hold the roving-tab-stop
 *  hook — a hook cannot be called inside a `.map` callback. Ruling 457:
 *  memoised like the card, for the same reason. */
const ListRow = memo(function ListRow({
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
  const stage = stages.find((s) => s.id === task.stage);
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
      {/* F19-13: the card's state block verbatim — the row used to draw
          validation and the wait tag alone, so the PR-state, checks and
          review pills existed on one board layout and not the other. Ruling
          365: the same status chip and problem chips the card draws. Ruling
          625: before the seats, so the stage and the owner — fixed widths at
          the row's end — start on one x on every row whatever the chips say. */}
      <CardChips task={task} />
      <ListAgent task={task} />
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
        // Same read-only rendering the task page uses (stage-colored dot +
        // name), not a bare neutral pill — one fact, one treatment.
        <span className="stage-static">
          <span className="col-stage-dot sm" data-stage-color={stage?.color} />
          {/* Ruling 148: one fact, one wording — the stage menu and the task
              page say "unknown stage" too, and the raw internal id is not
              rendered copy. */}
          {stageLabel(stage)}
        </span>
      )}
      {/* Ruling 625: no per-row "OWNER" eyebrow — the seat's place in the
          row and its accessible name say what it is. */}
      <OwnerSeat task={task} />
    </div>
  );
});

function ListView({
  tasks: visibleTasks,
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
  // Ruling 457: unchanged tasks keep the objects the rows already drew.
  const tasks = useStableRows(visibleTasks, taskKeyOf);
  return (
    <div className="board list">
      {/* The lanes give the stage layout its h2s; the list has one lane, so
          this is its level between the page h1 and the row h3s. Spoken only:
          the layout toggle already says "List" on screen. */}
      <h2 style={SR_ONLY}>All tasks</h2>
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
 * Ruling 694: what the New task dialog asks for, in the words of the board it
 * is on. A board with a repository files a change, and its goal is what counts
 * as done. A board with none files a piece of a person's own work (ruling
 * 667), and a person who came to hand over a subject and a few notes was asked
 * for a "goal" a triage gate would flag, under an example about a force-push.
 */
const NEW_TASK_COPY = {
  repository: {
    titlePlaceholder: "e.g. Reconcile PR state after force-push",
    stage: "The goal gets refined at triage before any work begins.",
    goalHint: "what counts as done, for the operator and the agents",
    goalPlaceholder: "One or two sentences. A vague goal gets flagged by the operator at triage.",
  },
  files: {
    titlePlaceholder: "e.g. What you want back, in a few words",
    stage: "The agents work from what you write here and ask you for what only you know.",
    goalHint: "what you want back, and what you know about it",
    goalPlaceholder: "Say what you want back and add your notes. Files go below.",
  },
} as const;

function NewTaskModal({
  entryStageName,
  hasRepository,
  labelSuggestions,
  epics,
  initialEpic,
  onClose,
}: {
  /** R19-14: every task is created at the entry stage — the modal names it. */
  entryStageName: string;
  /** Ruling 694: whether the project has a repository, which decides the
   *  dialog's words. */
  hasRepository: boolean;
  /** Labels already used across the board, offered as label autocomplete. */
  labelSuggestions: string[];
  /** Ruling 503: the project's open epics, a new task can start in one. */
  epics: readonly EpicOption[];
  /** The epic the board is filtered to, so a task made there lands in it. */
  initialEpic: string | null;
  onClose: () => void;
}) {
  const copy = hasRepository ? NEW_TASK_COPY.repository : NEW_TASK_COPY.files;
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [epic, setEpic] = useState(initialEpic ?? "");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [labels, setLabels] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  // Ruling 533: the files the task is filed with, and the first one refused.
  const [files, setFiles] = useState<File[]>([]);
  const [filesProblem, setFilesProblem] = useState<string | null>(null);
  const addFiles = (incoming: File[]) => {
    const next = addPickedFiles(files, incoming, FILING_BATCH);
    setFiles(next.files);
    setFilesProblem(next.problem);
  };
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
  const titleRef = useRef<HTMLInputElement>(null);

  const valid = title.trim().length >= 3;
  // The dialog opened on an empty title, so `!valid` was true from first paint
  // and the footer greeted every new task with "A title needs at least 3
  // characters." — an error for something the person had not had a chance to
  // do yet. The requirement is only *unmet* once they have left the field or
  // tried to submit.
  const [titleTouched, setTitleTouched] = useState(false);
  // One condition for the red hint, the alert role, the field's aria-invalid
  // and its describedby, so the four can never disagree.
  const titleError = titleTouched && !valid;
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
      // Ruling 459: the same exit Cancel plays; close() then calls onClose.
      close();
    }
  }, [fetcher.data, close, push]);

  const submit = () => {
    setTitleTouched(true);
    // A created task's modal is leaving: an Enter in the title during the
    // exit must not create a second one.
    if (busy || closedRef.current) return;
    if (!valid) {
      // The primary is no longer hard-disabled while the form is invalid (a
      // disabled submit gave a click no feedback and dropped out of the tab
      // order), so the click reaches this guard: name the requirement, mark
      // the field, and put the person on it.
      titleRef.current?.focus();
      return;
    }
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-task");
    fd.set("title", title.trim());
    fd.set("goal", goal.trim());
    if (priority !== "normal") fd.set("priority", priority);
    if (labels.length > 0) fd.set("labels", labels.join(","));
    if (dueDate) fd.set("dueDate", dueDate);
    if (epic) fd.set("epic", epic);
    for (const file of files) fd.append("files", file, file.name);
    // R19-14: no stage field — the server creates at the entry stage.
    fetcher.submit(
      fd,
      files.length > 0 ? { method: "post", encType: "multipart/form-data" } : { method: "post" },
    );
  };

  return (
    <dialog
      className="modal-card modal-narrow"
      aria-label="New task"
      ref={panelRef}
      // Ruling 533: a screenshot pasted anywhere in the dialog is filed with
      // the task; copied text pasted into a field stays text.
      onPaste={(e) => {
        const intoTextField =
          e.target instanceof Element && e.target.matches("input, textarea, [contenteditable]");
        const pasted = filesFromPaste(e.clipboardData, intoTextField, files);
        if (!pasted) return;
        e.preventDefault();
        addFiles(pasted);
      }}
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
            <span className="fhint">at least 3 characters</span>
          </label>
          <input
            id="new-task-title"
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? "new-task-hint" : undefined}
            // Empty-blur stays quiet: dialog.showModal() steals focus right
            // after autoFocus, so an unconditional blur handler marked the
            // field touched on FIRST PAINT and the footer opened red (the
            // exact premature-error this state exists to prevent). A person
            // who typed something and left the field still gets the check;
            // submit() flags it regardless.
            onBlur={(e) => {
              if (e.target.value.trim() !== "") setTitleTouched(true);
            }}
            placeholder={copy.titlePlaceholder}
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
            Starts in {entryStageName}. {copy.stage}
          </span>
        </div>
        <div className="field">
          <label className="flabel" htmlFor="new-task-goal">
            Goal
            <span className="fhint">{copy.goalHint}</span>
          </label>
          <textarea
            id="new-task-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={copy.goalPlaceholder}
          />
        </div>
        <FiledFiles
          files={files}
          problem={filesProblem}
          onAdd={addFiles}
          onRemove={(name) => {
            setFiles((prev) => prev.filter((f) => f.name !== name));
            setFilesProblem(null);
          }}
        />
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
              label="Due date"
              // Visible text inside the name "Due date: not set" (label in name).
              placeholder="Not set"
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
        {/* Ruling 503: a task can start in an epic; it can join or leave one
            at any time afterwards, from its own page or the epic's. */}
        {epics.length > 0 && (
          <div className="field">
            <label className="flabel" htmlFor="new-task-epic">
              Epic
              <span className="fhint">optional</span>
            </label>
            <select id="new-task-epic" value={epic} onChange={(e) => setEpic(e.target.value)}>
              <option value="">No epic</option>
              {epics.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <NewTaskFoot
        titleError={titleError}
        serverError={serverError}
        busy={busy}
        onCancel={close}
        onSubmit={submit}
      />
    </dialog>
  );
}

/**
 * The new-task dialog's foot (ruling 696(e), split out of `NewTaskModal`): the
 * one hint line — the title's length rule once it is unmet, else the server's
 * refusal, else how the key is assigned — and the two actions. The modal owns
 * the form and the post and hands this what it shows.
 */
function NewTaskFoot({
  titleError,
  serverError,
  busy,
  onCancel,
  onSubmit,
}: {
  /** The title's length rule is unmet, and the field was left or submitted. */
  titleError: boolean;
  /** The server's refusal of the last create, if it refused. */
  serverError: string | null | undefined;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="modal-foot">
      <span
        id="new-task-hint"
        className={"foot-hint" + (serverError || titleError ? " err" : "")}
        // UX-coherence: announce the server/validation error to screen
        // readers — the same role=alert idiom the Home "New project" modal
        // got in the Pass-19 audit; this modal (same fetcher/serverError
        // shape) was missed. Condition mirrors the className ternary above so
        // the announce state can never desync from the visible error. The
        // title requirement outranks a stale server refusal: the field's
        // describedby points here, so the text must be about the title
        // whenever the title is what is wrong.
        role={serverError || titleError ? "alert" : undefined}
      >
        {/* Interface review 2026-09-24 (writ-4): "A title is required." said
            nothing to someone who had typed "QA"; the rule is the length. */}
        {titleError
          ? "A title needs at least 3 characters."
          : serverError
            ? serverError
            : "The task key is assigned automatically."}
      </span>
      <div className="foot-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        {/* Enabled until the request starts: an invalid submit is refused
            with the hint above, the field marked and focused (submit()).
            Only `busy` disables, and the aria-busy sheet rule paints it. */}
        <button
          type="button"
          className="btn primary"
          onClick={onSubmit}
          disabled={busy}
          aria-busy={busy}
        >
          <Icon name="plus" />
          Create task
        </button>
      </div>
    </div>
  );
}

/* ---------- Board ---------- */

/** Visible label filter chips before the "+N more" overflow chip. */
const LABEL_CHIP_CAP = 6;

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
      ? countLabel(taskCount, "task")
      : `${shownCount} of ${countLabel(taskCount, "task")}`;
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
        {/* role="status" on the count alone: it changes as the filter is
            typed, and a screen reader otherwise hears nothing change; the
            project-wide waiting figure does not follow the filter, so it stays
            outside the (atomic) region. No explicit aria-live: the board's own
            announcer is found by that attribute. */}
        <div className="sub">
          <span role="status">{countLine}</span> · {waitingHuman} waiting on a
          human in this project
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
  epicFilter,
  epics,
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
  /** Ruling 503: the active epic filter (`?epic=`, an epic's id or `none`),
   *  and the project's epics it picks from. */
  epicFilter: string | null;
  epics: readonly EpicOption[];
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
  // Label-chip overflow: active label first, then the vocabulary order.
  const [labelsExpanded, setLabelsExpanded] = useState(false);
  const orderedLabels = labelFilter
    ? [
        ...projectLabels.filter(
          (l) => l.toLowerCase() === labelFilter.toLowerCase(),
        ),
        ...projectLabels.filter(
          (l) => l.toLowerCase() !== labelFilter.toLowerCase(),
        ),
      ]
    : projectLabels;
  return (
    <div className="filter-bar">
      {/* R15-5: the term input lives on the BOARD now. The topbar's box read
          "Search tasks, branches, agents…" while only ever filtering the open
          board; the global question moved to the ⌘K palette and this one says
          exactly what it does. Ruling 625: it leads the row, the left end that
          the open controller dock (anchored bottom right) never covers; at the
          row's right end it sat under the dock's panel at 1280×720. */}
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
      {/* Ruling 625: the chips as one row — no box on a wide screen (the row
          is `display: contents` there), one line that scrolls sideways on a
          phone, where seven wrapped chips took three rows above the lanes. */}
      <div className="fchip-row">
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
            // Ruling 632: clicking the active chip clears it, back to All tasks.
            onClick={() => setParam("filter", f.id === "all" || filter === f.id ? null : f.id)}
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
        {/* F26-12 / R26-2: one chip per label the project actually uses (the same
            vocabulary the New-task modal offers). Single-select: clicking a label
            narrows the board to its tasks; clicking the active one clears it. They
            AND with the readiness chips and the term, and only render when the
            project has labels — a board that never tagged anything stays clean. */}
        {/* Cap the visible label chips (active-first) — a many-label project
            pushed the search input down several wrapped rows. The overflow
            stays reachable: expand in place, and the search box already
            matches labels. Mirrors the card's own LabelChips "+N" rule. */}
        {(labelsExpanded
          ? orderedLabels
          : orderedLabels.slice(0, LABEL_CHIP_CAP)
        ).map((l) => {
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
        {orderedLabels.length > LABEL_CHIP_CAP && (
          <button
            type="button"
            className="fchip lbl"
            aria-expanded={labelsExpanded}
            onClick={() => setLabelsExpanded((v) => !v)}
            title={
              labelsExpanded
                ? "Collapse the label list"
                : `Show all ${orderedLabels.length} labels`
            }
          >
            {labelsExpanded
              ? "fewer labels"
              : `+${orderedLabels.length - LABEL_CHIP_CAP} more`}
          </button>
        )}
      </div>
      {/* Ruling 503: only when the project has epics, or the filter is
          already on (`EpicFilter`). */}
      {(epics.length > 0 || epicFilter) && (
        <EpicFilter epicFilter={epicFilter} epics={epics} setParam={setParam} />
      )}
      {/* P13-D-34: the board's clear-filter affordance. "All tasks" resets the
          filter but NOT `?q=`, so a board hidden by a stale term needs one
          control that resets both (and the label filter — F26-12). One chip per
          board, not one per column. */}
      {(filter !== "all" || query.trim() !== "" || labelFilter || epicFilter) && (
        <button
          type="button"
          className="fchip"
          onClick={onClear}
          title="Show every task again. Clears the board filter, the label and epic filters and the search"
        >
          <Icon name="x" />
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Ruling 503: one epic's tasks, or those in none. A select rather than chips: a
 * project can hold many epics, and their names are long. Split out of
 * `FilterBar` by ruling 696(e); the bar draws it only when the project has
 * epics, or the filter is already on.
 */
function EpicFilter({
  epicFilter,
  epics,
  setParam,
}: {
  epicFilter: string | null;
  epics: readonly EpicOption[];
  setParam: (key: string, value: string | null) => void;
}) {
  return (
    <label className={"board-epic-filter" + (epicFilter ? " on" : "")}>
      <Icon name="epic" />
      <select
        value={epicFilter ?? ""}
        aria-label="Show one epic's tasks"
        onChange={(e) => setParam("epic", e.target.value || null)}
      >
        <option value="">All epics</option>
        <option value={EPIC_FILTER_NONE}>No epic</option>
        {epics.map((epic) => (
          <option key={epic.id} value={epic.id}>
            {epic.title}
            {isEpicOpen(epic.status) ? "" : ` (${EPIC_STATUS_LABEL[epic.status]})`}
          </option>
        ))}
        {epicFilter &&
          epicFilter !== EPIC_FILTER_NONE &&
          !epics.some((epic) => epic.id === epicFilter) && (
            <option value={epicFilter}>{epicFilter}</option>
          )}
      </select>
    </label>
  );
}

function OrphanBanner({ orphanTasks }: { orphanTasks: BoardTask[] }) {
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

/**
 * U33-2 — the repository fact, on the surface the work happens on.
 *
 * Creating a project pre-fills the repo name from the project name (pass-8 P1),
 * so "Sandbox" produced `akin-ozer/sandbox`, which does not exist. Creation
 * succeeded, the `repoWarning` toast fired once, and after that the fact had no
 * home: only /projects/:slug/github said "repo not found", while every agent
 * run failed its clone (`git exit 128`) with nothing on the board saying why.
 *
 * Two things are deliberately borrowed rather than invented. The strip is the
 * board's OWN banner slot (`.board-orphans`, already carrying both the unstaged
 * diagnosis and the archived-filter explainer), and the words come from
 * `connectionPill` — the ONE connection vocabulary the GitHub page's Connection
 * row speaks — so the two surfaces cannot word the same fact differently.
 *
 * VISIBILITY is derived from that shared pill instead of re-listing statuses:
 * `risk`/`blocked` are exactly the arms where a repository IS configured and
 * GitHub will not serve it, which is what makes every clone fail. `connected`,
 * `no_repo_configured` (a legitimate choice, already rendered as "no
 * repository"), `no_pat_configured` (setup, not breakage) and
 * `network_unavailable` (transient) stay quiet — a board that cries wolf while
 * GitHub is briefly down teaches people to ignore it.
 *
 * The same two lines live in `features/home/project-cards.tsx`. They belong
 * beside `connectionPill` in `features/github/github-pills.ts`; that file is
 * another cluster's, so the duplication is recorded here rather than smuggled
 * in as a third vocabulary.
 */
function repoAccessNotice(access: RepoAccessResult) {
  const pill = connectionPill(access);
  if (pill.kind !== "risk" && pill.kind !== "blocked") return null;
  // Discriminant, not an `in` probe: `no_repo_configured` is the one arm with
  // no repo, and it never reaches here (its pill is neutral).
  const repo = access.status === "no_repo_configured" ? null : access.repo;
  return { repo, label: pill.label };
}

function RepoAccessBanner({
  slug,
  access,
}: {
  /** Route param, so the link works on a board with no tasks to borrow a slug
   *  from (a brand-new project is exactly where this misconfiguration lands). */
  slug: string;
  access: RepoAccessResult;
}) {
  const notice = repoAccessNotice(access);
  if (!notice) return null;
  return (
    <div className="board-orphans" role="region" aria-label="Repository">
      <Icon name="github" />
      <span className="board-orphans-label">
        {notice.repo} · {notice.label}. Agents clone the repository before they
        work, so runs in this project fail until GitHub can serve it.
      </span>
      <Link className="board-orphan-key" to={`/projects/${slug}/github`}>
        GitHub
      </Link>
    </div>
  );
}

/** The board by stage. Exported for its render test: a move in flight within
 *  one lane starts from a pointer drag, which jsdom has no layout to run. */
export function StageBoard({
  columns,
  visible,
  doneStageId,
  canCreate,
  createCta,
  canTransition,
  onNew,
  drag,
  overStage,
  beforeKey,
  arrivedKey,
  draggedTask,
  inFlight,
  inFlightTask,
  onMoveTask,
  onNudgeTask,
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
  /** Pass 30: virgin-board teaching CTA in the entry lane. */
  createCta: boolean;
  canTransition: boolean;
  /** R19-14: creation lands at the entry stage, so no stage argument here. */
  onNew: () => void;
  drag: { key: string; fromStage: string } | null;
  overStage: string | null;
  beforeKey: string | null;
  arrivedKey: string | null;
  draggedTask: BoardTask | null;
  /** The move awaiting the server, and the card it moves (see `boardDropAnimation`). */
  inFlight: { key: string; from: string; to: string; beforeKey: string | null } | null;
  inFlightTask: BoardTask | null;
  /** F10-25: the StageMenu move — the always-available non-drag path. */
  onMoveTask: (taskKey: string, toStageId: string) => void;
  /** acce-17: the StageMenu's Move up / Move down — the non-drag path to a
   *  slot within the lane. */
  onNudgeTask: (taskKey: string, stageId: string, dir: -1 | 1) => void;
}) {
  // All stages, for the per-card keyboard "Move to stage" menu (F10-25). The
  // same array while the stages are unchanged (ruling 457): every card takes it.
  const allStages = useStableRows(
    columns.map((c) => c.stage),
    stageIdOf,
  );
  // The slot a drop would submit RIGHT NOW — the same resolution `onDragEnd`
  // (`useBoardDrag`) runs, so the preview shows exactly what the drop would ask
  // for, and shows nothing where a drop would change nothing (the card's own
  // slot in its own lane: before itself, before the card that already follows
  // it). Before this the preview drew "before itself" over the hole the card
  // had just left, so a card looked movable above and below its own ghost
  // (owner, 2026-09-08).
  const slot =
    drag && overStage
      ? resolveBoardDrop({
          dragKey: drag.key,
          fromStage: drag.fromStage,
          overStage,
          beforeKey,
          columns: columns.map((c) => ({
            stageId: c.stage.id,
            keys: visible(c.tasks).map((t) => t.key),
          })),
        })
      : null;
  // Read against the DATA, not the request: once the server's answer has
  // revalidated the columns the card stands where it asked to be, so nothing is
  // left to hide and the landing preview has nothing to stand in for — the
  // real card takes its place in the same render, no blank frame and no
  // doubled card while the fetcher settles. A move to another lane is read per
  // lane below: its old lane no longer holds the card, its new one does. A
  // reorder keeps the card in its own lane before and after, so there the
  // ORDER is the answer (`reorderLanded`); until the lane has it, the card
  // hides in its old slot and the landing stands in the slot it asked for.
  const flight =
    inFlight &&
    !(
      inFlight.from === inFlight.to &&
      reorderLanded(
        visible(columns.find((c) => c.stage.id === inFlight.to)?.tasks ?? []).map((t) => t.key),
        inFlight.key,
        inFlight.beforeKey,
      )
    )
      ? inFlight
      : null;
  const flightFrom =
    flight &&
    columns.some(
      (c) => c.stage.id === flight.from && c.tasks.some((t) => t.key === flight.key),
    )
      ? flight.from
      : null;
  if (columns.length === 0) {
    // A project whose project.md `stages:` was emptied by an external edit
    // (in-app actions can't remove the locked entry/terminal stages) would
    // otherwise render a blank board with no explanation. Disclose it, the
    // same way the OrphanBanner / archived-filter notices in this file do.
    return (
      <div className="board-orphans notice" role="status">
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
        // A move in flight shifts the counts the same way a cross-lane hover
        // does: the card has left its lane for the requested one.
        const crossFlight = !!flight && flightFrom !== null && flight.to !== flightFrom;
        const flightSource = crossFlight && c.stage.id === flightFrom;
        const flightTarget = crossFlight && c.stage.id === flight!.to;
        const count =
          base.length +
          (isTarget ? 1 : 0) -
          (isSource ? 1 : 0) +
          (flightTarget ? 1 : 0) -
          (flightSource ? 1 : 0);
        // A reorder's landing stands in the lane the card never left; a move
        // across lanes lands until the new lane holds the card.
        const landing =
          flight &&
          inFlightTask &&
          flight.to === c.stage.id &&
          (flight.from === flight.to || !c.tasks.some((t) => t.key === flight.key))
            ? {
                task: inFlightTask,
                beforeKey: landingSlot(
                  base.map((t) => t.key),
                  flight.beforeKey,
                ),
              }
            : null;
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
            createCta={createCta}
            canTransition={canTransition}
            onNew={onNew}
            arrivedKey={arrivedKey}
            dropTarget={hovered}
            previewTask={hovered && slot ? draggedTask : null}
            beforeKey={slot?.beforeKey ?? null}
            landing={landing}
            inFlightKey={flight && flightFrom === c.stage.id ? flight.key : null}
            allStages={allStages}
            onMoveTask={onMoveTask}
            onNudgeTask={onNudgeTask}
            rovingKey={rovingKey}
          />
        );
      })}
    </div>
  );
}

interface BoardPageProps {
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
  /**
   * U33-2: GitHub's own answer for this project's repository, the last one
   * recorded (`readRepoHealth`, ruling 517). The board must NOT reach for
   * GitHub itself — the check is a live `GET /repos/:repo`, and project-scope
   * SSE revalidates this view on every task event. Null or absent means "nobody
   * has established it", which the banner reads as silence, never as health.
   */
  repoAccess?: RepoAccessResult | null;
  /** Ruling 694: false on a board with no repository, whose New task dialog
   *  asks for what a person files there. */
  hasRepository?: boolean;
  /** Ruling 503: the project's epics, for the epic filter and the New-task
   *  Epic pick. */
  epics?: readonly EpicOption[];
}

export function BoardPage({
  columns,
  orphanTasks,
  canCreate,
  canTransition,
  canRescan,
  defaultBranch = "main",
  repoAccess,
  hasRepository = true,
  epics = [],
}: BoardPageProps) {
  const { slug: projectSlug } = useParams();
  const { view, setParam, clearFilters } = useBoardQuery();
  const { filter, group, query, labelFilter, epicFilter } = view;
  const openEpics = useMemo(() => epics.filter((e) => isEpicOpen(e.status)), [epics]);
  // R19-14: creation always lands at the entry stage, so this is a plain
  // open/closed flag — no per-lane stage rides along any more.
  const [creating, setCreating] = useState(false);
  const csrf = useCsrfToken();
  const push = useToast();
  // The page's two posts, in the order their fetchers always registered: the
  // re-scan's here, the moves' below.
  const rescan = useRescan(csrf);

  // One array while the stages are unchanged (ruling 457): every list row takes it.
  const stages = useStableRows(
    columns.map((c) => c.stage),
    stageIdOf,
  );
  const doneStageId = stages[stages.length - 1]?.id;
  const allTasks = useMemo(
    () => [...columns.flatMap((c) => c.tasks), ...orphanTasks],
    [columns, orphanTasks],
  );
  const visible = visibleIn(view);
  // The all-tasks filter feeds the roving tab stop, the "N shown" count and the
  // list view; run it once per render rather than three times (each pass
  // rebuilds a per-task search haystack).
  const visibleAllTasks = visible(allTasks);

  const moves = useBoardMoves(columns, allTasks, csrf);
  const keyboard = useBoardKeyboard(
    columns,
    visible,
    // D19: the cards the layout draws, in order (the roving stop's resting place).
    group === "stage"
      ? columns.flatMap((c) => visible(c.tasks).map((t) => t.key))
      : visibleAllTasks.map((t) => t.key),
    moves,
  );
  const confirms = useMoveConfirms({ columns, stages, allTasks, defaultBranch, moves });
  const dnd = useBoardDrag({
    columns,
    allTasks,
    visible,
    velocity: dragVelocity,
    moves,
    confirms,
  });
  useRescanAnswer(rescan.fetcher);

  const labelSuggestions = useMemo(() => labelVocabulary(allTasks), [allTasks]);
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
  // P13-D-34: what the board actually draws, and why anything is missing. The
  // board total is LIVE, not all: archived tasks render on no column under any
  // normal filter, so counting them makes an empty board look occupied — which
  // is exactly what a strict project holding one archived task did.
  const emptyCopyFor = emptyCopyIn(view, epics, liveTasks.length);

  return (
    <div className="board-wrap" data-screen-label="Board">
      {/* D9: the board's polite announcement region — pickup/drop requests and
          the server's own move outcome (including a refusal) spoken to assistive
          tech, which the pointer-only drag and the toast never gave a keyboard
          user. Visually hidden but kept in the DOM (see SR_ONLY). */}
      <div style={SR_ONLY} role="status" aria-live="polite">
        {moves.announce}
      </div>
      <BoardHeader
        shownCount={visibleAllTasks.length}
        // R14-3: the denominator follows the view. On the Archived filter the
        // population IS the archived set, so "2 of 2" reads true instead of
        // measuring archived cards against a live-task total they left.
        taskCount={filter === "archived" ? archivedCount : liveTasks.length}
        waitingHuman={waitingHuman}
        group={group}
        canCreate={canCreate}
        canRescan={canRescan}
        scanning={rescan.scanning}
        setParam={setParam}
        onRescan={rescan.rescan}
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

      {/* U33-2: directly under the header, above the filters — the fact is
          about the whole project, not about whatever the filters are showing,
          and it must survive a filter/search that empties every column. */}
      {repoAccess && projectSlug && (
        <RepoAccessBanner slug={projectSlug} access={repoAccess} />
      )}

      {/* Only once there is anything for the filters to act on (`showsFilterBar`). */}
      {showsFilterBar(view, allTasks.length, archivedCount) && (
        <FilterBar
          filter={filter}
          query={query}
          labelFilter={labelFilter}
          projectLabels={labelSuggestions}
          epicFilter={epicFilter}
          epics={epics}
          waitingOnMe={waitingOnMe}
          quiet={quietCount}
          continuity={continuityCount}
          archived={archivedCount}
          setParam={setParam}
          onClear={clearFilters}
        />
      )}

      {filter === "archived" && (
        <div className="board-orphans notice" role="status">
          <Icon name="archive" />
          <span className="board-orphans-label">
            Archived tasks: finished or abandoned work, kept for the record.
            Their timelines and audit are intact, they are out of the review
            queue, and a maintainer can restore one from its task page.
          </span>
        </div>
      )}

      {orphanTasks.length > 0 && <OrphanBanner orphanTasks={orphanTasks} />}

      {group === "stage" ? (
        <DragDropProvider
          sensors={DRAG_SENSORS}
          plugins={BOARD_PLUGINS}
          onDragStart={dnd.onDragStart}
          onDragOver={dnd.onDragOver}
          onDragMove={dnd.onDragMove}
          onDragEnd={dnd.onDragEnd}
        >
          <StageBoard
            columns={columns}
            visible={visible}
            emptyCopyFor={emptyCopyFor}
            doneStageId={doneStageId}
            canCreate={canCreate}
            createCta={isVirginBoard(view, liveTasks.length)}
            canTransition={canTransition}
            onNew={() => setCreating(true)}
            drag={dnd.drag}
            overStage={dnd.overStage}
            beforeKey={dnd.beforeKey}
            arrivedKey={moves.arrivedKey}
            draggedTask={dnd.draggedTask}
            inFlight={moves.inFlight}
            inFlightTask={moves.inFlightTask}
            onMoveTask={confirms.moveTask}
            onNudgeTask={keyboard.onNudgeTask}
            rovingKey={keyboard.rovingKey}
            onCardKeyDown={keyboard.onCardKeyDown}
          />
        </DragDropProvider>
      ) : (
        <ListView
          tasks={visibleAllTasks}
          stages={stages}
          canTransition={canTransition}
          onMoveTask={confirms.moveTask}
          emptyCopy={emptyCopyFor(allTasks.length, true)}
          rovingKey={keyboard.rovingKey}
          onCardKeyDown={keyboard.onCardKeyDown}
        />
      )}

      {creating && stages[0] && (
        <NewTaskModal
          entryStageName={stages[0].name}
          hasRepository={hasRepository}
          labelSuggestions={labelSuggestions}
          epics={openEpics}
          initialEpic={newTaskEpic(epicFilter, openEpics)}
          onClose={() => setCreating(false)}
        />
      )}

      {/* Ruling 381 and B1 / D3: the move-back reason and the acceptance
          ceremony, each while its move waits on it (`useMoveConfirms`). */}
      {confirms.moveBackDialog}
      {confirms.acceptDialog}
    </div>
  );
}
