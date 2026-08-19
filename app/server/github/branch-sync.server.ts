import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import {
  encodeRefPath,
  githubFailureMessage,
  type GithubClient,
} from "./github-client.server";
import {
  getProjectGithubContext,
  type GithubContextFailure,
  type GithubContextOptions,
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
  /**
   * F21-8 — how many entries of that list GitHub sent and this reader could not
   * decode. `commits` is consumed as the branch's FOOTPRINT (task-key commit
   * association, the branch panel, delivery evidence), so a dropped entry is a
   * fact the caller has to be able to see: 0 means the list is complete.
   */
  droppedCommits: number;
}

/** ONE compare commit. `sha` is the identity — an entry without one names no
 *  commit — so the entry is dropped WHOLE (and counted, below) rather than
 *  admitted with a blank sha. The message carries its reader's `??`-tolerance. */
const ghCompareCommitSchema = z.object({
  sha: z.string(),
  commit: z
    .object({ message: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

/**
 * The compare payload's read slice, with the readers' own `??`-tolerance baked
 * in — every field degrades to the caller's fallback on drift, so a mangled
 * response yields the same "identical / 0 / 0" answer the raw reads produced.
 *
 * The commit entries are tolerated ONE BY ONE (`null` = undecodable). Voiding
 * the array on a single bad entry emptied the whole list while `ahead_by`
 * survived — a branch that reads "4 commits ahead" with no commits to show,
 * and a delivery footprint silently reduced to nothing.
 */
const ghCompareSchema = z
  .object({
    ahead_by: z.number().optional().catch(undefined),
    behind_by: z.number().optional().catch(undefined),
    status: z.string().optional().catch(undefined),
    commits: z
      .array(ghCompareCommitSchema.nullable().catch(null))
      .optional()
      .catch(undefined),
  })
  .catch({});

export type BranchCompareResult =
  | { status: "ok"; compare: BranchCompare }
  | { status: "missing_ref" }
  | { status: "forbidden"; message: string }
  // A 403 caused by RATE LIMITING, not a missing scope (DG-3). GitHub returns
  // 403 for both; conflating them lets a transient rate-limit blip auto-open a
  // bogus `repo` scope violation. Callers treat this as transient (skip/retry),
  // never as a permissions failure.
  | { status: "rate_limited"; message: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

export async function getBranchCompare(
  client: GithubClient,
  repo: string,
  base: string,
  head: string,
): Promise<BranchCompareResult> {
  const result = await client.request(
    "GET",
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    ghCompareSchema,
    { searchParams: { per_page: 250 } },
  );
  if (result.ok) {
    const entries = result.data.commits ?? [];
    const commits = entries.flatMap((c) =>
      c === null
        ? []
        : [
            {
              sha: c.sha.slice(0, 7),
              msg: (c.commit?.message ?? "").split("\n", 1)[0] ?? "",
            },
          ],
    );
    const droppedCommits = entries.length - commits.length;
    if (droppedCommits > 0) {
      // The diagnostic half of the tolerant read: the surviving commits are
      // still returned, and the count says the list is short.
      logger.warn("compare payload dropped undecodable commit entries", {
        repo,
        base,
        head,
        kept: commits.length,
        dropped: droppedCommits,
      });
    }
    return {
      status: "ok",
      compare: {
        aheadBy: result.data.ahead_by ?? 0,
        behindBy: result.data.behind_by ?? 0,
        status: result.data.status ?? "identical",
        commits,
        droppedCommits,
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
    // Rate-limit 403 vs scope 403 (DG-3): GitHub zeroes x-ratelimit-remaining on
    // a primary limit, and secondary limits carry a "rate limit" message.
    const isRateLimited =
      result.rateLimit.remaining === 0 ||
      /rate limit/i.test(result.message);
    if (isRateLimited) {
      return { status: "rate_limited", message: result.message };
    }
    return { status: "forbidden", message: result.message };
  }
  // Residual — including a payload that did not decode, which names itself
  // rather than degrading to "unknown".
  return {
    status: "network_unavailable",
    message:
      result.kind === "http"
        ? `GitHub ${result.status}`
        : githubFailureMessage(result),
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

/**
 * `GET git/ref` — read only where the base head is resolved, and that sha
 * feeds straight into the ref-create call, so it stays strict: an answer
 * without `object.sha` must fail loudly, never create a branch from nothing.
 */
const ghRefSchema = z.object({ object: z.object({ sha: z.string() }) });

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

  // P13-D-5: passed `repoOverride: file.parsed.frontmatter.repo` until the
  // task-level repo override was deleted (owner ruling) — project repo only.
  // `fetchImpl` is an OPTIONAL key: the context reads it with a truthiness
  // check, so the hook is set only when a caller supplied one.
  const ghOptions: GithubContextOptions = {};
  if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
  const gh = getProjectGithubContext(db, input.projectSlug, ghOptions);
  if (gh.status !== "ok") return gh;

  const branch =
    file.parsed.frontmatter.branch ?? taskBranchName(input.taskKey);

  // 1. Does the ref already exist? (idempotency first)
  const existing = await gh.client.request(
    "GET",
    `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${branch}`)}`,
    z.unknown(),
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
      const baseRef = await gh.client.request(
        "GET",
        `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${gh.defaultBranch}`)}`,
        ghRefSchema,
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
          // Includes the strict-schema `decode` failure: a ref answer without
          // `object.sha` never creates a branch from nothing, and now says so
          // as a value instead of throwing out of the call.
          message: githubFailureMessage(baseRef),
        };
      }
      // 3. …and create the branch ref from it.
      const createRef = await gh.client.request(
        "POST",
        `/repos/${gh.repo}/git/refs`,
        z.unknown(),
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
          message: githubFailureMessage(createRef),
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
        message: githubFailureMessage(existing),
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
