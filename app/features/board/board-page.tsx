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
  useParams,
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
  type DragDropManager,
  type DropAnimationFunction,
} from "@dnd-kit/dom";
import { laneAt, resolveBoardDrop, slotInLane, type LaneBlock } from "./board-dnd";
import { cardProblems, cardStatus, PROBLEM_CAP } from "./card-status";
import type { TaskSummary } from "~/shared/mapping/task.server";
import {
  archivedTaskBlockedReason,
  closedPrBlockedReason,
  coercePriority,
  conflictingPrBlockedReason,
  unpushedRevisionBlockedReason,
  PRIORITY_VALUES,
  type TaskPriority,
} from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { DatePicker } from "~/ui/date-picker";
import { Icon, type IconName } from "~/ui/icon";
import { LabelInput } from "~/ui/label-input";
import { LocalDayDotTime } from "~/ui/local-time";
import { AgentBadge, AgentGlyph } from "~/ui/identity";
import { connectionPill } from "~/features/github/github-pills";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";
import { AcceptConfirm } from "~/features/task-detail/accept-confirm";
import { MoveBackConfirm } from "~/features/task-detail/move-back-confirm";
import {
  acceptanceDisclosureFields,
  type AcceptanceDisclosure,
} from "~/shared/acceptance-disclosure";
import { stageName } from "~/shared/workflow/stage-roles";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import {
  boardEmptyCopy,
  countArchived,
  isArchived,
  isBoardFilterId,
  matchesBoardFilter,
  matchesLabelFilter,
  matchesSearch,
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
  const timing: KeyframeAnimationOptions = {
    duration: 180,
    easing: "cubic-bezier(.23, 1, .32, 1)",
    fill: "forwards",
  };
  const flight = feedbackElement.animate(
    { translate: [`${tx}px ${ty}px 0`, `${tx + dx}px ${ty + dy}px 0`] },
    timing,
  );
  const closing = closes
    ? placeholder.animate({ marginBlockEnd: ["0px", `${-share}px`], opacity: [1, 0] }, timing)
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

/**
 * Ruling 365: the trace mark in the card's head — the PR number when a PR
 * exists (the stronger trace; it implies the branch, ruling 171(d)), else the
 * branch glyph alone with the branch name as its tooltip and accessible name,
 * else nothing. The chip used to print the branch name, which at the board's
 * 218px lanes cut to "shop-6…" and told nobody anything the key beside it had
 * not; the task page's GitHub trace prints both in full.
 */
function TraceMark({ task }: { task: TaskSummary }) {
  if (task.pr) {
    return (
      <span className="trace pr" title={"Pull request #" + task.pr.number}>
        <Icon name="pr" />#{task.pr.number}
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
function WhoStack({ task }: { task: TaskSummary }) {
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
function StatusChip({ task }: { task: TaskSummary }) {
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
function ProblemChips({ task }: { task: TaskSummary }) {
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
        </span>
      )}
    </>
  );
}

/** The card's property row: the status chip, then the problems. Drawn by the
 *  card and the list row alike (F19-13: one state block, both layouts), and
 *  absent when there is nothing to say. */
function CardChips({ task }: { task: TaskSummary }) {
  if (cardStatus(task) === null && cardProblems(task).length === 0) return null;
  return (
    <div className="card-props">
      <StatusChip task={task} />
      <ProblemChips task={task} />
    </div>
  );
}

/** The list row's agent: the badge and the name — the row has the room the
 *  card does not, and ruling 168(c)'s name stays printed here. */
function ListAgent({ task }: { task: TaskSummary }) {
  const sp = task.specialist;
  if (!sp) return null;
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
function OwnerSeat({ task, label }: { task: TaskSummary; label?: boolean }) {
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
      {label && <span className="rs-lbl">owner</span>}
      {human ? <Avatar person={human} size="xs" /> : <span className="avatar xs ghost">?</span>}
    </span>
  );
}

function TaskCard({
  task,
  index,
  canTransition,
  arrived,
  inFlight,
  allStages,
  onMoveTask,
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
    plugins: (defaults) => [
      ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
      Feedback.configure({ feedback: "clone", dropAnimation: boardDropAnimation }),
    ],
  });
  // Pass 30: the wait-human/urgent class pushes are gone — ruling 16 removed
  // the card-level accent layer and no rule has styled either class since
  // (the P16-UI-04 comment in app.css records the removal). The facts render
  // as the wait tag and the priority flag.
  const cls = ["card"];
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
      /* The slot rule reads the lane's flow from the DOM (`laneBlocks`): this
         names the card each block stands for. dnd-kit's placeholder — the hole
         a lifted card leaves — is a clone of this element, so it carries the
         key too and stands in the flow for the card. */
      data-card-key={task.key}
    >
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
          />
        </div>
      )}
    </div>
  );
}

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
/** A lane's flow as drawn, top to bottom, for `slotInLane`: every `.card-wrap`
 *  in the column body except the lifted card itself, which follows the pointer
 *  (its hole — the placeholder dnd-kit leaves, `data-card-key` and all — stands
 *  in the flow for it). The drop preview and a landing preview carry no key. */
function laneBlocks(body: Element): LaneBlock[] {
  const blocks: LaneBlock[] = [];
  for (const el of body.children) {
    if (!(el instanceof HTMLElement) || !el.classList.contains("card-wrap")) continue;
    if (el.hasAttribute("data-dnd-dragging")) continue;
    const r = el.getBoundingClientRect();
    blocks.push({ key: el.dataset.cardKey ?? null, top: r.top, bottom: r.bottom });
  }
  return blocks;
}

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

function Column({
  stage,
  tasks,
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
}) {
  // The lane is a droppable for two reasons that are not its collisions: the
  // slot rule (`refineSlot`) finds the lanes' live rectangles through dnd-kit's
  // registry by this id, and `dragover` fires when the pointer crosses into an
  // empty lane. Which droppable dnd-kit calls the target no longer decides
  // anything — the lane comes from the pointer (`laneAt`), the slot from the
  // lane's flow (`slotInLane`). Priority 1 (Low) keeps dnd-kit's own target
  // sensible: an over-card collision (Normal, 2) wins over its column.
  const { ref } = useDroppable({
    id: `stage:${stage.id}`,
    collisionPriority: 1,
  });
  const showPreview = dropTarget && previewTask !== null;
  const preview = showPreview ? <DropPreview task={previewTask!} /> : null;
  const landingEl = landing ? <DropPreview task={landing.task} landing /> : null;
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
        className="col-body"
        role={tasks.length > 0 ? "list" : undefined}
        aria-label={tasks.length > 0 ? `${stage.name} tasks` : undefined}
        tabIndex={tasks.length > 0 ? 0 : undefined}
      >
        {tasks.length === 0 ? (
          showPreview ? (
            preview
          ) : landing ? (
            landingEl
          ) : (
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
          )
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
  // Ruling 148: one fact, one wording — the stage menu and the task page say
  // "unknown stage" too, and the raw internal id is not rendered copy.
  const stageName =
    stages.find((s) => s.id === task.stage)?.name ?? "unknown stage";
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
        // Same read-only rendering the task page uses (stage-colored dot +
        // name), not a bare neutral pill — one fact, one treatment.
        <span className="stage-static">
          <span
            className="col-stage-dot sm"
            data-stage-color={stages.find((s) => s.id === task.stage)?.color}
          />
          {stageName}
        </span>
      )}
      <ListAgent task={task} />
      <OwnerSeat task={task} label />
      {/* F19-13: the card's state block verbatim — the row used to draw
          validation and the wait tag alone, so the PR-state, checks and
          review pills existed on one board layout and not the other. Ruling
          365: the same status chip and problem chips the card draws. */}
      <CardChips task={task} />
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
    // Ruling 135: the delivered revision is not on the PR, above the conflict.
    unpushedRevisionBlockedReason(task.pr, task.workRevisionSha ?? null, task.key) ??
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
        // Ruling 304: the board summary carries the checks too, so the same
        // dialog says the same thing from either door.
        prChecks: task.prChecks ?? null,
        // Ruling 360: and the refused read, when that is what the summary holds.
        prChecksUnread: task.prChecksUnread ?? null,
      }}
      workRevisionSha={task.workRevisionSha ?? null}
      noChanges={false}
      noPullRequest={false}
      // F32-11: the board summary carries the open packet too.
      openPacketTitle={task.packet?.title ?? null}
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
      // Ruling 162's interlock is for the refusal the server re-decides. This
      // one is composed from a projection SUMMARY on purpose (see
      // `boardAcceptRefusal`), so it is a disclosure, not a verdict: the board
      // discloses it and lets the confirmed move be answered by the server,
      // which is also the only door here — the board has no force-accept.
      blockedReasonAuthoritative={false}
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
  const titleRef = useRef<HTMLInputElement>(null);

  const valid = title.trim().length >= 3;
  // The dialog opened on an empty title, so `!valid` was true from first paint
  // and the footer greeted every new task with "A title is required." — an error
  // for something the person had not had a chance to do yet. The requirement is
  // only *unmet* once they have left the field or tried to submit.
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
      onClose();
    }
  }, [fetcher.data, onClose, push]);

  const submit = () => {
    setTitleTouched(true);
    if (busy) return;
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
          {titleError
            ? "A title is required."
            : serverError
              ? serverError
              : "The task key is assigned automatically."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          {/* Enabled until the request starts: an invalid submit is refused
              with the hint above, the field marked and focused (submit()).
              Only `busy` disables, and the aria-busy sheet rule paints it. */}
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy}
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

/** Visible label filter chips before the "+N more" overflow chip. */
const LABEL_CHIP_CAP = 6;

/** Full-strength state pills on one card before the "+N" fold (pass 30). */

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
}) {
  // All stages, for the per-card keyboard "Move to stage" menu (F10-25).
  const allStages = columns.map((c) => c.stage);
  // The slot a drop would submit RIGHT NOW — the same resolution `onDragEnd`
  // runs, so the preview shows exactly what the drop would ask for, and shows
  // nothing where a drop would change nothing (the card's own slot in its own
  // lane: before itself, before the card that already follows it). Before this
  // the preview drew "before itself" over the hole the card had just left, so a
  // card looked movable above and below its own ghost (owner, 2026-09-08).
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
  repoAccess,
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
  /**
   * U33-2: GitHub's own answer for this project's repository, as the GitHub
   * view already computes it (`checkRepoAccess`). Optional and absent by
   * default: no loader carries this fact yet, and the board must NOT reach for
   * GitHub itself — the check is a live `GET /repos/:repo`, and project-scope
   * SSE revalidates this view on every task event. `undefined` means "nobody
   * has established it", which the banner reads as silence, never as health.
   */
  repoAccess?: RepoAccessResult;
}) {
  const { slug: projectSlug } = useParams();
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
  // lane under the pointer. While a card is dragged across lanes, its own slot
  // shows a hole (dnd-kit's placeholder) and the target lane the drop preview
  // + a +1 count; a drop fires the governed transition and the card pulses on
  // arrival (`arrivedKey`). One fetcher per board.
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
  /** The move awaiting the server's answer: the card hides in its lane and the
   *  landing preview stands in the requested slot until the answer renders the
   *  real card there — or refuses, and the card comes back with the toast. */
  const [inFlight, setInFlight] = useState<{
    key: string;
    from: string;
    to: string;
    beforeKey: string | null;
  } | null>(null);
  /** D19: the card the roving tab stop sits on. Null until an arrow moves it —
   *  the resting stop is then the first card the layout draws (`rovingKey`). */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** B1: a move into the final stage waits here for an explicit confirmation. */
  /** Ruling 381: a backward drag waiting on its reason. */
  const [pendingMoveBack, setPendingMoveBack] = useState<{
    taskKey: string;
    from: string;
    to: string;
    beforeKey: string;
  } | null>(null);
  const [pendingAccept, setPendingAccept] = useState<{
    taskKey: string;
    to: string;
    beforeKey: string;
  } | null>(null);
  const finalStageId = columns[columns.length - 1]?.stage.id;
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
  // The slot is GEOMETRY, not dnd-kit's collision target: `laneAt` names the
  // lane under the pointer and `slotInLane` reads the pointer against that
  // lane's flow as drawn — the cards, the dragged card's hole AND the preview
  // already standing there (board-dnd.ts says why the preview must count).
  // The target dnd-kit reports was the loop the owner saw (2026-09-08): the
  // preview drawn above a card pushed the card from under the pointer, the
  // next collision pass found the column, the old rule read that as "end",
  // the preview moved below the card and the card came back up under the
  // pointer — every hand tremor walked it, ~10 times a second, top half only.
  // Both hover events run the same rule (`dragover` fires when the target
  // changes, `dragmove` when the pointer moves); state updates only when the
  // answer changes.
  const onDragStart = (event: DragStartEvent) => {
    const key = String(event.operation.source?.id ?? "");
    const t = allTasks.find((x) => x.key === key);
    if (!t) return;
    setDrag({ key, fromStage: t.stage });
    setOverStage(t.stage);
    // "Before itself": the slot the card already holds, so nothing previews
    // until the pointer moves (null would preview the lane's END on lift).
    setBeforeKey(key);
  };
  const refineSlot = (event: DragOverEvent | DragMoveEvent, manager: DragDropManager) => {
    const { x, y } = event.operation.position.current;
    const lanes: { stageId: string; element: Element }[] = [];
    for (const droppable of manager.registry.droppables) {
      const id = String(droppable.id);
      if (id.startsWith("stage:") && droppable.element) {
        lanes.push({ stageId: id.slice("stage:".length), element: droppable.element });
      }
    }
    const stage = laneAt(
      lanes.map(({ stageId, element }) => {
        const r = element.getBoundingClientRect();
        return { stageId, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
      x,
      y,
    );
    if (!stage) {
      setOverStage(null);
      setBeforeKey(null);
      return;
    }
    const body = lanes
      .find((l) => l.stageId === stage)
      ?.element.querySelector(":scope > .col-body");
    const before = slotInLane(body ? laneBlocks(body) : [], y);
    setOverStage(stage);
    setBeforeKey((prev) => (prev === before ? prev : before));
  };
  const onDragOver = refineSlot;
  const onDragMove = refineSlot;
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
    // Ruling 381: dragging a card BACK is the same act as picking an earlier
    // stage from the task page's menu, and the server requires a reason for
    // either. Without this the drag would simply be refused, with nowhere to
    // type the answer.
    const fromIdx = columns.findIndex((c) => c.stage.id === active.fromStage);
    const toIdx = columns.findIndex((c) => c.stage.id === resolution.to);
    if (toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx) {
      setPendingMoveBack({
        taskKey: active.key,
        from: active.fromStage,
        to: resolution.to,
        beforeKey: resolution.beforeKey ?? "",
      });
      return;
    }
    submitReorder(active.key, resolution.to, resolution.beforeKey ?? "");
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
    // Ruling 381: why the card went back. Required by the server for a
    // backward move; collected by `MoveBackConfirm` before this is called.
    reason?: string,
  ) => {
    // The request is drawn at once (landing preview in the target lane, the
    // card hidden in its own); the arrival pulse waits for the server's yes.
    const from = allTasks.find((t) => t.key === taskKey)?.stage;
    if (from) {
      setInFlight({ key: taskKey, from, to, beforeKey: beforeKey === "" ? null : beforeKey });
    }
    announceMove(taskKey, to); // D9
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "reorder");
    fd.set("taskKey", taskKey);
    fd.set("to", to);
    fd.set("beforeKey", beforeKey);
    if (reason) fd.set("reason", reason);
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
    // Ruling 381: and the same reason dialog. A keyboard user who skipped this
    // would meet a bare 400 with no field to answer it in — the drag's own
    // dead end, one door over.
    const fromIdx = columns.findIndex((c) => c.stage.id === fromStage);
    const toIdx = columns.findIndex((c) => c.stage.id === toStageId);
    if (toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx && fromStage) {
      setPendingMoveBack({ taskKey, from: fromStage, to: toStageId, beforeKey: "" });
      return;
    }
    submitReorder(taskKey, toStageId, "");
  };

  // Toast on completion (and drop the pulse if the move was rejected).
  useFetcherResult(transitionFetcher, (d) => {
    // The answer is in and the loader has revalidated: the real card stands
    // where the landing preview stood (and pulses), or is back in its lane.
    setInFlight(null);
    if (d.ok) setArrivedKey(inFlight?.key ?? null);
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
  });

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
  const inFlightTask = inFlight
    ? (allTasks.find((t) => t.key === inFlight.key) ?? null)
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

      {/* U33-2: directly under the header, above the filters — the fact is
          about the whole project, not about whatever the filters are showing,
          and it must survive a filter/search that empties every column. */}
      {repoAccess && projectSlug && (
        <RepoAccessBanner slug={projectSlug} access={repoAccess} />
      )}

      {/* A brand-new board has nothing to filter or search — the machinery
          renders once there is anything for it to act on (the Archived chip is
          the only road back, so any archived count keeps the bar). */}
      {(allTasks.length > 0 ||
        archivedCount > 0 ||
        filter !== "all" ||
        query !== "" ||
        labelFilter != null) && (
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
      )}

      {filter === "archived" && (
        <div className="board-orphans notice" role="status">
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
            createCta={
              liveTasks.length === 0 &&
              filter === "all" &&
              query === "" &&
              labelFilter == null
            }
            canTransition={canTransition}
            onNew={() => setCreating(true)}
            drag={drag}
            overStage={overStage}
            beforeKey={beforeKey}
            arrivedKey={arrivedKey}
            draggedTask={draggedTask}
            inFlight={inFlight}
            inFlightTask={inFlightTask}
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
      {pendingMoveBack && (
        <MoveBackConfirm
          taskKey={pendingMoveBack.taskKey}
          taskTitle={
            allTasks.find((t) => t.key === pendingMoveBack.taskKey)?.title ?? ""
          }
          fromStageName={
            columns.find((c) => c.stage.id === pendingMoveBack.from)?.stage.name ??
            pendingMoveBack.from
          }
          toStageName={
            columns.find((c) => c.stage.id === pendingMoveBack.to)?.stage.name ??
            pendingMoveBack.to
          }
          busy={transitionFetcher.state !== "idle"}
          onCancel={() => setPendingMoveBack(null)}
          onConfirm={(reason) => {
            const move = pendingMoveBack;
            setPendingMoveBack(null);
            submitReorder(move.taskKey, move.to, move.beforeKey, undefined, reason);
          }}
        />
      )}
      {pendingAccept && pendingAcceptTask && (
        <AcceptOnBoardConfirm
          task={pendingAcceptTask}
          stages={stages}
          fromStageName={stageName(stages, pendingAcceptTask.stage)}
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
