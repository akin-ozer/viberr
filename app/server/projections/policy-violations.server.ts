import type Database from "better-sqlite3";

/**
 * Open policy-violation count for the rail Settings badge (shell §4.1).
 *
 * PHASE-4 STAND-IN — Phase 7 replaces this with real per-violation
 * open/resolved records driven by the PAT scope validator (ruling 5).
 * Until then the count is derived honestly from the typed `policy` events
 * in the projected timelines: per task, the NEWEST policy event decides —
 * a "**Policy violation:**" event with no newer "**Policy update:**" on the
 * same task counts as one open violation. The seeded VIB-142 PAT-scope
 * violation yields exactly 1.
 */

const VIOLATION_MARK = "**Policy violation:**";
const RESOLUTION_MARK = "**Policy update:**";

export function countOpenPolicyViolations(
  db: Database.Database,
  projectSlug: string,
): number {
  const rows = db
    .prepare(
      `SELECT task_key, position, text FROM task_events
       WHERE project_slug = ? AND type = 'policy'
       ORDER BY task_key ASC, position ASC`,
    )
    .all(projectSlug) as { task_key: string; position: number; text: string }[];

  // position ASC = newest first (file order); the first row per task wins.
  const decided = new Set<string>();
  let open = 0;
  for (const row of rows) {
    if (decided.has(row.task_key)) continue;
    if (row.text.includes(RESOLUTION_MARK)) {
      decided.add(row.task_key);
      continue;
    }
    if (row.text.includes(VIOLATION_MARK)) {
      decided.add(row.task_key);
      open += 1;
    }
    // Other policy events (e.g. blocked agent actions) neither open nor
    // resolve a violation — keep scanning older events for this task.
  }
  return open;
}
