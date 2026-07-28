import type { DatabaseSync } from "node:sqlite";
import { guardrailSchema } from "~/schemas/project-file.schema";

/**
 * Post-merge branch cleanup policy (owner ruling R15-6, 2026-07-28).
 *
 * Merged task branches accumulated on every repo Viberr delivers into (vib-1..4,
 * 7, 9 were still sitting on the live repo when the ruling came in). A merged
 * PR's head branch has no remaining job: the commits live on the default branch
 * and the PR page keeps its history either way.
 *
 * Stored as a project.md guardrail row rather than a new frontmatter key so the
 * policy travels with the project file (and its projection) like every other
 * per-project switch. ABSENCE MEANS ON: the ruling's default applies to every
 * project that predates it without a rewrite of every project.md, and only an
 * explicit `on: false` turns it off.
 *
 * The deletion itself is `deleteTaskRemoteBranch` (github-reconciler) — same
 * mechanics, same refusals (never the default branch, never a branch with an
 * open PR), so this policy can only ever choose whether to ASK.
 */

export const BRANCH_CLEANUP_GUARDRAIL_ID = "delete-branch-after-merge";

export const BRANCH_CLEANUP_GUARDRAIL_DESC =
  "Delete the task's branch on GitHub once its review PR is merged.";

/**
 * Reads the policy off the project projection. A project with no row at all —
 * every project created before R15-6 — is ON, per the ruling's default.
 */
export function branchCleanupOnMerge(
  db: DatabaseSync,
  projectSlug: string,
): boolean {
  const row = db
    .prepare(`SELECT guardrails_json FROM projects WHERE slug = ?`)
    .get(projectSlug) as { guardrails_json: string | null } | undefined;
  if (!row?.guardrails_json) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.guardrails_json);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  for (const entry of parsed) {
    const guardrail = guardrailSchema.safeParse(entry);
    if (guardrail.success && guardrail.data.id === BRANCH_CLEANUP_GUARDRAIL_ID) {
      return guardrail.data.on;
    }
  }
  return true;
}
