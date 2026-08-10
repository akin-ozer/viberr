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

/**
 * A stage's DISPLAY name, or the raw id when the id resolves to no stage (a
 * reference to a renamed/removed stage). The one spelling every caller shares,
 * so the "unknown id → show the id" fallback can never diverge.
 */
export function stageName(
  stages: readonly Pick<StageDef, "id" | "name">[],
  stageId: string,
): string {
  return stages.find((s) => s.id === stageId)?.name ?? stageId;
}

/**
 * True when a human gates every advance BEFORE work starts — the `strict`
 * preset's actual signature in the workflow graph.
 *
 * R15-9. The preset a project was created with is not stored anywhere: it is a
 * creation-time shaping input, and what persists is its EFFECT. `strict` turns
 * every pre-terminal `auto` boundary into `approval`, so strictness is readable
 * straight off the graph — and readable for projects that predate any given
 * capability, which a stored `preset` field could never be (that is the F15-20
 * shape of bug: a field absent on everything that already exists).
 *
 * The terminal edge is excluded because review→done is human-locked in EVERY
 * preset, so it carries no signal. A workflow with no pre-terminal boundaries
 * at all is not "strict" — there is nothing being gated — hence the length check.
 */
export function humanGatesPreWorkAdvance(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly Pick<WorkflowBoundary, "to" | "boundary">[],
): boolean {
  const terminalId = stages[stages.length - 1]?.id ?? null;
  const preWork = workflow.filter((b) => b.to !== terminalId);
  return preWork.length > 0 && preWork.every((b) => b.boundary !== "auto");
}

/** True when `stageId` is the project's terminal (Done-equivalent) stage. */
export function isTerminalStage(
  stageId: string | null | undefined,
  stages: readonly Pick<StageDef, "id">[],
): boolean {
  if (stageId == null) return false;
  return stageId === stages[stages.length - 1]?.id;
}
