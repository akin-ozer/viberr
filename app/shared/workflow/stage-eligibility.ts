import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import { resolveStageRoles } from "./stage-roles";

/**
 * Stage eligibility across DIFFERENT boards (owner ruling R14-1).
 *
 * An agent profile declares the stages it may work as raw stage ids (`ready`,
 * `impl`, …). Stages are per-project: a board can rename them, add them, or come
 * from a different template entirely. So a profile deployed onto a board whose
 * ids differ matched NOTHING and became eligible for zero stages — live, that
 * left `Lightweight Lab` (ids `todo/doing/done`) with a task no agent could be
 * engaged on and an operator that could only report the dead end (P14-WL-01).
 *
 * Eligibility therefore resolves in three steps, most specific first:
 *
 *  1. **Literal id** — the declared id exists on this board. Unchanged behavior.
 *  2. **Structural role** — the declared id maps to a role (entry / ready / work
 *     / review / terminal) and this board's stage fills that role. This is what
 *     makes a renamed or re-templated board work without editing every profile.
 *  3. **Meaningless declaration** — NONE of the declared ids resolve on this
 *     board, by id or by role. The declaration says nothing about this workflow,
 *     so the profile is treated as unrestricted — the same rule an empty
 *     `stages` list already had. Silently disabling every agent is the worse
 *     failure, and it is the one we actually observed.
 */

export type StageRole = "entry" | "ready" | "work" | "review" | "terminal";

/**
 * Canonical role for a declared stage id. Templates and hand-authored boards use
 * a small, stable vocabulary; anything outside it has no role and only ever
 * matches literally.
 */
const ROLE_BY_ALIAS: ReadonlyMap<string, StageRole> = new Map([
  ["triage", "entry"],
  ["todo", "entry"],
  ["backlog", "entry"],
  ["inbox", "entry"],
  ["ready", "ready"],
  ["planned", "ready"],
  ["impl", "work"],
  ["doing", "work"],
  ["in-progress", "work"],
  ["in_progress", "work"],
  ["progress", "work"],
  ["wip", "work"],
  ["build", "work"],
  ["review", "review"],
  ["qa", "review"],
  ["verify", "review"],
  ["done", "terminal"],
  ["complete", "terminal"],
  ["completed", "terminal"],
  ["shipped", "terminal"],
]);

/** The role a DECLARED id names, independent of any board. */
export function declaredStageRole(stageId: string): StageRole | null {
  return ROLE_BY_ALIAS.get(stageId.trim().toLowerCase()) ?? null;
}

/**
 * The role each stage of THIS board fills. Structural roles come from the
 * workflow graph (`resolveStageRoles`); `ready` is the stage between entry and
 * work when the board has one, which is how the standard 5-stage template reads.
 * A stage can hold several roles on a short board (a 3-stage `todo/doing/done`
 * has `doing` as both work and review), so this returns a set per stage.
 */
export function boardStageRoles(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly Pick<WorkflowBoundary, "from" | "to">[],
): Map<string, Set<StageRole>> {
  const roles = resolveStageRoles(stages, workflow);
  const out = new Map<string, Set<StageRole>>();
  const add = (id: string | null, role: StageRole) => {
    if (!id) return;
    const set = out.get(id) ?? new Set<StageRole>();
    set.add(role);
    out.set(id, set);
  };
  add(roles.entryId, "entry");
  add(roles.workId, "work");
  add(roles.reviewId, "review");
  add(roles.terminalId, "terminal");

  // `ready` — the stage between entry and work. On a board with no such gap the
  // role is unfilled and a `ready`-declaring profile falls through to its other
  // declared stages (or to rule 3).
  const entryIdx = stages.findIndex((s) => s.id === roles.entryId);
  const workIdx = stages.findIndex((s) => s.id === roles.workId);
  if (entryIdx >= 0 && workIdx > entryIdx + 1) {
    add(stages[entryIdx + 1]?.id ?? null, "ready");
  }

  // A board short enough that work and review collapse onto one stage should
  // still accept a work-declaring profile at that stage — the alternative is an
  // implementation agent with nowhere to run.
  if (roles.workId && roles.workId === roles.entryId && roles.reviewId) {
    add(roles.reviewId, "work");
  }
  return out;
}

/**
 * The ids on THIS board that a profile's declared stage ids resolve to.
 * Empty when the declaration is meaningless here (caller applies rule 3).
 */
export function resolveDeclaredStages(
  declared: readonly string[],
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly Pick<WorkflowBoundary, "from" | "to">[],
): string[] {
  const present = new Set(stages.map((s) => s.id));
  const byRole = boardStageRoles(stages, workflow);
  const out = new Set<string>();
  for (const id of declared) {
    if (present.has(id)) {
      out.add(id);
      continue;
    }
    const role = declaredStageRole(id);
    if (!role) continue;
    for (const [stageId, roles] of byRole) {
      if (roles.has(role)) out.add(stageId);
    }
  }
  // Preserve board order so callers can render the result directly.
  return stages.filter((s) => out.has(s.id)).map((s) => s.id);
}

/**
 * True when a profile declaring `declared` may work this board's `stageId`.
 * `spanAll` and an empty declaration are unrestricted, as before; a declaration
 * that resolves to nothing on this board is treated the same way (rule 3).
 */
export function stageEligible(
  spec: { stages: readonly string[]; spanAll: boolean },
  stageId: string,
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly Pick<WorkflowBoundary, "from" | "to">[],
): boolean {
  if (spec.spanAll) return true;
  if (spec.stages.length === 0) return true;
  const resolved = resolveDeclaredStages(spec.stages, stages, workflow);
  if (resolved.length === 0) return true; // rule 3 — meaningless here
  return resolved.includes(stageId);
}

/**
 * Ruling 133's refusal, in ONE spelling: the server's dispatch gate and the
 * task page's Run-an-agent control (U36-10, pass 36) both print it, so the
 * words a person meets before the click are the words the server answers with.
 */
export function stageIneligibilitySentence(
  agentName: string,
  stageName: string,
  scopedTo: string,
): string {
  return `${agentName} is not eligible for the ${stageName} stage; its profile is scoped to ${
    scopedTo || "no stages"
  }. Change the task's stage or the profile's eligible stages.`;
}
