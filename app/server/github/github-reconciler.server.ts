import type Database from "better-sqlite3";
import type {
  GithubCache,
  PrRef,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { storeRelativePath } from "~/server/files/file-store-root.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  deriveSyncState,
  getBranchCompare,
  taskCommits,
  type BranchCompare,
  type BranchSyncState,
} from "./branch-sync.server";
import {
  getProjectGithubContext,
  type GithubContextFailure,
} from "./github-context.server";
import { findPrForBranch, type PrFacts } from "./pr-linker.server";
import {
  POLICY_ENGINE_ACTOR,
  flagScopeViolation,
  policyViolationText,
  resolveScopeViolationWithEvent,
} from "./scope-flag.server";
import { reviewEvidenceFingerprint } from "~/server/tasks/review-evidence.server";

/**
 * GitHub reconciler (Phase 7): given a task, fetches live GitHub facts
 * (branch compare, PR state, task-key commits, change stats), writes them
 * into the task.md `pr`/`github` frontmatter CACHE via the phase-3
 * frontmatter writers (files stay canonical, GitHub stays a projection —
 * format doc §"pr/github cache"), triggers incremental reprojection,
 * records provenance, and opens/resolves scope violations on 403-scope
 * failures (ruling 5 — violation rows carry their task).
 *
 * Plus mergeTaskPr — the real merge behind accept_completion (ruling 7):
 * PUT /pulls/{n}/merge with 405/409/403-scope mapped to typed results.
 * The VIB-142 scenario: a 403 opens (or reuses) the `pull_request:write`
 * violation and the caller renders the typed failure; the merge does NOT
 * transition the task — stage/readiness orchestration stays with the
 * accept_completion action (Phase 5 wiring).
 *
 * Everything returns typed results (degraded contract): no_pat_configured
 * / no_repo_configured / network_unavailable are values, not throws.
 */

export interface GithubActionContext {
  dataRoot?: string;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
}

function taskRefOf(
  input: { projectSlug: string; taskKey: string },
  ctx: GithubActionContext,
) {
  return {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
}

function recordGithubProvenance(
  db: Database.Database,
  input: {
    absPath: string;
    dataRoot?: string;
    action: string;
    details: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
     VALUES (?, NULL, ?, ?, ?)`,
  ).run(
    storeRelativePath(input.absPath, input.dataRoot),
    new Date().toISOString(),
    input.action,
    JSON.stringify(input.details),
  );
}

function userName(db: Database.Database, userId: string): string {
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId) as
    { name: string } | undefined;
  return row?.name ?? userId;
}

// ------------------------------------------------------------- reconcile

export type TaskReconcileResult =
  | {
      status: "reconciled";
      taskKey: string;
      repo: string;
      branch: string;
      /** True when the task.md cache actually changed (and re-projected). */
      changed: boolean;
      sync: BranchSyncState;
      compare: { aheadBy: number; behindBy: number } | null;
      pr: PrFacts | null;
      /** Task-key-prefixed commits found on the branch. */
      commits: number;
    }
  | { status: "no_branch"; taskKey: string }
  | { status: "task_not_found"; taskKey: string }
  | GithubContextFailure
  | {
      status: "scope_violation";
      taskKey: string;
      scope: string;
      violationId: string;
    }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

/**
 * Reconciles ONE task with GitHub. Idempotent: unchanged facts produce no
 * file write and no reprojection (`changed: false`), but always record a
 * provenance row for the observation.
 */
export async function reconcileTask(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<TaskReconcileResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const fm = file.parsed.frontmatter;
  if (!fm.branch) return { status: "no_branch", taskKey: input.taskKey };
  const branch = fm.branch;

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: fm.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  // 1. Compare vs the default branch (sync pill + commit association).
  const compareResult = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
  );
  if (compareResult.status === "network_unavailable") {
    return { status: "network_unavailable", message: compareResult.message };
  }
  if (compareResult.status === "auth_failed") {
    return { status: "auth_failed", message: compareResult.message };
  }
  if (compareResult.status === "forbidden") {
    const { violation } = await flagScopeViolation(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        scope: "repo",
        detail: policyViolationText(
          "repo",
          `Reading branch \`${branch}\` was refused during reconcile.`,
        ),
        actor,
      },
      ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
    );
    return {
      status: "scope_violation",
      taskKey: input.taskKey,
      scope: "repo",
      violationId: violation.id,
    };
  }
  const compare: BranchCompare | null =
    compareResult.status === "ok" ? compareResult.compare : null;

  // 2. PR lookup (state/draft/merged + checks + change stats).
  const prResult = await findPrForBranch(gh.client, gh.repo, branch);
  if (prResult.status === "network_unavailable") {
    return { status: "network_unavailable", message: prResult.message };
  }
  if (prResult.status === "auth_failed") {
    return { status: "auth_failed", message: prResult.message };
  }
  // A forbidden PR read degrades to "no PR facts" — reads are best-effort;
  // only WRITE failures open violations (an unproven read 403 could also
  // be repo visibility).
  const pr: PrFacts | null = prResult.status === "found" ? prResult.pr : null;

  // 3. Build the new frontmatter cache. A human-set "accepted" (merge-pending,
  // D3/S2) must NOT be downgraded to "review" just because the PR is still open
  // on GitHub — that would silently hide the "Complete merge" affordance. Keep
  // "accepted" until GitHub reports a real terminal state (merged/closed).
  const liveState =
    fm.pr?.state === "accepted" && pr && pr.state === "review"
      ? "accepted"
      : pr?.state;
  const newPr: PrRef | null = pr
    ? {
        number: pr.number,
        state: liveState ?? pr.state,
        title: pr.title,
        ...(pr.headSha ? { headSha: pr.headSha } : {}),
        ...(pr.checks ? { checks: pr.checks } : {}),
      }
    : (fm.pr ?? null); // keep last-known PR when lookup was refused/none

  const existingGithub: GithubCache | null = fm.github;
  // Commit association: `[KEY]`-prefixed commits on the branch. Agents don't
  // always follow the prefix convention, so an EMPTY filtered list must not
  // wipe a non-empty cache captured from the run workspace for this same
  // branch — keep what we honestly recorded rather than zeroing it.
  const prefixCommits = compare ? taskCommits(compare.commits, fm.key) : null;
  const existingCommits = existingGithub?.commits ?? [];
  const branchCommits =
    prefixCommits !== null &&
    prefixCommits.length === 0 &&
    existingCommits.length > 0
      ? existingCommits
      : prefixCommits;
  const newGithub: GithubCache | null =
    branchCommits !== null || pr?.changed || existingGithub
      ? {
          commits: branchCommits ?? existingCommits,
          changed: pr?.changed ?? existingGithub?.changed ?? null,
        }
      : null;

  // An accepted (merge-pending) PR closed on GitHub WITHOUT merging drops the
  // Complete-merge affordance with no path back — explain why, typed `policy`.
  const acceptedClosedExternally =
    fm.pr?.state === "accepted" &&
    newPr?.state === "closed" &&
    fm.pr.number === newPr.number;

  const oldEvidence = reviewEvidenceFingerprint(file.parsed, gh.repo);
  const nextTask = {
    ...file.parsed,
    frontmatter: { ...fm, pr: newPr, github: newGithub },
  };
  const evidenceChanged =
    oldEvidence !== reviewEvidenceFingerprint(nextTask, gh.repo);
  const changed =
    JSON.stringify({ pr: fm.pr, github: fm.github }) !==
    JSON.stringify({ pr: newPr, github: newGithub });

  if (changed) {
    const patch: Partial<TaskFrontmatter> = { pr: newPr, github: newGithub };
    if (evidenceChanged) {
      patch.reviewerVerdicts = [];
      if (fm.validation !== "failing") patch.validation = "changed";
    }
    await patchTaskFrontmatter(ref, patch);
    if (acceptedClosedExternally) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "policy",
        actor: POLICY_ENGINE_ACTOR,
        title: null,
        text: `**Policy note:** accepted PR #${newPr.number} was closed on GitHub without merging — the pending merge can no longer be completed from Viberr.`,
        toAgent: false,
        evidence: null,
      });
    }
    rebuildPath(db, resolveTaskFilePath(ref), {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  }

  const sync = deriveSyncState({
    prMerged: (pr?.state ?? fm.pr?.state) === "merged",
    behindBy: compare?.behindBy ?? 0,
  });

  recordGithubProvenance(db, {
    absPath: resolveTaskFilePath(ref),
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    action: "github.reconcile",
    details: {
      repo: gh.repo,
      branch,
      changed,
      sync,
      aheadBy: compare?.aheadBy ?? null,
      behindBy: compare?.behindBy ?? null,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      commits: branchCommits?.length ?? null,
    },
  });
  recordAudit(db, {
    action: "github.reconcile.task",
    actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { repo: gh.repo, branch, changed, sync },
  });

  return {
    status: "reconciled",
    taskKey: input.taskKey,
    repo: gh.repo,
    branch,
    changed,
    sync,
    compare: compare
      ? { aheadBy: compare.aheadBy, behindBy: compare.behindBy }
      : null,
    pr,
    commits: branchCommits?.length ?? 0,
  };
}

export interface ProjectReconcileSummary {
  status: "ok" | "no_pat_configured" | "no_repo_configured";
  /** Per-task results for every task that has a branch. */
  results: TaskReconcileResult[];
  reconciled: number;
  changed: number;
  failed: number;
}

/**
 * Reconciles every task of the project that has a branch (the GitHub
 * view's Reconcile button). Configuration gaps short-circuit before any
 * network call.
 */
export async function reconcileProject(
  db: Database.Database,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<ProjectReconcileSummary> {
  const gh = getProjectGithubContext(db, projectSlug, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") {
    return {
      status: gh.status,
      results: [],
      reconciled: 0,
      changed: 0,
      failed: 0,
    };
  }

  const rows = db
    .prepare(
      `SELECT task_key FROM task_projections
       WHERE project_slug = ? AND branch IS NOT NULL
       ORDER BY task_key ASC`,
    )
    .all(projectSlug) as { task_key: string }[];

  const results: TaskReconcileResult[] = await Promise.all(
    rows.map((row) =>
      reconcileTask(db, { projectSlug, taskKey: row.task_key }, actor, ctx),
    ),
  );
  let reconciled = 0;
  let changed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "reconciled") {
      reconciled += 1;
      if (result.changed) changed += 1;
    } else if (result.status !== "no_branch") {
      failed += 1;
    }
  }

  recordAudit(db, {
    action: "github.reconcile.project",
    actor,
    subjectKind: "project",
    subjectId: projectSlug,
    projectSlug,
    details: { tasks: rows.length, reconciled, changed, failed },
  });
  return { status: "ok", results, reconciled, changed, failed };
}

// ------------------------------------------------------------------ merge

export type MergeTaskPrResult =
  | { status: "merged"; prNumber: number; sha: string | null }
  | { status: "task_not_found"; taskKey: string }
  | { status: "no_pr"; taskKey: string }
  | GithubContextFailure
  | { status: "not_mergeable"; prNumber: number; message: string }
  | { status: "head_changed"; prNumber: number; message: string }
  | {
      status: "scope_violation";
      prNumber: number;
      scope: "pull_request:write";
      violationId: string;
      message: string;
    }
  | { status: "pr_not_found"; prNumber: number }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

interface GhMergeResponse {
  merged: boolean;
  sha: string | null;
  message?: string;
}

/**
 * THE real merge behind accept_completion (ruling 7). Merges the task's
 * cached PR via PUT /repos/{repo}/pulls/{n}/merge and returns typed
 * results — the caller (Phase 5 resolvePacket integration) renders
 * failures explicitly and must NOT flip the task to done unless this
 * returns `merged`.
 *
 * Side effects on success: task.md `pr.state` → "merged" + a `github`
 * timeline event authored by the accepting human ("Merged **PR #N** into
 * `main`.") + reprojection + audit; an open `pull_request:write` violation
 * for this task is resolved (the successful write is the proof) with its
 * typed policy-update event.
 *
 * Side effects on 403: opens (or reuses — idempotent) the
 * `pull_request:write` scope violation carried by this task, with its
 * typed `policy` timeline event + owner notification (the VIB-142
 * scenario; the seeded violation row is simply reused).
 */
export async function mergeTaskPr(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor & { userId: string },
  ctx: GithubActionContext = {},
): Promise<MergeTaskPrResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const fm = file.parsed.frontmatter;
  if (!fm.pr) return { status: "no_pr", taskKey: input.taskKey };
  const prNumber = fm.pr.number;

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: fm.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  const merge = await gh.client.request<GhMergeResponse>(
    "PUT",
    `/repos/${gh.repo}/pulls/${prNumber}/merge`,
    { body: fm.pr.headSha ? { sha: fm.pr.headSha } : {} },
  );

  if (merge.ok) {
    const sha = merge.data.sha ?? null;
    // File write: cache flips to merged + human-authored github event.
    await patchTaskFrontmatter(ref, { pr: { ...fm.pr, state: "merged" } });
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: {
        kind: "human",
        userId: actor.userId,
        nameHint: userName(db, actor.userId),
      },
      title: null,
      text: `Merged **PR #${prNumber}** into \`${gh.defaultBranch}\`.`,
      toAgent: false,
      evidence: null,
    });
    rebuildPath(db, resolveTaskFilePath(ref), {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    recordGithubProvenance(db, {
      absPath: resolveTaskFilePath(ref),
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      action: "github.merge",
      details: { repo: gh.repo, prNumber, sha },
    });
    recordAudit(db, {
      action: "github.pr.merged",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${prNumber}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, prNumber, sha },
    });
    // The successful write PROVES pull_request:write — resolve an open
    // violation for this task (typed policy-update event included).
    const open = findOpenScopeViolation(
      db,
      input.projectSlug,
      "pull_request:write",
      input.taskKey,
    );
    if (open) {
      await resolveScopeViolationWithEvent(
        db,
        open.id,
        actor,
        ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
      );
    }
    return { status: "merged", prNumber, sha };
  }

  if (merge.kind === "network") {
    return { status: "network_unavailable", message: merge.message };
  }
  // http failures
  if (merge.status === 405) {
    return { status: "not_mergeable", prNumber, message: merge.message };
  }
  if (merge.status === 409) {
    return { status: "head_changed", prNumber, message: merge.message };
  }
  if (merge.status === 403) {
    const { violation } = await flagScopeViolation(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        scope: "pull_request:write",
        detail: policyViolationText(
          "pull_request:write",
          `Merging PR #${prNumber} was refused.`,
        ),
        actor,
      },
      ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
    );
    recordAudit(db, {
      action: "github.pr.merge_refused",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${prNumber}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { scope: "pull_request:write", violationId: violation.id },
    });
    return {
      status: "scope_violation",
      prNumber,
      scope: "pull_request:write",
      violationId: violation.id,
      message: merge.message,
    };
  }
  if (merge.status === 404) {
    return { status: "pr_not_found", prNumber };
  }
  if (merge.status === 401) {
    return { status: "auth_failed", message: merge.message };
  }
  return {
    status: "network_unavailable",
    message: merge.kind === "http" ? merge.message : `GitHub ${merge.status}`,
  };
}
