import type { ValidationValue } from "~/ui/pill";
import { plainText } from "~/features/notifications/notification-meta";

export interface ReviewRowView {
  key: string;
  title: string;
  waiting: "human" | "agent" | "none";
  packet: { kind: string; title: string } | null;
  latestEventText: string | null;
  pr: {
    number: number;
    state: "review" | "merged" | "closed";
    /** P14-LV-07: GitHub's live mergeability for an open PR; absent = never read. */
    mergeable?: "clean" | "conflicting" | "unknown" | null;
    /** R17-1 (F17-L12): the PR head is ahead of the reviewed revision by
     *  `aheadBy` commits; the subline warns they would merge unreviewed. */
    revisionDrift?: { aheadBy: number } | null;
  } | null;
  validation: ValidationValue;
  /** F10-11: why the current revision is NOT acceptance-ready (null when it is).
   *  Only ever populated on "Still in review" rows — the acceptance panel holds
   *  only rows with a null block reason. */
  blockReason: string | null;
  /** Gap-10: ISO of the newest timeline event (`occurred_at`); null when the
   *  timeline is empty. */
  lastActivityAt: string | null;
  /** Gap-10: nothing recorded past this row's threshold and no run in flight. */
  quiet: boolean;
}

/**
 * P14-LV-05 — the live-PR-state subline.
 *
 * A row whose PR was closed on GitHub and then REOPENED kept reading
 * "Divergence: PR #103 was closed on GitHub without merging…", because the
 * subline fell through to the newest timeline event — a note that was true when
 * it was written and became a lie the moment the PR state changed. The queue's
 * whole job is to describe the boundary as it stands NOW, so a row that carries
 * a PR states the PR's LIVE facts and never a historical note about it. Rows
 * with no PR keep the timeline fallback (there is nothing live to say).
 */
function prStateSub(pr: NonNullable<ReviewRowView["pr"]>): string {
  if (pr.state === "merged") {
    return `PR #${pr.number} is merged on GitHub — accept the completion to close the task.`;
  }
  if (pr.state === "closed") {
    return `PR #${pr.number} was closed on GitHub without merging — rework and reopen it, or archive the task.`;
  }
  if (pr.mergeable === "conflicting") {
    return `PR #${pr.number} conflicts with the base branch — GitHub can't merge it until the branch is rebased.`;
  }
  // R17-1 (F17-L12): commits landed on the PR head after the review — accepting
  // still merges them, but they ship unreviewed, so the boundary says so.
  if (pr.revisionDrift && pr.revisionDrift.aheadBy > 0) {
    const n = pr.revisionDrift.aheadBy;
    return `PR #${pr.number} is open — ${n} commit${n === 1 ? "" : "s"} added since review would merge unreviewed.`;
  }
  return `PR #${pr.number} is open for review on GitHub.`;
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 14, one stripper app-wide). */
export function reviewRowSub(t: ReviewRowView): string {
  // R16-3 (owner ruling 2026-08-04): a CLOSED PR is a TERMINAL GitHub fact and
  // outranks every process gate. The row rendered `blockReason` first, so a
  // delivered-but-unreviewed task whose PR had been closed on GitHub read
  // "…no approving verdict yet — run a review for a verdict, or an admin can
  // force-accept": the process gate spoken over the terminal fact, offering the
  // one override the task page withholds once the PR is gone
  // (`acceptanceTerminallyBlocked`). Running a review is not the path here;
  // rework/reopen or archive is, which is what `prStateSub` says.
  //
  // Only `closed` jumps the gate. A MERGED PR is not a refusal — its "accept
  // the completion" line would become the lie if a process gate is genuinely
  // holding that acceptance, so a merged row keeps naming the gate, exactly as
  // the task page does.
  if (t.pr?.state === "closed") return prStateSub(t.pr);
  // F10-11: a not-yet-acceptable task states WHY (failing / awaiting a reviewer /
  // no delivered revision) instead of a generic "needs a human decision".
  if (t.blockReason) return t.blockReason;
  if (t.packet) return t.packet.kind + " — " + t.packet.title;
  // P14-LV-05: live PR state outranks the newest timeline note.
  if (t.pr) return prStateSub(t.pr);
  if (t.latestEventText) return plainText(t.latestEventText);
  // No packet, no PR, no timeline event yet. Don't claim "agent working" on a
  // task that is waiting on a HUMAN (R8-3, same fix as the wait-tag) — a human-
  // waiting row needs a person, not an agent.
  return t.waiting === "human"
    ? "Waiting at the review boundary — needs a human decision."
    : "Agent working — the packet arrives at the boundary.";
}
