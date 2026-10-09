import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { DragEndEvent, DragMoveEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/dom";
import { MoveBackConfirm } from "~/features/task-detail/move-back-confirm";
import { setDisclosure, type AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { mergeCollisions } from "~/shared/pr-overlaps";
import { countLabel, pluralNoun } from "~/shared/text/plural";
import type { createVelocityTracker } from "~/ui/spring";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { AcceptOnBoardConfirm } from "./board-accept-confirm";
import { laneAt, resolveBoardDrop, slotInLane, type LaneBlock } from "./board-dnd";
import type { BoardColumnData, BoardStage, BoardTask } from "./board-page";
import { findTask, readBoardView, stageNameIn } from "./board-page-derive";

/**
 * The board page's state and posts (ruling 13(b), the task-page recipe rolled
 * out to `board-page.tsx`), each hook owning its fetcher, toast and local
 * state: the view the URL carries, the re-scan, the moves and what they draw
 * while the server answers, the keyboard's way around the cards, the confirms a
 * move can need, and the drag. The page calls them in the order its fetchers
 * always registered (the re-scan's, then the moves'), so each fetcher keeps its
 * key, and places each confirm where it always stood. No component lives here
 * (the confirms are elements the page places), so the module is not a Fast
 * Refresh boundary.
 */

/** The board's view (`?filter=`, `?view=`, `?q=`, `?label=`, `?epic=`) and the
 *  two ways the page changes it, each a replace that keeps the scroll. */
export function useBoardQuery() {
  const [searchParams, setSearchParams] = useSearchParams();
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
        next.delete("epic"); // Ruling 325: and the epic filter.
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  return { view: readBoardView(searchParams), setParam, clearFilters };
}

/** The re-scan's answer: ok, or the refusal, and the files it could not read. */
interface RescanAnswer {
  ok: boolean;
  error?: string;
  errors?: number;
}

/** The re-scan's post: its fetcher, whether it runs, and the press, which does
 *  nothing while the last one runs. Its answer is `useRescanAnswer`, which the
 *  page calls after every other hook that has an effect, so its effect runs
 *  last and the answer's toast still follows the moves' and the abandoned
 *  acceptance's (as it did while one component held both). */
export function useRescan(csrf: string) {
  const rescanFetcher = useFetcher<RescanAnswer>();
  const push = useToast();
  const rescan = () => {
    if (rescanFetcher.state !== "idle") return;
    push("Re-scanning the task store…");
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rescan");
    rescanFetcher.submit(fd, { method: "post" });
  };
  return { fetcher: rescanFetcher, scanning: rescanFetcher.state !== "idle", rescan };
}

/** The re-scan's answer, toasted once per settled result. */
export function useRescanAnswer(rescanFetcher: ReturnType<typeof useRescan>["fetcher"]) {
  const push = useToast();
  const rescanDone = useRef(false);
  useEffect(() => {
    if (rescanFetcher.state === "submitting") rescanDone.current = false;
    if (rescanFetcher.state === "idle" && rescanFetcher.data && !rescanDone.current) {
      rescanDone.current = true;
      const { ok, errors } = rescanFetcher.data;
      // Interface review 2026-09-24 (writ-2): a file the re-scan could not
      // project comes back as `errors` on an ok answer, and this said the
      // board matched the store. Same sentence as Home's re-scan.
      if (ok && errors) {
        push(
          `Re-scan finished, but ${countLabel(errors, "file")} could not be read. The server log names each one. Fix ${pluralNoun(errors, "it", "them")} and re-scan.`,
          "error",
        );
        return;
      }
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
}

/** The move awaiting the server's answer: the card hides in its lane and the
 *  landing preview stands in the requested slot until the answer renders the
 *  real card there — or refuses, and the card comes back with the toast. */
interface MoveInFlight {
  key: string;
  from: string;
  to: string;
  beforeKey: string | null;
}

/**
 * The board's governed moves, on one fetcher per board, and what a move draws
 * while the server answers: the request at once (the landing preview in the
 * target lane, the card hidden in its own), the arrival pulse on the server's
 * yes, and the outcome as a toast and, for a screen reader, in the board's
 * polite region (D9). `submitReorder` is the one POST every door ends in: the
 * drop, the Move menu, Move up / Move down and both confirms.
 */
export function useBoardMoves(columns: BoardColumnData[], allTasks: BoardTask[], csrf: string) {
  const transitionFetcher = useFetcher<{
    ok: boolean;
    toast?: string;
    error?: string;
  }>();
  const push = useToast();
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<MoveInFlight | null>(null);
  /**
   * D9 (WCAG 2.2 / UX spec §Accessibility Strategy) — the board's polite
   * announcement region. Board drag is pointer-only and keyboard users move via
   * the StageMenu (ruling 307 built the traversal half), but nothing ever spoke
   * a requested move, a completed one, or a server refusal — including the 409
   * the server answers an off-boundary move with, since the board is
   * authoritative and never commits a move client-side. `announceMove` speaks
   * the request; the transition-fetcher effect below speaks the outcome, reusing
   * the server's own honest sentence (`d.toast` / `d.error`).
   */
  const [announce, setAnnounce] = useState("");
  const announceMove = (taskKey: string, toStageId: string) => {
    setAnnounce(`Move requested: ${taskKey} to ${stageNameIn(columns, toStageId)}.`);
  };

  const submitReorder = (
    taskKey: string,
    to: string,
    beforeKey: string,
    // Ruling 97 (F21-2): set ONLY for a move onto the FINAL column, which the
    // server reads as an acceptance (`reorderTask` → `transitionStage` →
    // `acceptCompletion` — the real merge). It is the echo of what the ceremony
    // just displayed; without it the server refuses the acceptance.
    disclosure?: AcceptanceDisclosure,
    // Ruling 47: why the card went back. Required by the server for a
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
    setDisclosure(fd, disclosure);
    transitionFetcher.submit(fd, { method: "post" });
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

  return {
    busy: transitionFetcher.state !== "idle",
    inFlight,
    inFlightTask: findTask(allTasks, inFlight?.key),
    arrivedKey,
    announce,
    submitReorder,
  };
}

type BoardMoves = ReturnType<typeof useBoardMoves>;

/**
 * The keyboard's way around the board: D19's roving tab stop and the arrows
 * that move it, and acce-17's Move up / Move down, which hands the focus back
 * to the nudged card's Move trigger once the server has answered.
 * `visibleKeys` is the cards the layout draws, in order: the stop rests on the
 * first of them until an arrow moves it.
 */
export function useBoardKeyboard(
  columns: BoardColumnData[],
  visible: (tasks: BoardTask[]) => BoardTask[],
  visibleKeys: readonly string[],
  moves: Pick<BoardMoves, "inFlight" | "submitReorder">,
) {
  const { inFlight, submitReorder } = moves;
  /** D19: the card the roving tab stop sits on. Null until an arrow moves it —
   *  the resting stop is then the first card the layout draws (`rovingKey`). */
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Interface review 2026-09-24 (acce-17): the card menu's Move up / Move down,
  // the keyboard and single-pointer way to a slot within the lane, which only
  // the drag offered. The SAME governed reorder the drop submits, read against
  // the same visible() order: up lands before the card above, down before the
  // card two below, or at the lane's end.
  const refocusKey = useRef<string | null>(null);
  const nudgeTaskNow = (taskKey: string, stageId: string, dir: -1 | 1) => {
    const keys = visible(columns.find((c) => c.stage.id === stageId)?.tasks ?? []).map(
      (t) => t.key,
    );
    const i = keys.indexOf(taskKey);
    if (i < 0 || (dir > 0 && i === keys.length - 1)) return;
    const beforeKey = dir < 0 ? keys[i - 1] : (keys[i + 2] ?? "");
    if (beforeKey === undefined) return;
    refocusKey.current = taskKey;
    submitReorder(taskKey, stageId, beforeKey);
  };
  // Ruling 11: the memoised cards take this as a prop, so it keeps one
  // identity and runs the latest render's nudge, as `moveTask` does
  // (`useMoveConfirms`).
  const latestNudgeTask = useRef(nudgeTaskNow);
  useLayoutEffect(() => {
    latestNudgeTask.current = nudgeTaskNow;
  });
  const onNudgeTask = useCallback(
    (taskKey: string, stageId: string, dir: -1 | 1) =>
      latestNudgeTask.current(taskKey, stageId, dir),
    [],
  );
  // The card hides while its move is in flight (`.in-flight`), which drops the
  // focus the menu handed back to its trigger. Once the answer is in, a nudge
  // puts it back there, so the next nudge is one keystroke away. Only when
  // focus really was dropped: a person who moved on meanwhile keeps their place.
  useEffect(() => {
    const key = refocusKey.current;
    if (inFlight || !key) return;
    refocusKey.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const card = [...document.querySelectorAll<HTMLElement>(".card-wrap[data-card-key]")].find(
      (el) => el.dataset.cardKey === key,
    );
    const trigger = card?.querySelector<HTMLButtonElement>("button.stage-menu-btn");
    if (!trigger) return;
    setFocusKey(key);
    trigger.focus();
  }, [inFlight]);

  // Re-anchors when the card the stop was on leaves the layout (filtered away,
  // archived, reprojected off the board) — a tab stop pinned to a card that is
  // no longer drawn is a board with no way in.
  const rovingKey =
    focusKey && visibleKeys.includes(focusKey)
      ? focusKey
      : (visibleKeys[0] ?? null);

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

  return { rovingKey, onCardKeyDown, onNudgeTask };
}

/** Ruling 47: a backward move waiting on its reason. */
interface PendingMoveBack {
  taskKey: string;
  from: string;
  to: string;
  beforeKey: string;
}

/** B1: a move into the final stage waiting on its confirmation. */
interface PendingAccept {
  taskKey: string;
  to: string;
  beforeKey: string;
}

/**
 * The two confirms a move can need before it posts: a move into the final
 * stage is an acceptance, confirmed through the one shared ceremony (B1, D3),
 * and a move back asks why (ruling 47). With them the Move menu's move
 * (F10-25), which routes to either the way the drop does, and both confirms as
 * elements the page places where they always stood.
 */
export function useMoveConfirms({
  columns,
  stages,
  allTasks,
  defaultBranch,
  moves,
}: {
  columns: BoardColumnData[];
  /** The page's stable stage list (ruling 11), which the ceremony names. */
  stages: BoardStage[];
  allTasks: BoardTask[];
  defaultBranch: string;
  moves: Pick<BoardMoves, "busy" | "submitReorder">;
}) {
  const { busy, submitReorder } = moves;
  const push = useToast();
  const [pendingMoveBack, setPendingMoveBack] = useState<PendingMoveBack | null>(null);
  const [pendingAccept, setPendingAccept] = useState<PendingAccept | null>(null);
  const finalStageId = columns[columns.length - 1]?.stage.id;

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
    // Ruling 47: and the same reason dialog. A keyboard user who skipped this
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
  // Ruling 11: every card and list row takes the move callback, so it keeps
  // one identity and runs the latest render's `onMoveTask` (which reads the
  // current columns); a fresh closure per render re-rendered every card.
  const latestMoveTask = useRef(onMoveTask);
  useLayoutEffect(() => {
    latestMoveTask.current = onMoveTask;
  });
  const moveTask = useCallback(
    (taskKey: string, toStageId: string) => latestMoveTask.current(taskKey, toStageId),
    [],
  );

  // F19-27: the summary the acceptance confirm discloses from. Resolved here
  // rather than captured into `pendingAccept` so it re-reads on every
  // revalidation — a stale snapshot is exactly the failure ruling 96 is about.
  const pendingAcceptTask = findTask(allTasks, pendingAccept?.taskKey);
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

  const moveBackDialog = pendingMoveBack && (
    <MoveBackConfirm
      taskKey={pendingMoveBack.taskKey}
      taskTitle={
        allTasks.find((t) => t.key === pendingMoveBack.taskKey)?.title ?? ""
      }
      fromStageName={stageNameIn(columns, pendingMoveBack.from)}
      toStageName={stageNameIn(columns, pendingMoveBack.to)}
      busy={busy}
      onCancel={() => setPendingMoveBack(null)}
      onConfirm={(reason) =>
        submitReorder(
          pendingMoveBack.taskKey,
          pendingMoveBack.to,
          pendingMoveBack.beforeKey,
          undefined,
          reason,
        )
      }
    />
  );
  // B1 / D3: the acceptance a board move really performs, confirmed through the
  // ONE shared ceremony. F19-27: the card's own summary is what the dialog
  // discloses from — looked up fresh so a revalidation between the gesture and
  // the confirmation shows the CURRENT PR head, not the one the drag started
  // on. A lookup that MISSES is handled by the effect above (clear + toast),
  // never by this silent `&&`.
  const acceptDialog = pendingAccept && pendingAcceptTask && (
    <AcceptOnBoardConfirm
      task={pendingAcceptTask}
      stages={stages}
      fromStageName={
        // `stageName`'s fallback, spelled here: importing stage-roles.ts
        // would put its whole chunk on the board for this one line
        // (ruling 11).
        stages.find((s) => s.id === pendingAcceptTask.stage)?.name ??
        pendingAcceptTask.stage
      }
      defaultBranch={defaultBranch}
      // Ruling 244 (F40-55 (c)): the same disclosure the task page's
      // dialog makes, from the board's own cards (`pr.paths` rides them).
      mergeCollisions={mergeCollisions(pendingAcceptTask, allTasks)}
      busy={busy}
      onCancel={() => setPendingAccept(null)}
      onConfirm={(disclosure) => {
        const p = pendingAccept;
        // Ruling 97: the drop commits with the ceremony's own echo of what
        // it disclosed — the same acknowledgment the task page's stage move
        // sends, on the same server contract.
        submitReorder(p.taskKey, p.to, p.beforeKey, disclosure);
      }}
    />
  );
  return {
    finalStageId,
    askAccept: setPendingAccept,
    askMoveBack: setPendingMoveBack,
    moveTask,
    moveBackDialog,
    acceptDialog,
  };
}

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

/**
 * Drag-and-drop stage moves. `drag` is the card in flight; `overStage` is the
 * lane under the pointer. While a card is dragged across lanes, its own slot
 * shows a hole (dnd-kit's placeholder) and the target lane the drop preview
 * + a +1 count; a drop fires the governed transition (`useBoardMoves`) and the
 * card pulses on arrival. The drop routes the way the Move menu does: into the
 * final stage through the acceptance confirm, backward through the reason.
 */
export function useBoardDrag({
  columns,
  allTasks,
  visible,
  velocity,
  moves,
  confirms,
}: {
  columns: BoardColumnData[];
  allTasks: BoardTask[];
  visible: (tasks: BoardTask[]) => BoardTask[];
  /** The pointer's velocity through the drag, which the drop's flight reads
   *  (`boardDropAnimation`). */
  velocity: ReturnType<typeof createVelocityTracker>;
  moves: Pick<BoardMoves, "submitReorder">;
  confirms: Pick<ReturnType<typeof useMoveConfirms>, "finalStageId" | "askAccept" | "askMoveBack">;
}) {
  const { submitReorder } = moves;
  const { finalStageId, askAccept, askMoveBack } = confirms;
  const [drag, setDrag] = useState<{ key: string; fromStage: string } | null>(
    null,
  );
  const [overStage, setOverStage] = useState<string | null>(null);
  // The card the dropped card should land immediately BEFORE (null = column end).
  const [beforeKey, setBeforeKey] = useState<string | null>(null);

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
    velocity.reset();
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
  // Only a MOVE is a velocity sample: `dragover` repeats the last position
  // under a later clock, which would read as the pointer slowing down.
  const onDragMove = (event: DragMoveEvent, manager: DragDropManager) => {
    const { x, y } = event.operation.position.current;
    velocity.push(x, y, performance.now());
    refineSlot(event, manager);
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
      askAccept({
        taskKey: active.key,
        to: resolution.to,
        beforeKey: resolution.beforeKey ?? "",
      });
      return;
    }
    // Ruling 47: dragging a card BACK is the same act as picking an earlier
    // stage from the task page's menu, and the server requires a reason for
    // either. Without this the drag would simply be refused, with nowhere to
    // type the answer.
    const fromIdx = columns.findIndex((c) => c.stage.id === active.fromStage);
    const toIdx = columns.findIndex((c) => c.stage.id === resolution.to);
    if (toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx) {
      askMoveBack({
        taskKey: active.key,
        from: active.fromStage,
        to: resolution.to,
        beforeKey: resolution.beforeKey ?? "",
      });
      return;
    }
    submitReorder(active.key, resolution.to, resolution.beforeKey ?? "");
  };

  return {
    drag,
    overStage,
    beforeKey,
    draggedTask: findTask(allTasks, drag?.key),
    onDragStart,
    onDragOver,
    onDragMove,
    onDragEnd,
  };
}
