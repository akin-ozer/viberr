import type { StageDef } from "~/schemas/project-file.schema";

/**
 * A stage's RENDERED label: its name, or "unknown stage" when the reference
 * resolves to no stage the project lists. Ruling 291: a missing fact is stated
 * in words, never as a glyph stand-in ("−"), an empty string or the raw internal
 * id, and in the same words everywhere (the stage menu, the board's list row,
 * the task page and the archive dialog). `stageName` (stage-roles.ts) is for
 * places where the id is the right fallback; this one is only for copy on
 * screen.
 *
 * It lives apart from stage-roles.ts on purpose (ruling 11). Only the board
 * and the task page render it, so here it ships inside the chunk those two
 * already share. In stage-roles.ts it put that module's whole chunk on the
 * board and grew the chunk Home loads.
 */
export function stageLabel(
  stage: Pick<StageDef, "name"> | null | undefined,
): string {
  return stage?.name ?? "unknown stage";
}
