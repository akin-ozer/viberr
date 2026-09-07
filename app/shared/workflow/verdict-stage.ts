import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import { requiredReviewers, type Engagement } from "~/schemas/task-file.schema";
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
 *  - When any required reviewer is eligible at the task's CURRENT stage, a
 *    verdict can be given here: null.
 *  - Otherwise the nearest EARLIER stage where one is eligible.
 *  - When no required reviewer is deployed (nothing declares eligibility), the
 *    structural acceptance-boundary stage (`resolveStageRoles(...).reviewId`)
 *    when the task stands past it; null otherwise.
 *
 * Pure: the caller supplies the deployed profiles' declarations.
 */
export function verdictStageFor(
  board: {
    stages: readonly Pick<StageDef, "id">[];
    workflow: readonly Pick<WorkflowBoundary, "from" | "to">[];
  },
  fm: { stage: string; engagements: Engagement[] },
  deployed: readonly { id: string; stages: readonly string[]; spanAll: boolean }[],
): string | null {
  const stages = board.stages;
  const currentIndex = stages.findIndex((s) => s.id === fm.stage);
  if (currentIndex < 0) return null;
  const roles = resolveStageRoles(stages, board.workflow);
  if (fm.stage === roles.terminalId) return null;
  const reviewerSpecs = requiredReviewers(fm).flatMap((e) => {
    const view = deployed.find((d) => d.id === e.profileId);
    return view ? [{ stages: view.stages, spanAll: view.spanAll }] : [];
  });
  if (reviewerSpecs.length === 0) {
    const reviewIndex =
      roles.reviewId === null ? -1 : stages.findIndex((s) => s.id === roles.reviewId);
    return reviewIndex >= 0 && currentIndex > reviewIndex ? roles.reviewId : null;
  }
  const eligibleAt = (stageId: string): boolean =>
    reviewerSpecs.some((spec) => stageEligible(spec, stageId, stages, board.workflow));
  if (eligibleAt(fm.stage)) return null;
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const id = stages[i]!.id;
    if (eligibleAt(id)) return id;
  }
  return null;
}
