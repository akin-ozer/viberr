import type { TaskFileEvent } from "~/schemas/task-file.schema";

/**
 * Anti-noise timeline compaction (F5 companion, FR17: "compressed historical
 * context while preserving continuity"). A long-running task accretes routine
 * operator/agent narration; the canonical file — the thing agents re-anchor on —
 * grows noisier and slower to read over time (a named PRD adoption risk).
 *
 * This collapses OLD, routine `comment` events into a single compaction marker
 * while preserving EVERY typed governance event (transition, packet, blocked,
 * quality, completion, github, assign, agent) and the most-recent window intact.
 * Pure + exported so its behavior is fully unit-tested; the canonical file is
 * only rewritten when this actually reduced the event count.
 */

/** A compaction marker is a plain comment whose title is exactly this. */
export const COMPACTION_TITLE = "Compacted";

export interface CompactionOptions {
  /** Compact only when the timeline has more than this many events. */
  threshold: number;
  /** Always keep this many newest events verbatim. */
  keepRecent: number;
}

export const DEFAULT_COMPACTION: CompactionOptions = {
  threshold: 60,
  keepRecent: 24,
};

/**
 * Returns a compacted copy of a newest-first timeline, or the SAME array
 * reference when nothing changed (so callers can skip the file write). Never
 * drops a typed event; collapses each run of consecutive routine comments in
 * the older region into one marker recording how many it replaced.
 */
export function compactTimelineEvents(
  events: TaskFileEvent[],
  options: CompactionOptions = DEFAULT_COMPACTION,
): TaskFileEvent[] {
  if (events.length <= options.threshold) return events;

  const recent = events.slice(0, options.keepRecent);
  const older = events.slice(options.keepRecent);

  const compactedOlder: TaskFileEvent[] = [];
  let run: TaskFileEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // A lone routine comment isn't worth a marker — keep it as-is.
      compactedOlder.push(run[0]!);
    } else {
      // Anchor the marker at the newest comment's time so ordering is stable.
      compactedOlder.push({
        occurredAt: run[0]!.occurredAt,
        type: "comment",
        actor: { kind: "operator" },
        title: COMPACTION_TITLE,
        text: `_${run.length} earlier routine comments compacted to keep the task readable._`,
        toAgent: false,
        evidence: null,
      });
    }
    run = [];
  };

  for (const e of older) {
    const isRoutineComment =
      e.type === "comment" &&
      // never fold an existing marker into another marker (idempotent)
      e.title !== COMPACTION_TITLE &&
      // a to-agent prompt is a governance hand-off, not routine chatter
      !e.toAgent &&
      // NEVER fold an AGENT-authored reply (adversarial-review #13): a
      // specialist's reply is the rework evidence hasReworkSinceLastRejection
      // scans for, so compacting it away could re-strand a task at "failing".
      e.actor.kind !== "agent";
    if (isRoutineComment) {
      run.push(e);
    } else {
      flush();
      compactedOlder.push(e);
    }
  }
  flush();

  const result = [...recent, ...compactedOlder];
  return result.length < events.length ? result : events;
}
