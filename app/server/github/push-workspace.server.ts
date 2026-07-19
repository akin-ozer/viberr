import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createGitHubAskpassEnv } from "~/server/tasks/git-clone-auth.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";

/**
 * Server-side workspace push (F-GH3 — closing the governed-delivery gap).
 *
 * A real coding specialist commits INSIDE its cloned workspace but does not
 * push: the Codex Developer runs sandboxed with no network, and even a Claude
 * run's clone persists only the credential-free origin URL, so it holds no push
 * auth. Meanwhile the server-side delivery path opened the remote task branch at
 * the default branch's SHA (empty). Nobody bridged the two — the local commits
 * never reached the remote, so opening the review PR hit GitHub 422 ("no commits
 * between base and head") and the chain silently dead-ended at "nothing to
 * review".
 *
 * This runs at the review boundary, BEFORE opening the PR: it re-supplies the
 * project PAT via the same short-lived askpass mechanism the clone uses and
 * pushes the workspace's task branch to origin, so the remote branch carries the
 * real diff the PR needs. Best-effort and never throws — a missing PAT, missing
 * workspace, or offline remote degrades to a typed reason the caller surfaces.
 */

const execFileAsync = promisify(execFile);

export type PushWorkspaceResult =
  | { status: "pushed"; branch: string; commits: number }
  | { status: "up_to_date"; branch: string }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_branch"
        | "no_commits"
        | "push_failed"
        | "task_not_found";
      reason: string;
    };

interface Exec {
  (
    file: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

const defaultExec: Exec = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
    };
  }
};

/** Locate the workspace git repo for a task (same conventions as the reconciler). */
function findRepoDir(
  projectSlug: string,
  taskKey: string,
  repoName: string,
  dataRoot?: string,
  workdir?: string | null,
): string | null {
  const wsRoot = path.join(taskDir(projectSlug, taskKey, dataRoot), "workspace");
  const candidates = [
    workdir ?? null,
    path.join(wsRoot, repoName),
    path.join(wsRoot, "repo"),
    wsRoot,
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(path.join(c, ".git"))) ?? null;
}

export interface PushWorkspaceBranchInput {
  db: Database.Database;
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  workdir?: string | null;
  /** Injected runner (tests). */
  exec?: Exec;
}

/**
 * Push the task's workspace branch to origin using the project PAT. Returns a
 * typed result; never throws. `pushed` means the remote now carries the local
 * commits; `up_to_date` means the remote already matched; every other status is
 * a degraded reason the caller can log or surface.
 */
export async function pushWorkspaceBranch(
  input: PushWorkspaceBranchInput,
): Promise<PushWorkspaceResult> {
  const { db, projectSlug, taskKey, dataRoot } = input;
  const exec = input.exec ?? defaultExec;
  try {
    const ref = {
      projectSlug,
      taskKey,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    };
    const file = readTaskFile(ref);
    if (!file) return { status: "task_not_found", reason: "task file missing" };
    const fm = file.parsed.frontmatter;

    const projectFile = readProjectFile({
      projectSlug,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    });
    const repo = fm.repo ?? projectFile?.parsed.frontmatter.repo ?? null;
    if (!repo) return { status: "no_repo", reason: "project has no repo" };
    const defaultBranch =
      projectFile?.parsed.frontmatter.defaultBranch || "main";
    const repoName = repo.split("/").pop() ?? repo;

    const repoDir = findRepoDir(
      projectSlug,
      taskKey,
      repoName,
      dataRoot,
      input.workdir,
    );
    if (!repoDir) {
      return { status: "no_workspace", reason: "no workspace git repo" };
    }

    // The branch HEAD is on (a real task branch, not the default branch).
    const headRes = await exec(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const branch = headRes.ok ? headRes.stdout.trim() : "";
    if (!branch || branch === "HEAD" || branch === defaultBranch) {
      return { status: "no_branch", reason: `HEAD not on a task branch (${branch || "detached"})` };
    }

    // Server-side DELIVERY FINALIZATION: if the agent WROTE changes but never
    // committed them, commit the working tree now so delivery reaches the
    // branch. The agent may not commit for legitimate reasons — its
    // `execute-code-or-write-repo` grant is withheld (so its prompt is told NOT
    // to commit), a Codex run wrote files but read its "workspace contract" as
    // prohibiting commit, etc. At the Review boundary those changes ARE the
    // deliverable (the human reviews the resulting PR), and delivery must not
    // dead-end just because the agent left them uncommitted. A well-behaved
    // agent that already committed leaves a clean tree here — this is a no-op
    // for it. Only reachable once HEAD is confirmed on the task branch (never
    // the default), so it can never auto-commit onto main.
    const statusRes = await exec(
      "git",
      ["-C", repoDir, "status", "--porcelain"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    if (statusRes.ok && statusRes.stdout.trim() !== "") {
      const addRes = await exec(
        "git",
        ["-C", repoDir, "add", "-A"],
        { cwd: repoDir, timeoutMs: 15_000 },
      );
      if (addRes.ok) {
        const commitRes = await exec(
          "git",
          [
            "-C",
            repoDir,
            // Inline identity so the commit works even in a fresh clone with no
            // configured user; the AGENT already wrote the content.
            "-c",
            "user.name=Viberr Delivery",
            "-c",
            "user.email=delivery@viberr.local",
            "commit",
            "-m",
            `[${taskKey}] deliver working-tree changes from the agent run`,
          ],
          { cwd: repoDir, timeoutMs: 20_000 },
        );
        if (commitRes.ok) {
          logger.info("committed uncommitted workspace changes for delivery", {
            taskKey,
            branch,
          });
        } else {
          logger.info("delivery auto-commit failed — pushing existing commits only", {
            taskKey,
            branch,
          });
        }
      }
    }

    // Count local commits not on the default branch — nothing to push otherwise.
    const countRes = await exec(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${defaultBranch}..HEAD`],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const localAhead = countRes.ok ? Number.parseInt(countRes.stdout.trim(), 10) || 0 : 0;
    if (localAhead === 0) {
      return { status: "no_commits", reason: "no local commits ahead of the default branch" };
    }

    const credential = getProjectCredential(db, projectSlug);
    const token = credential ? getPatToken(db, credential.id) : null;
    if (!token) return { status: "no_pat", reason: "no project credential" };

    const askpass = createGitHubAskpassEnv({ token });
    try {
      const pushRes = await exec(
        "git",
        ["-C", repoDir, "push", "origin", `HEAD:refs/heads/${branch}`],
        { cwd: repoDir, timeoutMs: 30_000, env: askpass.env },
      );
      if (!pushRes.ok) {
        // Redact stderr — a git push failure can echo the remote URL/token.
        logger.info("workspace branch push failed", { taskKey, branch });
        return { status: "push_failed", reason: "git push returned non-zero" };
      }
    } finally {
      askpass.dispose();
    }

    logger.info("pushed workspace branch to origin", {
      taskKey,
      branch,
      commits: localAhead,
    });
    return { status: "pushed", branch, commits: localAhead };
  } catch (error) {
    logger.info("workspace branch push errored — skipping", {
      taskKey,
      err: error instanceof Error ? error.message : String(error),
    });
    return { status: "push_failed", reason: "unexpected error" };
  }
}
