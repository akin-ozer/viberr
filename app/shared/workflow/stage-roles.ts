import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";

/**
 * Canonical stage-role resolution.
 *
 * Stages are per-project and freely renamed/reordered, so NOTHING in the app
 * may hard-code the literal ids "triage" / "ready" / "review" / "done" — a
 * customized board can be anything. Every place that used to test
 * `stage === "done"` or `stages[length-2]` now asks this resolver, so the four
 * structural roles are derived one way from the workflow graph:
 *
 * - `entry`    = the first stage (index 0) — where new tasks land.
 * - `terminal` = the last stage (index length-1) — the human-only Done stage.
 * - `review`   = the stage that has a workflow edge INTO the terminal stage.
 *                This is the boundary the operator opens a PR at and where
 *                acceptance happens from. If multiple edges point at terminal,
 *                the first-defined one wins (deterministic).
 * - `work`     = the stage with an edge INTO the review stage (the "in progress"
 *                stage). Falls back to the stage positionally before review.
 *
 * All ids are resolved against the SAME arrays, so callers never diverge
 * (the root cause of the old positional-vs-literal bugs).
 */
export interface StageRoles {
  entryId: string | null;
  terminalId: string | null;
  reviewId: string | null;
  workId: string | null;
}

export function stageLockReason(
  stageId: string,
  stages: readonly { id: string }[],
): string | null {
  if (stageId === stages[0]?.id) return "it's the entry point";
  if (stageId === stages.at(-1)?.id)
    return "human acceptance stays terminal";
  return null;
}

export function resolveStageRoles(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly Pick<WorkflowBoundary, "from" | "to">[],
): StageRoles {
  const entryId = stages[0]?.id ?? null;
  const terminalId = stages[stages.length - 1]?.id ?? null;

  // review = the (first) stage with an edge into terminal; fall back to the
  // stage positionally before terminal so a workflow-less project still resolves.
  const reviewId =
    (terminalId != null
      ? workflow.find((w) => w.to === terminalId)?.from
      : undefined) ??
    (stages.length >= 2 ? (stages[stages.length - 2]?.id ?? null) : null);

  // work = the (first) stage with an edge into review; fall back to the stage
  // positionally before review.
  let workId: string | null = null;
  if (reviewId != null) {
    workId = workflow.find((w) => w.to === reviewId)?.from ?? null;
    if (workId == null) {
      const reviewIdx = stages.findIndex((s) => s.id === reviewId);
      if (reviewIdx > 0) workId = stages[reviewIdx - 1]?.id ?? null;
    }
  }

  return { entryId, terminalId, reviewId, workId };
}

/** True when `stageId` is the project's terminal (Done-equivalent) stage. */
export function isTerminalStage(
  stageId: string | null | undefined,
  stages: readonly Pick<StageDef, "id">[],
): boolean {
  if (stageId == null) return false;
  return stageId === stages[stages.length - 1]?.id;
}
