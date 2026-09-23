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
  // CS-5: a plain comment (no "@") ran the whole mention machinery (both
  // agent resolvers, the member ladder twice, the author's name and tone for a
  // fan-out that reaches no one) and built a task summary no caller read
  // (29 before, already net of the CS-6 change above).
  "writes:comment.sql": {
    ceiling: 16,
    unit: "count",
    journey: "compose-send",
    fixture:
      "setupAppTest + runDemoSeed; commentToAgent on viberr-core/VIB-142 as arda, text with no '@'; SQL statement executions (auth not included)",
  },
  // CS-5: the same comment's data-root file reads: project.md and the three
  // agent profiles three times over, and task.md parsed once more just to
  // check it exists (18 before). The three project.md reads left are
  // loadProjectContext and the two compression-guardrail lookups.
  "writes:comment.file-reads": {
    ceiling: 5,
    unit: "count",
    journey: "compose-send",
    fixture:
      "same fixture and call; fs.readFileSync calls on files under the data root",
  },
  // CS-4: an @member comment's notified stamp was the one task.md write
  // nothing re-projected, so the file watcher re-projected it ~250 ms later
  // and sent a second task.updated (1 before).
  "writes:mention-comment.late-reprojections": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture:
      "same fixture; commentToAgent '@elif can you take a look at the schema?' on VIB-142, then rebuildPath(task.md) as the watcher would; 1 when it re-projected",
  },
};
