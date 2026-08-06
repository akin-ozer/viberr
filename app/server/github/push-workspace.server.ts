import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createGitHubAskpassEnv } from "~/server/tasks/git-clone-auth.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
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
  /** B-GH1/F15-15: the remote branch holds commits the local delivery does not
   *  (non-fast-forward) — a HISTORY divergence, never a credential problem. The
   *  branch is carried so recovery copy can name what diverged. */
  | { status: "push_conflict"; branch: string; reason: string }
  /** F19-18: the residual failure bucket. `reason` is Viberr's own sentence;
   *  `detail` is git's text, scrubbed (`redactGitOutput`). Without the latter a
   *  protected-branch, pre-receive-hook or permission rejection reached the
   *  human as the literal words "git push returned non-zero", and the only way
   *  to learn the cause was to reproduce the push outside the product. */
  | { status: "push_failed"; reason: string; detail?: string }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_branch"
        | "no_commits"
        | "grant_withheld"
        | "task_not_found";
      reason: string;
    };

/** Ceiling for the branch push itself (the one network step here). */
const PUSH_TIMEOUT_MS = 120_000;

interface Exec {
  (
    file: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    /** The child was KILLED (timeout), not merely unsuccessful. */
    timedOut?: boolean;
  }>;
}

/** Exported ONLY so its timeout detection can be proven against a really-killed
 *  child. Injecting a fake `exec` in a test proves the classification above but
 *  says nothing about whether a kill is detected at all. */
export const defaultExec: Exec = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    // A timeout is a KILL, not a non-zero exit, and saying "returned non-zero"
    // about a process that never returned sends the reader looking for a git
    // error that was never printed. Same failure the clone path had, one pipe
    // over: the true cause was "we did not wait long enough".
    const timedOut = err.killed === true || typeof err.signal === "string";
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
};

/**
 * Non-fast-forward classifier for `git push` stderr (B-GH1). git's rejection
 * text is stable across versions: `! [rejected] ... (non-fast-forward)` or the
 * `(fetch first)` hint when the remote ref moved. Exported for its unit test —
 * misclassifying here re-creates the F15-15 "blame the credential" copy.
 */
export function isNonFastForwardStderr(stderr: string): boolean {
  return (
    /non-fast-forward/i.test(stderr) ||
    /fetch first/i.test(stderr) ||
    (/\[rejected\]/i.test(stderr) && /behind its remote counterpart/i.test(stderr))
  );
}

/**
 * Commits on HEAD that the default branch does not carry — `null` when history
 * cannot answer honestly (A3).
 *
 * Two rules, both matching `reconcileWorkspaceDelivery`'s commit count, which
 * this path had drifted from:
 *  - compare against `origin/<default>`, the remote-tracking ref, not the LOCAL
 *    default branch: the agent owns the local one and a workspace is reused
 *    across runs;
 *  - specialist clones are `--depth 1`, so the range runs over truncated history
 *    and every reachable commit looks "ahead". Deepen first; a deepen that fails
 *    (offline, no remote) leaves the answer unknown rather than wrong.
 */
async function countCommitsAhead(
  exec: Exec,
  repoDir: string,
  defaultBranch: string,
): Promise<number | null> {
  const shallowRes = await exec(
    "git",
    ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  if (shallowRes.ok && shallowRes.stdout.trim() === "true") {
    const deepen = await exec(
      "git",
      ["-C", repoDir, "fetch", "--deepen", "50", "origin", defaultBranch],
      { cwd: repoDir, timeoutMs: 30_000 },
    );
    if (!deepen.ok) return null;
  }
  const countRes = await exec(
    "git",
    ["-C", repoDir, "rev-list", "--count", `origin/${defaultBranch}..HEAD`],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  if (!countRes.ok) return null;
  const parsed = Number.parseInt(countRes.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  workdir?: string | null;
  /**
   * Whether the DELIVERING profile is authorized to write/commit/push the repo
   * (its `execute-code-or-write-repo` / `commit-push-branch` grant, resolved by
   * the caller). Defaults to `true` for callers/tests that don't gate. When
   * `false`, the server refuses to stage/commit/push the workspace — capability
   * grants shown as enforced must actually constrain server-owned delivery
   * (F10-03). This is the real enforcement for Codex, which ignores the tool
   * denylist and could otherwise write + have its dirty tree auto-committed.
   */
  canCommitPush?: boolean;
  /** Injected runner (tests). */
  exec?: Exec;
}

/**
 * Push the task's workspace branch to origin using the project PAT. Returns a
 * typed result; never throws. `pushed` means the remote now carries the local
 * commits (a `git push` with nothing new still reports `pushed`); `no_commits`
 * means the branch had no local commits ahead of the default branch; every
 * other status is a degraded reason the caller can log or surface.
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
      dataRoot,
    };
    // The task file is still read as the existence check — a push against a
    // task that has no canonical record must not proceed.
    if (!readTaskFile(ref)) {
      return { status: "task_not_found", reason: "task file missing" };
    }

    const projectFile = readProjectFile({
      projectSlug,
      dataRoot,
    });
    // P13-D-5: one project, one repository — the task-level override is gone.
    const repo = projectFile?.parsed.frontmatter.repo ?? null;
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

    // F10-03: server-owned delivery honors the delivering profile's repo-write
    // grant. If that capability is withheld, the server must NOT stage, commit,
    // or push the workspace — otherwise a "read-only" or grant-withheld profile
    // (notably a Codex run, which ignores the tool denylist) could still have
    // its dirty tree delivered. Refuse before touching the index or the remote.
    if (input.canCommitPush === false) {
      logger.info("skipping workspace delivery — repo-write grant withheld", {
        taskKey,
        branch,
      });
      return {
        status: "grant_withheld",
        reason: "delivering profile's repository-write capability is withheld",
      };
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
      // F15: `git add -A` intentionally delivers the agent's whole working tree
      // (the uncommitted changes ARE the deliverable) and already honors
      // `.gitignore`, so build artifacts / deps stay out. Capture the file list
      // so unexpected/stray files in a REUSED workspace are visible for review
      // rather than silently shipped into the PR.
      const changedFiles = statusRes.stdout
        .trim()
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      const addRes = await exec(
        "git",
        ["-C", repoDir, "add", "-A"],
        { cwd: repoDir, timeoutMs: 15_000 },
      );
      if (addRes.ok) {
        // F24: prefer the workspace's configured identity (cloneRepo stamps it to
        // the delivering profile, matching the agent's own commits). Fall back to
        // a stable Viberr identity only when no user is configured, so a fresh
        // clone with no identity never dead-ends the commit.
        const emailRes = await exec(
          "git",
          ["-C", repoDir, "config", "user.email"],
          { cwd: repoDir, timeoutMs: 5_000 },
        );
        const identityArgs =
          emailRes.ok && emailRes.stdout.trim() !== ""
            ? []
            : [
                "-c",
                "user.name=Viberr Delivery",
                "-c",
                "user.email=delivery@viberr.local",
              ];
        const commitRes = await exec(
          "git",
          [
            "-C",
            repoDir,
            ...identityArgs,
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
            files: changedFiles,
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
    // `null` is UNKNOWN and is NOT "no commits": a failed rev-list used to read
    // as 0, so a real delivery reported `no_commits` and the caller opened a PR
    // over a remote nobody had pushed to (A3, the F15-15 hazard class through a
    // different door). Unknown pushes: a push with nothing new is a no-op, while
    // skipping one that had commits is the failure that matters.
    const localAhead = await countCommitsAhead(exec, repoDir, defaultBranch);
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
        { cwd: repoDir, timeoutMs: PUSH_TIMEOUT_MS, env: askpass.env },
      );
      if (!pushRes.ok) {
        // B-GH1/F15-15: a NON-FAST-FORWARD rejection is a history divergence
        // (the remote branch carries commits the local delivery does not — a
        // pre-existing branch under the task key, a rebase, a reused
        // workspace), and it must never be reported as a credential problem.
        // git names it deterministically on stderr; classify before redacting.
        if (isNonFastForwardStderr(pushRes.stderr)) {
          logger.info("workspace branch push rejected non-fast-forward", {
            taskKey,
            branch,
          });
          return {
            status: "push_conflict",
            branch,
            reason:
              `the remote branch \`${branch}\` holds commits that are not in ` +
              `the local delivery (non-fast-forward)`,
          };
        }
        // F19-18: git's stderr is SCRUBBED, not dropped. `createGitHubAskpassEnv`
        // keeps the PAT out of argv and out of the remote URL, so what is left
        // is git's diagnosis — the only text that can name a protected branch, a
        // push ruleset or a pre-receive hook. A failed delivery push used to
        // record its reason NOWHERE: not the timeline, not the log, just the
        // fixed words "git push returned non-zero".
        //
        // WARN, not info, for the same reason the clone path is: a delivery that
        // did not happen changes what the review PR would have contained.
        const detail = redactGitOutput(pushRes.stderr, { token });
        logger.warn("workspace branch push failed", {
          taskKey,
          branch,
          ...(pushRes.timedOut ? { timedOut: true } : {}),
          ...(detail ? { detail } : {}),
        });
        return {
          status: "push_failed",
          reason: pushRes.timedOut
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : "git push returned non-zero",
          ...(detail ? { detail } : {}),
        };
      }
    } finally {
      askpass.dispose();
    }

    logger.info("pushed workspace branch to origin", {
      taskKey,
      branch,
      commits: localAhead,
    });
    // `commits: null` (history unreadable) reports 0 — the push happened, the
    // count is the only thing we don't know.
    return { status: "pushed", branch, commits: localAhead ?? 0 };
  } catch (error) {
    logger.info("workspace branch push errored — skipping", {
      taskKey,
      err: error instanceof Error ? error.message : String(error),
    });
    return { status: "push_failed", reason: "unexpected error" };
  }
}
