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
  } | null;
  validation: ValidationValue;
  /** F10-11: why the current revision is NOT acceptance-ready (null when it is).
   *  Only ever populated on "Still in review" rows — the acceptance panel holds
   *  only rows with a null block reason. */
  blockReason: string | null;
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
  return `PR #${pr.number} is open for review on GitHub.`;
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 14, one stripper app-wide). */
export function reviewRowSub(t: ReviewRowView): string {
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
