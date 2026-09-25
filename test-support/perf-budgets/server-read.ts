import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 457 ratchet ceilings: server read path (file parses, auth, SQL per request). */

const TASK_REVALIDATION =
  "demo seed, arda, VIB-142 + 60 comments (69 events): root + layout + task loaders on one .data Request, second (warm) revalidation";
const BOARD_REVALIDATION =
  "demo seed viberr-core (10 tasks), arda: root + layout + board loaders on one board .data Request, second (warm) revalidation";
const DOCK =
  "demo seed + shipped default agent assets, arda with 6 unseen controller replies on viberr-core, second (warm) call";

export const SERVER_READ_BUDGETS: PerfBudgetTable = {
  // TASK-2 / SRV-1: project.md, agent profiles and task.md re-parsed by every
  // helper that needs one field of them. 35 before the content-keyed parse
  // memo (parse-memo.server.ts); unchanged files now parse zero times.
  "server-read:task-revalidation.yaml-parses": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture: TASK_REVALIDATION,
  },
  // TASK-2 / SRV-1: the same revalidation with an EMPTY memo (a first open):
  // each distinct file parses once — project.md, task.md, three profiles.
  "server-read:task-revalidation.yaml-parses-cold": {
    ceiling: 5,
    unit: "count",
    journey: "task-open",
    fixture: `${TASK_REVALIDATION}, parse memo emptied first`,
  },
  // TASK-2 / SRV-1: store-file reads (each an existsSync + readFileSync pair).
  // 35 before the layout built the task list once.
  "server-read:task-revalidation.store-reads": {
    ceiling: 31,
    unit: "count",
    journey: "task-open",
    fixture: TASK_REVALIDATION,
  },
  // SRV-7 / FL-3 / BOARD-5 / SRV-5 / TASK-7: every SQL statement execution.
  // 86 before one session resolution per Request.
  // 76 before the layout built the task list once.
  // 64 before the layout stopped reading the bell's list (FL-4 / SRV-6) and
  // the board's decisions, live runs and repo probe (BOARD-6).
  "server-read:task-revalidation.sql": {
    ceiling: 49,
    unit: "count",
    journey: "server",
    fixture: TASK_REVALIDATION,
  },
  // FL-8 / SRV-7: better-auth session reads (one getSession per loader).
  // 3 before one session resolution per Request.
  "server-read:task-revalidation.session-lookups": {
    ceiling: 1,
    unit: "count",
    journey: "server",
    fixture: TASK_REVALIDATION,
  },
  // TASK-7: task_events rows read to ship the 30-event slice.
  // 69 before the loader read only the window it ships (SQL LIMIT).
  "server-read:task-loader.timeline-rows": {
    ceiling: 30,
    unit: "count",
    journey: "task-open",
    fixture: TASK_REVALIDATION,
  },
  // SRV-1 / FL-3 / BOARD-5: project.md + three profiles parsed twice (board,
  // then the review queue's second task list). 8 before the parse memo.
  "server-read:board-revalidation.yaml-parses": {
    ceiling: 0,
    unit: "count",
    journey: "board-live",
    fixture: BOARD_REVALIDATION,
  },
  // FL-3 / BOARD-5: the same four files read twice.
  // 8 before the layout built the task list once.
  "server-read:board-revalidation.store-reads": {
    ceiling: 4,
    unit: "count",
    journey: "board-live",
    fixture: BOARD_REVALIDATION,
  },
  // FL-3 / BOARD-5 / SRV-5 / FL-8: every SQL statement execution.
  // 54 before one session resolution per Request.
  // 49 before the layout built the task list once (getBoardWithTasks feeds the review queue).
  // 37 before the bell's list left the layout (FL-4 / SRV-6); the board
  // route's own loader (BOARD-6) shares the layout's read of the project.
  "server-read:board-revalidation.sql": {
    ceiling: 29,
    unit: "count",
    journey: "server",
    fixture: BOARD_REVALIDATION,
  },
  // FL-8 / SRV-7: one getSession per loader.
  // 2 before one session resolution per Request.
  "server-read:board-revalidation.session-lookups": {
    ceiling: 1,
    unit: "count",
    journey: "server",
    fixture: BOARD_REVALIDATION,
  },
  // BOARD-5: task_projections rows mapped (2N: board, then review queue).
  // 20 before the layout built the task list once.
  "server-read:board-revalidation.task-rows": {
    ceiling: 10,
    unit: "count",
    journey: "board-live",
    fixture: BOARD_REVALIDATION,
  },
  // CTL-6: project.md read once per unseen reply to answer "can they open it?".
  // 6 before the unseen check asked once per project.
  "server-read:controller-unseen.store-reads": {
    ceiling: 1,
    unit: "count",
    journey: "controller",
    fixture: DOCK,
  },
  // CTL-6 / SRV-7.
  "server-read:controller-unseen.sql": {
    ceiling: 6,
    unit: "count",
    journey: "controller",
    fixture: DOCK,
  },
  // CTL-6: task-scope dock view, VIB-142 — the task summary built to answer
  // "does it exist?", and the controller definition read for its name.
  // 7 before dockTaskExists stopped building a task summary and the dock stopped reading the definition doc for the controller's name.
  "server-read:dock-task-view.store-reads": {
    ceiling: 2,
    unit: "count",
    journey: "controller",
    fixture: DOCK,
  },
  // CTL-6.
  // 13 before dockTaskExists became one SELECT 1.
  "server-read:dock-task-view.sql": {
    ceiling: 10,
    unit: "count",
    journey: "controller",
    fixture: DOCK,
  },
  // SRV-2: freshness reads whose index binds fewer columns than they filter.
  // 4 before idx_audit_events__task_action and idx_provenance__path_action.
  "server-read:task-freshness.partially-indexed-reads": {
    ceiling: 0,
    unit: "count",
    journey: "task-open",
    fixture:
      "fresh baseline schema: latestTaskReconcileCheckAt, latestTaskReconcileAt, the behindBy lookup, latestReconcileObservation (EXPLAIN QUERY PLAN)",
  },
};
