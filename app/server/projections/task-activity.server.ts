import type { DatabaseSync } from "node:sqlite";
import type { Waiting } from "~/schemas/task-file.schema";

/**
 * Last activity, and the "gone quiet" signal derived from it (pass-19 gap 10).
 *
 * WHY `task_events.occurred_at` AND NOT `task_projections.updated_at`
 * ---------------------------------------------------------------------------
 * `updated_at` is a FILE-WRITE stamp, not an activity stamp. `updateTaskFile`
 * sets `frontmatter.updatedAt = now` on EVERY write (task-writer.server.ts),
 * and several of those writes are bookkeeping nobody performed:
 *   · the background GitHub reconcile poller runs every 5 minutes over every
 *     branched task and `patchTaskFrontmatter`s the refreshed `pr`/`github`
 *     cache (reconcile-poller.server.ts, github-reconciler.server.ts:510), so a
 *     CI check flipping pending→passing, or the base branch moving under a
 *     task's `github.sync` counters, re-stamps a task nobody has touched;
 *   · `schedule.server.ts` marks a scheduled entry fired;
 *   · a board drag writes `boardRank`.
 * A task that has been dead for a week but still has an open PR therefore reads
 * "updated 4m ago" forever — which is exactly the lie this signal exists to
 * stop telling. (A projection REBUILD is the mirror-image hazard the same way:
 * the rebuilder copies `fm.updatedAt` through, so it does not forge the stamp
 * today, but nothing structurally prevents the next writer from doing so —
 * `updated_at` is not, and was never, an "activity" column.)
 *
 * `task_events.occurred_at` is stamped by the actor that did the thing — an
 * agent report, a human comment, a transition, a packet opened or answered —
 * and a rebuild re-inserts the same value straight from the task file. It is
 * the only column in the projection that means "something happened here". Note
 * the column is `occurred_at`, NOT `created_at`; `task_events` has no
 * `created_at`.
 */

/**
 * A task with no run in flight, waiting on an AGENT (or on nobody at all), that
 * has recorded nothing for an hour.
 *
 * Grounded in the runtime's own hang guard: `claudeIdleTimeoutMs()` kills a run
 * that produces no output for 15 minutes, and the Codex adapter has the same
 * guard (owner ruling A8). So an hour of total silence is four times the longest
 * silence a HEALTHY run is allowed — by then the run has settled, errored, or
 * never started, and no one re-engaged. That is the stranding class this signal
 * is for: an operator turn that ended without queuing anything, a run that
 * errored after the task file was written, an agent nobody re-engaged.
 */
export const QUIET_AFTER_AGENT_MS = 60 * 60_000;

/**
 * A task waiting on a HUMAN gets three days, not one hour.
 *
 * A human is legitimately slow, and a task waiting on a person overnight is
 * normal — flagging it would train people to ignore the cue. 72h is chosen so
 * the ordinary weekend never fires it: a decision reached on Friday evening and
 * picked up Monday morning is ~60h of silence. Past three days, a decision
 * nobody has made is a decision nobody remembers.
 */
export const QUIET_AFTER_HUMAN_MS = 72 * 60 * 60_000;

export interface TaskActivityFacts {
  /** ISO stamp of the newest timeline event; null when the timeline is empty. */
  lastActivityAt: string | null;
  /** A run is `queued` or `running` for this task right now. */
  runInFlight: boolean;
}

const NO_ACTIVITY: TaskActivityFacts = {
  lastActivityAt: null,
  runInFlight: false,
};

/** Newest timeline stamp + live-run flag for every task in a project, in two
 *  aggregate queries (both index-covered: `idx_task_events__task`,
 *  `idx_agent_runs__task`). Tasks with neither are simply absent from the map —
 *  {@link activityFactsFor} resolves them to "nothing ever happened". */
export function readProjectActivity(
  db: DatabaseSync,
  slug: string,
): Map<string, TaskActivityFacts> {
  const facts = new Map<string, TaskActivityFacts>();
  // SAFETY: the two selected columns are exactly the two asserted here —
  // `task_key` is TEXT NOT NULL, and `MAX(occurred_at)` over a TEXT column is
  // TEXT or NULL for an empty group (0001_baseline.sql `task_events`).
  const events = db
    .prepare(
      `SELECT task_key AS k, MAX(occurred_at) AS last_at
         FROM task_events WHERE project_slug = ? GROUP BY task_key`,
    )
    .all(slug) as { k: string; last_at: string | null }[];
  for (const row of events) {
    facts.set(row.k, { lastActivityAt: row.last_at, runInFlight: false });
  }
  // The live run registry the board card has never consulted. A task with a run
  // actually in flight is not quiet whatever its timeline says — a run can work
  // for an hour and report once at the end, and the runtime's idle guard (not
  // this module) owns the "the run itself hung" case.
  // SAFETY: one selected column, `agent_runs.task_key` (TEXT NOT NULL).
  const live = db
    .prepare(
      `SELECT DISTINCT task_key AS k FROM agent_runs
        WHERE project_slug = ? AND state IN ('queued', 'running')`,
    )
    .all(slug) as { k: string }[];
  for (const row of live) {
    const existing = facts.get(row.k);
    if (existing) existing.runInFlight = true;
    else facts.set(row.k, { lastActivityAt: null, runInFlight: true });
  }
  return facts;
}

/** Single-task form — the task-detail read path reads one row, not a project. */
export function readTaskActivity(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
): TaskActivityFacts {
  // SAFETY: an un-grouped `MAX()` returns at most one row, and its single
  // column is `task_events.occurred_at` (TEXT) — NULL when nothing matched.
  const event = db
    .prepare(
      `SELECT MAX(occurred_at) AS last_at FROM task_events
        WHERE project_slug = ? AND task_key = ?`,
    )
    .get(slug, taskKey) as { last_at: string | null } | undefined;
  const live = db
    .prepare(
      `SELECT 1 FROM agent_runs
        WHERE project_slug = ? AND task_key = ? AND state IN ('queued', 'running')
        LIMIT 1`,
    )
    .get(slug, taskKey);
  return {
    lastActivityAt: event?.last_at ?? null,
    runInFlight: live !== undefined,
  };
}

export function activityFactsFor(
  facts: Map<string, TaskActivityFacts>,
  taskKey: string,
): TaskActivityFacts {
  return facts.get(taskKey) ?? NO_ACTIVITY;
}

/** What {@link isQuiet} needs to answer the question. */
export interface QuietCheck {
  lastActivityAt: string | null;
  waiting: Waiting;
  archived: boolean;
  /** Terminal stage — accepted / merged, i.e. `isAcceptedDisplayState`. */
  terminal: boolean;
  runInFlight: boolean;
  /** Ruling 131 (pass 34): the task waits on other work (`blockedBy` is
   *  non-empty). Such a task is held on purpose and is never "gone quiet". */
  held: boolean;
  /** Omitted outside tests — the real clock answers the question. */
  now?: Date;
}

/**
 * Has this task gone quiet? Pure, so both read models and the tests agree.
 *
 * Deliberately conservative on four counts, because a cue that fires on healthy
 * work is worse than no cue:
 *  · ARCHIVED and TERMINAL tasks are out of the flow and owe nobody anything
 *    (R14-3 / UXO-1 / F19-8) — they never carry the cue.
 *  · a run in flight is not quiet, whatever the timeline says.
 *  · a task with an EMPTY timeline has not "stopped moving" — it never started.
 *    A backlog item created in a planning session and not picked up is a
 *    backlog, not a stall, and a board that lights up 20 fresh cards three days
 *    after a planning session has taught everyone to ignore it.
 *  · the threshold follows who is on the hook (see the two constants).
 */
export function isQuiet(input: QuietCheck): boolean {
  if (input.archived || input.terminal || input.runInFlight) return false;
  // A task waiting on other work is holding, not stalling (ruling 131(a)).
  if (input.held) return false;
  if (!input.lastActivityAt) return false;
  const at = Date.parse(input.lastActivityAt);
  if (!Number.isFinite(at)) return false;
  const idleMs = (input.now ?? new Date()).getTime() - at;
  const threshold =
    input.waiting === "human" ? QUIET_AFTER_HUMAN_MS : QUIET_AFTER_AGENT_MS;
  return idleMs >= threshold;
}
