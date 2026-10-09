import {
  describeRevisionDrift,
  type RevisionDrift,
} from "~/shared/revision-drift";
import type {
  PrState,
  TaskPriority,
  UnpushedRevision,
  Waiting,
} from "~/schemas/task-file.schema";
import type { ValidationValue } from "~/ui/pill";
import { plainText } from "~/features/notifications/notification-meta";

import type { PrOverlap } from "~/shared/pr-overlaps";

export interface ReviewRowView {
  key: string;
  title: string;
  /** U35-5: the display name of the stage the task sits at; the subline names
   *  it for a row that is not at the review boundary. */
  stageName: string;
  /** U35-5: at the project's resolved review stage (the acceptance boundary).
   *  False for review work listed from an earlier stage: an open review PR, or
   *  a required reviewer's verdict outstanding on the current revision. */
  atAcceptanceBoundary: boolean;
  /** F26-14: the same lightweight triage metadata the board card shows, carried
   *  to the acceptance boundary (where a forgotten high/overdue task costs most).
   *  Rendered via the shared `task-meta.tsx` pills. */
  priority: TaskPriority;
  labels: string[];
  dueDate: string | null;
  /** The same lesson `PrState` below records: one vocabulary, one union. A
   *  hand-copied triple here could not express ruling 45's derived
   *  `schedule`, so a review row would have had to invent its own answer for a
   *  state the projection already decided. */
  waiting: Waiting;
  /** Ruling 45: when `waiting` is `schedule`, the instant the task picks
   *  itself back up. */
  resumesAt?: string | null;
  packet: { kind: string; title: string } | null;
  /** Ruling 63: the packet is decided and waits for the edited goal. */
  goalEditPending: boolean;
  latestEventText: string | null;
  pr: {
    number: number;
    /** F19-32: the canonical `PrState`, shared with the projection row and with
     *  `prStatePill` (ruling 237). The hand-copied review|merged|closed union
     *  dropped `accepted` (merge pending, R16-6/ruling 244) at the type level, so
     *  the pill's amber branch could not be reached from this surface however
     *  the row was rendered. One vocabulary, one union. */
    state: PrState;
    /** P14-LV-07: GitHub's live mergeability for an open PR; absent = never read. */
    mergeable?: "clean" | "conflicting" | "unknown" | null;
    /** Ruling 239: the whole drift record, so the
     *  subline prints `describeRevisionDrift`'s sentence verbatim — authored
     *  commits merge unreviewed; a base refresh is named as a base refresh. */
    revisionDrift?: RevisionDrift | null;
    /** Ruling 243: the CURRENT unpushed record, filtered by the row builder. */
    headSha?: string;
    unpushedRevision?: UnpushedRevision;
    /** Ruling 242: the other open PRs whose diffs collide with this one, as the
     *  projection computed them. Absent when no file list has been read; empty
     *  when nothing overlaps. */
    overlaps?: PrOverlap[];
  } | null;
  validation: ValidationValue;
  /** F10-11: why the current revision is NOT acceptance-ready (null when it is).
   *  A row the acceptance panel lists with no packet open always has none; a
   *  packet's row and a "Still in review" row may. */
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
    return `PR #${pr.number} is merged on GitHub. Accept the completion to close the task.`;
  }
  if (pr.state === "closed") {
    return `PR #${pr.number} was closed on GitHub without merging. Rework and reopen it, or archive the task.`;
  }
  // Ruling 243 (pass 34, F34-11): the delivered revision is not on the PR.
  // Ranked ABOVE the conflict: `mergeable` describes the head GitHub has, and
  // the fact a person can act on is that the reviewed revision never reached it.
  if (pr.unpushedRevision || pr.mergeable === "conflicting") {
    const acted = actionablePrSub(pr);
    if (acted) return acted;
  }
  // F19-32 / ruling 244 (R16-6): "accepted" means a human (or a direct-grant
  // operator) accepted the completion and the REAL merge is still outstanding.
  // It read "open for review on GitHub" here — the one sentence that hides the
  // second meaning of Done on the surface the ruling names. The conflict check
  // above stays first: a conflicting accepted PR is stuck for a reason a rebase
  // fixes, which is the more actionable half of the same fact.
  if (pr.state === "accepted") {
    return `PR #${pr.number} is accepted. The merge is still pending; a human completes it on the task.`;
  }
  return actionablePrSub(pr) ?? `PR #${pr.number} is open for review on GitHub.`;
}

/**
 * The live PR facts a person can ACT on, in the order `prStateSub` ranks them,
 * or null when the pull request carries none of them and is simply open.
 *
 * Ruling 243 names "the review row subline" among the surfaces that must
 * consult `unpushedRevisionBlockedReason`; ruling 239 calls the drift line the
 * one canonical sentence; P14-LV-07 puts the conflict here. None of them is
 * decoration, and none of them belongs to the acceptance boundary alone — the
 * queue is the triage surface, so a row listed from an EARLIER stage carries
 * them too (`reviewInProgressSub`). Split out so the two callers cannot drift
 * into two vocabularies for one fact.
 */
function actionablePrSub(pr: NonNullable<ReviewRowView["pr"]>): string | null {
  if (pr.unpushedRevision) {
    const rev = pr.unpushedRevision.revisionSha.slice(0, 7);
    return pr.unpushedRevision.relation === "diverged"
      ? `PR #${pr.number} does not carry the delivered revision ${rev}, and its head holds commits the workspace does not. Resolve the history, then deliver the branch to push it.`
      : `PR #${pr.number} does not carry the delivered revision ${rev}. Deliver the branch to push it.`;
  }
  if (pr.mergeable === "conflicting") {
    // Ruling 230: merged IN, not rebased. Viberr's own remedy is a merge
    // (`update_branch_from_base`), and a rebase rewrites commits the pull
    // request already published — which is how SHOP-11's branch diverged from
    // its own PR #15.
    return `PR #${pr.number} conflicts with the base branch. GitHub can't merge it until the base is merged INTO the branch (not rebased).`;
  }
  // Ruling 239 (F17-L12, F34-14): the head moved after the review — the ONE
  // canonical sentence says what moved, and only
  // authored commits are called unreviewed.
  const drift = describeRevisionDrift(pr.revisionDrift);
  if (drift.kind !== "none") return `PR #${pr.number} is open. ${drift.sentence}.`;
  return null;
}

/**
 * U35-5 (pass 35): the subline for review work that is NOT at the acceptance
 * boundary. Such a row is listed because its PR is open for review or a
 * required reviewer has not approved the current revision, so the sentence
 * says where the task is, which PR, and what the verdict state is:
 * "Review in progress at Validation · PR #8 · awaiting verdict"
 * (`awaiting verdict` for `changed`, `changes requested` for `failing`; an
 * approved revision with the PR still open reads "approved", and a row with no
 * verdict subject carries no verdict segment at all rather than a word for a
 * state it does not have).
 *
 * A LIVE PR fact outranks all of that: an unpushed delivered revision, a
 * conflicting pull request or a drifted head is what the person is being asked
 * to act on (rulings 243 / 239, P14-LV-07), and the stage name still says where
 * the task stands. Nothing else on the row renders those facts — `RQRow` draws
 * no mergeable pill — so ranking them below this sentence hid them on the one
 * surface built for triage.
 */
function reviewInProgressSub(t: ReviewRowView): string {
  const where = `Review in progress at ${t.stageName}`;
  const acted = t.pr ? actionablePrSub(t.pr) : null;
  if (acted) return `${where} · ${acted}`;
  const parts = [where];
  if (t.pr) parts.push(`PR #${t.pr.number}`);
  if (t.validation === "failing") parts.push("changes requested");
  else if (t.validation === "changed") parts.push("awaiting verdict");
  else if (t.validation === "healthy") parts.push("approved");
  return parts.join(" · ");
}

/** Ruling 63: a decided edit_goal packet is not a decision still owed — the
 *  row says what is owed instead of re-offering the packet. */
const GOAL_EDIT_PENDING_SUB =
  "Goal edit pending: save the edited goal to clear the decision packet.";

/**
 * Ruling 304: an "Open decisions" row names the decision it opens: the
 * packet's kind and its question, wherever the task stands. Its stage, PR and
 * verdict facts are the dialog's to show beside the options.
 */
export function decisionRowSub(t: ReviewRowView): string {
  if (t.goalEditPending) return GOAL_EDIT_PENDING_SUB;
  return t.packet ? t.packet.kind + ": " + t.packet.title : reviewRowSub(t);
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 297, one stripper app-wide). */
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
  // U35-5: a row listed from BEFORE the boundary is review work in progress,
  // not a task awaiting acceptance. Every sentence below this line describes
  // the boundary (the acceptance gate, the packet the operator opened there,
  // the live PR facts of a delivered task), so an off-boundary row says where
  // it actually is instead. Only the closed-PR terminal fact above outranks it.
  if (!t.atAcceptanceBoundary) return reviewInProgressSub(t);
  // F10-11: a not-yet-acceptable task states WHY (failing / awaiting a reviewer /
  // no delivered revision) instead of a generic "needs a human decision".
  if (t.blockReason) return t.blockReason;
  if (t.goalEditPending) return GOAL_EDIT_PENDING_SUB;
  if (t.packet) return t.packet.kind + ": " + t.packet.title;
  // P14-LV-05: live PR state outranks the newest timeline note.
  if (t.pr) return prStateSub(t.pr);
  if (t.latestEventText) return plainText(t.latestEventText);
  // No packet, no PR, no timeline event yet. Don't claim "agent working" on a
  // task that is waiting on a HUMAN (R8-3, same fix as the wait-tag) — a human-
  // waiting row needs a person, not an agent.
  if (t.waiting === "human") {
    return "Waiting at the review boundary. Needs a human decision.";
  }
  // F19-31: `none` used to fall through to the agent sentence, so the legal
  // `review + none` combination (nothing is waiting on either side) claimed a
  // live agent run on this surface while the board card claims no wait at all
  // for the same stored value (its status seat, `cardStatus`, shows the
  // readiness word). One value, two claims. It gets its own honest line: the
  // row is at the boundary with no run and no decision behind it.
  if (t.waiting === "none") {
    return "At the review boundary: no agent is running and no decision is pending.";
  }
  // Ruling 45 (F37-45), and F19-31's lesson a second time: a value that falls
  // through to the sentence below claims a live agent run that does not exist.
  // A clock-resting row has neither a run nor a decision behind it; it has a
  // time.
  if (t.waiting === "schedule") {
    return "At the review boundary: nothing is running, and a scheduled run picks this task back up.";
  }
  return "Agent working. The packet arrives at the boundary.";
}
