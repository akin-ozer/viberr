import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const countRow = z.object({ n: z.number() });

/**
 * Tasks whose GitHub records point at the CURRENT repo: a linked PR, or
 * commits observed on a pushed branch. A project that never reached its
 * repository has zero (every push failed), which is what keeps changing it
 * friction-free.
 *
 * In a module of its own, with no import beyond the database: the settings
 * door reads it, and so does the operator's repository question (ruling 224),
 * which must not load the settings door to ask it. It did, lazily, in the
 * middle of the operator's action, and that first load is slow enough on a
 * cold process to outlast whatever waits for the packet.
 */
export function repoFootprintTasks(db: DatabaseSync, projectSlug: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_projections
       WHERE project_slug = ?
         AND (pr_json IS NOT NULL
              OR COALESCE(json_array_length(json_extract(github_json, '$.commits')), 0) > 0)`,
    )
    .get(projectSlug);
  return countRow.parse(row).n;
}
