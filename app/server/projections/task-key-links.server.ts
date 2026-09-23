import type { DatabaseSync } from "node:sqlite";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { TASK_KEY_IN_TEXT_RE, type TaskLinks } from "~/shared/task-key-links";

/** Keys looked up per transcript; a conversation that names more than this
 *  many distinct tasks links the first ones and leaves the rest as text. */
const MAX_KEYS = 400;

/**
 * U39-29 (pass 39): the tasks a text names, as the pages a person can open
 * from it. The controller transcript was first (U39-29); a task's own goal and
 * timeline read the same way (U39-31), minus the task itself.
 *
 * The controller answers in task keys. Live on ax-clone at 03:30 it wrote "I
 * created two urgent core tasks for the Developer, AX-33 and AX-34 … AX-21 now
 * waits on AX-33 and AX-30 waits on AX-34", and all five were plain text, so
 * following any of them meant leaving the page for the board or the search.
 *
 * Only a task this viewer can open becomes a link, the same rule the @mention
 * chip follows for names (P13-LV-12): a project page links its own project's
 * tasks, and the instance page links tasks in projects the viewer belongs to
 * (every project for an org admin). A key two visible projects share is left
 * as text rather than guessed.
 */
export function taskKeyLinks(
  db: DatabaseSync,
  texts: readonly string[],
  scope: {
    projectSlug: string | null;
    viewerId: string;
    /** A key never linked: the page's own task, which would link to itself. */
    exclude?: string;
  },
): TaskLinks {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(TASK_KEY_IN_TEXT_RE)) {
      if (keys.size >= MAX_KEYS) break;
      keys.add(match[0]);
    }
  }
  if (keys.size === 0) return {};
  const list = [...keys];
  // SAFETY: both selected columns are TEXT NOT NULL on `task_projections`.
  const rows = db
    .prepare(
      `SELECT project_slug, task_key FROM task_projections WHERE task_key IN (${list.map(() => "?").join(", ")})`,
    )
    .all(...list) as { project_slug: string; task_key: string }[];
  const visible = scope.projectSlug
    ? new Set([scope.projectSlug])
    : isOrgAdmin(db, scope.viewerId)
      ? null
      : memberProjects(db, scope.viewerId);
  const where = new Map<string, string[]>();
  for (const row of rows) {
    if (visible && !visible.has(row.project_slug)) continue;
    where.set(row.task_key, [...(where.get(row.task_key) ?? []), row.project_slug]);
  }
  const links: Record<string, string> = {};
  for (const [key, slugs] of where) {
    const [slug] = slugs;
    if (key === scope.exclude) continue;
    if (slugs.length === 1 && slug) links[key] = `/projects/${slug}/tasks/${key}`;
  }
  return links;
}

function memberProjects(db: DatabaseSync, userId: string): Set<string> {
  // SAFETY: `project_slug` is TEXT NOT NULL on `project_members`.
  const rows = db
    .prepare(`SELECT project_slug FROM project_members WHERE user_id = ?`)
    .all(userId) as { project_slug: string }[];
  return new Set(rows.map((r) => r.project_slug));
}
