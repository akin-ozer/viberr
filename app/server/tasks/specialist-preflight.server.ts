import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  defaultCommandExec,
  type CommandExec,
  type CommandExecResult,
} from "~/server/github/command-exec.server";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  createGitHubAuthPlan,
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
      /** Exact checked-out head when a review target was requested. */
      headSha: string | null;
    }
  | {
      status: "blocked";
      code: SpecialistPreflightCode;
      title: string;
      detail: string;
      credentialBound: boolean;
    };

/** Compatibility export for the focused preflight tests and callers. */
export type PreflightExec = CommandExec;

function assertPreflightActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Specialist workspace preparation was cancelled.", "AbortError");
}

/** Full repository identity, not basename, owns a workspace. The digest keeps
 * paths bounded while ensuring owner changes such as acme/web→fork/web cannot
 * relabel and reuse an unrelated checkout. */
export function repositoryWorkspaceKey(repo: string): string {
  const readable = repo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "--")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const digest = createHash("sha256")
    .update(repo.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `${readable || "repository"}-${digest}`;
}

/** A caller-selected workspace namespace (for example one reviewer profile).
 * Returning null keeps all path construction centralized and traversal-safe. */
export function workspaceNamespaceKey(
  value: string | null | undefined,
): string | null {
  const safe = value
    ?.trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || null;
}

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
    /** Reviewers inspect the exact remote task branch, never a new branch made
     * from the clone's default branch. */
    checkoutRef?: string;
    /** When canonical GitHub evidence knows the head, refuse any other code. */
    expectedHeadSha?: string | null;
    dataRoot?: string;
  },
  options: { exec?: PreflightExec; signal?: AbortSignal } = {},
): Promise<SpecialistPreflightResult> {
  assertPreflightActive(options.signal);
  const credential = getProjectCredential(db, input.projectSlug);
  const token = credential ? getPatToken(db, credential.id) : null;
  const credentialBound = token !== null;
  if (!input.repo) return blocked("repository_not_configured", credentialBound);

  const rawExec = options.exec ?? defaultCommandExec;
  // Archive/delete aborts the project-owned launch. Thread that cancellation
  // through every Git command and check it on both sides of the await so a
  // terminated command cannot be misclassified as a checkout failure and open
  // a recovery packet on a project whose lifecycle is already draining.
  const exec: PreflightExec = async (file, args, execOptions) => {
    assertPreflightActive(options.signal);
    const result = await rawExec(file, args, {
      ...execOptions,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertPreflightActive(options.signal);
    return result;
  };
  const repoIdentity = repositoryWorkspaceKey(input.repo);
  const baseWorkspaceRoot = path.join(
    taskDir(input.projectSlug, input.taskKey, input.dataRoot),
    "workspace",
  );
  const workspaceKey = workspaceNamespaceKey(input.workspaceKey);
  const workspaceRoot = workspaceKey
    ? path.join(baseWorkspaceRoot, workspaceKey)
    : baseWorkspaceRoot;
  const destination = path.join(workspaceRoot, repoIdentity);
  mkdirSync(workspaceRoot, { recursive: true });

  const validate = async (): Promise<boolean> => {
    const result = await exec(
      "git",
      ["-C", destination, "rev-parse", "--is-inside-work-tree"],
      { cwd: destination, timeoutMs: 10_000 },
    );
    return result.ok && result.stdout.trim() === "true";
  };

  let reused = false;
  if (existsSync(path.join(destination, ".git"))) {
    const sanitized = await exec(
      "git",
      githubRemoteSanitizationArgs(input.repo, destination),
      { cwd: destination, timeoutMs: 10_000 },
    );
    if (!sanitized.ok) {
      return blocked(
        sanitized.reason === "unavailable"
          ? "git_unavailable"
          : "checkout_invalid",
        credentialBound,
      );
    }
    if (!(await validate()))
      return blocked("checkout_invalid", credentialBound);
    reused = true;
  } else {
    const clone = createGitHubClonePlan({
      repo: input.repo,
      destination,
      ...(token ? { token } : {}),
    });
    let cloned: CommandExecResult;
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
      if (cloned.reason === "unavailable") {
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
  }

  let headSha: string | null = null;
  if (input.checkoutRef?.trim()) {
    const auth = createGitHubAuthPlan({ ...(token ? { token } : {}) });
    let fetched: CommandExecResult;
    try {
      fetched = await exec(
        "git",
        [
          "-C",
          destination,
          "fetch",
          "--depth",
          "1",
          "origin",
          `refs/heads/${input.checkoutRef.trim()}`,
        ],
        { cwd: destination, env: auth.env, timeoutMs: 60_000 },
      );
    } finally {
      auth.dispose();
    }
    if (!fetched.ok) {
      return blocked(
        fetched.reason === "unavailable"
          ? "git_unavailable"
          : credentialBound
            ? "checkout_failed"
            : "checkout_auth_or_access_required",
        credentialBound,
      );
    }
    const checkedOut = await exec(
      "git",
      ["-C", destination, "checkout", "--detach", "FETCH_HEAD"],
      { cwd: destination, timeoutMs: 10_000 },
    );
    if (!checkedOut.ok) return blocked("checkout_invalid", credentialBound);
    const head = await exec("git", ["-C", destination, "rev-parse", "HEAD"], {
      cwd: destination,
      timeoutMs: 10_000,
    });
    if (!head.ok || !head.stdout.trim()) {
      return blocked("checkout_invalid", credentialBound);
    }
    headSha = head.stdout.trim();
    if (
      input.expectedHeadSha?.trim() &&
      headSha.toLowerCase() !== input.expectedHeadSha.trim().toLowerCase()
    ) {
      return blocked("checkout_invalid", credentialBound);
    }
  }
  return {
    status: "ready",
    workdir: destination,
    credentialBound,
    reused,
    headSha,
  };
}
