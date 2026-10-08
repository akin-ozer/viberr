import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import { stageEligible } from "./stage-eligibility";
import { resolveStageRoles } from "./stage-roles";

/** One earlier stage a task may go back to, and the agents that can be given
 *  its delivery there. */
export interface EngageStage {
  stageId: string;
  agents: string[];
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
 * task stood at Cover: the hand-off was refused for the stage, the backward
 * move was refused because no review was failing, and the refusal named a way
 * out ("the engaged deliverer runs at every stage") that did not exist. The
 * task waited on a person for a stage move.
 *
 *  - A task with a delivering engagement: nothing. Its deliverer runs where
 *    the task stands.
 *  - A task at its first stage, at the terminal stage or at a stage this board
 *    does not have: nothing.
 *  - Otherwise every earlier stage at which some deployed agent that can be
 *    given a delivery, and cannot be engaged where the task stands, is
 *    eligible, with those agents' names.
 *
 * Three callers share this one answer, the way they share `verdictStageFor`:
 * what the operator's snapshot offers (`reworkStages`), what its move claims
 * (`operatorTransitionStage`) and what `transitionStage` re-vets.
 *
 * Pure: the caller supplies the deployed profiles.
 */
export function engageStagesFor(
  board: {
    stages: readonly Pick<StageDef, "id">[];
    workflow: readonly Pick<WorkflowBoundary, "from" | "to">[];
  },
  fm: { stage: string; engagements: readonly { delivers: boolean }[] },
  deployed: readonly {
    name: string;
    stages: readonly string[];
    spanAll: boolean;
    capabilities: { delivery: boolean; postsFiles: boolean };
  }[],
): EngageStage[] {
  if (fm.engagements.some((e) => e.delivers)) return [];
  const stages = board.stages;
  const currentIndex = stages.findIndex((s) => s.id === fm.stage);
  // The first stage has nothing before it: the scan below is empty there.
  if (currentIndex < 0) return [];
  if (fm.stage === resolveStageRoles(stages, board.workflow).terminalId) return [];
  const eligibleAt = (spec: { stages: readonly string[]; spanAll: boolean }, stageId: string) =>
    stageEligible(spec, stageId, stages, board.workflow);
  // An agent that can be engaged where the task stands needs no move.
  const elsewhere = deployed.filter(
    (d) => (d.capabilities.delivery || d.capabilities.postsFiles) && !eligibleAt(d, fm.stage),
  );
  return stages.slice(0, currentIndex).flatMap((stage) => {
    const agents = elsewhere.filter((d) => eligibleAt(d, stage.id)).map((d) => d.name);
    return agents.length > 0 ? [{ stageId: stage.id, agents }] : [];
  });
}
