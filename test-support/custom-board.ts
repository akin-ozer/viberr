import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";

/**
 * A hand-CUSTOMIZED 3-stage board (`todo` / `doing` / `done`) — the shape a
 * user produces by editing stages in project settings.
 *
 * It used to be the shipped "Lightweight · 3 stages" workflow template, which
 * P13-AP-04 (owner ruling 2, 2026-07-24) DELETED: creating a project from it
 * preinstalled the built-in Developer/Reviewer, whose eligible stages are the
 * governed ids (`ready`/`impl`/`review`), so no specialist was ever eligible on
 * the resulting board and the operator could not hand work off.
 *
 * Custom boards themselves are still fully supported, so the behaviour that
 * depends on non-default stage ids — stage-role resolution, review-queue
 * role-vs-literal-id filtering — is still worth covering. It lives here as a
 * TEST FIXTURE so those tests keep their coverage without the product shipping
 * a preset that cannot be worked.
 */
export const CUSTOM_3_STAGE_BOARD: {
  stages: StageDef[];
  workflow: WorkflowBoundary[];
} = {
  stages: [
    { id: "todo", name: "To do", color: "#a5a8b5" },
    { id: "doing", name: "In progress", color: "#7b61ff" },
    { id: "done", name: "Done", color: "#00b473" },
  ],
  workflow: [
    {
      from: "todo",
      to: "doing",
      boundary: "auto",
      by: "Operator, when a delivering agent is assigned",
      locked: false,
    },
    {
      from: "doing",
      to: "done",
      boundary: "human",
      by: "Human acceptance of the completion report",
      locked: true,
    },
  ],
};
