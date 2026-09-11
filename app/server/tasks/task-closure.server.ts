import type { StageDef } from "~/schemas/project-file.schema";
import { isTerminalStage, stageName } from "~/shared/workflow/stage-roles";

/**
 * Ruling 177 (pass 36, F36-4 / F36-5): ONE spelling of "this task is closed".
 *
 * A task is closed when it is archived or when it sits at the terminal stage
 * (Shipped / Done — the last stage of the board, the one human acceptance moves
 * into). Before this module every coordination door spelled the test its own
 * way: the schedule runner had `mootNow`, the specialist dispatch refused
 * `archived` only, `runOperator` refused the terminal stage for the `scheduled`
 * trigger only, and the packet writer, the completion wake and the reconciler
 * read neither — so a shipped task kept being coordinated (a developer run that
 * outlived the force-accept re-invoked the operator, which opened a decision
 * packet on the closed task) and an `@operator` mention on an archived task
 * started a paid run behind a page whose own button refused it.
 *
 * Every door reads THIS predicate and refuses with THIS wording. A closed task
 * still answers reads, still accepts a human moving it back to an open stage,
 * and still lets a live run be interrupted — closure fences coordination, not
 * disposition.
 */
export type TaskClosure =
  | { closed: false }
  | { closed: true; why: "archived" | "terminal"; stageId: string };

export function taskClosure(
  fm: { stage: string; archived?: boolean | null | undefined },
  stages: readonly Pick<StageDef, "id">[],
): TaskClosure {
  if (fm.archived === true) return { closed: true, why: "archived", stageId: fm.stage };
  if (isTerminalStage(fm.stage, stages)) {
    return { closed: true, why: "terminal", stageId: fm.stage };
  }
  return { closed: false };
}

/**
 * The refusal sentence every door uses, so a person meets the same words on
 * the Run buttons, in a "Mention not started" note, in the operator's plan
 * narration and in the audit detail. `verb` completes "…before <verb>", e.g.
 * "running the operator on it".
 */
export function closureRefusal(
  taskKey: string,
  closure: Extract<TaskClosure, { closed: true }>,
  stages: readonly Pick<StageDef, "id" | "name">[],
  verb: string,
): string {
  if (closure.why === "archived") {
    return `${taskKey} is archived — restore it before ${verb}.`;
  }
  return (
    `${taskKey} is closed (${stageName(stages, closure.stageId)} is the terminal stage) — ` +
    `move it back to an open stage before ${verb}.`
  );
}
