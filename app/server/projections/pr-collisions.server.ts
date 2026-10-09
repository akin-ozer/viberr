import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { prRefSchema, type PrRef } from "~/schemas/task-file.schema";
import { mergeCollisions, openPrDiffPaths, type PrOverlap } from "~/shared/pr-overlaps";

/** The two projection columns the read below selects. */
const openPrRows = z.array(z.object({ task_key: z.string(), pr_json: z.string().nullable() }));

/**
 * Ruling 244 (F40-55 (c)): for the task page's accept dialog, the other open
 * review PRs of the project that merging this task's PR would likely put in
 * conflict (they change a path it changes).
 *
 * Live on akinozer-com the owner accepted WEB-4 while WEB-2's open PR changed
 * the same `package.json`; Viberr knew (both `pr.paths`), and the dialog said
 * nothing, so WEB-2's acceptance was refused a minute later. Reads only the
 * open PRs whose path list was recorded, and only when this task's own PR is
 * open with one: a task page with nothing to merge pays nothing.
 */
export function taskMergeCollisions(
  db: DatabaseSync,
  projectSlug: string,
  task: { key: string; pr: PrRef | null },
): PrOverlap[] {
  if (!openPrDiffPaths(task)) return [];
  const rows = openPrRows.parse(
    db
      .prepare(
        `SELECT task_key, pr_json FROM task_projections
         WHERE project_slug = ? AND task_key <> ? AND archived = 0
           AND json_extract(pr_json, '$.state') IN ('review', 'accepted')
           AND json_extract(pr_json, '$.paths') IS NOT NULL
         ORDER BY task_key ASC`,
      )
      .all(projectSlug, task.key),
  );
  const others = rows.flatMap((row) => {
    if (!row.pr_json) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(row.pr_json);
    } catch {
      return [];
    }
    const pr = prRefSchema.safeParse(raw);
    return pr.success ? [{ key: row.task_key, pr: pr.data }] : [];
  });
  return mergeCollisions(task, others);
}
