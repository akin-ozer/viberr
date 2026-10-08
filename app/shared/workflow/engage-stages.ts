import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import { reviewSubjectId, type WorkRevision } from "~/schemas/task-file.schema";
import { stageEligible } from "./stage-eligibility";
import { resolveStageRoles } from "./stage-roles";

/** One earlier stage a task may go back to, and the agents that can be given
 *  its delivery there. */
export interface EngageStage {
  stageId: string;
  agents: { id: string; name: string }[];
}

/** What the answer is read from: the task, as its file holds it. */
export interface EngageTaskState {
  stage: string;
  engagements: readonly { profileId: string; delivers: boolean }[];
  blockedBy: readonly unknown[];
  recommendations: readonly { kind: string }[];
  workRevision: WorkRevision | null;
  deliveredAt?: string | null;
}

/** A deployed agent, as `listDeployedSpecialists` describes it. */
export interface EngageCandidate {
  id: string;
  name: string;
  stages: readonly string[];
  spanAll: boolean;
  capabilities: { delivery: boolean; postsFiles: boolean };
}

/**
 * True when the task has a delivering engagement the operator can still run:
 * its profile is deployed on the board. An engagement whose profile was
 * removed names an agent `run_agent` refuses ("No deployed agent").
 */
export function hasDeliveringAgent(
  fm: Pick<EngageTaskState, "engagements">,
  deployed: readonly Pick<EngageCandidate, "id">[],
): boolean {
  return fm.engagements.some((e) => e.delivers && deployed.some((d) => d.id === e.profileId));
}

/**
 * Ruling 702: the EARLIER stages a task with no delivering agent may go back
 * to so that one can be engaged, or nothing when no such move is needed.
 *
 * Ruling 133 lets a task's engaged deliverer run at every stage and judges
 * every other profile by its declared stages. A task that reached a later
 * stage with no deliverer (its files were taken from another task, a person
 * moved it, only supporting agents ran on it) has nobody the first half
 * covers. Live on BLOG-8 the writer was declared for Brief and Writing and the
 * task stood at Cover: the hand-off was refused for the stage, and the list of
 * backward moves the operator may make was empty because no review was
 * failing. The task waited on a person for a stage move.
 *
 * Nothing is offered:
 *  - once the task has delivered anything (a revision or a files delivery):
 *    from then on a review's verdict decides the way back (R7-4, ruling 163),
 *    and a task waiting to be accepted is not walked away from its offer;
 *  - while an acceptance offer stands on it for any other reason: a task can
 *    be acceptable with nothing delivered, and the move would withdraw it;
 *  - while the task is held on other work: the hand-off would be refused;
 *  - while a delivering agent that can run is engaged: it runs where the task
 *    stands;
 *  - at the first stage, at the terminal stage, or at a stage this board does
 *    not have.
 *
 * Otherwise: every earlier stage at which some deployed agent is eligible
 * that can be given a delivery (a repo-write grant or the grant to save
 * files, ruling 535, and not one of the project's required reviewers, ruling
 * 556) and that cannot be engaged where the task stands, with those agents.
 *
 * Four callers share this one answer, the way three share `verdictStageFor`:
 * what the operator's snapshot offers (`reworkStages`), what its move claims
 * (`operatorTransitionStage`), what `transitionStage` re-vets, and the packet
 * door, which refuses to ask a person for a move the operator makes itself.
 *
 * Pure: the caller supplies the deployed profiles and the project's rules.
 */
export function engageStagesFor(
  board: {
    stages: readonly Pick<StageDef, "id">[];
    workflow: readonly Pick<WorkflowBoundary, "from" | "to">[];
  },
  fm: EngageTaskState,
  deployed: readonly EngageCandidate[],
  requiredReviewers: readonly { profileId: string }[],
): EngageStage[] {
  if (reviewSubjectId(fm) !== null) return [];
  if (fm.recommendations.some((r) => r.kind === "accept_completion")) return [];
  if (fm.blockedBy.length > 0) return [];
  if (hasDeliveringAgent(fm, deployed)) return [];
  const stages = board.stages;
  const currentIndex = stages.findIndex((s) => s.id === fm.stage);
  // The first stage has nothing before it: the scan below is empty there.
  if (currentIndex < 0) return [];
  if (fm.stage === resolveStageRoles(stages, board.workflow).terminalId) return [];
  const eligibleAt = (spec: { stages: readonly string[]; spanAll: boolean }, stageId: string) =>
    stageEligible(spec, stageId, stages, board.workflow);
  // An agent that can be engaged where the task stands needs no move.
  const elsewhere = deployed.filter(
    (d) =>
      (d.capabilities.delivery || d.capabilities.postsFiles) &&
      !requiredReviewers.some((rule) => rule.profileId === d.id) &&
      !eligibleAt(d, fm.stage),
  );
  return stages.slice(0, currentIndex).flatMap((stage) => {
    const agents = elsewhere
      .filter((d) => eligibleAt(d, stage.id))
      .map((d) => ({ id: d.id, name: d.name }));
    return agents.length > 0 ? [{ stageId: stage.id, agents }] : [];
  });
}
