/**
 * Ruling 136(a) (pass 34, F34-10): what the SERVER did after a human resolved
 * a packet option whose ceremony performs work of its own. It rides the
 * `packet-resolved` hand-off in its OWN field, rendered to the operator as
 * Viberr's sentence and never inside the human's quoted note, so the
 * operator's next turn states what happened instead of re-deriving it, and
 * never reads a server-composed fact as the person's own words (F34-12's
 * failure, inside its own remedy).
 *
 * A pure leaf: the task writers build it, the operator run renders it, tests
 * assert on the one sentence.
 */

import { DIVERGED_BRANCH_REMEDY } from "~/schemas/task-file.schema";

export const COLLISION_OUTCOMES = [
  /** The stale remote branch was cleared and the work re-delivered. */
  "cleared_and_delivered",
  /** Cleared, but the re-delivery did not complete; the block stays. */
  "cleared_delivery_failed",
  /** No collision: the PR is the task's own; the revision was pushed to it. */
  "own_pr_pushed",
  /** No collision: the task's own PR already carried the revision. */
  "own_pr_current",
  /** No collision, but the delivery that would push it did not complete. */
  "own_pr_delivery_failed",
  /** No collision, but the remote copy diverged; a person resolves history. */
  "own_pr_diverged",
  /** The delete refused for another reason; nothing was re-delivered. */
  "refused",
] as const;
export type CollisionOutcome = (typeof COLLISION_OUTCOMES)[number];

export interface CollisionServerOutcome {
  kind: "resolve_remote_collision";
  outcome: CollisionOutcome;
  /** The review PR involved, when one is known. */
  prNumber?: number;
  /** The refusal or failure text, when the outcome carries one. */
  reason?: string;
}

/** The option a human chose on a decision packet, as handed to the operator. */
export interface ResolvedPacketOption {
  kind: string;
  title: string;
  /** The person's own words (a custom directive or the decision note). */
  note?: string;
  /** Viberr's own record of what the option's ceremony then did. */
  serverOutcome?: CollisionServerOutcome;
}

/** The one sentence the operator reads for a server outcome. */
export function serverOutcomeSentence(o: CollisionServerOutcome): string {
  const pr = o.prNumber !== undefined ? `PR #${o.prNumber}` : "the review PR";
  const reason = o.reason ?? "no reason recorded";
  switch (o.outcome) {
    case "cleared_and_delivered":
      return `the stale remote branch was cleared and the work was re-delivered to ${pr}.`;
    case "cleared_delivery_failed":
      return `the stale remote branch was cleared, but the re-delivery did not complete (${reason}); the block stays.`;
    case "own_pr_pushed":
      return `there was no collision to clear (${pr} is this task's own review PR); the delivered revision was pushed to it and the block is lifted.`;
    case "own_pr_current":
      return `there was no collision to clear (${pr} is this task's own review PR); it already carried the delivered revision and the block is lifted.`;
    case "own_pr_delivery_failed":
      return `there was no collision to clear (${pr} is this task's own review PR), but the delivery that would push the revision to it did not complete (${reason}); the block stays.`;
    case "own_pr_diverged":
      return `there was no collision to clear (${pr} is this task's own review PR), but its remote copy holds commits this workspace does not. ${DIVERGED_BRANCH_REMEDY} The block stays until that happens.`;
    case "refused":
      return `the collision was not cleared (${reason}); nothing was re-delivered and the block stays.`;
  }
}
