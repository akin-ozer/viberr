import type Database from "better-sqlite3";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";
import {
  projectCompletionSignal,
  withProjectCompletionEffect,
} from "~/server/runtimes/run-completion-state.server";
import {
  assertTaskLifecycleActive,
  type TaskLifecycleGuard,
} from "~/server/tasks/task-lifecycle.server";
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
 * `<key-lowercase>-<slug-of-title>`, e.g.
 * taskBranchName("VIB-142", "Attach execution workspace to task runtime")
 * → "vib-142-attach-execution-workspace" (slug capped at 4 words to match
 * the mock's naming style).
 */
export function taskBranchName(taskKey: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\u0131/g, "i") // dotless \u0131 has no NFKD decomposition
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  const key = taskKey.toLowerCase();
  return slug ? `${key}-${slug}` : key;
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
  signal?: AbortSignal,
): Promise<BranchCompareResult> {
  const result = await client.request<GhCompare>(
    "GET",
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    {
      searchParams: { per_page: 250 },
      ...(signal ? { signal } : {}),
    },
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
 * prefix convention (mock data contract).
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
  /** Exact task identity held across every GitHub and canonical-write await. */
  taskLifecycle?: TaskLifecycleGuard;
  /** Optional caller-owned project lifecycle signal. Defaults to the shared
   * project signal so archive/delete revocation is never accidentally omitted. */
  signal?: AbortSignal;
  /** Governing caller re-check immediately before remote/canonical mutation. */
  assertAuthorization?: () => void;
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
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: EnsureBranchContext = {},
): Promise<EnsureBranchResult> {
  return withProjectCompletionEffect(db, input.projectSlug, () =>
    ensureTaskBranchOwned(db, input, actor, ctx),
  );
}

async function ensureTaskBranchOwned(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: EnsureBranchContext,
): Promise<EnsureBranchResult> {
  assertProjectActive(db, input.projectSlug, ctx);
  const taskRef = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
  const file = readTaskFile(taskRef);
  if (!file) return { status: "task_not_found" };
  const capturedCreatedAt = file.parsed.frontmatter.createdAt;
  if (!capturedCreatedAt) {
    throw new DOMException("Task lifecycle ownership is missing.", "AbortError");
  }
  const signal =
    ctx.taskLifecycle?.signal ??
    ctx.signal ??
    projectCompletionSignal(db, input.projectSlug);
  const taskLifecycle: TaskLifecycleGuard = {
    expectedCreatedAt:
      ctx.taskLifecycle?.expectedCreatedAt ??
      capturedCreatedAt,
    signal,
  };
  const assertCurrent = (): void => {
    assertProjectActive(db, input.projectSlug, ctx);
    ctx.assertAuthorization?.();
    const current = readTaskFile(taskRef);
    assertTaskLifecycleActive(
      taskLifecycle,
      current?.parsed.frontmatter.createdAt ?? null,
    );
  };
  assertCurrent();

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: file.parsed.frontmatter.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  const branch =
    file.parsed.frontmatter.branch ??
    taskBranchName(input.taskKey, file.parsed.frontmatter.title);

  // 1. Does the ref already exist? (idempotency first)
  const existing = await gh.client.request<GhRef>(
    "GET",
    `/repos/${gh.repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
    { signal },
  );
  assertCurrent();
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
        { signal },
      );
      assertCurrent();
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
      // This is the irreversible remote boundary: task/project ownership and
      // caller authority must still be exact immediately before the request.
      assertCurrent();
      const createRef = await gh.client.request<GhRef>(
        "POST",
        `/repos/${gh.repo}/git/refs`,
        {
          body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha },
          signal,
        },
      );
      // Preserve the objective remote fact even when ownership changed while
      // GitHub was processing the irreversible request. The old task identity
      // remains explicit and no canonical mutation follows unless the guard
      // below still succeeds.
      if (createRef.ok) {
        recordAudit(db, {
          action: "github.branch.created",
          actor,
          subjectKind: "branch",
          subjectId: branch,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          details: {
            repo: gh.repo,
            from: gh.defaultBranch,
            taskCreatedAt: taskLifecycle.expectedCreatedAt,
          },
        });
      }
      assertCurrent();
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
          {
            ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
            expectedTaskCreatedAt: taskLifecycle.expectedCreatedAt,
            signal,
          },
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
        {
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
          expectedTaskCreatedAt: taskLifecycle.expectedCreatedAt,
          signal,
        },
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
    assertCurrent();
    await updateTaskFile(
      {
        ...taskRef,
        expectedTaskIncarnation: taskLifecycle.expectedCreatedAt,
      },
      (parsed) => {
        assertTaskLifecycleActive(
          taskLifecycle,
          parsed.frontmatter.createdAt,
        );
        if (
          parsed.frontmatter.branch !== null &&
          parsed.frontmatter.branch !== branch
        ) {
          throw new DOMException(
            "Task branch ownership changed while branch creation was in progress.",
            "AbortError",
          );
        }
        parsed.frontmatter.branch = branch;
      },
    );
    assertCurrent();
    rebuildPath(db, resolveTaskFilePath(taskRef), {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  }

  const compareResult = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
    signal,
  );
  assertCurrent();
  return {
    status: "synced",
    branch,
    created,
    compare: compareResult.status === "ok" ? compareResult.compare : null,
  };
}
