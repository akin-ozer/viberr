import {
  VERDICT_REPORT_TITLE,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";

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
 *  - Ruling 257: neither is a CONTROLLER comment, for the same reason. It is a
 *    person publishing through an instrument, not a machine narrating; the
 *    actor kind records the instrument, and reading it as authorship deleted
 *    eleven of the owner's own comments from the live board.
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
    // Ruling 317: a verdict's justification is the one comment a STORED record
    // points at. `clipVerdictReason` keeps 2,000 characters of it and appends
    // "Its full report is on this task's timeline, whole" — so folding it turns
    // a live pointer into a dangling one and the reviewer's reasoning is
    // unrecoverable from canonical `task.md`.
    //
    // It is not covered by the evidence and attachment clauses below: those two
    // fields are moved OFF the reply exactly when it carries a verdict
    // (P13-D-26 puts them on the `quality` event), so the protection was
    // inverted — a deliverer's report was immune and this was first to go.
    // Measured on SHOP-76: three of four rounds of review reasoning gone, with
    // every `verdicts[].reason` still naming the timeline as the whole copy.
    e.title !== VERDICT_REPORT_TITLE &&
    // a to-agent prompt is a governance hand-off, not routine chatter
    !e.toAgent &&
    // B-FD9: a person's prose is never deleted from canonical task.md.
    e.actor.kind !== "human" &&
    // Ruling 257 (pass 37, F37-87): a CONTROLLER comment is a person's prose
    // too. Ruling 99(b) deliberately made the controller a different actor kind
    // — the person is the authority, the controller is the instrument — and
    // every other seam honours that: the audit row reads
    // "arda@viberr.dev · via controller", the comment is signed "Posted by the
    // controller for Arda", `auditActorDisplay` renders "Arda (via the
    // controller)". This was the one place that read `kind` as a proxy for
    // AUTHORSHIP, so the instrument disclosure turned the person's own
    // publication into machine noise and deleted it.
    //
    // Measured on the live board before the fix: 19 controller comments in the
    // audit log, 8 left in the files. Eleven of the owner's own published
    // comments gone from canonical `task.md`, from `task_events`, and from the
    // audit payload (`details_json` is `{"actorRef":"controller"}` and nothing
    // else) — including the two on SHOP-5 that explained a `pnpm-lock.yaml`
    // lease the board was still enforcing. And the line that replaced them says
    // "human comments are never compacted", so nobody who noticed the gap would
    // even look.
    e.actor.kind !== "controller" &&
    // Ruling 382 (F39-9): viberr TOLD somebody this comment was here. Live on
    // ax-clone AX-9 the folded one was the operator answering Arda by name
    // about a correction he had just filed — his question survived (human
    // prose), the answer did not, and canonical task.md, which the next agent
    // anchors on, read as a person correcting the record and nobody replying.
    // The notification row still quotes it and still offers a button to the
    // task, so following it lands on a page the text is no longer on: the same
    // dangling pointer ruling 317 closed for a verdict's justification.
    (e.notified === undefined || e.notified.length === 0) &&
    // Ruling 209: a comment carrying EVIDENCE is not prose — it is the pointer
    // to files the evidence-separation guardrail moved out of the timeline and
    // onto disk. Folding it keeps a count and drops the reference, orphaning
    // an attachment that is still there and still the proof behind a verdict.
    // Reachable on the live board: an Infrastructure Engineer's reply carrying
    // "1 attachment: …" rows is agent-authored, not `toAgent`, and matched
    // every other clause here.
    (e.evidence === null || e.evidence.length === 0) &&
    // Ruling 211(e): `attachments` is a SECOND, separate pointer list on the
    // same event (browser captures the run saved into `attachments/`), and 209
    // excluded only `evidence`. The files survive in the directory either way,
    // but folding deletes the chips AND the prose that says what each capture
    // shows, permanently, from canonical task.md.
    (e.attachments === undefined || e.attachments.length === 0);

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
