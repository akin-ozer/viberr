import type { PerfBudgetTable } from "../perf-verdict";

/** The project.payload.perf.test.ts fixture. */
const WORKSPACE =
  "demo seed on the pinned clock, arda (org admin, project admin, ten notifications): root + layout + page loaders on one .data Request, second (warm) revalidation; bytes = JSON of each loader's result, summed";

/** The same, with thirty clones of the demo's task files (40 tasks). */
const BOARD_40 = `${WORKSPACE}; viberr-core enlarged to 40 tasks by cloning the demo's task files`;

/** Ruling 457 ratchet ceilings: loader payloads (bell, board columns, board task shape). */
export const PAYLOAD_BUDGETS: PerfBudgetTable = {
  // FL-4: 8,505 before the bell's list left the pages (owner, 2026-09-24):
  // 62 % of Home's payload was a popover closed at first paint. 3,251 was
  // first recorded on the wall clock at 03:13 ("Good morning", two bytes
  // shorter than the afternoon's greeting) and counted the data root, a temp
  // path as long as the host makes it (71 bytes on macOS, 26 on Linux); on the
  // pinned clock with the path measured as empty the same payload is 3,182.
  // Raised by 136 for ruling 532: the setup checklist's four steps. The demo
  // seed gives arda no GitHub connection and no Claude or Codex account, so
  // the checklist is open (two steps done), and it rides the loader it shows
  // on; an instance with every step done sends `null`.
  "payload:home.loader-bytes": {
    ceiling: 3318,
    unit: "bytes",
    journey: "fresh-load",
    fixture:
      "demo seed on the pinned clock, arda (org admin, ten notifications): the Home loader's JSON with storeRoot (the host's temp path) blanked, second (warm) run",
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
  // BOARD-3 / BOARD-6 / FL-4: 85,091 before. 38,717 was first recorded on
  // the wall clock in the small hours, before the demo's "today" agent
  // activity was an hour old; on the pinned clock twelve cards read `quiet:
  // true`, a byte shorter each (the same for card-bytes below). Raised 38705
  // to 38865 by ruling 471: the four cards cloned from VIB-142 carry the
  // option the board's acceptance answers their open decision with
  // (`"acceptAnswersWith":"Accept completion"`, 40 bytes each), so the
  // dialog can say "Answers" from the loader instead of "Withdraws".
  "payload:board-40.revalidation-bytes": {
    ceiling: 38865,
    unit: "bytes",
    journey: "board-live",
    fixture: `${BOARD_40}; /board`,
  },
  // BOARD-3: 74,188 before (the whole TaskSummary per card). Raised 37048 to
  // 37208 by ruling 471: the same four cards' `acceptAnswersWith` (40 bytes
  // each, as above).
  "payload:board-40.card-bytes": {
    ceiling: 37208,
    unit: "bytes",
    journey: "board-live",
    fixture: `${BOARD_40}; /board; the 40 cards' JSON`,
  },
  // BOARD-3: 49 before; `toBoardCard` ships the board's read set. 28 since
  // ruling 491 dropped `prChecksUnread`, which fed only the removed pill.
  // Raised 28 to 29 by ruling 503: `epicId`, which the board's epic filter
  // reads (the card draws no chip for it, ruling 172).
  "payload:board-40.card-fields": {
    ceiling: 29,
    unit: "count",
    journey: "board-live",
    fixture: `${BOARD_40}; /board; the most fields any card ships`,
  },
};
