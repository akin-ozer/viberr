import type { DatabaseSync } from "node:sqlite";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { GithubClient } from "./github-client.server";
import {
  getProjectGithubContext,
  type GithubContextFailure,
} from "./github-context.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";

/**
 * Branch sync (Phase 7): task-key execution branches
 * (`vib-142-attach-workspace`) created from the project default branch via
 * the git refs API, plus the real compare data (ahead/behind) the sync
 * pill derives from (ruling 12: merged > behind > synced — never from
 * `validation === "failing"` like the mock).
 *
 * Idempotent by design: an existing branch is SUCCESS (`created: false`);
 * a 422 "Reference already exists" race is success too.
 */

// --------------------------------------------------------------- naming

/**
 * The task's ONE branch: the lowercased key and nothing else —
 * taskBranchName("VIB-142") → "vib-142". The old `<key>-<title-slug>` form
 * (owner ruling 2026-07-17) added no identity (the key IS the identifier)
 * and produced awkward truncations like "vib-1-list-files-in-the"; one
 * task, one predictable branch. Existing tasks keep whatever `branch:`
 * their frontmatter already stores — this only defaults NEW branches.
 */
export function taskBranchName(taskKey: string): string {
  return taskKey.toLowerCase();
}

// -------------------------------------------------------------- compare

export interface BranchCompare {
  aheadBy: number;
  behindBy: number;
  /** GitHub compare status: "ahead" | "behind" | "identical" | "diverged". */
  status: string;
  /** Commits the branch is ahead by (short sha + first message line). */
  commits: { sha: string; msg: string }[];
}

interface GhCompare {
  ahead_by: number;
  behind_by: number;
  status: string;
  commits: { sha: string; commit: { message: string } }[];
}

export type BranchCompareResult =
  | { status: "ok"; compare: BranchCompare }
  | { status: "missing_ref" }
  | { status: "forbidden"; message: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

export async function getBranchCompare(
  client: GithubClient,
  repo: string,
  base: string,
  head: string,
): Promise<BranchCompareResult> {
  const result = await client.request<GhCompare>(
    "GET",
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { searchParams: { per_page: 250 } },
  );
  if (result.ok) {
    return {
      status: "ok",
      compare: {
        aheadBy: result.data.ahead_by ?? 0,
        behindBy: result.data.behind_by ?? 0,
        status: result.data.status ?? "identical",
        commits: (result.data.commits ?? []).map((c) => ({
          sha: c.sha.slice(0, 7),
          msg: (c.commit?.message ?? "").split("\n", 1)[0] ?? "",
        })),
      },
    };
  }
  if (result.kind === "network") {
    return { status: "network_unavailable", message: result.message };
  }
  if (result.kind === "http" && result.status === 404) {
    return { status: "missing_ref" };
  }
  if (result.kind === "http" && result.status === 401) {
    return { status: "auth_failed", message: result.message };
  }
  if (result.kind === "http" && result.status === 403) {
    return { status: "forbidden", message: result.message };
  }
  return {
    status: "network_unavailable",
    message: result.kind === "http" ? `GitHub ${result.status}` : "unknown",
  };
}

/**
 * Commit association: branch commits carrying the `[VIB-n]` task-key
 * prefix convention.
 */
export function taskCommits(
  commits: { sha: string; msg: string }[],
  taskKey: string,
): { sha: string; msg: string }[] {
  const prefix = `[${taskKey.toLowerCase()}]`;
  return commits.filter((c) => c.msg.toLowerCase().startsWith(prefix));
}

/** Sync pill derivation (ruling 12): merged > behind > synced. */
export type BranchSyncState = "merged" | "behind_main" | "synced";

export function deriveSyncState(input: {
  prMerged: boolean;
  behindBy: number;
}): BranchSyncState {
  if (input.prMerged) return "merged";
  if (input.behindBy > 0) return "behind_main";
  return "synced";
}

// -------------------------------------------------------- ensure branch

export type EnsureBranchResult =
  | {
      status: "synced";
      branch: string;
      /** True when this call created the ref on GitHub. */
      created: boolean;
      /** Compare vs the default branch (null when the compare failed). */
      compare: BranchCompare | null;
    }
  | GithubContextFailure
  | { status: "task_not_found" }
  | { status: "default_branch_missing"; defaultBranch: string }
  | { status: "scope_violation"; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

export interface EnsureBranchContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
}

interface GhRef {
  object: { sha: string };
}

/**
 * Creates (or confirms) the task-key branch from the project default
 * branch, writes the branch name into task.md when it was absent, and
 * returns fresh compare data. Every failure mode is a typed result; a 403
 * creating the ref opens a `repo` scope violation carried by the task.
 */
export async function ensureTaskBranch(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: EnsureBranchContext = {},
): Promise<EnsureBranchResult> {
  const taskRef = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: ctx.dataRoot,
  };
  const file = readTaskFile(taskRef);
  if (!file) return { status: "task_not_found" };

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: file.parsed.frontmatter.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  const branch =
    file.parsed.frontmatter.branch ?? taskBranchName(input.taskKey);

  // 1. Does the ref already exist? (idempotency first)
  const existing = await gh.client.request<GhRef>(
    "GET",
    `/repos/${gh.repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
  );
  let created = false;
  if (!existing.ok) {
    if (existing.kind === "network") {
      return { status: "network_unavailable", message: existing.message };
    }
    if (existing.kind === "http" && existing.status === 401) {
      return { status: "auth_failed", message: existing.message };
    }
    if (existing.kind === "http" && existing.status === 404) {
      // 2. Resolve the default branch head…
      const baseRef = await gh.client.request<GhRef>(
        "GET",
        `/repos/${gh.repo}/git/ref/${encodeURIComponent(`heads/${gh.defaultBranch}`)}`,
      );
      if (!baseRef.ok) {
        if (baseRef.kind === "http" && baseRef.status === 404) {
          return {
            status: "default_branch_missing",
            defaultBranch: gh.defaultBranch,
          };
        }
        if (baseRef.kind === "network") {
          return { status: "network_unavailable", message: baseRef.message };
        }
        return {
          status: "network_unavailable",
          message: baseRef.kind === "http" ? baseRef.message : "unknown",
        };
      }
      // 3. …and create the branch ref from it.
      const createRef = await gh.client.request<GhRef>(
        "POST",
        `/repos/${gh.repo}/git/refs`,
        { body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha } },
      );
      if (createRef.ok) {
        created = true;
      } else if (
        createRef.kind === "http" &&
        createRef.status === 422 &&
        /already exists/i.test(createRef.message)
      ) {
        created = false; // concurrent creation — idempotent success
      } else if (createRef.kind === "http" && createRef.status === 403) {
        const { violation } = await flagScopeViolation(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            scope: "repo",
            detail: policyViolationText(
              "repo",
              `Creating branch \`${branch}\` was refused.`,
            ),
            actor,
          },
          { dataRoot: ctx.dataRoot },
        );
        return {
          status: "scope_violation",
          scope: "repo",
          violationId: violation.id,
        };
      } else if (createRef.kind === "network") {
        return { status: "network_unavailable", message: createRef.message };
      } else {
        return {
          status: "network_unavailable",
          message: createRef.kind === "http" ? createRef.message : "unknown",
        };
      }
    } else if (existing.kind === "http" && existing.status === 403) {
      const { violation } = await flagScopeViolation(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          scope: "repo",
          detail: policyViolationText(
            "repo",
            `Reading branch \`${branch}\` was refused.`,
          ),
          actor,
        },
        { dataRoot: ctx.dataRoot },
      );
      return {
        status: "scope_violation",
        scope: "repo",
        violationId: violation.id,
      };
    } else {
      return {
        status: "network_unavailable",
        message: existing.kind === "http" ? existing.message : "unknown",
      };
    }
  }

  // Persist the branch name into task.md when it wasn't recorded yet
  // (file write → reproject; canonical truth stays in the file).
  if (file.parsed.frontmatter.branch !== branch) {
    await patchTaskFrontmatter(taskRef, { branch });
    rebuildPath(db, resolveTaskFilePath(taskRef), {
      dataRoot: ctx.dataRoot,
    });
  }

  if (created) {
    recordAudit(db, {
      action: "github.branch.created",
      actor,
      subjectKind: "branch",
      subjectId: branch,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, from: gh.defaultBranch },
    });
  }

  const compareResult = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
  );
  return {
    status: "synced",
    branch,
    created,
    compare: compareResult.status === "ok" ? compareResult.compare : null,
  };
}
