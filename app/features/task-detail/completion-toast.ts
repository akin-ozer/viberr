import type { StageDef } from "~/schemas/project-file.schema";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";

/**
 * U36-9 (pass 36): the toasts a human sees after accepting or force-accepting
 * a completion name the board's terminal stage as the board calls it. Live,
 * "Completion accepted · HLC-10 moved to Done" and "Force-accepted HLC-9 ·
 * moved to Done (review gate overridden)" landed on a board whose last stage
 * is Shipped — the accept button's toast was fixed in the first pass-36 commit,
 * these two (and the packet-side pair) still carried the literal.
 */
export function terminalStageNameFor(
  project:
    | {
        stages: readonly Pick<StageDef, "id" | "name">[];
        workflow?: readonly { from: string; to: string }[];
      }
    | null
    | undefined,
): string {
  if (!project) return "Done";
  const id = resolveStageRoles(project.stages, project.workflow ?? []).terminalId;
  return id === null ? "Done" : stageName(project.stages, id);
}

export function completionToast(
  kind: "accepted" | "forced",
  taskKey: string,
  terminalName: string,
): string {
  return kind === "forced"
    ? `Force-accepted ${taskKey} · moved to ${terminalName} (review gate overridden)`
    : `Completion accepted · ${taskKey} moved to ${terminalName}`;
}
