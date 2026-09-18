import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import {
  currentVerdicts,
  requiredReviewers,
  type Engagement,
  type ReviewVerdict,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { stageEligible } from "./stage-eligibility";
import { resolveStageRoles } from "./stage-roles";

/**
 * Ruling 163 (pass 35, F35-13): the stage a task whose revision changed after
 * a verdict goes BACK to for its re-verdict, or null when no move is needed.
 *
 * "The review stage" is defined by where the task's required reviewers can
 * run, not by a structural role: reviewer eligibility is declared per profile
 * (`stageEligible`), and on the board this finding came from the two
 * verdict-capable profiles declared Validation and Review while the task
 * waited at Merge, one stage further along, where neither could be summoned.
 *
 * Only a task standing AT OR PAST the structural review stage
 * (`resolveStageRoles(...).reviewId`) is ever moved: that is the plan's scope
 * for all three doors (F35-13 (b) and (c)) and this function's own promise.
 * Without it the backward scan reached from a WORK stage — the seeded reviewer
 * declares `impl` and `review`, so a delivery at a Validation stage in between
 * walked the task back to Implementation, a stage that reviews nothing, past
 * `transitionStage` and its boundary checks.
 *
 *  - When the task stands before the review stage: null.
 *  - When a required reviewer that still OWES a verdict on the current
 *    revision is eligible at the task's CURRENT stage, that verdict can be
 *    given here: null.
 *
 *    Ruling 208: it used to ask whether ANY required reviewer was eligible
 *    here, which is a different question the moment a board declares required
 *    reviewers at two different stages. Live on SHOP-15: `code-reviewer`
 *    (stages build+review) had no approve on the delivered revision, and
 *    `integration-verifier` (stages review+verify) did — and because the
 *    verifier is eligible at Verify, this returned null, so `reworkStages` was
 *    empty and `transitionStage` refused "No allowed transition from Verify to
 *    Review". The task could not reach the only stage its missing reviewer can
 *    run at: not by the operator, not by a human. The exits were an admin
 *    force-accept past a gate that was legitimately unmet, or archive.
 *  - Otherwise the nearest EARLIER stage where one is eligible.
 *  - When no required reviewer is deployed (nothing declares eligibility), the
 *    structural acceptance-boundary stage when the task stands past it; null
 *    otherwise.
 *
 * Pure: the caller supplies the deployed profiles' declarations.
 */
export function verdictStageFor(
  board: {
    stages: readonly Pick<StageDef, "id">[];
    workflow: readonly Pick<WorkflowBoundary, "from" | "to">[];
  },
  fm: {
    stage: string;
    engagements: Engagement[];
    /** Ruling 208: which reviewers still owe a verdict is read from these. A
     *  caller that has no verdict history (none of the shipped ones) is treated
     *  as "everybody owes", which is the pre-208 behaviour. */
    verdicts?: ReviewVerdict[];
    workRevision?: WorkRevision | null;
  },
  deployed: readonly { id: string; stages: readonly string[]; spanAll: boolean }[],
): string | null {
  const stages = board.stages;
  const currentIndex = stages.findIndex((s) => s.id === fm.stage);
  if (currentIndex < 0) return null;
  const roles = resolveStageRoles(stages, board.workflow);
  if (fm.stage === roles.terminalId) return null;
  const reviewIndex =
    roles.reviewId === null ? -1 : stages.findIndex((s) => s.id === roles.reviewId);
  if (reviewIndex < 0) return null;
  // Ruling 208: only the reviewers whose approve on the CURRENT revision is
  // missing. The ones that already approved cannot be the reason a re-verdict
  // is needed, so their eligibility must not answer for the ones that have not.
  const approved = new Set(
    currentVerdicts({
      workRevision: fm.workRevision ?? null,
      verdicts: fm.verdicts ?? [],
    })
      .filter((v) => v.result === "approve")
      .map((v) => v.profileId),
  );
  const owing = requiredReviewers(fm).filter((e) => !approved.has(e.profileId));
  if (requiredReviewers(fm).length > 0 && owing.length === 0) return null;
  const reviewerSpecs = owing.flatMap((e) => {
    const view = deployed.find((d) => d.id === e.profileId);
    return view ? [{ stages: view.stages, spanAll: view.spanAll }] : [];
  });
  if (reviewerSpecs.length === 0) {
    return currentIndex > reviewIndex ? roles.reviewId : null;
  }
  const eligibleAt = (stageId: string): boolean =>
    reviewerSpecs.some((spec) => stageEligible(spec, stageId, stages, board.workflow));
  if (eligibleAt(fm.stage)) return null;
  // At or past the review stage only: before it the task is still doing the
  // work, and a delivery there moves nothing.
  if (currentIndex < reviewIndex) return null;
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const id = stages[i]!.id;
    if (eligibleAt(id)) return id;
  }
  return null;
}
