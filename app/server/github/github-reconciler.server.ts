import type Database from "better-sqlite3";
import type {
  GithubCache,
  PrRef,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
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
import type { GithubClient } from "./github-client.server";
import { findPrForBranch, type PrFacts } from "./pr-linker.server";
import { normalizeFullGitSha } from "./head-sha.server";
import {
  POLICY_ENGINE_ACTOR,
  flagScopeViolation,
  policyViolationText,
  resolveScopeViolationWithEvent,
} from "./scope-flag.server";
import {
  clearReviewEvidence,
  reviewEvidenceFingerprint,
} from "~/server/tasks/review-evidence.server";
import {
  assertTaskLifecycleActive,
  type TaskLifecycleGuard,
} from "~/server/tasks/task-lifecycle.server";
import { newId } from "~/shared/ids/new-id.server";

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

export type GithubMergeAuthoritySource =
  "project_role" | "task_owner" | "org_admin_override";

export interface GithubActionContext {
  dataRoot?: string;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  taskLifecycle?: TaskLifecycleGuard;
  /** Governing caller re-check performed synchronously at each irreversible
   * merge boundary (RBAC/evidence ownership lives in the task service). */
  assertAuthorized?: () => GithubMergeAuthoritySource | void;
}

let mergeFaultHooksForTests: {
  afterRemoteSuccess?: () => void | Promise<void>;
  afterTargetCheckBeforeCanonicalWrite?: () => void | Promise<void>;
  afterCanonicalWrite?: () => void | Promise<void>;
} | null = null;

/** Focused crash seams for the irreversible remote-merge boundary and the
 * canonical-write/side-effect checkpoint. */
export function configureMergeFaultHooksForTests(
  hooks: {
    afterRemoteSuccess?: () => void | Promise<void>;
    afterTargetCheckBeforeCanonicalWrite?: () => void | Promise<void>;
    afterCanonicalWrite?: () => void | Promise<void>;
  } | null,
): void {
  mergeFaultHooksForTests = hooks;
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

function taskLifecycleFor(
  ctx: GithubActionContext,
  createdAt: string | null | undefined,
): TaskLifecycleGuard {
  const expectedCreatedAt = ctx.taskLifecycle?.expectedCreatedAt ?? createdAt;
  if (!expectedCreatedAt) {
    throw new DOMException(
      "Task lifecycle ownership is missing.",
      "AbortError",
    );
  }
  return {
    expectedCreatedAt,
    ...((ctx.taskLifecycle?.signal ?? ctx.signal)
      ? { signal: ctx.taskLifecycle?.signal ?? ctx.signal }
      : {}),
  };
}

function assertCurrentGithubTask(
  ref: ReturnType<typeof taskRefOf>,
  guard: TaskLifecycleGuard,
): void {
  const current = readTaskFile(ref);
  assertTaskLifecycleActive(
    guard,
    current?.parsed.frontmatter.createdAt ?? null,
  );
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
  const taskLifecycle = taskLifecycleFor(
    ctx,
    file.parsed.frontmatter.createdAt,
  );
  assertTaskLifecycleActive(taskLifecycle, file.parsed.frontmatter.createdAt);
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
  assertCurrentGithubTask(ref, taskLifecycle);
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
      {
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        expectedTaskCreatedAt: taskLifecycle.expectedCreatedAt,
        ...(taskLifecycle.signal ? { signal: taskLifecycle.signal } : {}),
      },
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
  const prResult = await findPrForBranch(
    gh.client,
    gh.repo,
    branch,
    gh.defaultBranch,
  );
  assertCurrentGithubTask(ref, taskLifecycle);
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

  const observedHeadSha = normalizeFullGitSha(pr?.headSha);
  const computeNext = (parsed: {
    goal: string;
    frontmatter: TaskFrontmatter;
  }) => {
    const currentFm = parsed.frontmatter;
    const samePr = !!pr && currentFm.pr?.number === pr.number;
    const previousHeadSha = samePr
      ? normalizeFullGitSha(currentFm.pr?.headSha)
      : null;
    // Missing live head is degraded data, not evidence of erasure. A positively
    // observed replacement head, however, revokes the old human acceptance.
    const reconciledHeadSha = observedHeadSha ?? previousHeadSha;
    const headChanged =
      samePr && observedHeadSha !== null && previousHeadSha !== observedHeadSha;
    const liveState =
      samePr &&
      currentFm.pr?.state === "accepted" &&
      pr?.state === "review" &&
      !headChanged
        ? "accepted"
        : pr?.state;
    const nextPr: PrRef | null = pr
      ? {
          number: pr.number,
          state: liveState ?? pr.state,
          title: pr.title,
          ...(reconciledHeadSha ? { headSha: reconciledHeadSha } : {}),
          ...(pr.baseRepo ? { baseRepo: pr.baseRepo } : {}),
          ...(pr.baseRef ? { baseRef: pr.baseRef } : {}),
          ...(pr.checks ? { checks: pr.checks } : {}),
        }
      : (currentFm.pr ?? null);
    const existingGithub: GithubCache | null = currentFm.github;
    const prefixCommits = compare
      ? taskCommits(compare.commits, currentFm.key)
      : null;
    const existingCommits = existingGithub?.commits ?? [];
    const branchCommits =
      prefixCommits !== null &&
      prefixCommits.length === 0 &&
      existingCommits.length > 0
        ? existingCommits
        : prefixCommits;
    const nextGithub: GithubCache | null =
      branchCommits !== null || pr?.changed || existingGithub
        ? {
            commits: branchCommits ?? existingCommits,
            changed: pr?.changed ?? existingGithub?.changed ?? null,
          }
        : null;
    return {
      nextPr,
      nextGithub,
      branchCommits,
      headChanged,
      acceptedClosedExternally:
        currentFm.pr?.state === "accepted" &&
        nextPr?.state === "closed" &&
        currentFm.pr.number === nextPr.number,
      changed:
        JSON.stringify({ pr: currentFm.pr, github: currentFm.github }) !==
        JSON.stringify({ pr: nextPr, github: nextGithub }),
    };
  };

  let next = computeNext(file.parsed);
  let changed = next.changed;
  if (changed) {
    await updateTaskFile(ref, (parsed) => {
      assertTaskLifecycleActive(taskLifecycle, parsed.frontmatter.createdAt);
      next = computeNext(parsed);
      changed = next.changed;
      if (!changed) return;
      const oldEvidence = reviewEvidenceFingerprint(parsed, gh.repo);
      parsed.frontmatter.pr = next.nextPr;
      parsed.frontmatter.github = next.nextGithub;
      const evidenceChanged =
        oldEvidence !== reviewEvidenceFingerprint(parsed, gh.repo);
      if (evidenceChanged || next.headChanged) {
        clearReviewEvidence(parsed, null);
        if (parsed.frontmatter.validation !== "failing") {
          parsed.frontmatter.validation = "changed";
        }
      }
      if (next.acceptedClosedExternally && next.nextPr) {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "policy",
          actor: POLICY_ENGINE_ACTOR,
          title: null,
          text: `**Policy note:** accepted PR #${next.nextPr.number} was closed on GitHub without merging — the pending merge can no longer be completed from Viberr.`,
          toAgent: false,
          evidence: null,
        });
      }
    });
    assertCurrentGithubTask(ref, taskLifecycle);
    if (changed) {
      rebuildPath(db, resolveTaskFilePath(ref), {
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      });
    }
  }
  const newPr = next.nextPr;
  const branchCommits = next.branchCommits;

  const sync = deriveSyncState({
    prMerged: (pr?.state ?? fm.pr?.state) === "merged",
    behindBy: compare?.behindBy ?? 0,
  });

  assertCurrentGithubTask(ref, taskLifecycle);
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

interface GhPullHeadResponse {
  head?: { sha?: string };
  base?: {
    ref?: string;
    repo?: { full_name?: string };
  };
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
}

export type LivePullObservationResult =
  | {
      status: "ok";
      repo: string;
      prNumber: number;
      headSha: string;
      merged: boolean;
      mergeSha: string | null;
      baseRef: string | null;
      baseRepo: string | null;
    }
  | { status: "pr_not_found" }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

async function readLivePullHead(
  client: GithubClient,
  repo: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<LivePullObservationResult> {
  const result = await client.request<GhPullHeadResponse>(
    "GET",
    `/repos/${repo}/pulls/${prNumber}`,
    signal ? { signal } : {},
  );
  if (result.ok) {
    const headSha = normalizeFullGitSha(result.data.head?.sha);
    return headSha
      ? {
          status: "ok",
          repo,
          prNumber,
          headSha,
          merged:
            result.data.merged === true ||
            !!result.data.merged_at ||
            result.data.state?.toLowerCase() === "merged",
          mergeSha: result.data.merge_commit_sha ?? null,
          baseRef: result.data.base?.ref ?? null,
          baseRepo: result.data.base?.repo?.full_name ?? null,
        }
      : {
          status: "network_unavailable",
          message: "GitHub did not return a full pull-request head SHA.",
        };
  }
  if (result.kind === "network") {
    return { status: "network_unavailable", message: result.message };
  }
  if (result.status === 401) {
    return { status: "auth_failed", message: result.message };
  }
  if (result.status === 404) return { status: "pr_not_found" };
  return {
    status: "network_unavailable",
    message:
      result.kind === "http"
        ? result.message
        : "GitHub returned no updated pull-request head.",
  };
}

/** Observe one exact PR without trusting task.md cache state. Used by merge
 * recovery and by the completion umbrella when a process died before the
 * narrower GitHub merge intent was staged. */
export async function observeLivePullRequest(
  db: Database.Database,
  input: { projectSlug: string; repo: string; prNumber: number },
  ctx: Pick<GithubActionContext, "fetchImpl" | "signal"> = {},
): Promise<LivePullObservationResult | GithubContextFailure> {
  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: input.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;
  if (normalizedRepo(gh.repo) !== normalizedRepo(input.repo)) {
    return { status: "no_repo_configured" };
  }
  return readLivePullHead(gh.client, input.repo, input.prNumber, ctx.signal);
}

function hasMergeProvenance(
  db: Database.Database,
  sourcePath: string,
  taskIncarnation: string,
  repo: string,
  prNumber: number,
  headSha: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM provenance
        WHERE source_path = ?
          AND action = 'github.merge'
          AND lower(json_extract(details_json, '$.repo')) = lower(?)
          AND json_extract(details_json, '$.prNumber') = ?
          AND json_extract(details_json, '$.headSha') = ?
          AND json_extract(details_json, '$.taskIncarnation') = ?
        LIMIT 1`,
    )
    .get(sourcePath, repo, prNumber, headSha, taskIncarnation);
}

function hasMergeAudit(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  taskIncarnation: string,
  repo: string,
  prNumber: number,
  headSha: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM audit_events
        WHERE action = 'github.pr.merged'
          AND project_slug = ?
          AND task_key = ?
          AND lower(json_extract(details_json, '$.repo')) = lower(?)
          AND json_extract(details_json, '$.prNumber') = ?
          AND json_extract(details_json, '$.headSha') = ?
          AND json_extract(details_json, '$.taskIncarnation') = ?
        LIMIT 1`,
    )
    .get(projectSlug, taskKey, repo, prNumber, headSha, taskIncarnation);
}

interface GithubMergeIntentRow {
  id: string;
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  repo: string;
  default_branch: string;
  pr_number: number;
  head_sha: string;
  actor_user_id: string;
  actor_label: string;
  authority_source: GithubMergeAuthoritySource | null;
  created_at: string;
}

function mergeIntentActor(row: GithubMergeIntentRow): AuditActor {
  return {
    userId: row.actor_user_id,
    label: row.actor_label,
    ...(row.authority_source === "org_admin_override"
      ? { auditAuthoritySource: row.authority_source }
      : {}),
  };
}

function findMergeIntent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    repo: string;
    prNumber: number;
    headSha: string;
  },
): GithubMergeIntentRow | null {
  return (
    (db
      .prepare(
        `SELECT id, project_slug, task_key, task_incarnation, repo,
                default_branch, pr_number, head_sha, actor_user_id,
                actor_label, authority_source, created_at
           FROM github_merge_intents
          WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
            AND lower(repo) = lower(?) AND pr_number = ? AND head_sha = ?`,
      )
      .get(
        input.projectSlug,
        input.taskKey,
        input.taskIncarnation,
        input.repo,
        input.prNumber,
        input.headSha,
      ) as GithubMergeIntentRow | undefined) ?? null
  );
}

function createOrFindMergeIntent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    repo: string;
    defaultBranch: string;
    prNumber: number;
    headSha: string;
    authoritySource: GithubMergeAuthoritySource | null;
  },
  actor: AuditActor & { userId: string },
): { intent: GithubMergeIntentRow; created: boolean } {
  const id = newId("merge_intent");
  const createdAt = new Date().toISOString();
  const repo = normalizedRepo(input.repo);
  if (!repo) throw new Error("GitHub merge intent requires a repository.");
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO github_merge_intents
         (id, project_slug, task_key, task_incarnation, repo, default_branch,
          pr_number, head_sha, actor_user_id, actor_label, authority_source,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectSlug,
      input.taskKey,
      input.taskIncarnation,
      repo,
      input.defaultBranch,
      input.prNumber,
      input.headSha,
      actor.userId,
      actor.label,
      input.authoritySource,
      createdAt,
    );
  const intent = findMergeIntent(db, input);
  if (!intent) {
    throw new Error("GitHub merge intent could not be persisted.");
  }
  return { intent, created: inserted.changes === 1 };
}

function replaceMergeIntentActor(
  db: Database.Database,
  intent: GithubMergeIntentRow,
  defaultBranch: string,
  actor: AuditActor & { userId: string },
  authoritySource: GithubMergeAuthoritySource | null,
): GithubMergeIntentRow {
  db.prepare(
    `UPDATE github_merge_intents
        SET default_branch = ?, actor_user_id = ?, actor_label = ?,
            authority_source = ?, created_at = ?
      WHERE id = ?`,
  ).run(
    defaultBranch,
    actor.userId,
    actor.label,
    authoritySource,
    new Date().toISOString(),
    intent.id,
  );
  return {
    ...intent,
    default_branch: defaultBranch,
    actor_user_id: actor.userId,
    actor_label: actor.label,
    authority_source: authoritySource,
  };
}

function clearMergeIntent(
  db: Database.Database,
  intent: GithubMergeIntentRow | null,
): void {
  if (!intent) return;
  db.prepare(`DELETE FROM github_merge_intents WHERE id = ?`).run(intent.id);
}

const ACTIVE_MERGE_INTENTS = Symbol.for("viberr.activeGithubMergeIntents");

function activeMergeIntents(): Set<string> {
  const cache = globalThis as unknown as Record<
    symbol,
    Set<string> | undefined
  >;
  return (cache[ACTIVE_MERGE_INTENTS] ??= new Set());
}

function tryOwnMergeIntent(intentId: string): boolean {
  const active = activeMergeIntents();
  if (active.has(intentId)) return false;
  active.add(intentId);
  return true;
}

function releaseMergeIntent(intentId: string): void {
  activeMergeIntents().delete(intentId);
}

function mergeTimelineActor(
  db: Database.Database,
  actor: AuditActor,
):
  | { kind: "human"; userId: string; nameHint: string | null }
  | { kind: "system"; systemId: string } {
  return actor.userId
    ? {
        kind: "human",
        userId: actor.userId,
        nameHint: userName(db, actor.userId),
      }
    : { kind: "system", systemId: "github-reconciler" };
}

interface SuccessfulMergeFact {
  projectSlug: string;
  taskKey: string;
  repo: string;
  defaultBranch: string;
  prNumber: number;
  expectedHeadSha: string;
  mergeSha: string | null;
  authoritySource: GithubMergeAuthoritySource | null;
  mergeIntentId?: string | null;
}

function currentCanonicalMergeTarget(
  ref: ReturnType<typeof taskRefOf>,
  input: SuccessfulMergeFact,
  ctx: GithubActionContext,
  taskLifecycle: TaskLifecycleGuard,
): "matches" | "detached" | "revoked" {
  if (taskLifecycle.signal?.aborted) return "revoked";
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project || project.parsed.frontmatter.archived) return "revoked";
  const task = readTaskFile(ref);
  if (task?.parsed.frontmatter.createdAt !== taskLifecycle.expectedCreatedAt) {
    return "detached";
  }
  const pr = task.parsed.frontmatter.pr;
  return normalizedRepo(
    task.parsed.frontmatter.repo ?? project?.parsed.frontmatter.repo,
  ) === normalizedRepo(input.repo) &&
    (project?.parsed.frontmatter.defaultBranch ?? "main") ===
      input.defaultBranch &&
    pr?.number === input.prNumber &&
    normalizeFullGitSha(pr.headSha) === input.expectedHeadSha &&
    (!pr.baseRepo ||
      normalizedRepo(pr.baseRepo) === normalizedRepo(input.repo)) &&
    (!pr.baseRef || pr.baseRef === input.defaultBranch)
    ? "matches"
    : "detached";
}

/** Converge every local effect of one already-confirmed remote merge. The
 * immutable audit/provenance fact never depends on mutable task targeting.
 * Canonical task state is updated only while the same incarnation still links
 * the exact repo/PR/head; otherwise the old remote fact is recorded detached
 * without corrupting the replacement target. */
async function convergeSuccessfulMerge(
  db: Database.Database,
  ref: ReturnType<typeof taskRefOf>,
  input: SuccessfulMergeFact,
  actor: AuditActor,
  ctx: GithubActionContext,
  taskLifecycle: TaskLifecycleGuard,
): Promise<MergeTaskPrResult> {
  const targetState = currentCanonicalMergeTarget(
    ref,
    input,
    ctx,
    taskLifecycle,
  );
  let canonicalApplied = false;
  if (targetState === "matches") {
    const eventSource = `github-merge:${taskLifecycle.expectedCreatedAt}:${input.repo}#${input.prNumber}:${input.expectedHeadSha}`;
    const eventText = `Merged **PR #${input.prNumber}** into \`${input.defaultBranch}\`.`;
    try {
      await mergeFaultHooksForTests?.afterTargetCheckBeforeCanonicalWrite?.();
      await updateTaskFile(ref, (parsed) => {
        assertTaskLifecycleActive(taskLifecycle, parsed.frontmatter.createdAt);
        const currentProject = readProjectFile({
          projectSlug: input.projectSlug,
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        });
        const currentPr = parsed.frontmatter.pr;
        if (
          !currentProject ||
          currentProject.parsed.frontmatter.archived ||
          normalizedRepo(
            parsed.frontmatter.repo ?? currentProject.parsed.frontmatter.repo,
          ) !== normalizedRepo(input.repo) ||
          currentProject.parsed.frontmatter.defaultBranch !==
            input.defaultBranch ||
          !currentPr ||
          currentPr.number !== input.prNumber ||
          normalizeFullGitSha(currentPr.headSha) !== input.expectedHeadSha ||
          (!!currentPr.baseRepo &&
            normalizedRepo(currentPr.baseRepo) !==
              normalizedRepo(input.repo)) ||
          (!!currentPr.baseRef && currentPr.baseRef !== input.defaultBranch)
        ) {
          return;
        }
        parsed.frontmatter.pr = { ...currentPr, state: "merged" };
        const eventExists = parsed.timeline.some(
          (event) =>
            event.type === "github" && event.sourceRunId === eventSource,
        );
        if (!eventExists) {
          parsed.timeline.unshift({
            occurredAt: new Date().toISOString(),
            type: "github",
            actor: mergeTimelineActor(db, actor),
            title: null,
            text: eventText,
            toAgent: false,
            sourceRunId: eventSource,
            evidence: null,
          });
        }
        canonicalApplied = true;
      });
      if (canonicalApplied) {
        await mergeFaultHooksForTests?.afterCanonicalWrite?.();
      }
    } catch (error) {
      if (taskLifecycle.signal?.aborted && error instanceof DOMException) {
        canonicalApplied = false;
      } else {
        throw error;
      }
    }
  }

  const absPath = resolveTaskFilePath(ref);
  if (canonicalApplied) {
    rebuildPath(db, absPath, {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  }
  const sourcePath = storeRelativePath(absPath, ctx.dataRoot);
  if (
    !hasMergeProvenance(
      db,
      sourcePath,
      taskLifecycle.expectedCreatedAt,
      input.repo,
      input.prNumber,
      input.expectedHeadSha,
    )
  ) {
    recordGithubProvenance(db, {
      absPath,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      action: "github.merge",
      details: {
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.expectedHeadSha,
        taskIncarnation: taskLifecycle.expectedCreatedAt,
        sha: input.mergeSha,
        authoritySource: input.authoritySource,
        canonicalApplied,
      },
    });
  }
  if (
    !hasMergeAudit(
      db,
      input.projectSlug,
      input.taskKey,
      taskLifecycle.expectedCreatedAt,
      input.repo,
      input.prNumber,
      input.expectedHeadSha,
    )
  ) {
    recordAudit(db, {
      action: "github.pr.merged",
      actor,
      subjectKind: "pull_request",
      subjectId: `${input.repo}#${input.prNumber}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.expectedHeadSha,
        taskIncarnation: taskLifecycle.expectedCreatedAt,
        sha: input.mergeSha,
        authoritySource: input.authoritySource,
        canonicalApplied,
      },
    });
    if (
      !hasMergeAudit(
        db,
        input.projectSlug,
        input.taskKey,
        taskLifecycle.expectedCreatedAt,
        input.repo,
        input.prNumber,
        input.expectedHeadSha,
      )
    ) {
      throw new Error(
        "GitHub merge audit could not be persisted; merge intent retained for recovery.",
      );
    }
  }
  const open = canonicalApplied
    ? findOpenScopeViolation(
        db,
        input.projectSlug,
        "pull_request:write",
        input.taskKey,
      )
    : null;
  if (open && canonicalApplied) {
    await resolveScopeViolationWithEvent(db, open.id, actor, {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      expectedTaskCreatedAt: taskLifecycle.expectedCreatedAt,
      ...(taskLifecycle.signal ? { signal: taskLifecycle.signal } : {}),
    });
  }
  // A revoked lifecycle retains the intent so restore/restart can still apply
  // the known merge to the unchanged canonical task. A detached target has no
  // safe task mutation left; its immutable fact is complete and the intent can
  // be consumed.
  if (input.mergeIntentId && (canonicalApplied || targetState === "detached")) {
    db.prepare(`DELETE FROM github_merge_intents WHERE id = ?`).run(
      input.mergeIntentId,
    );
  }
  return {
    status: "merged",
    prNumber: input.prNumber,
    sha: input.mergeSha,
  };
}

export interface GithubMergeRecoverySummary {
  /** Remote merge facts whose immutable audit/provenance effects converged. */
  completed: number;
  /** Intents conclusively shown not to represent the pinned merge target. */
  cancelled: number;
  /** Intents retained because credentials, transport, or local ownership was busy. */
  deferred: number;
  /** Unexpected failures; the durable intent is retained for a later boot. */
  errors: number;
}

/**
 * Consume durable merge intents left by a process exit. Recovery never issues
 * another PUT: it either trusts a matching intent plus canonical merged cache,
 * observes the exact live repo/base/head as merged, or retains/cancels the row.
 * That keeps restart replay attribution stable and prevents a boot from
 * performing a new irreversible action without a live human authorization
 * check.
 */
export async function recoverGithubMergeIntents(
  db: Database.Database,
  ctx: Pick<GithubActionContext, "dataRoot" | "fetchImpl" | "signal"> = {},
): Promise<GithubMergeRecoverySummary> {
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation, repo,
              default_branch, pr_number, head_sha, actor_user_id,
              actor_label, authority_source, created_at
         FROM github_merge_intents
        ORDER BY created_at, id`,
    )
    .all() as GithubMergeIntentRow[];
  const summary: GithubMergeRecoverySummary = {
    completed: 0,
    cancelled: 0,
    deferred: 0,
    errors: 0,
  };

  for (const intent of rows) {
    const canonicalProject = readProjectFile({
      projectSlug: intent.project_slug,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    if (!canonicalProject || canonicalProject.parsed.frontmatter.archived) {
      // Canonical archive/delete owns the namespace. Preserve the remote-fact
      // journal for an explicit restore decision, but never fetch or mutate
      // archived history during boot recovery.
      summary.deferred += 1;
      continue;
    }
    if (ctx.signal?.aborted) {
      summary.deferred += 1;
      continue;
    }
    if (!tryOwnMergeIntent(intent.id)) {
      summary.deferred += 1;
      continue;
    }
    const actionCtx: GithubActionContext = {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      taskLifecycle: {
        expectedCreatedAt: intent.task_incarnation,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    };
    const ref = taskRefOf(
      { projectSlug: intent.project_slug, taskKey: intent.task_key },
      actionCtx,
    );
    const fact: SuccessfulMergeFact = {
      projectSlug: intent.project_slug,
      taskKey: intent.task_key,
      repo: intent.repo,
      defaultBranch: intent.default_branch,
      prNumber: intent.pr_number,
      expectedHeadSha: intent.head_sha,
      mergeSha: null,
      authoritySource: intent.authority_source,
      mergeIntentId: intent.id,
    };
    const lifecycle: TaskLifecycleGuard = {
      expectedCreatedAt: intent.task_incarnation,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    try {
      const live = await observeLivePullRequest(
        db,
        {
          projectSlug: intent.project_slug,
          repo: intent.repo,
          prNumber: intent.pr_number,
        },
        {
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      if (live.status === "pr_not_found") {
        clearMergeIntent(db, intent);
        summary.cancelled += 1;
        continue;
      }
      if (live.status !== "ok") {
        summary.deferred += 1;
        continue;
      }

      const exactTarget = livePullMatchesTarget(live, {
        repo: intent.repo,
        defaultBranch: intent.default_branch,
        headSha: intent.head_sha,
      });
      if (exactTarget && live.merged) {
        await convergeSuccessfulMerge(
          db,
          ref,
          { ...fact, mergeSha: live.mergeSha },
          mergeIntentActor(intent),
          actionCtx,
          lifecycle,
        );
        summary.completed += 1;
        continue;
      }

      // An exact, still-open observation conclusively says the ambiguous PUT
      // did not commit. A changed live target cannot satisfy this intent.
      clearMergeIntent(db, intent);
      if (
        !exactTarget &&
        currentCanonicalMergeTarget(ref, fact, actionCtx, lifecycle) ===
          "matches"
      ) {
        await invalidateLivePullTarget(
          db,
          ref,
          {
            projectSlug: intent.project_slug,
            taskKey: intent.task_key,
            repo: intent.repo,
            prNumber: intent.pr_number,
            live,
            reason: "target_mismatch",
          },
          mergeIntentActor(intent),
          actionCtx,
        );
      }
      summary.cancelled += 1;
    } catch {
      summary.errors += 1;
    } finally {
      releaseMergeIntent(intent.id);
    }
  }
  return summary;
}

/**
 * Rebinds the canonical PR cache to a newly observed head and revokes evidence
 * for the older head in the same locked file mutation. `forceInvalidate` is
 * used when GitHub's merge endpoint positively proved the approved head stale
 * even if a follow-up read could not reveal the replacement.
 */
async function replaceMergeHeadEvidence(
  db: Database.Database,
  ref: ReturnType<typeof taskRefOf>,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string;
    prNumber: number;
    headSha: string | null;
    reason:
      | "missing"
      | "cached_mismatch"
      | "merge_405"
      | "merge_409"
      | "intent_reconcile";
    forceInvalidate: boolean;
  },
  actor: AuditActor,
  ctx: GithubActionContext,
): Promise<boolean> {
  const current = readTaskFile(ref);
  const taskLifecycle = taskLifecycleFor(
    ctx,
    current?.parsed.frontmatter.createdAt,
  );
  assertCurrentGithubTask(ref, taskLifecycle);
  let changed = false;
  let previousHeadSha: string | null = null;
  await updateTaskFile(ref, (parsed) => {
    assertTaskLifecycleActive(taskLifecycle, parsed.frontmatter.createdAt);
    const pr = parsed.frontmatter.pr;
    if (!pr || pr.number !== input.prNumber) return;
    previousHeadSha = normalizeFullGitSha(pr.headSha);
    const headChanged = previousHeadSha !== input.headSha;
    const acceptedEvidenceChanged = pr.state === "accepted";
    if (!headChanged && !input.forceInvalidate) return;

    const nextPr = headChanged ? { ...pr, headSha: input.headSha } : pr;
    parsed.frontmatter.pr = acceptedEvidenceChanged
      ? { ...nextPr, state: "review" }
      : nextPr;
    const currentFingerprint = reviewEvidenceFingerprint(parsed, input.repo);
    const previousVerdictCount = parsed.frontmatter.reviewerVerdicts.length;
    parsed.frontmatter.reviewerVerdicts = input.headSha
      ? parsed.frontmatter.reviewerVerdicts.filter(
          (verdict) => verdict.evidenceFingerprint === currentFingerprint,
        )
      : [];
    const humanValidationInvalidated =
      parsed.frontmatter.humanValidation !== null &&
      (!input.headSha ||
        parsed.frontmatter.humanValidation.evidenceFingerprint !==
          currentFingerprint);
    if (humanValidationInvalidated) {
      parsed.frontmatter.humanValidation = null;
    }
    const evidenceInvalidated =
      previousVerdictCount !== parsed.frontmatter.reviewerVerdicts.length ||
      humanValidationInvalidated;
    const resetValidation =
      headChanged || evidenceInvalidated || acceptedEvidenceChanged;
    if (resetValidation && parsed.frontmatter.validation !== "failing") {
      parsed.frontmatter.validation = "changed";
    }
    changed = headChanged || evidenceInvalidated || acceptedEvidenceChanged;
  });
  if (!changed) return false;

  assertCurrentGithubTask(ref, taskLifecycle);
  rebuildPath(db, resolveTaskFilePath(ref), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  recordAudit(db, {
    action: "github.pr.head_rebound",
    actor,
    subjectKind: "pull_request",
    subjectId: `${input.repo}#${input.prNumber}`,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      repo: input.repo,
      prNumber: input.prNumber,
      previousHeadSha,
      headSha: input.headSha,
      reason: input.reason,
    },
  });
  return true;
}

async function invalidateLivePullTarget(
  db: Database.Database,
  ref: ReturnType<typeof taskRefOf>,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string;
    prNumber: number;
    live: Extract<LivePullObservationResult, { status: "ok" }>;
    reason: "target_mismatch" | "false_merged_cache";
  },
  actor: AuditActor,
  ctx: GithubActionContext,
): Promise<void> {
  const current = readTaskFile(ref);
  const taskLifecycle = taskLifecycleFor(
    ctx,
    current?.parsed.frontmatter.createdAt,
  );
  await updateTaskFile(ref, (parsed) => {
    assertTaskLifecycleActive(taskLifecycle, parsed.frontmatter.createdAt);
    const pr = parsed.frontmatter.pr;
    if (!pr || pr.number !== input.prNumber) return;
    parsed.frontmatter.pr = {
      ...pr,
      state: input.live.merged ? "merged" : "review",
      headSha: input.live.headSha,
      baseRepo: input.live.baseRepo,
      baseRef: input.live.baseRef,
    };
    clearReviewEvidence(parsed, null);
    if (parsed.frontmatter.validation !== "failing") {
      parsed.frontmatter.validation = "changed";
    }
  });
  assertCurrentGithubTask(ref, taskLifecycle);
  rebuildPath(db, resolveTaskFilePath(ref), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  recordAudit(db, {
    action: "github.pr.target_rebound",
    actor,
    subjectKind: "pull_request",
    subjectId: `${input.repo}#${input.prNumber}`,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.live.headSha,
      baseRepo: input.live.baseRepo,
      baseRef: input.live.baseRef,
      merged: input.live.merged,
      reason: input.reason,
    },
  });
}

function normalizedRepo(repo: string | null | undefined): string | null {
  return repo?.trim().toLowerCase() || null;
}

function livePullMatchesTarget(
  live: Extract<LivePullObservationResult, { status: "ok" }>,
  input: { repo: string; defaultBranch: string; headSha: string },
): boolean {
  return (
    live.headSha === input.headSha &&
    normalizedRepo(live.baseRepo) === normalizedRepo(input.repo) &&
    live.baseRef === input.defaultBranch
  );
}

function wrongLiveTargetMessage(
  live: Extract<LivePullObservationResult, { status: "ok" }>,
  input: { repo: string; defaultBranch: string },
): string {
  return `PR #${live.prNumber} targets ${live.baseRepo ?? "an unknown repository"}:${live.baseRef ?? "an unknown branch"}; expected ${input.repo}:${input.defaultBranch}. Review the correct delivery target before retrying.`;
}

/** Re-read the complete immutable remote target and invoke the task service's
 * authority/evidence guard synchronously. Call this immediately before PUT;
 * a project/task repo change can never retarget an approved merge to another
 * repository that happens to share the PR number and head. */
function assertPinnedMergeTarget(
  ref: ReturnType<typeof taskRefOf>,
  input: {
    projectSlug: string;
    expectedRepo: string;
    expectedDefaultBranch: string;
    expectedPrNumber: number;
    expectedHeadSha: string;
  },
  ctx: GithubActionContext,
  taskLifecycle: TaskLifecycleGuard,
  options: { checkAuthorization?: boolean } = {},
): GithubMergeAuthoritySource | null {
  const authoritySource =
    options.checkAuthorization !== false
      ? (ctx.assertAuthorized?.() ?? null)
      : null;
  const currentTask = readTaskFile(ref);
  assertTaskLifecycleActive(
    taskLifecycle,
    currentTask?.parsed.frontmatter.createdAt,
  );
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const currentRepo = normalizedRepo(
    currentTask?.parsed.frontmatter.repo ?? project?.parsed.frontmatter.repo,
  );
  const currentPr = currentTask?.parsed.frontmatter.pr;
  if (
    currentRepo !== normalizedRepo(input.expectedRepo) ||
    (project?.parsed.frontmatter.defaultBranch ?? "main") !==
      input.expectedDefaultBranch ||
    currentPr?.number !== input.expectedPrNumber ||
    normalizeFullGitSha(currentPr?.headSha) !== input.expectedHeadSha ||
    (!!currentPr?.baseRepo &&
      normalizedRepo(currentPr.baseRepo) !==
        normalizedRepo(input.expectedRepo)) ||
    (!!currentPr?.baseRef && currentPr.baseRef !== input.expectedDefaultBranch)
  ) {
    throw new DOMException(
      "The repository, branch, pull request, or reviewed head changed before merge.",
      "AbortError",
    );
  }
  return authoritySource;
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
  input: {
    projectSlug: string;
    taskKey: string;
    /** Exact full PR head covered by the current completion evidence. */
    expectedHeadSha: string | null;
    /** Immutable remote target captured by the governing acceptance action.
     * Direct maintenance callers may omit these and pin the current target at
     * entry; completion paths always provide all three. */
    expectedRepo?: string;
    expectedDefaultBranch?: string;
    expectedPrNumber?: number;
    /** Authorization source captured at request admission. The exact pre-PUT
     * callback may replace it with a fresher source. */
    authoritySource?: GithubMergeAuthoritySource;
  },
  actor: AuditActor & { userId: string },
  ctx: GithubActionContext = {},
): Promise<MergeTaskPrResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const taskLifecycle = taskLifecycleFor(
    ctx,
    file.parsed.frontmatter.createdAt,
  );
  ctx = { ...ctx, taskLifecycle };
  assertCurrentGithubTask(ref, taskLifecycle);
  const fm = file.parsed.frontmatter;
  if (!fm.pr) return { status: "no_pr", taskKey: input.taskKey };
  const prNumber = fm.pr.number;
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const currentRepo = fm.repo ?? project?.parsed.frontmatter.repo ?? null;
  if (!currentRepo) return { status: "no_repo_configured" };
  const expectedRepo = input.expectedRepo ?? currentRepo;
  const expectedDefaultBranch =
    input.expectedDefaultBranch ??
    project?.parsed.frontmatter.defaultBranch ??
    "main";
  const expectedPrNumber = input.expectedPrNumber ?? prNumber;

  const expectedHeadSha = normalizeFullGitSha(input.expectedHeadSha);
  const cachedHeadSha = normalizeFullGitSha(fm.pr.headSha);
  const existingIntent = expectedHeadSha
    ? findMergeIntent(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        taskIncarnation: taskLifecycle.expectedCreatedAt,
        repo: expectedRepo,
        prNumber: expectedPrNumber,
        headSha: expectedHeadSha,
      })
    : null;
  if (expectedHeadSha && cachedHeadSha === expectedHeadSha) {
    assertPinnedMergeTarget(
      ref,
      {
        projectSlug: input.projectSlug,
        expectedRepo,
        expectedDefaultBranch,
        expectedPrNumber,
        expectedHeadSha,
      },
      ctx,
      taskLifecycle,
      { checkAuthorization: false },
    );
  }

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: fm.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;
  if (normalizedRepo(gh.repo) !== normalizedRepo(expectedRepo)) {
    throw new DOMException(
      "The configured GitHub repository changed before merge.",
      "AbortError",
    );
  }

  if (!expectedHeadSha || cachedHeadSha !== expectedHeadSha) {
    let currentHeadSha = cachedHeadSha;
    if (!currentHeadSha) {
      const live = await readLivePullHead(
        gh.client,
        gh.repo,
        prNumber,
        taskLifecycle.signal,
      );
      assertCurrentGithubTask(ref, taskLifecycle);
      if (live.status !== "ok") {
        return live.status === "pr_not_found"
          ? { status: "pr_not_found", prNumber }
          : live;
      }
      currentHeadSha = live.headSha;
    }
    await replaceMergeHeadEvidence(
      db,
      ref,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo: gh.repo,
        prNumber,
        headSha: currentHeadSha,
        reason: cachedHeadSha ? "cached_mismatch" : "missing",
        forceInvalidate: true,
      },
      actor,
      ctx,
    );
    return {
      status: "head_changed",
      prNumber,
      message:
        "The pull request head was not pinned to the currently approved evidence. The live head is now cached and requires review.",
    };
  }

  const pinnedTarget = {
    projectSlug: input.projectSlug,
    expectedRepo,
    expectedDefaultBranch,
    expectedPrNumber,
    expectedHeadSha,
  };
  assertPinnedMergeTarget(ref, pinnedTarget, ctx, taskLifecycle);
  const liveBeforePut = await readLivePullHead(
    gh.client,
    expectedRepo,
    expectedPrNumber,
    taskLifecycle.signal,
  );
  assertCurrentGithubTask(ref, taskLifecycle);
  if (liveBeforePut.status !== "ok") {
    if (liveBeforePut.status === "pr_not_found") {
      clearMergeIntent(db, existingIntent);
      return { status: "pr_not_found", prNumber: expectedPrNumber };
    }
    return liveBeforePut;
  }
  if (
    !livePullMatchesTarget(liveBeforePut, {
      repo: expectedRepo,
      defaultBranch: expectedDefaultBranch,
      headSha: expectedHeadSha,
    })
  ) {
    clearMergeIntent(db, existingIntent);
    await invalidateLivePullTarget(
      db,
      ref,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo: expectedRepo,
        prNumber: expectedPrNumber,
        live: liveBeforePut,
        reason: "target_mismatch",
      },
      actor,
      ctx,
    );
    return {
      status: "head_changed",
      prNumber: expectedPrNumber,
      message:
        liveBeforePut.headSha !== expectedHeadSha
          ? "The pull request head changed after review. The live target is now cached and requires fresh review."
          : wrongLiveTargetMessage(liveBeforePut, {
              repo: expectedRepo,
              defaultBranch: expectedDefaultBranch,
            }),
    };
  }

  if (liveBeforePut.merged) {
    // The GET above is an await boundary. Even though no PUT is necessary, the
    // ensuing canonical acceptance/Done transition is still irreversible from
    // Viberr's perspective, so the accepting human must still exist, be
    // enabled, and retain authority at this exact boundary.
    const exactAuthority = assertPinnedMergeTarget(
      ref,
      pinnedTarget,
      ctx,
      taskLifecycle,
    );
    if (existingIntent && !tryOwnMergeIntent(existingIntent.id)) {
      return {
        status: "network_unavailable",
        message: "This pull request merge is already being finalized.",
      };
    }
    try {
      return await convergeSuccessfulMerge(
        db,
        ref,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo: expectedRepo,
          defaultBranch:
            existingIntent?.default_branch ?? expectedDefaultBranch,
          prNumber: expectedPrNumber,
          expectedHeadSha,
          mergeSha: liveBeforePut.mergeSha,
          authoritySource:
            existingIntent?.authority_source ??
            exactAuthority ??
            input.authoritySource ??
            null,
          mergeIntentId: existingIntent?.id ?? null,
        },
        existingIntent
          ? mergeIntentActor(existingIntent)
          : input.authoritySource
            ? actor
            : SYSTEM_ACTOR,
        ctx,
        taskLifecycle,
      );
    } finally {
      if (existingIntent) releaseMergeIntent(existingIntent.id);
    }
  }

  if (fm.pr.state === "merged") {
    clearMergeIntent(db, existingIntent);
    await invalidateLivePullTarget(
      db,
      ref,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo: expectedRepo,
        prNumber: expectedPrNumber,
        live: liveBeforePut,
        reason: "false_merged_cache",
      },
      actor,
      ctx,
    );
    return {
      status: "head_changed",
      prNumber: expectedPrNumber,
      message:
        "The cached merged state did not match GitHub. Completion evidence was reset for fresh review.",
    };
  }

  const admissionAuthority = assertPinnedMergeTarget(
    ref,
    pinnedTarget,
    ctx,
    taskLifecycle,
  );
  let { intent, created } = createOrFindMergeIntent(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      taskIncarnation: taskLifecycle.expectedCreatedAt,
      repo: expectedRepo,
      defaultBranch: expectedDefaultBranch,
      prNumber: expectedPrNumber,
      headSha: expectedHeadSha,
      authoritySource: admissionAuthority ?? input.authoritySource ?? null,
    },
    actor,
  );
  if (!tryOwnMergeIntent(intent.id)) {
    return {
      status: "network_unavailable",
      message: "This pull request merge is already in progress.",
    };
  }

  let crossedRemoteBoundary = false;
  try {
    const exactAuthority = assertPinnedMergeTarget(
      ref,
      pinnedTarget,
      ctx,
      taskLifecycle,
    );
    intent = replaceMergeIntentActor(
      db,
      intent,
      expectedDefaultBranch,
      actor,
      exactAuthority ?? input.authoritySource ?? intent.authority_source,
    );

    // From this point on the outcome is potentially ambiguous: the request may
    // reach GitHub even if the local transport reports an error or this process
    // exits. Retain the intent until a live observation proves the outcome.
    crossedRemoteBoundary = true;
    const merge = await gh.client.request<GhMergeResponse>(
      "PUT",
      `/repos/${expectedRepo}/pulls/${expectedPrNumber}/merge`,
      {
        body: { sha: expectedHeadSha },
        ...(taskLifecycle.signal ? { signal: taskLifecycle.signal } : {}),
      },
    );

    if (merge.ok && merge.data.merged) {
      await mergeFaultHooksForTests?.afterRemoteSuccess?.();
      return await convergeSuccessfulMerge(
        db,
        ref,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo: expectedRepo,
          defaultBranch: expectedDefaultBranch,
          prNumber: expectedPrNumber,
          expectedHeadSha,
          mergeSha: merge.data.sha ?? null,
          authoritySource: intent.authority_source,
          mergeIntentId: intent.id,
        },
        mergeIntentActor(intent),
        ctx,
        taskLifecycle,
      );
    }
    if (merge.ok) {
      clearMergeIntent(db, intent);
      return {
        status: "not_mergeable",
        prNumber: expectedPrNumber,
        message:
          merge.data.message ?? "GitHub did not merge this pull request.",
      };
    }

    if (merge.kind === "network") {
      // Ambiguous: the server may have merged before the transport failed.
      return { status: "network_unavailable", message: merge.message };
    }
    if (merge.status === 405) {
      const live = await readLivePullHead(
        gh.client,
        expectedRepo,
        expectedPrNumber,
        taskLifecycle.signal,
      );
      const exactLiveTarget =
        live.status === "ok" &&
        livePullMatchesTarget(live, {
          repo: expectedRepo,
          defaultBranch: expectedDefaultBranch,
          headSha: expectedHeadSha,
        });
      if (exactLiveTarget && live.merged) {
        return await convergeSuccessfulMerge(
          db,
          ref,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            repo: expectedRepo,
            defaultBranch: expectedDefaultBranch,
            prNumber: expectedPrNumber,
            expectedHeadSha,
            mergeSha: live.mergeSha,
            authoritySource: intent.authority_source,
            mergeIntentId: intent.id,
          },
          mergeIntentActor(intent),
          ctx,
          taskLifecycle,
        );
      }
      if (live.status === "ok" && !exactLiveTarget) {
        clearMergeIntent(db, intent);
        if (
          currentCanonicalMergeTarget(
            ref,
            {
              projectSlug: input.projectSlug,
              taskKey: input.taskKey,
              repo: expectedRepo,
              defaultBranch: expectedDefaultBranch,
              prNumber: expectedPrNumber,
              expectedHeadSha,
              mergeSha: null,
              authoritySource: intent.authority_source,
            },
            ctx,
            taskLifecycle,
          ) === "matches"
        ) {
          if (
            live.headSha !== expectedHeadSha &&
            normalizedRepo(live.baseRepo) === normalizedRepo(expectedRepo) &&
            live.baseRef === expectedDefaultBranch
          ) {
            await replaceMergeHeadEvidence(
              db,
              ref,
              {
                projectSlug: input.projectSlug,
                taskKey: input.taskKey,
                repo: expectedRepo,
                prNumber: expectedPrNumber,
                headSha: live.headSha,
                reason: "merge_405",
                forceInvalidate: true,
              },
              actor,
              ctx,
            );
          } else {
            await invalidateLivePullTarget(
              db,
              ref,
              {
                projectSlug: input.projectSlug,
                taskKey: input.taskKey,
                repo: expectedRepo,
                prNumber: expectedPrNumber,
                live,
                reason: "target_mismatch",
              },
              actor,
              ctx,
            );
          }
        }
        return {
          status: "head_changed",
          prNumber: expectedPrNumber,
          message:
            live.headSha !== expectedHeadSha
              ? "GitHub reports a different pull-request head. Review the current head before retrying."
              : wrongLiveTargetMessage(live, {
                  repo: expectedRepo,
                  defaultBranch: expectedDefaultBranch,
                }),
        };
      }
      if (live.status === "ok") clearMergeIntent(db, intent);
      return {
        status: "not_mergeable",
        prNumber: expectedPrNumber,
        message: merge.message,
      };
    }
    if (merge.status === 409) {
      const live = await readLivePullHead(
        gh.client,
        expectedRepo,
        expectedPrNumber,
        taskLifecycle.signal,
      );
      const exactLiveTarget =
        live.status === "ok" &&
        livePullMatchesTarget(live, {
          repo: expectedRepo,
          defaultBranch: expectedDefaultBranch,
          headSha: expectedHeadSha,
        });
      if (exactLiveTarget && live.merged) {
        return await convergeSuccessfulMerge(
          db,
          ref,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            repo: expectedRepo,
            defaultBranch: expectedDefaultBranch,
            prNumber: expectedPrNumber,
            expectedHeadSha,
            mergeSha: live.mergeSha,
            authoritySource: intent.authority_source,
            mergeIntentId: intent.id,
          },
          mergeIntentActor(intent),
          ctx,
          taskLifecycle,
        );
      }
      clearMergeIntent(db, intent);
      if (exactLiveTarget) {
        return {
          status: "not_mergeable",
          prNumber: expectedPrNumber,
          message: merge.message,
        };
      }
      if (
        live.status === "ok" &&
        currentCanonicalMergeTarget(
          ref,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            repo: expectedRepo,
            defaultBranch: expectedDefaultBranch,
            prNumber: expectedPrNumber,
            expectedHeadSha,
            mergeSha: null,
            authoritySource: intent.authority_source,
          },
          ctx,
          taskLifecycle,
        ) === "matches"
      ) {
        if (
          live.headSha !== expectedHeadSha &&
          normalizedRepo(live.baseRepo) === normalizedRepo(expectedRepo) &&
          live.baseRef === expectedDefaultBranch
        ) {
          await replaceMergeHeadEvidence(
            db,
            ref,
            {
              projectSlug: input.projectSlug,
              taskKey: input.taskKey,
              repo: expectedRepo,
              prNumber: expectedPrNumber,
              headSha: live.headSha,
              reason: "merge_409",
              forceInvalidate: true,
            },
            actor,
            ctx,
          );
        } else {
          await invalidateLivePullTarget(
            db,
            ref,
            {
              projectSlug: input.projectSlug,
              taskKey: input.taskKey,
              repo: expectedRepo,
              prNumber: expectedPrNumber,
              live,
              reason: "target_mismatch",
            },
            actor,
            ctx,
          );
        }
      }
      return {
        status: "head_changed",
        prNumber: expectedPrNumber,
        message:
          live.status === "ok"
            ? `${merge.message} The current PR target was cached; review it before retrying.`
            : `${merge.message} Viberr could not read the current PR target, so completion evidence must be refreshed.`,
      };
    }
    if (merge.status === 403) {
      assertPinnedMergeTarget(ref, pinnedTarget, ctx, taskLifecycle, {
        checkAuthorization: false,
      });
      clearMergeIntent(db, intent);
      const { violation } = await flagScopeViolation(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          scope: "pull_request:write",
          detail: policyViolationText(
            "pull_request:write",
            `Merging PR #${expectedPrNumber} was refused.`,
          ),
          actor,
        },
        {
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
          expectedTaskCreatedAt: taskLifecycle.expectedCreatedAt,
          ...(taskLifecycle.signal ? { signal: taskLifecycle.signal } : {}),
        },
      );
      assertCurrentGithubTask(ref, taskLifecycle);
      recordAudit(db, {
        action: "github.pr.merge_refused",
        actor,
        subjectKind: "pull_request",
        subjectId: `${expectedRepo}#${expectedPrNumber}`,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        details: { scope: "pull_request:write", violationId: violation.id },
      });
      return {
        status: "scope_violation",
        prNumber: expectedPrNumber,
        scope: "pull_request:write",
        violationId: violation.id,
        message: merge.message,
      };
    }
    if (merge.status === 404) {
      clearMergeIntent(db, intent);
      return { status: "pr_not_found", prNumber: expectedPrNumber };
    }
    if (merge.status === 401) {
      clearMergeIntent(db, intent);
      return { status: "auth_failed", message: merge.message };
    }
    // A 5xx response can be generated after GitHub accepted the operation;
    // retain intent and force observe-before-retry, like a transport failure.
    return {
      status: "network_unavailable",
      message:
        merge.kind === "http"
          ? merge.message
          : "GitHub returned an unusable merge response.",
    };
  } finally {
    if (created && !crossedRemoteBoundary) clearMergeIntent(db, intent);
    releaseMergeIntent(intent.id);
  }
}
