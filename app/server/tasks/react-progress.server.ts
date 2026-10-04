import {
  activeWorkRevision,
  type GateRun,
  type PrRef,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import type { ProjectGate } from "~/schemas/project-file.schema";
import { projectGatesView } from "~/shared/project-gates";
import type { OperatorPacketOptionInput } from "./operator-packets.server";

/**
 * Ruling 489 (pass 40, F40-68): where a react chain's work stands, read from
 * what the server wrote rather than from what an agent said.
 *
 * Two readers. The react loop asks whether the task's head MOVED during the
 * hop that just finished: a reply that committed a new head (or whose head was
 * delivered in the meantime) is progress, a boundary like an approve (ruling
 * 362), so the depth count starts over. And when the depth cap still opens the
 * stuck-loop packet, the packet says where the work stands: the last report,
 * the head and whether it is delivered, the last gate result, and, when a
 * committed head is not delivered, the one step left.
 */

const short = (sha: string): string => sha.slice(0, 7);

/** How the head moved during a hop. */
export interface HeadMove {
  /** The full sha of the head that moved. */
  sha: string;
  /** `committed`: a delivering run's reconcile minted a new revision.
   *  `delivered`: a delivery push published the revision's head. */
  how: "committed" | "delivered";
}

/**
 * Did the task's head move since `since` (the hop's start: the finished run's
 * row was created then)?
 *
 * The signal is the WORK REVISION, which only the server writes: the
 * workspace reconcile mints a new one from the checkout's full head and tree
 * sha when a delivering run leaves a new tree behind (`nextWorkRevision`), and
 * a delivery push stamps `pushedAt` on the revision whose head origin now
 * carries. A head that reaches the revision only through Viberr's own base
 * refreshes mints nothing (ruling 439), and neither counts here. Two kinds are
 * not the chain's progress: a `verified` revision is the base branch a
 * reviewer judged (it arrives with an approve, which ruling 362 already
 * counts), and an `external` one is a head somebody else pushed onto the pull
 * request.
 */
export function headMovedSince(
  workRevision: WorkRevision | null | undefined,
  since: string | null | undefined,
): HeadMove | null {
  const rev = activeWorkRevision(workRevision);
  const from = since ? Date.parse(since) : Number.NaN;
  if (!rev || Number.isNaN(from)) return null;
  const kind = rev.kind ?? "delivered";
  if (kind === "delivered" && Date.parse(rev.createdAt) >= from) {
    return { sha: rev.headSha, how: "committed" };
  }
  if (kind !== "verified" && rev.pushedAt && Date.parse(rev.pushedAt) >= from) {
    return { sha: rev.headSha, how: "delivered" };
  }
  return null;
}

/**
 * Ruling 613: did this hop deliver the task's files?
 *
 * A task whose deliverable is files is delivered by moving `deliveredAt`
 * (rulings 388 and 587), never by a work revision, so `headMovedSince` saw no
 * hop of it make progress. Live on AWSC-71 (2026-10-01) the Estimate Judge
 * asked for two small fixes, the Architect saved them and the Calculator
 * Builder delivered the files again, and the fourth hop opened "Work stalled:
 * pick a recovery path" over a rework that had just finished; round 5's
 * AWSC-65 stalled the same way. A delivery stamped during the hop is that
 * board's head moving: the stamp, or null.
 */
export function filesDeliveredSince(
  deliveredAt: string | null | undefined,
  since: string | null | undefined,
): string | null {
  if (!deliveredAt || !since) return null;
  const at = Date.parse(deliveredAt);
  const from = Date.parse(since);
  if (Number.isNaN(at) || Number.isNaN(from)) return null;
  return at >= from ? deliveredAt : null;
}

/** The task's committed head and whether it has been delivered. */
export type TaskHeadState =
  /** No committed head on record (no revision, or only a verification of the
   *  base branch). */
  | { kind: "none" }
  /** The head left the workspace: a delivery pushed it, or the live pull
   *  request carries it. `prNumber` is that pull request, when one is live. */
  | { kind: "delivered"; sha: string; prNumber: number | null }
  /** The head is committed in the workspace and nothing delivered it.
   *  `prNumber`/`prHeadSha` name the live pull request and the head it still
   *  carries, when there is one. */
  | { kind: "undelivered"; sha: string; prNumber: number | null; prHeadSha: string | null };

/** Read the task's head state from its recorded revision and pull request. */
export function taskHeadState(fm: {
  workRevision: WorkRevision | null;
  pr: PrRef | null;
}): TaskHeadState {
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev || rev.kind === "verified") return { kind: "none" };
  const livePr = fm.pr && fm.pr.state !== "closed" && fm.pr.state !== "merged" ? fm.pr : null;
  const prNumber = livePr?.number ?? null;
  // An `external` revision IS the pull request's head (ruling 179): somebody
  // pushed it there, so it is not waiting on a delivery.
  if (rev.kind === "external" || rev.pushedAt || (livePr && livePr.headSha === rev.headSha)) {
    return { kind: "delivered", sha: rev.headSha, prNumber };
  }
  return {
    kind: "undelivered",
    sha: rev.headSha,
    prNumber,
    prHeadSha: livePr?.headSha ?? null,
  };
}

/** The longest report excerpt the capped packet quotes. */
export const STUCK_REPORT_EXCERPT_MAX = 280;

/**
 * The first paragraph of an agent's report, heading marks and bookkeeping
 * lines dropped, whitespace collapsed and capped at
 * {@link STUCK_REPORT_EXCERPT_MAX} with an ellipsis. Null for an empty report.
 */
export function reportExcerpt(text: string | null): string | null {
  if (!text) return null;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((line) => !line.startsWith("cc @"))
        .map((line) => line.replace(/^\s*#+\s*/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p !== "");
  const first = paragraphs[0];
  if (!first) return null;
  return first.length > STUCK_REPORT_EXCERPT_MAX
    ? `${first.slice(0, STUCK_REPORT_EXCERPT_MAX - 1).trimEnd()}…`
    : first;
}

/** The sentence naming the head and its delivery state. */
export function headStateSentence(state: TaskHeadState): string {
  switch (state.kind) {
    case "none":
      return "No committed head is on record for this task.";
    case "delivered":
      return state.prNumber !== null
        ? `The task's head is \`${short(state.sha)}\`, delivered: PR #${state.prNumber} carries it.`
        : `The task's head is \`${short(state.sha)}\`, delivered: a delivery pushed it to origin.`;
    case "undelivered":
      return state.prNumber !== null
        ? `The task's head is \`${short(state.sha)}\`, committed and NOT delivered: PR #${state.prNumber} still carries ${
            state.prHeadSha ? `\`${short(state.prHeadSha)}\`` : "an older head"
          }.`
        : `The task's head is \`${short(state.sha)}\`, committed and NOT delivered: no pull request carries it yet.`;
  }
}

/** A committed head nothing delivered, and the live pull request, if any. */
export interface UndeliveredHead {
  sha: string;
  prNumber: number | null;
}

/** What the depth-capped packet says about where the work stands. */
export interface StuckLoopStandings {
  /** The sentences for the packet body: the report, the head, the gates. */
  text: string;
  /** Set when a committed head is not delivered: the option to deliver it. */
  deliver: UndeliveredHead | null;
}

/**
 * Ruling 489: the body of a depth-capped "Work stalled" packet, from the task
 * as it stands after the reply. `replyText` is the reply that hit the cap;
 * `agentHandle` names who wrote it.
 */
export function stuckLoopStandings(input: {
  fm: {
    workRevision: WorkRevision | null;
    pr: PrRef | null;
    gateRun?: GateRun | undefined;
    deliveredAt?: string | null;
  };
  gates: readonly ProjectGate[];
  replyText: string | null;
  agentHandle: string;
}): StuckLoopStandings {
  const parts: string[] = [];
  const excerpt = reportExcerpt(input.replyText);
  if (excerpt) parts.push(`The last report, from @${input.agentHandle}: “${excerpt}”`);
  const head = taskHeadState(input.fm);
  // Ruling 613: a task delivered as files has no head to name; its delivery
  // is the stamp a review binds to (`files:<deliveredAt>`, ruling 388).
  parts.push(
    head.kind === "none" && input.fm.deliveredAt
      ? `The task's files were last delivered at ${input.fm.deliveredAt}.`
      : headStateSentence(head),
  );
  // Ruling 482: the last gate result on record. The view binds it to the head
  // under review, so a run on an older revision reads as "not run yet" here.
  const gates = input.fm.gateRun ? projectGatesView(input.gates, input.fm) : null;
  if (gates) parts.push(`${gates.line}.`);
  return {
    text: parts.join(" "),
    deliver:
      head.kind === "undelivered" ? { sha: head.sha, prNumber: head.prNumber } : null,
  };
}

/** The recommended option of a depth-capped packet over an undelivered head. */
export function deliverHeadOption(deliver: UndeliveredHead): OperatorPacketOptionInput {
  const sha = short(deliver.sha);
  return {
    kind: "deliver_for_review",
    title: `Deliver ${sha} for review`,
    detail:
      deliver.prNumber !== null
        ? `Push ${sha} to PR #${deliver.prNumber}, so the reviewers judge the new revision. Viberr performs the delivery when you confirm.`
        : `Push the branch and open the review pull request for ${sha}. Viberr performs the delivery when you confirm.`,
    recommended: true,
  };
}
