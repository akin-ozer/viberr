import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";

/**
 * Ruling 162 / G35-5(d) (pass 35): why the operator may not refresh the
 * branch from where the task stands, or null. At the acceptance boundary (the
 * stage with the edge into the terminal one, and anything past it) the base
 * refresh belongs to the acceptance ceremony, which brings the branch up to
 * date once, re-runs the gate and merges in the same step; an operator
 * refresh there pushed merge commits that conflicted again minutes later. The
 * one exception is a PR GitHub already reports conflicting: acceptance would
 * only refuse, so the tool's job is to attempt the merge, record the
 * conflict list and open the conflict packet.
 *
 * Ruling 424: its own module so the operator's snapshot can carry the same
 * verdict as `notRefreshableReason` — the tool and the snapshot read one
 * function — without the snapshot importing the tool that imports it.
 */
export function acceptanceBoundaryRefusal(
  fm: TaskFrontmatter,
  taskKey: string,
  project: { stages: { id: string; name: string }[]; workflow: { from: string; to: string }[] },
): string | null {
  const roles = resolveStageRoles(project.stages, project.workflow);
  if (roles.reviewId === null || roles.terminalId === null) return null;
  const stageIndex = project.stages.findIndex((s) => s.id === fm.stage);
  const reviewIndex = project.stages.findIndex((s) => s.id === roles.reviewId);
  if (stageIndex < 0 || reviewIndex < 0) return null;
  if (stageIndex < reviewIndex || fm.stage === roles.terminalId) return null;
  if (fm.pr?.mergeable === "conflicting") return null;
  const here = stageName(project.stages, fm.stage);
  return (
    `${taskKey} is at ${here}, the acceptance boundary: the branch is brought up to date ` +
    `once, at acceptance time, and merged in the same ceremony. Do not refresh it here; ` +
    `recommend or accept the completion instead.`
  );
}
