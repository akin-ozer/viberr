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
 *
 * B-FD9 — what compaction may and may not delete:
 *
 *  - A HUMAN's comment is NEVER folded. Compaction rewrites canonical `task.md`
 *    and the marker keeps only a count, so folding a person's prose deletes it
 *    from the source of truth permanently, to save noise the person did not
 *    make. Machine prose is regenerable and cheap to lose; a person's is not.
 *  - AGENT replies now DO fold, except the newest one in each run. Excluding
 *    agents outright meant an agent-heavy timeline — the flood case anti-noise
 *    exists for — never compacted at all. Keeping the newest reply of every run
 *    preserves what `hasReworkSinceLastRejection` scans for (a specialist's
 *    reply is the rework evidence; compacting it away could re-strand a task at
 *    "failing"), while the repetitive tail behind it collapses.
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
  const marker = (anchor: TaskFileEvent, count: number): TaskFileEvent => ({
    occurredAt: anchor.occurredAt,
    type: "comment",
    actor: { kind: "operator" },
    title: COMPACTION_TITLE,
    text: `_${count} earlier routine comments compacted to keep the task readable — human comments are never compacted._`,
    toAgent: false,
    evidence: null,
  });
  const flush = () => {
    if (run.length === 0) return;
    // The newest AGENT reply in this run stays verbatim (rework evidence);
    // everything else in the run folds. `run` is newest-first.
    const keepIdx = run.findIndex((e) => e.actor.kind === "agent");
    const folded = run.filter((_, i) => i !== keepIdx);
    if (folded.length <= 1) {
      // Nothing worth a marker — one event replaced by one marker is no saving.
      compactedOlder.push(...run);
    } else if (keepIdx === 0) {
      compactedOlder.push(run[0]!, marker(folded[0]!, folded.length));
    } else {
      // Anchor the marker at the newest comment's time so ordering is stable.
      compactedOlder.push(marker(run[0]!, folded.length));
      if (keepIdx > 0) compactedOlder.push(run[keepIdx]!);
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
      // B-FD9: a person's prose is never deleted from canonical task.md.
      e.actor.kind !== "human";
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
