import type { DatabaseSync } from "node:sqlite";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { getProjectGithubContext } from "~/server/github/github-context.server";
import { ensureDefaultBranch } from "~/server/github/repo-bootstrap.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import { taskWorkspaceGit } from "./workspace-git.server";
import { refreshWorkspaceFromMirror, type WorkspaceRefreshInput } from "./workspace-refresh.server";

/** Ruling 227: the bootstrap's actor, as the branch preparation names it. */
const DELIVERY_ACTOR: AuditActor = { userId: null, label: "system:delivery" };

export interface UnbornCheckoutInput {
  projectSlug: string;
  taskKey: string;
  /** `owner/repo`. */
  repo: string;
  /** The checkout on disk. */
  dir: string;
  defaultBranch: string;
  dataRoot?: string;
}

export type UnbornCheckoutOutcome =
  /** HEAD has a commit: nothing to do (every repository that has one). */
  | "born"
  /** The repository was empty; its first commit now exists and the checkout stands on it. */
  | "initialized"
  /** Unborn, and the bootstrap or the fast-forward did not complete (logged). */
  | "unchanged";

/**
 * Ruling 227 (F40-12): the operator's checkout of an EMPTY repository is
 * initialized, never handed to a person.
 *
 * `ensureDefaultBranch` also creates the default branch's first commit when a
 * task branch is prepared, which is a delivering dispatch. The operator runs
 * before any dispatch: live, WEB-1's first operator run cloned `akin-ozer/
 * website`, found an unborn `main`, and opened a packet asking the owner to
 * "push one initial commit (a README)". This is the other path that needs the
 * base: a checkout whose HEAD has no commit asks GitHub for the base through
 * the same bootstrap (idempotent: a branch that exists writes nothing), then
 * moves the unborn checkout onto it through ruling 195's refresh, which
 * refuses a checkout with staged changes or files the move would overwrite.
 *
 * One `git rev-parse` for every other checkout — as the task's person, like
 * every git in a workspace (pass 40 review, R-seams-1). Never throws: a
 * checkout that could not be initialized is used as it stands and the run
 * proceeds.
 */
export async function initializeUnbornCheckout(
  db: DatabaseSync,
  input: UnbornCheckoutInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<UnbornCheckoutOutcome> {
  let git: ReturnType<typeof taskWorkspaceGit>;
  try {
    git = taskWorkspaceGit(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      dataRoot: input.dataRoot,
    });
  } catch (error) {
    logger.warn("the operator's checkout could not be read as its person; it is used as it stands", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      err: toError(error),
    });
    return "unchanged";
  }
  try {
    await git.run(["-C", input.dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      timeoutMs: 10_000,
    });
    return "born";
  } catch {
    // No commit behind HEAD: an unborn checkout of an empty repository.
  }
  try {
    const gh = getProjectGithubContext(
      db,
      input.projectSlug,
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
    );
    if (gh.status !== "ok") return "unchanged";
    const base = await ensureDefaultBranch(
      db,
      gh,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      DELIVERY_ACTOR,
      { dataRoot: input.dataRoot, before: "operator-checkout" },
    );
    if (base.status !== "bootstrapped" && base.status !== "exists" && base.status !== "adopted") {
      logger.warn("the repository's base could not be settled before the operator's checkout", {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo: input.repo,
        status: base.status,
        reason: base.status === "bootstrap_failed" ? base.reason : null,
      });
      return "unchanged";
    }
    const refresh: WorkspaceRefreshInput = {
      projectSlug: input.projectSlug,
      repo: input.repo,
      dir: input.dir,
      // Ruling 227: the branch the bootstrap settled on, which is the
      // repository's own once the project has taken it. The refresh moves an
      // unborn checkout onto it from whatever name it was cloned with.
      defaultBranch: base.defaultBranch,
      fastForward: true,
      createMirror: true,
      taskKey: input.taskKey,
    };
    if (input.dataRoot) refresh.dataRoot = input.dataRoot;
    const moved = await refreshWorkspaceFromMirror(db, refresh);
    return moved.status === "fast_forwarded" ? "initialized" : "unchanged";
  } catch (error) {
    logger.warn("the operator's unborn checkout could not be initialized; it is used as it stands", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      repo: input.repo,
      err: toError(error),
    });
    return "unchanged";
  }
}
