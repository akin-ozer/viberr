import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 454 ratchet ceilings: write path and projection (reprojection, comments, run sink). */
export const WRITES_BUDGETS: PerfBudgetTable = {
  // SRV-3: the watcher's project.md rebuild after allocateTaskKey bumped only
  // nextTaskNumber force-re-projected every task, one task.updated each
  // (30 before); a cascade now needs a field tasks derive from to change.
  "writes:task-create.task-events-emitted": {
    ceiling: 0,
    unit: "count",
    journey: "server",
    fixture:
      "test store viberr-core with 30 tasks of 4 events each, projected; allocateTaskKey, then rebuildPath(project.md); task.updated events emitted",
  },
  // SRV-3: statements in that same rebuildPath(project.md) (430 before).
  "writes:task-create.sql": {
    ceiling: 14,
    unit: "count",
    journey: "server",
    fixture:
      "same 30-task fixture; SQL statement executions in rebuildPath(project.md) after allocateTaskKey",
  },
  // SRV-3 + SRV-4: WAL commits in that same rebuildPath(project.md) (279
  // before: autocommit writes of the project row and of every task).
  "writes:task-create.commits": {
    ceiling: 1,
    unit: "count",
    journey: "server",
    fixture:
      "same 30-task fixture; writes outside a transaction plus COMMITs in rebuildPath(project.md) after allocateTaskKey",
  },
  // SRV-4: one reprojection ran as N+5 autocommit writes (305 before).
  "writes:reproject-300.commits": {
    ceiling: 1,
    unit: "count",
    journey: "server",
    fixture:
      "test store task with 300 timeline events (comments by one member and system notes), projected; rebuildTaskFile(force); WAL commits",
  },
  // CS-6: every reprojection deleted and re-inserted every task_events row
  // (102 before); now one position shift and one INSERT.
  "writes:comment-append.task-event-writes": {
    ceiling: 2,
    unit: "count",
    journey: "compose-send",
    fixture:
      "test store task with 100 timeline events, projected; one comment unshifted into task.md, then rebuildPath(task.md); INSERT/UPDATE/DELETE statements on task_events",
  },
  // CS-1: ...so every pre-existing row came back with a new id and the
  // timeline (keyed by id) remounted every item (100 before).
  "writes:comment-append.event-ids-reissued": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture:
      "same 100-event task; pre-existing task_events rows whose id changed after the append's reprojection",
  },
  // CS-1: what the reader sees of that churn (31 before: every item remounted).
  "writes:timeline-append.items-rewritten": {
    ceiling: 1,
    unit: "count",
    journey: "compose-send",
    fixture:
      "jsdom Timeline fed by the real rebuilder: a 30-comment task, then one comment appended and re-projected; .tl-item nodes that are new or now show another event",
  },
};
