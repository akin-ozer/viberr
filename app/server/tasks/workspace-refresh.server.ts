import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import { getPatToken, getProjectCredential } from "~/server/secrets/pat-store.server";
import { gitErrorText, redactGitOutput } from "~/server/secrets/git-output-redact.server";
import {
  mirrorGitEnv,
  refreshProjectMirror,
  type ProjectMirrorRequest,
} from "./repo-mirror.server";

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Ruling 129 (pass 34, Q34-5 / F34-6): a reused checkout is refreshed from
 * the project mirror on every dispatch.
 *
 * Live (JC-2 to JC-5): the task workspaces were cloned once, by the operators'
 * first triage, from a repository that was still EMPTY; every later run
 * reused them as they stood (agents hold no credential, so they could not
 * fetch), and while the operator read a bootstrapped `main` through the
 * mirror the spec writers found zero commits in their checkouts and committed
 * unrelated ROOT commits on their task branches.
 *
 * The rule: (1) refresh the project mirror from GitHub (creating it on a
 * delivering dispatch; falling back to a server-side credentialed fetch when
 * the mirror cannot be built), (2) fetch its heads into the checkout's
 * `origin/*`, (3) with `fastForward`, move a checkout that is unborn or sits
 * clean on the default branch to `origin/<default>`; a task branch, a dirty
 * tree and a detached HEAD are never touched (`update_branch_from_base` owns a
 * diverged task branch); a branch sharing NO history with the default branch
 * is NAMED (`unrelated`) so the damage is disclosed rather than silently left.
 * A failed refresh degrades with a warning: a cache never blocks a task.
 */
export type WorkspaceRefreshHead =
  /** HEAD was already `origin/<default>`. */
  | "current"
  /** HEAD is on a task branch (left as it is). */
  | "task_branch"
  /** On the default branch with commits origin does not have (left as it is). */
  | "local_commits"
  /** The working tree has uncommitted changes (never touched). */
  | "dirty"
  /** HEAD is detached (never touched). */
  | "detached"
  /** The mirror carries no `origin/<default>` yet (empty repository). */
  | "no_base"
  /** HEAD shares no history with `origin/<default>`: named, never moved. */
  | "unrelated"
  /** A fetch-only refresh (supporting checkouts). */
  | "not_requested";

export type WorkspaceRefreshResult =
  | {
      status: "fast_forwarded";
      head: string;
      from: "unborn" | "behind" | "behind_task_branch";
      mirrorRefreshed: boolean;
    }
  | { status: "fetched"; head: WorkspaceRefreshHead; mirrorRefreshed: boolean }
  | { status: "no_mirror" }
  | { status: "fetch_failed"; message: string };

export interface WorkspaceRefreshInput {
  projectSlug: string;
  /** `owner/repo`. */
  repo: string;
  /** The checkout to refresh. */
  dir: string;
  defaultBranch: string;
  dataRoot?: string;
  /** Move an unborn or clean default-branch checkout to `origin/<default>`
   *  (delivering dispatch); false = fetch only (supporting checkouts). */
  fastForward: boolean;
  /** Create the mirror when it is missing (a delivering dispatch pays it). */
  createMirror?: boolean;
  /** Ruling 179 (pass 36): the task's own branch. A clean checkout ON it that
   *  is strictly behind `origin/<taskBranch>` — commits Viberr did not deliver
   *  joined the branch, the external revision under review — is fast-forwarded
   *  to it, so a rework starts from the head the reviewers judge. A diverged
   *  branch is left as it is (the delivery's non-fast-forward refusal and a
   *  person own that). */
  taskBranch?: string | null;
}

async function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const out = await execFileAsync("git", ["-C", dir, ...args], {
    timeout: FETCH_TIMEOUT_MS,
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return out.stdout.trim();
}

/** `git <args>` as a yes/no question (exit 0 = yes). */
async function gitOk(dir: string, args: string[]): Promise<boolean> {
  try {
    await git(dir, args);
    return true;
  } catch {
    return false;
  }
}

export async function refreshWorkspaceFromMirror(
  db: DatabaseSync,
  input: WorkspaceRefreshInput,
): Promise<WorkspaceRefreshResult> {
  if (!existsSync(path.join(input.dir, ".git"))) {
    return { status: "fetch_failed", message: "the checkout has no .git directory" };
  }
  const cred = getProjectCredential(db, input.projectSlug);
  const token = cred ? getPatToken(db, cred.id) : null;
  const request: ProjectMirrorRequest = {
    projectSlug: input.projectSlug,
    repo: input.repo,
    token,
    create: input.createMirror ?? input.fastForward,
  };
  if (input.dataRoot) request.dataRoot = input.dataRoot;

  // 1. The mirror, refreshed from GitHub; 2. its heads into origin/*.
  let mirrorRefreshed = false;
  try {
    const mirror = await refreshProjectMirror(request);
    if (mirror) {
      mirrorRefreshed = mirror.refreshed;
      await git(input.dir, ["fetch", "--quiet", mirror.dir, "+refs/heads/*:refs/remotes/origin/*"]);
    } else {
      // No cache and none could be built: fetch the remote heads directly with
      // the project's credential through the askpass env (never argv or the
      // remote URL). The checkout's `origin` is the sanitized GitHub URL.
      if (!token) return { status: "no_mirror" };
      const auth = mirrorGitEnv(token);
      try {
        await git(
          input.dir,
          ["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"],
          auth.env,
        );
        mirrorRefreshed = true;
      } finally {
        auth.dispose();
      }
    }
  } catch (error) {
    const message = redactGitOutput(gitErrorText(error), { token });
    logger.warn("workspace refresh: could not fetch the remote heads; the run proceeds on the checkout as it stands", {
      projectSlug: input.projectSlug,
      repo: input.repo,
      dir: input.dir,
      message,
    });
    return { status: "fetch_failed", message };
  }

  if (!input.fastForward) return { status: "fetched", head: "not_requested", mirrorRefreshed };

  // 3. Where is HEAD, and may it move?
  const base = `origin/${input.defaultBranch}`;
  const hasBase = await gitOk(input.dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (!hasBase) return { status: "fetched", head: "no_base", mirrorRefreshed };

  let symbolic: string | null = null;
  try {
    symbolic = await git(input.dir, ["symbolic-ref", "-q", "HEAD"]);
  } catch {
    symbolic = null;
  }
  if (!symbolic) return { status: "fetched", head: "detached", mirrorRefreshed };
  const onDefault = symbolic === `refs/heads/${input.defaultBranch}`;
  const born = await gitOk(input.dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  // Tracked changes only: mounted skill folders and other untracked files are
  // ordinary in a reused workspace and must not freeze the refresh.
  const status = await git(input.dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (status) return { status: "fetched", head: "dirty", mirrorRefreshed };

  try {
    if (!born) {
      if (!onDefault) return { status: "fetched", head: "task_branch", mirrorRefreshed };
      await git(input.dir, ["checkout", "-q", "-B", input.defaultBranch, base]);
      const head = await git(input.dir, ["rev-parse", "HEAD"]);
      return { status: "fast_forwarded", head, from: "unborn", mirrorRefreshed };
    }
    const related = await gitOk(input.dir, ["merge-base", "HEAD", base]);
    if (!related) return { status: "fetched", head: "unrelated", mirrorRefreshed };
    if (!onDefault) {
      // Ruling 179: the task branch follows origin's copy when it is strictly
      // behind it. Live (HLC-18, 19:54Z): after an observer commit became the
      // external revision under review, the rework started from the old local
      // head, and its delivery was refused as non-fast-forward with "delete or
      // rename the remote branch, or force-push" — a dead end for work the
      // ruling had just declared the revision under review.
      const taskBranch = input.taskBranch;
      if (taskBranch && symbolic === `refs/heads/${taskBranch}`) {
        const remote = `origin/${taskBranch}`;
        const hasRemote = await gitOk(input.dir, ["rev-parse", "--verify", "--quiet", `${remote}^{commit}`]);
        if (hasRemote) {
          const headSha = await git(input.dir, ["rev-parse", "HEAD"]);
          const remoteSha = await git(input.dir, ["rev-parse", remote]);
          const behind =
            headSha !== remoteSha &&
            (await gitOk(input.dir, ["merge-base", "--is-ancestor", "HEAD", remote]));
          if (behind) {
            await git(input.dir, ["merge", "--ff-only", "--quiet", remote]);
            const head = await git(input.dir, ["rev-parse", "HEAD"]);
            return { status: "fast_forwarded", head, from: "behind_task_branch", mirrorRefreshed };
          }
        }
      }
      return { status: "fetched", head: "task_branch", mirrorRefreshed };
    }
    const headSha = await git(input.dir, ["rev-parse", "HEAD"]);
    const baseSha = await git(input.dir, ["rev-parse", base]);
    if (headSha === baseSha) return { status: "fetched", head: "current", mirrorRefreshed };
    const ancestor = await gitOk(input.dir, ["merge-base", "--is-ancestor", "HEAD", base]);
    if (!ancestor) return { status: "fetched", head: "local_commits", mirrorRefreshed };
    await git(input.dir, ["merge", "--ff-only", "--quiet", base]);
    const head = await git(input.dir, ["rev-parse", "HEAD"]);
    return { status: "fast_forwarded", head, from: "behind", mirrorRefreshed };
  } catch (error) {
    const message = redactGitOutput(gitErrorText(error), { token });
    logger.warn("workspace refresh: the fast-forward failed; the run proceeds on the checkout as it stands", {
      projectSlug: input.projectSlug,
      repo: input.repo,
      dir: input.dir,
      message,
    });
    return { status: "fetch_failed", message };
  }
}

/** The one-line disclosure for the run's `run·inputs` line and the agent's
 *  workspace contract. */
export function describeWorkspaceRefresh(
  result: WorkspaceRefreshResult,
  defaultBranch: string,
): string {
  const stale = (r: { mirrorRefreshed: boolean }) =>
    r.mirrorRefreshed ? "" : " (the mirror could not be refreshed from GitHub first, so origin/* may lag)";
  switch (result.status) {
    case "fast_forwarded":
      return result.from === "unborn"
        ? `fast-forwarded the unborn checkout to \`origin/${defaultBranch}\` at \`${result.head.slice(0, 7)}\`${stale(result)}`
        : result.from === "behind_task_branch"
          ? `fast-forwarded the task branch to origin's copy at \`${result.head.slice(0, 7)}\` — commits Viberr did not deliver joined it (ruling 179)${stale(result)}`
          : `fast-forwarded \`${defaultBranch}\` to \`origin/${defaultBranch}\` at \`${result.head.slice(0, 7)}\`${stale(result)}`;
    case "fetched":
      switch (result.head) {
        case "current":
          return `origin/* refreshed; the checkout was already at \`origin/${defaultBranch}\`${stale(result)}`;
        case "task_branch":
          return `origin/* refreshed; HEAD is on the task branch and was left as it is (update_branch_from_base owns a diverged task branch)${stale(result)}`;
        case "local_commits":
          return `origin/* refreshed; \`${defaultBranch}\` carries local commits origin does not and was left as it is${stale(result)}`;
        case "dirty":
          return `origin/* refreshed; the working tree has uncommitted changes and was not moved${stale(result)}`;
        case "detached":
          return `origin/* refreshed; HEAD is detached and was not moved${stale(result)}`;
        case "no_base":
          return `origin/* refreshed; the remote has no \`${defaultBranch}\` yet, so nothing to fast-forward to${stale(result)}`;
        case "unrelated":
          return `origin/* refreshed; this branch shares NO history with \`origin/${defaultBranch}\` and was left as it is (update_branch_from_base will refuse to merge unrelated histories)${stale(result)}`;
        case "not_requested":
          return `origin/* refreshed from the project mirror${stale(result)}`;
      }
      break;
    case "no_mirror":
      return "not refreshed: no project mirror and no credential to fetch with; origin/* is as old as the clone";
    case "fetch_failed":
      return `not refreshed: ${result.message}; origin/* is as old as the last successful fetch`;
  }
  return "";
}
