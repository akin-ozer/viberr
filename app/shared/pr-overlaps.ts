import type { PrRef } from "~/schemas/task-file.schema";

/**
 * Ruling 236's pairwise path intersection between open review pull requests,
 * as a pure rule every surface shares.
 *
 * It lived in `review-queue.server.ts` (extracted there by ruling 413 so the
 * operator snapshot could reuse it). Ruling 475 (F40-55 (c)) moved it here
 * because the acceptance dialog needs the same answer on both of its doors: the
 * task page's loader computes it on the server, and the board computes it from
 * the cards it already holds (their `pr.paths`), with no extra payload.
 */

/** Ruling 236: one other open PR this row's diff collides with. */
export interface PrOverlap {
  taskKey: string;
  prNumber: number;
  /** The shared paths, in this row's order. Capped for display by the surface;
   *  the full set is what the count reflects. */
  paths: string[];
  /** Either side's path list hit `PR_PATHS_MAX`, so the real overlap may be
   *  LARGER than this. Never smaller: a clipped list can only miss a collision.
   *  A surface that shows the count must say so. */
  partial: boolean;
}

/** Ruling 413: one side of the pairwise intersection, as either caller has it. */
export interface PrDiffPaths {
  taskKey: string;
  prNumber: number;
  changed: readonly string[];
  truncated: boolean;
}

/**
 * Ruling 236's pairwise path intersection, as a pure rule.
 *
 * Extracted (ruling 413) because the operator needs the same answer the review
 * queue renders, and ruling 407 is the standing lesson about re-deriving a
 * predicate in a second surface instead of reusing it.
 */
export function prPathOverlaps(
  mine: PrDiffPaths,
  others: readonly PrDiffPaths[],
): PrOverlap[] {
  const minePaths = new Set(mine.changed);
  const found: PrOverlap[] = [];
  for (const other of others) {
    if (other.taskKey === mine.taskKey) continue;
    const shared = other.changed.filter((path) => minePaths.has(path));
    if (shared.length === 0) continue;
    found.push({
      taskKey: other.taskKey,
      prNumber: other.prNumber,
      paths: shared,
      partial: mine.truncated || other.truncated,
    });
  }
  return found;
}

/** The PR facts {@link mergeCollisions} reads. */
type PrPathsView = Pick<PrRef, "number" | "state" | "paths">;

/**
 * Ruling 475 (F40-55 (c)): the task's side of the intersection when its pull
 * request is still OPEN on GitHub (`review`, or `accepted` with the merge
 * pending) and its changed paths were read; null otherwise.
 */
export function openPrDiffPaths(task: { key: string; pr: PrPathsView | null }): PrDiffPaths | null {
  const pr = task.pr;
  if (!pr || (pr.state !== "review" && pr.state !== "accepted")) return null;
  const paths = pr.paths;
  if (!paths || paths.changed.length === 0) return null;
  return { taskKey: task.key, prNumber: pr.number, changed: paths.changed, truncated: paths.truncated };
}

/**
 * Ruling 475 (F40-55 (c)): the other open pull requests that merging `task`'s
 * would likely put in conflict, because they change a path it changes. Empty
 * when the task has no open PR with a read path list. The accept dialog names
 * them before the merge rather than after it.
 */
export function mergeCollisions(
  task: { key: string; pr: PrPathsView | null },
  others: readonly { key: string; pr: PrPathsView | null }[],
): PrOverlap[] {
  const mine = openPrDiffPaths(task);
  if (!mine) return [];
  const sides = others.flatMap((other) => {
    const side = openPrDiffPaths(other);
    return side ? [side] : [];
  });
  return prPathOverlaps(mine, sides);
}
