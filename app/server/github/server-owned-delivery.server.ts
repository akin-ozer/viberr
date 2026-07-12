import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import type { DeliveryPermissions } from "~/server/tasks/specialist-tool-policy";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  createGitHubAuthPlan,
  githubRemoteSanitizationArgs,
} from "~/server/tasks/git-clone-auth.server";
import { getBranchCompare, taskBranchName } from "./branch-sync.server";
import { getProjectGithubContext } from "./github-context.server";
import { openTaskPr } from "./pr-open.server";
import {
  reconcileWorkspaceDelivery,
  type CommandExec,
} from "./workspace-delivery.server";

export type DeliveryFailureCode =
  | "workspace_missing"
  | "workspace_invalid"
  | "local_branch_missing"
  | "uncommitted_changes"
  | "credential_missing"
  | "push_failed"
  | "remote_head_unverified"
  | "remote_diff_empty"
  | "pr_open_failed";

export type ServerOwnedDeliveryResult =
  | { status: "delivered"; branch: string; remoteSha: string; prNumber: number | null }
  | { status: "no_changes"; branch: string }
  | { status: "withheld"; reason: string }
  | {
      status: "failed";
      code: DeliveryFailureCode;
      title: string;
      detail: string;
    };

export type DeliveryExecResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "unavailable" | "failed" | "terminated" };

export type DeliveryExec = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<DeliveryExecResult>;

const execFileAsync = promisify(execFile);

const defaultExec: DeliveryExec = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      env: options.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error) {
    const value =
      error && typeof error === "object"
        ? (error as { code?: unknown; signal?: unknown; killed?: unknown })
        : {};
    return {
      ok: false,
      reason:
        value.code === "ENOENT"
          ? "unavailable"
          : value.killed || typeof value.signal === "string"
            ? "terminated"
            : "failed",
    };
  }
};

function failure(
  code: DeliveryFailureCode,
  title: string,
  detail: string,
): ServerOwnedDeliveryResult {
  return { status: "failed", code, title, detail };
}

function parseCommits(stdout: string): { sha: string; msg: string }[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...rest] = line.split("\t");
      return { sha, msg: rest.join("\t") };
    });
}

interface RemoteRef {
  object: { sha: string };
}

/**
 * Finalizes a real specialist's local work without giving the model a PAT.
 * Viberr alone authenticates the push, verifies exact remote HEAD plus a
 * non-empty compare, reconciles the canonical task, and opens/reuses the PR.
 */
export async function deliverSpecialistWorkspace(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    workdir: string | null;
    backend: RealBackend;
    role: string;
    permissions: DeliveryPermissions;
    dataRoot?: string;
  },
  options: { exec?: DeliveryExec; fetchImpl?: typeof fetch } = {},
): Promise<ServerOwnedDeliveryResult> {
  if (!input.permissions.canCommitPush) {
    return { status: "withheld", reason: "Remote branch delivery is withheld by policy." };
  }
  if (!input.workdir || !existsSync(`${input.workdir}/.git`)) {
    return failure(
      "workspace_missing",
      "Specialist delivery workspace is missing",
      "The run finished without a verified Git workspace. No remote delivery was attempted.",
    );
  }
  const taskRef = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
  const task = readTaskFile(taskRef);
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });
  if (!task || !project) {
    return failure(
      "workspace_invalid",
      "Specialist delivery context is missing",
      "The task or project record disappeared before delivery could be finalized.",
    );
  }
  const repo = task.parsed.frontmatter.repo ?? project.parsed.frontmatter.repo;
  if (!repo) {
    return failure(
      "workspace_invalid",
      "Specialist delivery repository is missing",
      "No repository is configured for this task, so remote delivery cannot be verified.",
    );
  }
  const defaultBranch = project.parsed.frontmatter.defaultBranch || "main";
  const expectedBranch =
    task.parsed.frontmatter.branch ??
    taskBranchName(input.taskKey, task.parsed.frontmatter.title);
  const exec = options.exec ?? defaultExec;
  const run = (args: string[], timeoutMs = 10_000, env?: NodeJS.ProcessEnv) =>
    exec("git", args, {
      cwd: input.workdir!,
      timeoutMs,
      ...(env ? { env } : {}),
    });

  const branchResult = await run(["-C", input.workdir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchResult.ok) {
    return failure(
      "workspace_invalid",
      "Specialist delivery workspace is invalid",
      "Viberr could not read the local branch. No remote delivery was attempted.",
    );
  }
  const branch = branchResult.stdout.trim();
  if (!branch || branch === "HEAD" || branch !== expectedBranch) {
    return failure(
      "local_branch_missing",
      "Task branch was not prepared",
      `The specialist must finish on the task branch ${expectedBranch}; the remote was not changed.`,
    );
  }
  const status = await run(["-C", input.workdir, "status", "--porcelain"]);
  if (!status.ok) {
    return failure(
      "workspace_invalid",
      "Specialist delivery workspace is invalid",
      "Viberr could not inspect the local working tree. No remote delivery was attempted.",
    );
  }
  const commitsResult = await run([
    "-C",
    input.workdir,
    "log",
    "--format=%h%x09%s",
    `origin/${defaultBranch}..HEAD`,
  ]);
  if (!commitsResult.ok) {
    return failure(
      "workspace_invalid",
      "Specialist delivery history is unavailable",
      "Viberr could not compare the task branch with the default branch.",
    );
  }
  const commits = parseCommits(commitsResult.stdout);
  if (commits.length === 0) {
    if (status.stdout.trim()) {
      return failure(
        "uncommitted_changes",
        "Specialist changes were not committed",
        "Local changes remain uncommitted. No remote delivery was attempted.",
      );
    }
    return { status: "no_changes", branch };
  }
  if (status.stdout.trim()) {
    return failure(
      "uncommitted_changes",
      "Specialist workspace is not clean",
      "The task branch has commits but also contains uncommitted changes. Review or commit them before retrying delivery.",
    );
  }
  const head = await run(["-C", input.workdir, "rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout.trim()) {
    return failure(
      "workspace_invalid",
      "Specialist delivery HEAD is unavailable",
      "Viberr could not identify the exact local commit to deliver.",
    );
  }
  const localSha = head.stdout.trim();
  const credential = getProjectCredential(db, input.projectSlug);
  const token = credential ? getPatToken(db, credential.id) : null;
  if (!token) {
    return failure(
      "credential_missing",
      "GitHub delivery credential is missing",
      "Local commits are ready, but this project has no bound GitHub credential. Bind one and retry delivery.",
    );
  }

  const sanitized = await run(githubRemoteSanitizationArgs(repo, input.workdir));
  if (!sanitized.ok) {
    return failure(
      "workspace_invalid",
      "Git remote could not be prepared",
      "Viberr could not set the credential-free GitHub origin before delivery.",
    );
  }
  const auth = createGitHubAuthPlan({ token });
  let pushed: DeliveryExecResult;
  try {
    pushed = await run(
      [
        "-C",
        input.workdir,
        "push",
        "--set-upstream",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ],
      60_000,
      auth.env,
    );
  } finally {
    auth.dispose();
  }
  if (!pushed.ok) {
    return failure(
      "push_failed",
      "Server-owned GitHub push failed",
      "Viberr could not push the local task branch with the bound credential. Validate repository access and retry.",
    );
  }

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: repo,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (gh.status !== "ok") {
    return failure(
      "remote_head_unverified",
      "Remote branch could not be verified",
      "The push completed, but Viberr could not create an authenticated GitHub verification context.",
    );
  }
  const remote = await gh.client.request<RemoteRef>(
    "GET",
    `/repos/${gh.repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
  );
  if (!remote.ok || remote.data.object.sha !== localSha) {
    return failure(
      "remote_head_unverified",
      "Remote branch HEAD does not match",
      "Viberr did not confirm the exact local commit on the remote task branch. Review the remote before retrying.",
    );
  }
  const compare = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
  );
  if (compare.status !== "ok" || compare.compare.aheadBy < 1) {
    return failure(
      "remote_diff_empty",
      "Remote task branch has no reviewable diff",
      "GitHub did not report a non-empty diff between the task branch and the default branch.",
    );
  }

  const reconcileExec: CommandExec = (file, args, reconcileOptions) =>
    exec(file, args, { cwd: reconcileOptions.cwd, timeoutMs: reconcileOptions.timeoutMs }).then(
      (result) =>
        result.ok
          ? { ok: true as const, stdout: result.stdout }
          : { ok: false as const, stdout: "", stderr: "command failed", code: null },
    );
  await reconcileWorkspaceDelivery({
    db,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    workdir: input.workdir,
    backend: input.backend,
    role: input.role,
    simulated: false,
    skipPrDetection: true,
    exec: reconcileExec,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  const refreshed = readTaskFile(taskRef);
  const alreadyRecorded = refreshed?.parsed.timeline.some(
    (event) =>
      event.type === "github" &&
      event.actor.kind === "system" &&
      event.actor.systemId === "github-delivery" &&
      event.text.includes(localSha.slice(0, 7)),
  );
  if (!alreadyRecorded) {
    await appendTimelineEvent(taskRef, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: { kind: "system", systemId: "github-delivery" },
      title: "Remote branch verified",
      text: `Viberr pushed and verified branch \`${branch}\` at \`${localSha.slice(0, 7)}\` with ${compare.compare.aheadBy} commit(s) ahead of \`${gh.defaultBranch}\`.`,
      toAgent: false,
      evidence: null,
    });
    rebuildPath(db, resolveTaskFilePath(taskRef), {
      ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
    });
    recordAudit(db, {
      action: "github.workspace.branch_pushed",
      actor: { userId: null, label: "system:delivery" },
      subjectKind: "branch",
      subjectId: branch,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo, branch, remoteSha: localSha, aheadBy: compare.compare.aheadBy },
    });
  }

  let prNumber: number | null = null;
  if (input.permissions.canOpenPr) {
    const pr = await openTaskPr(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      { userId: null, label: "system:delivery" },
      {
        ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    );
    if (pr.status !== "ok") {
      return failure(
        "pr_open_failed",
        "Review pull request could not be opened",
        "The remote branch is verified, but Viberr could not open or reconcile its review pull request. Retry after checking GitHub access.",
      );
    }
    prNumber = pr.prNumber;
  }
  return { status: "delivered", branch, remoteSha: localSha, prNumber };
}
