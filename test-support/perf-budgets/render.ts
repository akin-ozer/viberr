import type { PerfBudgetTable } from "../perf-verdict";

/** The board-page.perf.test.tsx fixture, shared by its budgets. */
const BOARD_40 =
  "jsdom: BoardPage with 40 cards over five lanes (agent working, PRs, branches, owners, agent seats, problem chips) for a viewer who can move tasks; a revalidation is structuredClone of the board";

/** The local-time.perf.test.tsx fixture. */
const LOCAL_STAMPS =
  "jsdom: thirty LocalDayDotTime stamps mounted by a client render (no hydration) in Pacific/Auckland, inside a Profiler";

/** The number-ticker.perf.test.tsx fixture. */
const TICKER =
  "jsdom: <NumberTicker end={200}> settled, retargeted, then 160 fake-clock frames of 16 ms, one act() each, inside a Profiler";

/** The timeline.perf.test.tsx render fixture. */
const TIMELINE_30 =
  "jsdom: Timeline with 30 events (comments, typed events with evidence, an attachment chip), mentionables, task links and attachment names, in a routes stub, inside a Profiler; TimelineItem renders";

/** The comment-composer.perf.test.tsx fixture. */
const COMPOSER =
  "jsdom: the Timeline (ten comments) with the lazily loaded Lexical editor in a routes stub, text set through editor updates, inside a Profiler";

/** Ruling 11 ratchet ceilings: client render work and CSS (board cards, icons, hydration). */
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
  // CSS-3: 2 while useHydrated started false on every mount.
  "render:local-time.commits-per-client-mount": {
    ceiling: 1,
    unit: "count",
    journey: "task-open",
    fixture: LOCAL_STAMPS,
  },
  // CSS-3: 30 before (every stamp swapped from its UTC form after mounting).
  "render:local-time.text-rewrites-per-client-mount": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture: `${LOCAL_STAMPS}; characterData MutationObserver records`,
  },
  // CSS-4 (owner, 2026-09-24): 6 before.
  "render:css.live-scrollers-without-gutter": {
    ceiling: 0,
    unit: "count",
    journey: "board-live",
    fixture:
      "app/app.css: .col-body, .board.list, .detail, .console, .ctl-transcript and .dock-body without a top-level scrollbar-gutter: stable",
  },
  // CSS-7: 1 before (the timeline thumbnail's picture had only a max-height).
  "render:css.feed-thumbs-without-a-box": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture: "app/app.css: .attach-thumb img / .tl-attach-thumb img rules with neither height nor aspect-ratio",
  },
  // LIVE-7 / CSS-2: the retarget's commit, then one for the digit that
  // changes. 126 before (a new float set on every frame of the two-second
  // count, whatever the text drew).
  "render:number-ticker.commits-per-plus-one": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture: `${TICKER}; retargeted to 201`,
  },
  // LIVE-7 / CSS-2: the retarget and one per figure drawn. 126 before.
  "render:number-ticker.commits-per-plus-ten": {
    ceiling: 11,
    unit: "count",
    journey: "live-run",
    fixture: `${TICKER}; retargeted to 210`,
  },
  // CS-3: 60 before (every item re-rendered on the fetcher's submitting and
  // idle states) the items were memoised over shared rows and lookups.
  "render:timeline.item-renders-per-send": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture: `${TIMELINE_30}; the composer typed into, Comment clicked, a stub action answering { ok: true }, through to idle`,
  },
  // TASK-4 (the timeline half): 30 before (new event objects, a new
  // mentionables directory and attachment list on every revalidation).
  "render:timeline.item-renders-per-noop-revalidation": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture: `${TIMELINE_30}; a revalidation is structuredClone of events, mentionables, task links and attachment names`,
  },
  // CS-7: the draft lives in a ref, so nothing above the editor renders.
  "render:composer.renders-per-plain-keystroke": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture: `${COMPOSER}; "Looks good" to "Looks good!"; every component render`,
  },
  // CS-7: the menu's filter changed, so the editor renders once.
  "render:composer.editor-renders-per-token-keystroke": {
    ceiling: 1,
    unit: "count",
    journey: "compose-send",
    fixture: `${COMPOSER}; "ping @ar" to "ping @ard"; CommentEditor renders`,
  },
  // CS-7: 1 before (a new change handler on every render made OnChangePlugin
  // unregister and register its update listener).
  "render:composer.listener-registrations-per-token-keystroke": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture: `${COMPOSER}; "ping @ar" to "ping @ard"; editor.registerUpdateListener calls`,
  },
  // CS-7: 19 before (a new token object for the same @token re-rendered the
  // editor's whole subtree).
  "render:composer.renders-per-same-caret-selection": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture: `${COMPOSER}; "ping @ar", then a selection update that leaves the caret at the end; every component render`,
  },
  // CS-7: 1 before (an inline onChange and an unmemoised composer), with a
  // listener re-registration.
  "render:composer.editor-renders-per-noop-revalidation": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture: `${COMPOSER}; a draft typed, then structuredClone of the events and mentionables; CommentEditor renders`,
  },
  // RF-9: one interval per cadence (1 s and 30 s), however many readers.
  // 23 before (one interval per stamp and per counter).
  "render:clock.intervals-per-page": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture:
      "jsdom: twenty useRelativeTime stamps and three live useElapsed counters mounted by a client render on a fake clock (vi.getTimerCount())",
  },
};
