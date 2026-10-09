import type { PerfBudgetTable } from "../perf-verdict";

/** The `project.task.console.perf.test.ts` fixture. */
const TASK_CONSOLE =
  "demo seed + test-support/console-fixture.ts on VIB-142 (870 console lines over three agent groups, the developer streaming), arda; the task loader's result as JSON, second call";

/** The `task-console.perf.test.tsx` fixture. */
const TASK_PAGE =
  "jsdom: TaskDetailPage beside the layout's live stream, one Profiler; the developer streaming beside a finished 50-line operator, no timeline events; fake EventSource and /resources/run-log, fake timers";

/** Ruling 11 ratchet ceilings: live run console, task page render and its SSE streams. */
export const CONSOLE_BUDGETS: PerfBudgetTable = {
  // TASK-1: 1,048,869 while every group's window (display and raw) rode every
  // revalidation; now window facts only (owner decision 2). Raised 13001 to
  // 13073 by CON-7: each of the three groups carries its facts' version
  // (`"factsAt":<ms>,`, 24 bytes), so the strip keeps the newer of a
  // revalidation's read and a tail read instead of stepping back. Raised
  // 13073 to 13152 by ruling 316: VIB-142's packet render names the option
  // each acceptance door answers its decision with (`acceptAnswersWith` and
  // `forceAnswersWith`, "Accept completion", 79 bytes), so the accept dialog
  // reads the loader's answer instead of guessing. Raised 13152 to 13173 by
  // ruling 242: the loader names the open pull requests this merge will
  // likely put in conflict (`"mergeCollisions":[],`, 21 bytes on VIB-142, which
  // shares no path), so the accept dialog can say so before the merge. Raised
  // 13173 to 13395 by ruling 103: the loader ships the completion packet's
  // view (`completion`, 234 bytes on VIB-142: its one required reviewer, no
  // verdict yet on a91f7c2, and the change's size), which the decision that
  // offers acceptance draws; the payload had come down 12 bytes since 475.
  // Raised 13395 to 13421 by ruling 16: VIB-142's completion carries its two
  // evidence rows as a result and a mark (`"result":"6 passed","status":"pass"`)
  // in place of a diff's `add` and `del` (26 bytes), which the timeline draws
  // as a checklist. Raised 13421 to 13685 by ruling 83: the loader ships what
  // the task took for the completion card to print (`whatItTook`, its facts
  // and notes alone, 273 bytes on VIB-142: six runs and their agent time, no
  // cost reported, the first delivery, and two notes on what the figure
  // misses; its open acceptance decision is no asked round), only with a
  // completion view and to a viewer who may see the runs; the payload had
  // come down 9 bytes since 526. Lowered 13685 to 13666 by ruling 308: the
  // loader no longer ships `"runsVisible":true,` (19 bytes), a flag the
  // members-only page could only ever set true.
  "console:task-data.json-bytes": {
    ceiling: 13666,
    unit: "bytes",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a .data request`,
  },
  // TASK-1: 876 (three windows' rows plus six per-run COUNT/MIN/MAX); now one
  // task-wide COUNT/MAX and each window's own rows as sizes and tags, the
  // byte budget applied inside the query.
  "console:task-data.run-log-rows": {
    ceiling: 524,
    unit: "count",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a .data request; run_log_lines rows read`,
  },
  // TASK-1: 1,048,869 (the same payload as a revalidation); now the shown
  // agent's window, display lines only. Raised 136574 to 136646 by CON-7:
  // the three groups' `factsAt` (24 bytes each). Raised 136646 to 136725 by
  // ruling 316: the packet render's two answer fields (79 bytes, as above).
  // Raised 136725 to 136746 by ruling 242: `"mergeCollisions":[],` (21
  // bytes, as above). Raised 136746 to 136968 by ruling 103: `completion`
  // (234 bytes, as above, less the same 12). Raised 136968 to 136994 by
  // ruling 16: the two rows' result and mark (26 bytes, as above). Raised
  // 136994 to 137258 by ruling 83: `whatItTook` (273 bytes, as above, less
  // the same 9). Lowered 137258 to 137239 by ruling 308: `runsVisible` (19
  // bytes, as above).
  "console:task-document.json-bytes": {
    ceiling: 137239,
    unit: "bytes",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a document request`,
  },
  // TASK-1: the one request that fills a thread a .data payload left empty.
  // Raised 124054 to 124078 by CON-7: the facts' `factsAt` (24 bytes).
  "console:run-log-window.json-bytes": {
    ceiling: 124078,
    unit: "bytes",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}; /resources/run-log?runId=run_dev_3&window=1, the response body`,
  },
  // TASK-6 / LIVE-5: 2 while the console opened an EventSource of its own on
  // the task scope the layout's stream already held; it takes the layout's.
  "console:task-page.event-sources": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; open EventSources after mount`,
  },
  // TASK-3: 2 (discovery, 2026-09-24) while the console's mount effect
  // re-seeded identical lines; the store is seeded once.
  "console:task-page.page-renders-on-mount": {
    ceiling: 1,
    unit: "count",
    journey: "task-open",
    fixture: `${TASK_PAGE}; 400 rows; TaskDetailPage renders from mounting the page until it settles`,
  },
  // LIVE-2 / LIVE-4: 106 while the line buffer was TaskDetailPage state and
  // the whole page re-rendered per line; now the console view, the one row it
  // adds and the footer's count.
  "console:task-page.renders-per-line-40": {
    ceiling: 4,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 console rows; component renders for one appended line`,
  },
  // LIVE-2 / LIVE-4: 250 (the console's part grew with history: index keys,
  // the fold re-run over the buffer); now the same 4 as at 40 rows.
  "console:task-page.renders-per-line-400": {
    ceiling: 4,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 console rows; component renders for one appended line`,
  },
  // LIVE-4: 10; now the row and the footer's count.
  "console:task-page.dom-writes-per-line-40": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 console rows; MutationObserver records for one appended line`,
  },
  // LIVE-4: 9 (the count stuck at the loader's snapshot); now the row and the
  // count, the same 2 as at 40 rows.
  "console:task-page.dom-writes-per-line-400": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 console rows; MutationObserver records for one appended line`,
  },
  // LIVE-2: 1 while the line buffer was TaskDetailPage state.
  "console:task-page.page-renders-per-line": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; TaskDetailPage renders for one appended line`,
  },
  // TASK-4 (console half): 254 while the console and the run card
  // re-reconciled on identical data; neither renders now (the stable run
  // projection, memoised panels). The 43 left are the page's other panels
  // (54 before the timeline and composer memos of perf/journeys-pass; 51
  // before the memoised GlyphSwap (ruling 284) took the run start's and
  // Archive's glyphs out of the re-render; 49 before the Details panel (ruling
  // 309), whose property rows are memoised on its stabilised values, so an
  // unchanged task re-renders only the panel's shell and its head glyph; 44
  // before the PR card (ruling 315), where the branch is the link to its tree
  // and the "Open on GitHub" button's glyph is gone). Raised to 44 by ruling 13(b): the
  // TaskMainColumn region, the page's main column as a component of its own,
  // renders once with the page; every panel under it renders as before.
  "console:task-page.renders-per-noop-revalidation": {
    ceiling: 44,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; component renders for a structuredClone of the same props`,
  },
  // TASK-4: 8.
  "console:task-page.dom-writes-per-noop-revalidation": {
    ceiling: 3,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; MutationObserver records for a structuredClone of the same props`,
  },
  // LIVE-3: 2 while a same-run revalidation re-seeded the console from the
  // loader; the store keeps what it holds.
  "console:task-page.commits-per-sliding-revalidation-400": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows, five lines tailed, then props whose window slid by those five; React commits`,
  },
  // LIVE-3: 423.
  "console:task-page.dom-writes-per-sliding-revalidation-400": {
    ceiling: 3,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows, five lines tailed, then props whose window slid by those five; MutationObserver records`,
  },
  // LIVE-4: 621 while index keys rewrote every existing row on a prepend; now
  // the 200 rows inserted and the affordance's note.
  "console:task-page.dom-writes-per-load-older-400": {
    ceiling: 205,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; MutationObserver records for "load older lines" (a 200-line page)`,
  },
  // LIVE-11: 23 while the elapsed clock re-rendered the whole Live run card;
  // now its leaf on the shared clock, and only the digit field that moved
  // (6 until the event count stopped committing per frame, LIVE-7).
  "console:task-page.renders-per-clock-tick": {
    ceiling: 5,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 rows; component renders for one 1 s tick`,
  },
  // LIVE-1 / RF-2: 30 (root + layout + task every 2 s, only to move the
  // strip); the strip reads the facts each console tail read returns.
  "console:task-page.loader-runs-per-20s-of-lines": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture:
      "jsdom: routes stub root > layout (live stream) > task, each loader counting; TaskDetailPage with 40 rows; a run.log-appended every 500 ms for 19.5 s (short of the F22 20 s tick)",
  },
  // CTL-2 (page half): 14 (a 5 s revalidation poll plus the F22 20 s one);
  // the page reads the turn's tail every 5 s and revalidates when it ended.
  "console:controller-page.loader-runs-per-30s-turn": {
    ceiling: 0,
    unit: "count",
    journey: "controller",
    fixture:
      "jsdom: ControllerPage on a routes stub (root and page loaders counting), a working controller turn with a one-line console, fake timers, 30 s with nothing but the step moving",
  },
};
