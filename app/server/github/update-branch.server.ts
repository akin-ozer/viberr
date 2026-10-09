import type { DatabaseSync } from "node:sqlite";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  createGitHubAskpassEnv,
  githubRepositoryUrl,
} from "~/server/tasks/git-clone-auth.server";
import { withServerStage } from "~/server/tasks/repo-mirror.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  PUSH_TIMEOUT_MS,
  commitIdentityArgs,
  deliveryRunners,
  findWorkspaceRepoDir,
  isNonFastForwardStderr,
  isWorkflowScopeRejection,
  publishFromWorkspace,
  storeLayoutFilesInTree,
  storeLayoutPrefix,
  changedFilesOnBranch,
  type Exec,
} from "./push-workspace.server";
import { activeFileLeases } from "~/server/tasks/file-leases.server";
import { leaseConflictFor, leaseRefusal } from "~/shared/file-leases";
import { errorMessage } from "~/shared/errors";

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
 *
 * Pass 40 review (R-seams-1): "the server owns the git" no longer means the
 * server's uid runs it in the workspace. The merge, its abort and every read
 * run in the workspace as the task's person; GitHub's base and origin's copy
 * of the branch are fetched with the PAT into a stage the server owns and the
 * workspace fetches them from there; the push goes out from the stage.
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

/**
 * Ruling 229 (pass 34, F34-11): origin's copy of the TASK BRANCH, related
 * to the workspace head from the workspace's own history (the remote ref is
 * fetched, so `merge-base --is-ancestor` has the object). `current`: origin
 * carries the workspace head. `behind`: origin's head is an ancestor of the
 * workspace head, `commits` behind; `deliver_for_review` pushes it. `diverged`:
 * origin holds commits this workspace does not, so a plain push is refused.
 * `absent`: the branch does not exist on origin yet. `unknown`: the remote ref
 * could not be read, `why` says what git said.
 */
export type RemoteBranchState =
  | { kind: "current"; headSha: string }
  | { kind: "behind"; headSha: string; commits: number }
  | { kind: "diverged"; headSha: string }
  | { kind: "absent" }
  | { kind: "unknown"; why: string };

export type UpdateBranchResult =
  /** The branch now carries the base. `commits` is how many base commits it was
   *  missing. Ruling 239: `mergeSha` is the merge commit the refresh created and
   *  `baseSha` the base tip it merged (both read BEFORE the push, so a merge is
   *  never published unrecorded). Ruling 229: `remoteBefore` is origin's copy
   *  as it stood before this update and `remote` as the push left it
   *  (`current` by construction: the push published HEAD). Ruling 239: `onto`
   *  is the branch head the merge was made on, its first parent. */
  | {
      status: "updated";
      branch: string;
      base: string;
      commits: number;
      mergeSha: string;
      baseSha: string;
      onto: string;
      remoteBefore: RemoteBranchState;
      remote: RemoteBranchState;
    }
  /** Idempotent no-op on the BASE: nothing on the base that the branch does not
   *  have. `remote` still reports origin's copy of the branch (ruling 229):
   *  "already up to date with main" must never pronounce a lagging branch done. */
  | { status: "already_current"; branch: string; base: string; remote: RemoteBranchState }
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
      /** Ruling 129: the base tip the merge was attempted against (full sha),
       *  so "the same conflict" is the same files against the same base
       *  commit. Absent when it could not be read. */
      baseSha?: string;
    }
  /**
   * The remote branch holds commits this workspace does not (non-fast-forward)
   * — a HISTORY divergence, never a credential problem (B-GH1/F15-15). The
   * local merge is rolled back and nothing is force-pushed (R18-4).
   * Ruling 129: `remoteHeadSha` is origin's head that refused the push, as
   * read before the merge; absent when it could not be read.
   */
  | { status: "push_conflict"; branch: string; base: string; reason: string; remoteHeadSha?: string }
  /**
   * Ruling 229, pass 35 review: the workspace tree carries Viberr's own
   * store layout, so this door refuses too. The delivery push is not the only
   * one that publishes the branch — this one pushes the whole workspace HEAD,
   * so every commit made since the last delivery rides along, the delivery
   * refusal's own commit included (`pushWorkspaceBranch` auto-commits a dirty
   * tree BEFORE it reads it). Nothing is merged and nothing is pushed: the
   * branch is exactly as it was, and the paths say what to remove.
   */
  | { status: "store_layout"; branch: string; files: string[]; reason: string }
  /**
   * Ruling 241: a file this branch changes is leased to another task, so this
   * door refuses as the delivery push does (ruling 60). It publishes the
   * whole workspace head, so unpushed work rides along; live on ax-clone
   * AX-22's refresh at 00:11 published its rework while AX-20 held
   * `internal/controller/task.go`. Nothing is merged and nothing is pushed.
   */
  | { status: "lease_held"; branch: string; path: string; holder: string; reason: string }
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
  /** Injected runner (tests): the workspace's git and the server's. */
  exec?: Exec;
}

/** git's answer to fetching a ref the remote does not have. */
function isMissingRemoteRef(stderr: string): boolean {
  return /couldn't find remote ref|no such ref was fetched|Remote branch .* not found/i.test(stderr);
}

/**
 * Ruling 229: fetch origin's copy of the task branch and relate it to the
 * workspace head LOCALLY. `ls-remote` alone cannot answer `behind` vs
 * `diverged` (that needs the remote head OBJECT), and a head pushed from
 * another workspace is exactly the case the answer matters for. R-seams-1:
 * GitHub's copy is fetched with the PAT into the server's `stage`, and the
 * workspace fetches it from there as its person.
 */
async function readRemoteBranchState(
  runners: { workspace: Exec; server: Exec },
  stage: string,
  remoteUrl: string,
  repoDir: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  token: string,
): Promise<RemoteBranchState> {
  const exec = runners.workspace;
  const fetchRes = await runners.server(
    "git",
    [`--git-dir=${stage}`, "fetch", "--no-tags", remoteUrl, `+refs/heads/${branch}:refs/heads/${branch}`],
    { cwd: stage, timeoutMs: FETCH_TIMEOUT_MS, env },
  );
  if (!fetchRes.ok) {
    if (isMissingRemoteRef(fetchRes.stderr)) return { kind: "absent" };
    const why = redactGitOutput(fetchRes.stderr, { token }) || "the fetch failed";
    return { kind: "unknown", why: fetchRes.timedOut ? "the fetch ran past its time limit" : why };
  }
  const intoWorkspace = await exec(
    "git",
    ["-C", repoDir, "fetch", "--no-tags", stage, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: repoDir, timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (!intoWorkspace.ok) {
    return {
      kind: "unknown",
      why: redactGitOutput(intoWorkspace.stderr, { token }) || "origin's copy could not be brought into the workspace",
    };
  }
  const remoteRes = await exec(
    "git",
    ["-C", repoDir, "rev-parse", "--verify", `refs/remotes/origin/${branch}`],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  const headRes = await exec("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    cwd: repoDir,
    timeoutMs: 5_000,
  });
  const remoteHead = remoteRes.ok ? remoteRes.stdout.trim() : "";
  const head = headRes.ok ? headRes.stdout.trim() : "";
  if (!remoteHead || !head) {
    return { kind: "unknown", why: "the fetched remote ref could not be read" };
  }
  if (remoteHead === head) return { kind: "current", headSha: remoteHead };
  const ancestor = await exec(
    "git",
    ["-C", repoDir, "merge-base", "--is-ancestor", remoteHead, head],
    { cwd: repoDir, timeoutMs: 10_000 },
  );
  if (!ancestor.ok) return { kind: "diverged", headSha: remoteHead };
  const countRes = await exec(
    "git",
    ["-C", repoDir, "rev-list", "--count", `${remoteHead}..HEAD`],
    { cwd: repoDir, timeoutMs: 10_000 },
  );
  const commits = countRes.ok ? Number.parseInt(countRes.stdout.trim(), 10) : Number.NaN;
  return { kind: "behind", headSha: remoteHead, commits: Number.isFinite(commits) ? commits : 1 };
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

    const repoDir = findWorkspaceRepoDir(projectSlug, taskKey, repoName, dataRoot);
    if (!repoDir) {
      return {
        status: "no_workspace",
        reason:
          "no workspace git repo (the branch is only writable from the delivering engagement's workspace)",
      };
    }
    // R-seams-1: `exec` is the workspace's own git, as the task's person.
    const runners = deliveryRunners(db, { projectSlug, taskKey, dataRoot }, input);
    const exec = runners.workspace;

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
          "the workspace has uncommitted changes (deliver or discard them before updating the branch)",
      };
    }

    // Ruling 229: "viberr must never publish its own store layout into a
    // customer repository, whatever an agent did" — and this is the second
    // door that publishes the branch. It pushes the whole workspace HEAD, so a
    // stray folder the delivery refusal left committed on the local branch
    // would reach origin here. Read BEFORE the fetch and the merge: a refusal
    // costs no network and leaves nothing to roll back.
    const storeLayoutFiles = await storeLayoutFilesInTree(exec, repoDir, projectSlug);
    if (storeLayoutFiles === null) {
      logger.info("could not read the workspace tree for the store-layout check", {
        taskKey,
        branch,
      });
    } else if (storeLayoutFiles.length > 0) {
      logger.info("branch update refused: the tree carries the store layout", {
        taskKey,
        branch,
        files: storeLayoutFiles,
      });
      return {
        status: "store_layout",
        branch,
        files: storeLayoutFiles,
        reason:
          `the branch carries ${storeLayoutFiles.map((f) => `\`${f}\``).join(", ")}, ` +
          `which is Viberr's own store layout (\`${storeLayoutPrefix(projectSlug)}\`), not part of ` +
          `the repository, so the branch was not moved and nothing was pushed`,
      };
    }

    // Ruling 241: the lease gate, at the same seam and read the same way as
    // the delivery push's (the BRANCH's files, ruling 60; the resolved list,
    // ruling 60). Before the fetch and the merge, like the store-layout
    // check above: a refusal costs no network and leaves nothing to roll back.
    const leases = activeFileLeases(projectSlug, dataRoot ? { dataRoot } : {});
    if (leases.length > 0) {
      const changed = await changedFilesOnBranch(exec, repoDir, base);
      if (changed === null) {
        logger.info("could not measure the files this branch changes; no lease gate", {
          taskKey,
          branch,
        });
      } else {
        const conflict = leaseConflictFor(changed, leases, taskKey);
        if (conflict) {
          logger.info("branch update refused: file lease", {
            taskKey,
            branch,
            path: conflict.path,
            holder: conflict.lease.taskKey,
          });
          return {
            status: "lease_held",
            branch,
            path: conflict.path,
            holder: conflict.lease.taskKey,
            reason: leaseRefusal(taskKey, conflict, "its branch is moved and pushed"),
          };
        }
      }
    }

    const credential = getProjectCredential(db, projectSlug);
    const token = credential ? getPatToken(db, credential.id) : null;
    if (!token) return { status: "no_pat", reason: "no project credential" };

    const askpass = createGitHubAskpassEnv({ token });
    // R-seams-1: the project's own GitHub URL, never the `origin` a checkout's
    // agent-writable config names.
    const remoteUrl = githubRepositoryUrl(repo);
    try {
      return await withServerStage(
        { projectSlug, repo, dataRoot },
        async (stage): Promise<UpdateBranchResult> => {
          // 1. Fetch the base. Specialist clones are `--depth 1`, so a merge would
          //    otherwise run against a truncated history that has no merge base
          //    with the advanced remote.
          const shallowRes = await exec(
            "git",
            ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
            { cwd: repoDir, timeoutMs: 5_000 },
          );
          const shallow = shallowRes.ok && shallowRes.stdout.trim() === "true";
          // R-seams-1: GitHub's base into the server's stage (the PAT's only
          // workplace), then into the workspace's `origin/<base>` as its person.
          const fetchRes = await runners.server(
            "git",
            [`--git-dir=${stage}`, "fetch", "--no-tags", remoteUrl, `+refs/heads/${base}:refs/heads/${base}`],
            { cwd: stage, timeoutMs: FETCH_TIMEOUT_MS, env: askpass.env },
          );
          const baseFetch = fetchRes.ok
            ? await exec(
                "git",
                [
                  "-C",
                  repoDir,
                  "fetch",
                  ...(shallow ? ["--unshallow"] : []),
                  "--no-tags",
                  stage,
                  // Explicit refspec: the update must read `origin/<base>`, and
                  // relying on git's opportunistic remote-tracking update makes
                  // that a version question.
                  `+refs/heads/${base}:refs/remotes/origin/${base}`,
                ],
                { cwd: repoDir, timeoutMs: FETCH_TIMEOUT_MS },
              )
            : fetchRes;
          if (!baseFetch.ok) {
            const detail = redactGitOutput(baseFetch.stderr, { token });
            const fields: GitLogFields = { taskKey, branch, base };
            if (baseFetch.timedOut) fields.timedOut = true;
            if (detail) fields.detail = detail;
            logger.warn("branch update could not fetch the base branch", fields);
            return updateFailed(
              baseFetch.timedOut
                ? `fetching \`${base}\` was cancelled after ${FETCH_TIMEOUT_MS / 1000}s because it ran past its time limit rather than failing`
                : `could not fetch \`${base}\` from origin`,
              detail,
            );
          }

          // 1b. Origin's copy of the TASK branch (ruling 229). A separate fetch:
          //    a refspec naming a ref origin does not have fails the whole fetch,
          //    and a never-pushed branch is a normal state here, not a failure.
          const remote = await readRemoteBranchState(
            runners,
            stage,
            remoteUrl,
            repoDir,
            branch,
            askpass.env,
            token,
          );

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
            return { status: "already_current", branch, base, remote };
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
              // Ruling 239: every refresh is a real merge commit, so the drift
              // classifier can tell a base refresh (a two-parent commit recorded in
              // `baseRefreshes`) from authored work. A fast-forward would leave
              // nothing to record.
              "--no-ff",
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
              logger.info("branch update conflicted; merge aborted", fields);
              const conflict: Extract<UpdateBranchResult, { status: "conflict" }> = {
                status: "conflict",
                branch,
                base,
                files,
              };
              if (detail) conflict.detail = detail;
              // Ruling 129: the base commit this conflict is against, so a
              // second conflict can be told apart from the one already sent to
              // the delivering agent. Read after the abort; best-effort.
              const conflictBaseRes = await exec(
                "git",
                ["-C", repoDir, "rev-parse", `refs/remotes/origin/${base}`],
                { cwd: repoDir, timeoutMs: 5_000 },
              );
              const conflictBaseSha = conflictBaseRes.ok ? conflictBaseRes.stdout.trim() : "";
              if (conflictBaseSha) conflict.baseSha = conflictBaseSha;
              return conflict;
            }
            const detail = redactGitOutput(output, { token });
            const fields: GitLogFields = { taskKey, branch, base };
            if (mergeRes.timedOut) fields.timedOut = true;
            if (detail) fields.detail = detail;
            logger.warn("branch update merge failed", fields);
            return updateFailed(
              mergeRes.timedOut
                ? `merging \`${base}\` was cancelled after ${MERGE_TIMEOUT_MS / 1000}s because it ran past its time limit rather than failing`
                : `merging \`${base}\` into \`${branch}\` failed`,
              detail,
            );
          }

          // 3b. The merge commit and the base tip, read BEFORE the push (ruling
          //    239): a merge that cannot be recorded is not published. An unreadable
          //    sha resets to `preSha` exactly like a failed push.
          const mergeShaRes = await exec("git", ["-C", repoDir, "rev-parse", "HEAD"], {
            cwd: repoDir,
            timeoutMs: 5_000,
          });
          const baseShaRes = await exec(
            "git",
            ["-C", repoDir, "rev-parse", `refs/remotes/origin/${base}`],
            { cwd: repoDir, timeoutMs: 5_000 },
          );
          const mergeSha = mergeShaRes.ok ? mergeShaRes.stdout.trim() : "";
          const baseSha = baseShaRes.ok ? baseShaRes.stdout.trim() : "";
          if (!mergeSha || !baseSha || mergeSha === preSha) {
            await exec("git", ["-C", repoDir, "reset", "--hard", preSha], {
              cwd: repoDir,
              timeoutMs: 15_000,
            });
            logger.warn("branch update could not read the merge commit; rolled back", {
              taskKey,
              branch,
              base,
            });
            return updateFailed(
              "could not read the merge commit after merging, so the update was rolled back and nothing was pushed",
              redactGitOutput(`${mergeShaRes.stderr}\n${baseShaRes.stderr}`, { token }),
            );
          }

          // 4. Publish. A fast-forward on the remote by construction (the merge sits
          //    on top of the branch head) — anything else means someone else wrote
          //    to the branch, which is a human decision (R18-4), never a force-push.
          //    R-seams-1: the merge commit is read out of the workspace into the
          //    server's stage (as the person) and pushed from there.
          const published = await publishFromWorkspace({
            exec: runners.server,
            stage,
            launch: runners.launch,
            repoDir,
            branch,
            sha: mergeSha,
            remoteUrl,
            askpassEnv: askpass.env,
            timeoutMs: PUSH_TIMEOUT_MS,
          });
          if (published.phase === "handoff") {
            await exec("git", ["-C", repoDir, "reset", "--hard", preSha], {
              cwd: repoDir,
              timeoutMs: 15_000,
            });
            const detail = redactGitOutput(published.result.stderr, { token });
            const fields: GitLogFields = { taskKey, branch };
            if (published.result.timedOut) fields.timedOut = true;
            if (detail) fields.detail = detail;
            logger.warn("branch update could not read the merge out of the workspace", fields);
            return updateFailed(
              "the merge could not be read out of the workspace for the push, so the update was rolled back",
              detail,
            );
          }
          const pushRes = published.result;
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
              const pushConflict: Extract<UpdateBranchResult, { status: "push_conflict" }> = {
                status: "push_conflict",
                branch,
                base,
                reason:
                  `the remote branch \`${branch}\` holds commits that are not in this ` +
                  `workspace (non-fast-forward), so the update was rolled back, not forced`,
              };
              // Ruling 129: which of origin's heads refused it, when known.
              if ("headSha" in remote) pushConflict.remoteHeadSha = remote.headSha;
              return pushConflict;
            }
            const detail = redactGitOutput(pushRes.stderr, { token });
            // Ruling 221(a), the sibling this was never threaded through: GitHub's
            // refusal of a workflow-file push for a token without the `workflow`
            // scope is a SCOPE fact, not a generic push failure. The delivery push
            // classifies it and names the remedy; this one dropped it in the
            // catch-all bucket, so an operator base-refresh on a branch that
            // touches `.github/workflows/` failed with "pushing the updated branch
            // returned non-zero" — every time, forever, with nothing saying the
            // token simply lacks a scope.
            if (isWorkflowScopeRejection(pushRes.stderr)) {
              logger.info("branch update push refused by GitHub: workflow scope", {
                taskKey,
                branch,
              });
              return updateFailed(
                "GitHub refused the push because it changes a file under " +
                  "`.github/workflows/` and the token has no `workflow` scope, so the " +
                  "update was rolled back. Re-authorize the connection with that scope, " +
                  "or take the workflow change out of this branch",
                detail,
              );
            }
            const fields: GitLogFields = { taskKey, branch };
            if (pushRes.timedOut) fields.timedOut = true;
            if (detail) fields.detail = detail;
            logger.warn("branch update push failed", fields);
            return updateFailed(
              pushRes.timedOut
                ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s because it ran past its time limit rather than failing`
                : "pushing the updated branch returned non-zero, so the update was rolled back",
              detail,
            );
          }

          logger.info("brought the task branch up to date with its base", {
            taskKey,
            branch,
            base,
            commits: behind,
          });
          return {
            status: "updated",
            branch,
            base,
            commits: behind,
            mergeSha,
            baseSha,
            onto: preSha,
            remoteBefore: remote,
            remote: { kind: "current", headSha: mergeSha },
          };
        },
      );
    } finally {
      askpass.dispose();
    }
  } catch (error) {
    logger.info("branch update errored", {
      taskKey,
      err: errorMessage(error),
    });
    return { status: "update_failed", reason: "unexpected error" };
  }
}
