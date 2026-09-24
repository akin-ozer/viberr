import type { PerfBudgetTable } from "../perf-verdict";

/** The project.payload.perf.test.ts fixture. */
const WORKSPACE =
  "demo seed, arda (org admin, project admin, ten notifications): root + layout + page loaders on one .data Request, second (warm) revalidation; bytes = JSON of each loader's result, summed";

/** The same, with thirty clones of the demo's task files (40 tasks). */
const BOARD_40 = `${WORKSPACE}; viberr-core enlarged to 40 tasks by cloning the demo's task files`;

/** Ruling 454 ratchet ceilings: loader payloads (bell, board columns, board task shape). */
export const PAYLOAD_BUDGETS: PerfBudgetTable = {
  // FL-4: 8,505 before the bell's list left the pages (owner, 2026-09-24):
  // 62 % of Home's payload was a popover closed at first paint.
  "payload:home.loader-bytes": {
    ceiling: 3251,
    unit: "bytes",
    journey: "fresh-load",
    fixture: "demo seed, arda (org admin, ten notifications): the Home loader's JSON, second (warm) run",
  },
  // FL-4: 10 before (every Home load read the bell's newest hundred).
  "payload:home.notification-rows": {
    ceiling: 0,
    unit: "count",
    journey: "fresh-load",
    fixture: "demo seed, arda: rows the Home loader read from the bell's list query",
  },
  // FL-4 / SRV-6 / BOARD-6: 29,348 before; 24,094 once the bell's list left,
  // then the board's columns and repo probe moved to the board route's loader.
  "payload:task-page.layout-bytes": {
    ceiling: 1138,
    unit: "bytes",
    journey: "task-open",
    fixture: `${WORKSPACE}; VIB-142; the layout's result alone`,
  },
  // SRV-6: 10 before.
  "payload:task-page.notification-rows": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture: `${WORKSPACE}; VIB-142; rows read from the bell's list query`,
  },
  // BOARD-6 / FL-4: 32,471 before (the whole board and the bell's list rode
  // every settings revalidation).
  "payload:settings-revalidation.bytes": {
    ceiling: 4261,
    unit: "bytes",
    journey: "server",
    fixture: `${WORKSPACE}; /settings`,
  },
  // BOARD-6 / SRV-6: 57 before (the board's decision scan, live runs and repo
  // probe, and the bell's list with its decision inbox).
  "payload:settings-revalidation.sql": {
    ceiling: 42,
    unit: "count",
    journey: "server",
    fixture: `${WORKSPACE}; /settings; SQL statement executions`,
  },
  // BOARD-3 / BOARD-6 / FL-4: 85,091 before.
  "payload:board-40.revalidation-bytes": {
    ceiling: 38717,
    unit: "bytes",
    journey: "board-live",
    fixture: `${BOARD_40}; /board`,
  },
  // BOARD-3: 74,188 before (the whole TaskSummary per card).
  "payload:board-40.card-bytes": {
    ceiling: 37060,
    unit: "bytes",
    journey: "board-live",
    fixture: `${BOARD_40}; /board; the 40 cards' JSON`,
  },
  // BOARD-3: 49 before; `toBoardCard` ships the board's read set.
  "payload:board-40.card-fields": {
    ceiling: 29,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}; /board; the most fields any card ships`,
  },
};
