import type { PerfBudgetTable } from "../perf-verdict";

/** The `project.task.console.perf.test.ts` fixture. */
const TASK_CONSOLE =
  "demo seed + test-support/console-fixture.ts on VIB-142 (870 console lines over three agent groups, the developer streaming), arda; the task loader's result as JSON, second call";

/** The `task-console.perf.test.tsx` fixture. */
const TASK_PAGE =
  "jsdom: TaskDetailPage beside the layout's live stream, one Profiler; the developer streaming beside a finished 50-line operator, no timeline events; fake EventSource and /resources/run-log, fake timers";

/** The `run-events.console.perf.test.ts` fixture. */
const TABS =
  "connectSseClient: a board tab (project + user) and a task tab (project + task + user); ten lines of one run on that task";

/** Ruling 454 ratchet ceilings: live run console, task page render and its SSE streams. */
export const CONSOLE_BUDGETS: PerfBudgetTable = {
  // TASK-1: every group's window, display and raw, on every revalidation.
  "console:task-data.json-bytes": {
    ceiling: 1048869,
    unit: "bytes",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a .data request`,
  },
  // TASK-1: the three windows' rows and six per-run COUNT/MIN/MAX scans.
  "console:task-data.run-log-rows": {
    ceiling: 876,
    unit: "count",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a .data request; run_log_lines rows read`,
  },
  // TASK-1: the same payload as a revalidation.
  "console:task-document.json-bytes": {
    ceiling: 1048869,
    unit: "bytes",
    journey: "task-open",
    fixture: `${TASK_CONSOLE}, a document request`,
  },
  // TASK-6 / LIVE-5: the layout's stream and the console's own.
  "console:task-page.event-sources": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; open EventSources after mount`,
  },
  // LIVE-2 / LIVE-4: the whole page re-rendered per line.
  "console:task-page.renders-per-line-40": {
    ceiling: 106,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 console rows; component renders for one appended line`,
  },
  // LIVE-2 / LIVE-4: ...and the console's part grew with history.
  "console:task-page.renders-per-line-400": {
    ceiling: 250,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 console rows; component renders for one appended line`,
  },
  "console:task-page.dom-writes-per-line-40": {
    ceiling: 10,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 console rows; MutationObserver records for one appended line`,
  },
  "console:task-page.dom-writes-per-line-400": {
    ceiling: 9,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 console rows; MutationObserver records for one appended line`,
  },
  // LIVE-2: the line buffer was TaskDetailPage state.
  "console:task-page.page-renders-per-line": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; TaskDetailPage renders for one appended line`,
  },
  // TASK-4 (console half): the console re-reconciled on identical data.
  "console:task-page.renders-per-noop-revalidation": {
    ceiling: 254,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; component renders for a structuredClone of the same props`,
  },
  "console:task-page.dom-writes-per-noop-revalidation": {
    ceiling: 8,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; MutationObserver records for a structuredClone of the same props`,
  },
  // LIVE-3: a same-run revalidation re-seeded the console from the loader.
  "console:task-page.commits-per-sliding-revalidation-400": {
    ceiling: 2,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows, five lines tailed, then props whose window slid by those five; React commits`,
  },
  "console:task-page.dom-writes-per-sliding-revalidation-400": {
    ceiling: 423,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows, five lines tailed, then props whose window slid by those five; MutationObserver records`,
  },
  // LIVE-4: index keys rewrote every existing row on a prepend.
  "console:task-page.dom-writes-per-load-older-400": {
    ceiling: 621,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 400 rows; MutationObserver records for "load older lines" (a 200-line page)`,
  },
  // LIVE-11: the elapsed clock re-rendered the whole Live run card.
  "console:task-page.renders-per-clock-tick": {
    ceiling: 23,
    unit: "count",
    journey: "live-run",
    fixture: `${TASK_PAGE}; 40 rows; component renders for one 1 s tick`,
  },
  // LIVE-1 / RF-2: root + layout + task every 2 s, only to move the strip.
  "console:task-page.loader-runs-per-20s-of-lines": {
    ceiling: 30,
    unit: "count",
    journey: "live-run",
    fixture:
      "jsdom: routes stub root > layout (live stream) > task, each loader counting; TaskDetailPage with 40 rows; a run.log-appended every 500 ms for 19.5 s (short of the F22 20 s tick)",
  },
  // LIVE-5: the task tab's layout stream carries the line once.
  "console:sse.run-line-frames-per-line-task-tab": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TABS}; frames per line on the task tab`,
  },
  // LIVE-5: 1 while every board of the project received and dropped every
  // line; the frame is task-scoped only now.
  "console:sse.run-line-frames-per-line-board-tab": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture: `${TABS}; frames per line on the board tab`,
  },
  // CTL-2 (page half): a 5 s revalidation poll plus the F22 20 s one.
  "console:controller-page.loader-runs-per-30s-turn": {
    ceiling: 14,
    unit: "count",
    journey: "controller",
    fixture:
      "jsdom: ControllerPage on a routes stub (root and page loaders counting), a working controller turn with a one-line console, fake timers, 30 s with nothing but the step moving",
  },
};
