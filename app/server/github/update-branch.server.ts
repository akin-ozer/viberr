import type { DatabaseSync } from "node:sqlite";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createGitHubAskpassEnv } from "~/server/tasks/git-clone-auth.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  PUSH_TIMEOUT_MS,
  commitIdentityArgs,
  defaultExec,
  findWorkspaceRepoDir,
  isNonFastForwardStderr,
  type Exec,
} from "./push-workspace.server";

/**
 * Bring a task branch up to date with its base (N19 gap 9).
 *
 * Viberr could create a branch, compare it, push it and merge its PR — and
 * never move it FORWARD. The moment two tasks run against one repository (the
 * normal case: one repo per project), the first merge leaves every other open
 * task behind. The product detected that precisely — `behind_main`,
 * `mergeable: "conflicting"` — and then offered nothing but three copy sites
 * telling a human to go rebase somewhere else. That is the "reconstruct the
 * truth outside the product" failure the UX spec calls make-or-break, and it
 * breaks the single-writer invariant on the way out: the branch's sole owner is
 * the delivering engagement's workspace, and a human rebasing in a terminal is
 * a second writer Viberr never sees.
 *
 * Owner ruling (N19-9): operator-decided — the operator updates the branch when
 * it judges it needed, and a CONFLICT is a human decision, never an agent
 * retry. This module is the mechanics half only, in the R15-2 shape: the server
 * owns the git, the agent only decides. `update-branch-operator.server.ts` is
 * the gated decision half.
 *
 * Three deliberate choices:
 *
 *  - **MERGE, never rebase.** A rebase rewrites the branch's history, which can
 *    only reach the remote through a force-push — exactly what R18-4 refused
 *    for the adjacent branch-collision case ("do NOT force-reset a remote
 *    branch"). A merge commit fast-forwards the remote, so the update needs no
 *    special power and can never clobber history a human or another writer put
 *    there.
 *  - **The workspace is the writer.** The update runs in the delivering
 *    engagement's own clone and is then pushed, so the workspace and the remote
 *    move together. Updating the remote alone (GitHub's merges API) would leave
 *    the workspace's base frozen at clone time AND make the next delivery push
 *    a non-fast-forward — the update would manufacture the very conflict class
 *    it exists to remove.
 *  - **All-or-nothing.** A conflict aborts the merge; a failed push resets the
 *    local branch to the commit it started on. The branch is either forward or
 *    exactly as it was — never half-updated with a merge commit that cannot be
 *    pushed.
 */

/** A conflict list longer than this is a wall of text in a decision packet. */
const MAX_CONFLICT_FILES = 20;

/**
 * `--unshallow` on a `--depth 1` workspace can pull a repository's whole
 * history. That is the honest cost of a correct merge base: deepening by a
 * guess (the 50 `countCommitsAhead` uses) silently produces "refusing to merge
 * unrelated histories" the moment the base moved further than the guess, and a
 * wrong merge base is a worse failure than a slow one.
 */
const FETCH_TIMEOUT_MS = 300_000;
const MERGE_TIMEOUT_MS = 60_000;

export type UpdateBranchResult =
  /** The branch now carries the base. `commits` is how many base commits it was
   *  missing. */
  | { status: "updated"; branch: string; base: string; commits: number }
  /** Idempotent no-op: nothing on the base that the branch does not have. */
  | { status: "already_current"; branch: string; base: string }
  /**
   * The merge could not be made automatically. The merge is ABORTED — the
   * branch (local and remote) is untouched — and the conflicting paths are
   * carried so the human decision can name them. Owner ruling: a conflict is a
   * human decision, not an agent retry.
   */
  | {
      status: "conflict";
      branch: string;
      base: string;
      files: string[];
      detail?: string;
    }
  /**
   * The remote branch holds commits this workspace does not (non-fast-forward)
   * — a HISTORY divergence, never a credential problem (B-GH1/F15-15). The
   * local merge is rolled back and nothing is force-pushed (R18-4).
   */
  | { status: "push_conflict"; branch: string; base: string; reason: string }
  /**
   * The residual failure bucket. `reason` is Viberr's own sentence; `detail` is
   * git's text, scrubbed (`redactGitOutput`). A git failure whose reason is
   * dropped is not an acceptable failure (F19-6/F19-18) — the only channel that
   * can say "no such remote ref" instead of "it did not work".
   */
  | { status: "update_failed"; reason: string; detail?: string }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_branch"
        | "dirty_workspace"
        | "task_not_found";
      reason: string;
    };

export interface UpdateBranchInput {
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  workdir?: string | null;
  /** Injected runner (tests). */
  exec?: Exec;
}

/** git prints `CONFLICT (content): …` / `Automatic merge failed` on STDOUT. */
function isMergeConflictOutput(text: string): boolean {
  return /CONFLICT\b/i.test(text) || /automatic merge failed/i.test(text);
}

/**
 * The structured fields this module's git log lines carry. The optional members
 * are OMITTED when they do not apply rather than written falsy: `timedOut:
 * false` on a line about a push that simply failed reads as a fact the server
 * checked, not an absent one.
 */
type GitLogFields = {
  taskKey: string;
  branch: string;
  base?: string;
  files?: string[];
  timedOut?: true;
  abortFailed?: true;
  detail?: string;
};

/**
 * `update_failed` carrying git's own (already scrubbed) words. `redactGitOutput`
 * answers "" when git printed nothing, and every reader of `detail` guards on
 * truthiness — so "git said nothing" stays the ABSENT key, not an empty one.
 */
function updateFailed(reason: string, detail: string): UpdateBranchResult {
  const failure: Extract<UpdateBranchResult, { status: "update_failed" }> = {
    status: "update_failed",
    reason,
  };
  if (detail) failure.detail = detail;
  return failure;
}

/**
 * Merge the project's default branch into the task's workspace branch and push
 * the result. Returns a typed result; never throws.
 */
export async function updateWorkspaceBranchFromBase(
  input: UpdateBranchInput,
): Promise<UpdateBranchResult> {
  const { db, projectSlug, taskKey, dataRoot } = input;
  const exec = input.exec ?? defaultExec;
  try {
    const ref = { projectSlug, taskKey, dataRoot };
    if (!readTaskFile(ref)) {
      return { status: "task_not_found", reason: "task file missing" };
    }

    const projectFile = readProjectFile({ projectSlug, dataRoot });
    // P13-D-5: one project, one repository.
    const repo = projectFile?.parsed.frontmatter.repo ?? null;
    if (!repo) return { status: "no_repo", reason: "project has no repo" };
    const base = projectFile?.parsed.frontmatter.defaultBranch || "main";
    const repoName = repo.split("/").pop() ?? repo;

    const repoDir = findWorkspaceRepoDir(
      projectSlug,
      taskKey,
      repoName,
      dataRoot,
      input.workdir,
    );
    if (!repoDir) {
      return {
        status: "no_workspace",
        reason:
          "no workspace git repo — the branch is only writable from the delivering engagement's workspace",
      };
    }

    const headRes = await exec(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const branch = headRes.ok ? headRes.stdout.trim() : "";
    if (!branch || branch === "HEAD" || branch === base) {
      return {
        status: "no_branch",
        reason: `HEAD not on a task branch (${branch || "detached"})`,
      };
    }

    // A dirty tree is NOT auto-committed here. Committing the agent's working
    // tree is a DELIVERY decision (`pushWorkspaceBranch` owns it, at the review
    // boundary, where those changes are the deliverable). Sweeping them into a
    // "bring the branch up to date" merge would ship unreviewed work under a
    // maintenance commit — and a merge over a dirty tree either refuses or
    // overwrites, both of which lose the agent's work.
    const statusRes = await exec(
      "git",
      ["-C", repoDir, "status", "--porcelain"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    if (statusRes.ok && statusRes.stdout.trim() !== "") {
      return {
        status: "dirty_workspace",
        reason:
          "the workspace has uncommitted changes — deliver or discard them before updating the branch",
      };
    }

    const credential = getProjectCredential(db, projectSlug);
    const token = credential ? getPatToken(db, credential.id) : null;
    if (!token) return { status: "no_pat", reason: "no project credential" };

    const askpass = createGitHubAskpassEnv({ token });
    try {
      // 1. Fetch the base. Specialist clones are `--depth 1`, so a merge would
      //    otherwise run against a truncated history that has no merge base
      //    with the advanced remote.
      const shallowRes = await exec(
        "git",
        ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
        { cwd: repoDir, timeoutMs: 5_000 },
      );
      const shallow = shallowRes.ok && shallowRes.stdout.trim() === "true";
      const fetchRes = await exec(
        "git",
        [
          "-C",
          repoDir,
          "fetch",
          ...(shallow ? ["--unshallow"] : []),
          "origin",
          // Explicit refspec: the update must read `origin/<base>`, and relying
          // on git's opportunistic remote-tracking update makes that a version
          // question.
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
        ],
        { cwd: repoDir, timeoutMs: FETCH_TIMEOUT_MS, env: askpass.env },
      );
      if (!fetchRes.ok) {
        const detail = redactGitOutput(fetchRes.stderr, { token });
        const fields: GitLogFields = { taskKey, branch, base };
        if (fetchRes.timedOut) fields.timedOut = true;
        if (detail) fields.detail = detail;
        logger.warn("branch update could not fetch the base branch", fields);
        return updateFailed(
          fetchRes.timedOut
            ? `fetching \`${base}\` was cancelled after ${FETCH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : `could not fetch \`${base}\` from origin`,
          detail,
        );
      }

      // 2. How far behind? Zero is a real answer, and it is a no-op that says
      //    so — never a merge commit nobody needed.
      const behindRes = await exec(
        "git",
        ["-C", repoDir, "rev-list", "--count", `HEAD..origin/${base}`],
        { cwd: repoDir, timeoutMs: 10_000 },
      );
      const behind = behindRes.ok
        ? Number.parseInt(behindRes.stdout.trim(), 10)
        : Number.NaN;
      if (!Number.isFinite(behind)) {
        return updateFailed(
          `could not compare \`${branch}\` against \`${base}\``,
          redactGitOutput(behindRes.stderr, { token }),
        );
      }
      if (behind === 0) {
        return { status: "already_current", branch, base };
      }

      // 3. The pre-merge commit, so a push that cannot land rolls all the way
      //    back. Without it the workspace keeps a merge commit the remote never
      //    got, and the next attempt compounds it.
      const preRes = await exec(
        "git",
        ["-C", repoDir, "rev-parse", "HEAD"],
        { cwd: repoDir, timeoutMs: 5_000 },
      );
      const preSha = preRes.ok ? preRes.stdout.trim() : "";
      if (!preSha) {
        return {
          status: "update_failed",
          reason: "could not read the branch head before merging",
        };
      }

      const identity = await commitIdentityArgs(exec, repoDir);
      const mergeRes = await exec(
        "git",
        [
          "-C",
          repoDir,
          ...identity,
          "merge",
          "--no-edit",
          "-m",
          `[${taskKey}] merge ${base} into ${branch}`,
          `origin/${base}`,
        ],
        { cwd: repoDir, timeoutMs: MERGE_TIMEOUT_MS },
      );
      if (!mergeRes.ok) {
        const output = `${mergeRes.stdout}\n${mergeRes.stderr}`;
        // Read the conflicted paths BEFORE aborting — after the abort there is
        // nothing left to name, and a conflict packet that cannot say WHICH
        // files conflicted sends the human back to a terminal to find out.
        const filesRes = await exec(
          "git",
          ["-C", repoDir, "diff", "--name-only", "--diff-filter=U"],
          { cwd: repoDir, timeoutMs: 10_000 },
        );
        const files = filesRes.ok
          ? filesRes.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, MAX_CONFLICT_FILES)
          : [];
        if (files.length > 0 || isMergeConflictOutput(output)) {
          // Abort so the workspace is exactly as the agent left it. A branch
          // parked in a conflicted merge state would break the delivering
          // engagement's next run, which is the one actor that can resolve it.
          const abortRes = await exec(
            "git",
            ["-C", repoDir, "merge", "--abort"],
            { cwd: repoDir, timeoutMs: 30_000 },
          );
          const detail = redactGitOutput(
            abortRes.ok ? output : `${output}\n${abortRes.stderr}`,
            { token },
          );
          const fields: GitLogFields = { taskKey, branch, base, files };
          if (!abortRes.ok) fields.abortFailed = true;
          logger.info("branch update conflicted — merge aborted", fields);
          const conflict: Extract<UpdateBranchResult, { status: "conflict" }> = {
            status: "conflict",
            branch,
            base,
            files,
          };
          if (detail) conflict.detail = detail;
          return conflict;
        }
        const detail = redactGitOutput(output, { token });
        const fields: GitLogFields = { taskKey, branch, base };
        if (mergeRes.timedOut) fields.timedOut = true;
        if (detail) fields.detail = detail;
        logger.warn("branch update merge failed", fields);
        return updateFailed(
          mergeRes.timedOut
            ? `merging \`${base}\` was cancelled after ${MERGE_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : `merging \`${base}\` into \`${branch}\` failed`,
          detail,
        );
      }

      // 4. Publish. A fast-forward on the remote by construction (the merge sits
      //    on top of the branch head) — anything else means someone else wrote
      //    to the branch, which is a human decision (R18-4), never a force-push.
      const pushRes = await exec(
        "git",
        ["-C", repoDir, "push", "origin", `HEAD:refs/heads/${branch}`],
        { cwd: repoDir, timeoutMs: PUSH_TIMEOUT_MS, env: askpass.env },
      );
      if (!pushRes.ok) {
        await exec("git", ["-C", repoDir, "reset", "--hard", preSha], {
          cwd: repoDir,
          timeoutMs: 15_000,
        });
        if (isNonFastForwardStderr(pushRes.stderr)) {
          logger.info("branch update push rejected non-fast-forward", {
            taskKey,
            branch,
          });
          return {
            status: "push_conflict",
            branch,
            base,
            reason:
              `the remote branch \`${branch}\` holds commits that are not in this ` +
              `workspace (non-fast-forward) — the update was rolled back, not forced`,
          };
        }
        const detail = redactGitOutput(pushRes.stderr, { token });
        const fields: GitLogFields = { taskKey, branch };
        if (pushRes.timedOut) fields.timedOut = true;
        if (detail) fields.detail = detail;
        logger.warn("branch update push failed", fields);
        return updateFailed(
          pushRes.timedOut
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : "pushing the updated branch returned non-zero — the update was rolled back",
          detail,
        );
      }

      logger.info("brought the task branch up to date with its base", {
        taskKey,
        branch,
        base,
        commits: behind,
      });
      return { status: "updated", branch, base, commits: behind };
    } finally {
      askpass.dispose();
    }
  } catch (error) {
    logger.info("branch update errored", {
      taskKey,
      err: error instanceof Error ? error.message : String(error),
    });
    return { status: "update_failed", reason: "unexpected error" };
  }
}
