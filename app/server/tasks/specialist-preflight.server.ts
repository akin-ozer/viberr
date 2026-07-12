import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  cloneFailureLogDetails,
  createGitHubClonePlan,
  githubRemoteSanitizationArgs,
} from "./git-clone-auth.server";

export type SpecialistPreflightCode =
  | "repository_not_configured"
  | "git_unavailable"
  | "checkout_auth_or_access_required"
  | "checkout_failed"
  | "checkout_invalid";

export type SpecialistPreflightResult =
  | {
      status: "ready";
      workdir: string;
      credentialBound: boolean;
      reused: boolean;
    }
  | {
      status: "blocked";
      code: SpecialistPreflightCode;
      title: string;
      detail: string;
      credentialBound: boolean;
    };

export type PreflightExecResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      reason: "git_unavailable" | "command_failed" | "command_terminated";
      exitCode?: number;
    };

export type PreflightExec = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<PreflightExecResult>;

const execFileAsync = promisify(execFile);

const defaultExec: PreflightExec = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error) {
    const safe = cloneFailureLogDetails(error);
    return {
      ok: false,
      reason:
        safe.reason === "git_unavailable"
          ? "git_unavailable"
          : safe.reason === "clone_terminated"
            ? "command_terminated"
            : "command_failed",
      ...(safe.exitCode !== undefined ? { exitCode: safe.exitCode } : {}),
    };
  }
};

function blocked(
  code: SpecialistPreflightCode,
  credentialBound: boolean,
): SpecialistPreflightResult {
  switch (code) {
    case "repository_not_configured":
      return {
        status: "blocked",
        code,
        credentialBound,
        title: "Specialist workspace is not configured",
        detail:
          "This task has no repository to check out. Configure a project or task repository before starting a real specialist.",
      };
    case "git_unavailable":
      return {
        status: "blocked",
        code,
        credentialBound,
        title: "Specialist workspace cannot be prepared",
        detail:
          "Git is unavailable in the runtime image. Restore the required runtime tool before retrying.",
      };
    case "checkout_auth_or_access_required":
      return {
        status: "blocked",
        code,
        credentialBound,
        title: "Repository checkout needs access",
        detail:
          "The repository could not be checked out without a bound project credential. Bind a GitHub credential, or verify that the repository is public and reachable, then retry.",
      };
    case "checkout_invalid":
      return {
        status: "blocked",
        code,
        credentialBound,
        title: "Repository checkout is not usable",
        detail:
          "The workspace exists but is not a valid Git working tree. Repair or clear the task workspace before retrying.",
      };
    default:
      return {
        status: "blocked",
        code,
        credentialBound,
        title: "Repository checkout failed",
        detail:
          "Viberr could not prepare the repository with the bound project credential. Validate the credential and repository access, then retry.",
      };
  }
}

/**
 * Repository/tool/auth preflight for a REAL specialist. A repo-backed model is
 * never started in an empty fallback directory: this either returns a verified
 * Git working tree or a structured, secret-free blocker for the recovery path.
 */
export async function preflightSpecialistWorkspace(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string | null;
    /** Optional isolated workspace namespace (one stable namespace per reviewer). */
    workspaceKey?: string;
    dataRoot?: string;
  },
  options: { exec?: PreflightExec } = {},
): Promise<SpecialistPreflightResult> {
  const credential = getProjectCredential(db, input.projectSlug);
  const token = credential ? getPatToken(db, credential.id) : null;
  const credentialBound = token !== null;
  if (!input.repo) return blocked("repository_not_configured", credentialBound);

  const exec = options.exec ?? defaultExec;
  const repoName = input.repo.split("/").pop() ?? input.repo;
  const baseWorkspaceRoot = path.join(
    taskDir(input.projectSlug, input.taskKey, input.dataRoot),
    "workspace",
  );
  const workspaceKey = input.workspaceKey
    ?.trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const workspaceRoot = workspaceKey
    ? path.join(baseWorkspaceRoot, workspaceKey)
    : baseWorkspaceRoot;
  const destination = path.join(workspaceRoot, repoName);
  mkdirSync(workspaceRoot, { recursive: true });

  const validate = async (): Promise<boolean> => {
    const result = await exec(
      "git",
      ["-C", destination, "rev-parse", "--is-inside-work-tree"],
      { cwd: destination, timeoutMs: 10_000 },
    );
    return result.ok && result.stdout.trim() === "true";
  };

  if (existsSync(path.join(destination, ".git"))) {
    const sanitized = await exec(
      "git",
      githubRemoteSanitizationArgs(input.repo, destination),
      { cwd: destination, timeoutMs: 10_000 },
    );
    if (!sanitized.ok) {
      return blocked(
        sanitized.reason === "git_unavailable"
          ? "git_unavailable"
          : "checkout_invalid",
        credentialBound,
      );
    }
    if (!(await validate()))
      return blocked("checkout_invalid", credentialBound);
    return {
      status: "ready",
      workdir: destination,
      credentialBound,
      reused: true,
    };
  }

  const clone = createGitHubClonePlan({
    repo: input.repo,
    destination,
    ...(token ? { token } : {}),
  });
  let cloned: PreflightExecResult;
  try {
    cloned = await exec("git", clone.args, {
      cwd: workspaceRoot,
      env: clone.env,
      timeoutMs: 60_000,
    });
  } finally {
    clone.dispose();
  }
  if (!cloned.ok) {
    if (cloned.reason === "git_unavailable") {
      return blocked("git_unavailable", credentialBound);
    }
    return blocked(
      credentialBound ? "checkout_failed" : "checkout_auth_or_access_required",
      credentialBound,
    );
  }
  if (!existsSync(path.join(destination, ".git")) || !(await validate())) {
    return blocked("checkout_invalid", credentialBound);
  }
  return {
    status: "ready",
    workdir: destination,
    credentialBound,
    reused: false,
  };
}
