import type { DatabaseSync } from "node:sqlite";
import { activeWorkRevision } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { noteRecipient } from "~/server/tasks/review-notes.server";
import { taskRef } from "~/server/tasks/task-mutation.server";
import type { GithubContextOptions } from "./github-context.server";
import { readPullRequestDiff, type PrDiffFile } from "./pr-diff.server";

/**
 * Ruling 484 (pass 40, F40-54): what the task page's Changes panel reads.
 *
 * A person reviewing delivered work saw `Diff N files · +a −d` and the commit
 * subjects; the only reader of a patch was the controller's tool (ruling 266).
 * This is the same read (`readPullRequestDiff`), for a person, BOUND to the
 * delivered revision: the pull request's live head must be the revision's head,
 * because the notes a person writes against these lines are addressed to the
 * agent that delivered them. A PR that is anywhere else is said, never shown as
 * if it were the delivered work.
 *
 * Membership is the route's gate (`task-changes.ts`); this reads with the
 * project's sealed credential and hands back hunks, never the token.
 */

/** Encoded patch characters one panel read carries. Well above the
 *  controller's 40 KB (a browser renders what a conversation cannot hold), and
 *  a file past it is listed with its counts and loaded on its own. */
const PANEL_PATCH_BYTES = 200_000;
/** One file asked for by path. */
const FILE_PATCH_BYTES = 1_000_000;

export type TaskChangesView =
  | {
      ok: true;
      prNumber: number;
      repo: string;
      /** The delivered revision these files are the changes of. */
      headSha: string;
      files: PrDiffFile[];
      moreFiles: boolean;
      truncated: boolean;
      /** Who a note reaches: the deployed delivering agent, or null. */
      recipient: { name: string; handle: string } | null;
    }
  | { ok: false; reason: string };

/** Null when the task does not exist (the route answers 404). */
export async function readTaskChanges(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    /** One file, by the path the PR lists it under; null for every file. */
    path: string | null;
  },
  opts: GithubContextOptions & { dataRoot?: string } = {},
): Promise<TaskChangesView | null> {
  const ctx = { dataRoot: opts.dataRoot };
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) return null;
  const fm = file.parsed.frontmatter;
  const key = input.taskKey;
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev || rev.kind === "verified") {
    return { ok: false, reason: `Nothing is delivered on ${key} yet, so there are no changes to read.` };
  }
  if (!fm.pr) {
    return {
      ok: false,
      reason: `${key}'s delivered revision is not on a pull request yet, so GitHub has no changes to show. Deliver the branch from the GitHub panel first.`,
    };
  }
  const n = fm.pr.number;
  const short = rev.headSha.slice(0, 7);
  const diffOpts: Parameters<typeof readPullRequestDiff>[3] = {
    headSha: rev.headSha,
    maxPatchBytes: input.path ? FILE_PATCH_BYTES : PANEL_PATCH_BYTES,
  };
  if (opts.fetchImpl) diffOpts.fetchImpl = opts.fetchImpl;
  if (input.path) diffOpts.path = input.path;
  const diff = await readPullRequestDiff(db, input.projectSlug, n, diffOpts);
  if (!diff.ok) {
    if (diff.liveHeadSha) {
      const live = diff.liveHeadSha.slice(0, 7);
      return {
        ok: false,
        reason:
          fm.pr.unpushedRevision?.revisionSha === rev.headSha
            ? `PR #${n} is at ${live} and does not carry the delivered revision ${short} yet. Push it from the GitHub panel, then read its changes here.`
            : `PR #${n} is at ${live}, not the delivered revision ${short}, so its changes are not the ones delivered. The next status check records the new head as the revision under review.`,
      };
    }
    return { ok: false, reason: `Could not read PR #${n} from GitHub: ${diff.reason}.` };
  }
  const recipient = noteRecipient(ctx, input.projectSlug, fm);
  return {
    ok: true,
    prNumber: n,
    repo: diff.repo,
    headSha: rev.headSha,
    files: diff.files,
    moreFiles: diff.moreFiles,
    truncated: diff.truncated,
    recipient: recipient ? { name: recipient.name, handle: recipient.handle } : null,
  };
}
