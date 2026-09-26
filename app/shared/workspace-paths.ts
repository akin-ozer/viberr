/**
 * Paths inside a task's checkout, read the way a person names them: relative
 * to the repository. Server and client share it since ruling 499: an agent's
 * reply is rewritten with it when it is extracted (F7-UX1), and the run
 * console prints the file an edit or a read names the same way, so one file
 * reads as `docs/x.md` on the timeline, in the Changes panel and in the log.
 */

/**
 * An absolute host path that points INTO a task workspace clone, matched at a
 * boundary that is not part of a URL (F7-UX1). Structure:
 *   `<data-root>/…/tasks/<KEY>/workspace/<repo>/<rest>`  →  captured `<rest>`.
 * P8 (pass 25): a SUPPORTING run's checkout is one level deeper —
 *   `…/tasks/<KEY>/workspace/support/<profileId>/<repo>/<rest>` — so the optional
 * `support/<profileId>/` group is skipped before the repo segment; without it a
 * reviewer's echoed path would rewrite to `<profileId>/<repo>/<rest>` (wrong).
 * The leading `/` must not follow a word char, `:`, `/`, or `.` so `http(s)://`
 * and `file://` URLs (and interior path segments) are never anchored on. The
 * `<rest>` capture stops at whitespace or bracket/paren so a markdown link's
 * closing `)` / `]` is left intact.
 */
const WORKSPACE_ABS_PATH_RE =
  /(?<![:\w/.])\/(?:[^\s()<>[\]]*?\/)?tasks\/[^/\s()<>[\]]+\/workspace\/(?:support\/[^/\s()<>[\]]+\/)?[^/\s()<>[\]]+\/([^\s()<>[\]]+)/g;

/**
 * Rewrite workspace-absolute host paths in an agent reply to repo-relative ones
 * (F7-UX1): `/Users/…/tasks/VIB-2/workspace/viberr/docs/x.md` → `docs/x.md`, so
 * links a specialist emits are portable for every reader instead of pointing at
 * one machine's checkout. Real URLs (http/https/file) and non-workspace paths
 * are left untouched. Applied at reply-extraction time so the canonical timeline
 * comment (and everything derived from it) is clean.
 */
export function normalizeWorkspacePaths(text: string): string {
  return text.replace(WORKSPACE_ABS_PATH_RE, "$1");
}
