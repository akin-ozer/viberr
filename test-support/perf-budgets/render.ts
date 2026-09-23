import type { PerfBudgetTable } from "../perf-verdict";

/** The board-page.perf.test.tsx fixture, shared by its budgets. */
const BOARD_40 =
  "jsdom: BoardPage with 40 cards over five lanes (agent working, PRs, branches, owners, agent seats, problem chips) for a viewer who can move tasks; a revalidation is structuredClone of the board";

/** Ruling 454 ratchet ceilings: client render work and CSS (board cards, icons, hydration). */
export const RENDER_BUDGETS: PerfBudgetTable = {
  // TASK-8 / LIVE-6 / BOARD-4 / CTL-5: 12 before the per-glyph {__html} cache
  // (every re-render re-parsed every icon's SVG markup).
  "render:icon.dom-writes-per-rerender": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture:
      "jsdom: twelve <Icon>s under a parent that re-renders with nothing changed; MutationObserver records on the <svg>s",
  },
  // BOARD-2: 40 before the cards were memoised over shared task objects.
  "render:board.card-renders-per-noop-revalidation": {
    ceiling: 0,
    unit: "count",
    journey: "board-live",
    fixture: BOARD_40,
  },
  // BOARD-2: 581 before, 40 cards' subtrees included.
  "render:board.component-renders-per-noop-revalidation": {
    ceiling: 25,
    unit: "count",
    journey: "board-live",
    fixture: BOARD_40,
  },
  // BOARD-4: 176 before (133 icon SVG resets, 40 roving tabindex writes, 3
  // input attribute writes React 19 makes on every update of an <input>).
  "render:board.dom-writes-per-noop-revalidation": {
    ceiling: 3,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}; MutationObserver records under the board`,
  },
  // BOARD-2: 40 before.
  "render:board.card-renders-per-single-card-change": {
    ceiling: 1,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}; one card's title changed`,
  },
  // BOARD-4: the new title, and the 3 input attribute writes above; 5 while
  // the roving effect rewrote the rendered card's unchanged tabindex.
  "render:board.dom-writes-per-single-card-change": {
    ceiling: 4,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}; one card's title changed; MutationObserver records under the board`,
  },
  // BOARD-2: 40 before.
  "render:board.list-row-renders-per-single-card-change": {
    ceiling: 1,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}, list view; one card's title changed`,
  },
  // BOARD-2: 40 before (a new stage list and move callback on every render).
  "render:board.card-renders-per-drag-slot-change": {
    ceiling: 0,
    unit: "count",
    journey: "board-live",
    fixture:
      "jsdom: StageBoard in a DragDropProvider, 40 cards over five lanes, a card dragged over the review lane; its landing slot moves",
  },
};
