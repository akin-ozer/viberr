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
 *  - AGENT replies now DO fold, except the newest one still in the older
 *    region. Excluding agents outright meant an agent-heavy timeline — the
 *    flood case anti-noise exists for — never compacted at all. Keeping the
 *    newest older reply preserves a specialist's most recent rework evidence,
 *    while the repetitive tail behind it collapses. (The rule used to cite
 *    `hasReworkSinceLastRejection`; no such function exists any more. What
 *    reads a previous reply today is `latestAgentReplyText`, and it looks for
 *    the reply before the CURRENT run, which lives in the untouched recent
 *    window.)
 *
 * Ruling 206: the folding is no longer ADJACENCY-based. It used to collapse
 * each run of CONSECUTIVE routine comments, which on viberr's own event stream
 * is almost never longer than one: a typed `agent`, `quality`, `github` or
 * `transition` event lands between every pair of agent replies, and an operator
 * prompt is excluded as a `toAgent` hand-off. Measured on the live board, the
 * longest consecutive routine-comment run on the six tasks past their threshold
 * was **two**, and not one compaction marker existed anywhere — while SHOP-7
 * carried 28 foldable comments worth 29% of its timeline's bytes and SHOP-6 18
 * worth 34%. A guardrail that is on, configured, and counted by Insights had
 * never removed a single event. Routine comments now fold wherever they are in
 * the older region, and the single marker takes the OLDEST one's slot so the
 * newest-first ordering is unchanged.
 */

/** A compaction marker is a plain comment whose title is exactly this. */
export const COMPACTION_TITLE = "Compacted";

export interface CompactionOptions {
  /** Compact only when the timeline has more than this many events. */
  threshold: number;
  /** Always keep this many newest events verbatim. */
  keepRecent: number;
}

/** The fallback when a project carries no `compression-threshold` guardrail
 *  row. V11-6 (pass 32): aligned with the template guardrail's own default
 *  (`app/shared/workflow/templates.ts`, 40 events) — it was 60, so a project
 *  whose row was hand-deleted compacted later than one that kept the default. */
export const DEFAULT_COMPACTION: CompactionOptions = {
  threshold: 40,
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

  const marker = (anchor: TaskFileEvent, count: number): TaskFileEvent => ({
    occurredAt: anchor.occurredAt,
    type: "comment",
    actor: { kind: "operator" },
    title: COMPACTION_TITLE,
    text: `_${count} earlier routine comments compacted to keep the task readable — human comments are never compacted._`,
    toAgent: false,
    evidence: null,
  });
  const isRoutineComment = (e: TaskFileEvent): boolean =>
    e.type === "comment" &&
    // never fold an existing marker into another marker (idempotent)
    e.title !== COMPACTION_TITLE &&
    // a to-agent prompt is a governance hand-off, not routine chatter
    !e.toAgent &&
    // B-FD9: a person's prose is never deleted from canonical task.md.
    e.actor.kind !== "human" &&
    // Ruling 209: a comment carrying EVIDENCE is not prose — it is the pointer
    // to files the evidence-separation guardrail moved out of the timeline and
    // onto disk. Folding it keeps a count and drops the reference, orphaning
    // an attachment that is still there and still the proof behind a verdict.
    // Reachable on the live board: an Infrastructure Engineer's reply carrying
    // "1 attachment: …" rows is agent-authored, not `toAgent`, and matched
    // every other clause here.
    (e.evidence === null || e.evidence.length === 0);

  // `older` is newest-first, so the FIRST agent-authored routine comment in it
  // is the newest one still outside the recent window: kept verbatim.
  const routine = older.filter(isRoutineComment);
  const keptReply = routine.find((e) => e.actor.kind === "agent") ?? null;
  const folded = new Set(routine.filter((e) => e !== keptReply));
  // One event replaced by one marker is no saving.
  if (folded.size <= 1) return events;

  const oldestFolded = [...folded][folded.size - 1]!;
  const compactedOlder: TaskFileEvent[] = [];
  for (const e of older) {
    if (e === oldestFolded) {
      // The marker takes the oldest folded event's slot, so every surviving
      // event keeps its position and the timeline stays newest-first.
      compactedOlder.push(marker(oldestFolded, folded.size));
      continue;
    }
    if (folded.has(e)) continue;
    compactedOlder.push(e);
  }

  const result = [...recent, ...compactedOlder];
  return result.length < events.length ? result : events;
}
