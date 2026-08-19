import type { PrState } from "~/schemas/task-file.schema";
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
    /** F19-32: the canonical `PrState`, shared with the projection row and with
     *  `prStatePill` (ruling 12). The hand-copied review|merged|closed union
     *  dropped `accepted` (merge pending, R16-6/ruling 40) at the type level, so
     *  the pill's amber branch could not be reached from this surface however
     *  the row was rendered. One vocabulary, one union. */
    state: PrState;
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
  /** D4: 'degraded' when this task's runtime continuity was lost — the same
   *  projected state the board card and the Continuity Recovery panel show. */
  continuity: "degraded" | null;
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
  // F19-32 / ruling 40 (R16-6): "accepted" means a human (or a direct-grant
  // operator) accepted the completion and the REAL merge is still outstanding.
  // It read "open for review on GitHub" here — the one sentence that hides the
  // second meaning of Done on the surface the ruling names. The conflict check
  // above stays first: a conflicting accepted PR is stuck for a reason a rebase
  // fixes, which is the more actionable half of the same fact.
  if (pr.state === "accepted") {
    return `PR #${pr.number} is accepted — the merge is still pending; a human completes it on the task.`;
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
  if (t.waiting === "human") {
    return "Waiting at the review boundary — needs a human decision.";
  }
  // F19-31: `none` used to fall through to the agent sentence, so the legal
  // `review + none` combination (nothing is waiting on either side) claimed a
  // live agent run on this surface while the board's WaitTag rendered NOTHING
  // for the same stored value. One value, two claims. It gets its own honest
  // line: the row is at the boundary with no run and no decision behind it.
  if (t.waiting === "none") {
    return "At the review boundary — no agent is running and no decision is pending.";
  }
  return "Agent working — the packet arrives at the boundary.";
}
