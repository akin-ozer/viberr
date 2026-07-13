import type Database from "better-sqlite3";
import type { ParsedTaskFile, PrRef } from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  assertTaskLifecycleActive,
  type TaskLifecycleGuard,
} from "~/server/tasks/task-lifecycle.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getEnv } from "~/server/config/env.server";
import { newId } from "~/shared/ids/new-id.server";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";
import { taskBranchName } from "./branch-sync.server";
import { normalizeFullGitSha } from "./head-sha.server";
import {
  getProjectGithubContext,
  type GithubContext,
  type GithubContextFailure,
} from "./github-context.server";
import { mapPrToCacheState } from "./pr-linker.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";

/** Compose the governed review hand-off stored verbatim in a durable intent. */
export function composePrBody(input: {
  taskKey: string;
  title: string;
  goal: string;
  taskUrl: string;
  changeSummary?: string | null;
  evidence?: string[] | null;
}): string {
  const lines: string[] = [];
  lines.push(
    `**Viberr task:** [${input.taskKey} — ${input.title}](${input.taskUrl})`,
  );
  lines.push("");
  lines.push("## Goal");
  lines.push(input.goal.trim() || "_No goal recorded on the task._");
  if (input.changeSummary && input.changeSummary.trim()) {
    lines.push("");
    lines.push("## Change summary");
    lines.push(input.changeSummary.trim());
  }
  if (input.evidence && input.evidence.length > 0) {
    lines.push("");
    lines.push("## Evidence");
    for (const evidence of input.evidence) lines.push(`- ${evidence}`);
  }
  lines.push("");
  lines.push(
    `---\n_Opened by Viberr for task ${input.taskKey}. Review and merge are human-authorized; accepting the completion in Viberr merges this PR when GitHub is reachable — otherwise the acceptance is recorded as merge-pending until a human completes the merge._`,
  );
  return lines.join("\n");
}

export function taskUrl(
  projectSlug: string,
  taskKey: string,
  appOrigin?: string,
): string {
  const origin = (appOrigin ?? getEnv().BETTER_AUTH_URL ?? "").replace(
    /\/+$/,
    "",
  );
  const path = `/projects/${projectSlug}/tasks/${taskKey}`;
  return origin ? `${origin}${path}` : path;
}

export type PrOpenAuthoritySource =
  "project_role" | "org_admin_override" | "operator" | "system_delivery";

export interface OpenTaskPrContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  appOrigin?: string;
  /** Full remote branch head already verified by server-owned delivery. */
  verifiedHeadSha?: string;
  signal?: AbortSignal;
  taskLifecycle?: TaskLifecycleGuard;
  assertAuthorization?: () => void;
  /** Explicit provenance for the actor that authorized opening this PR. */
  authoritySource?: PrOpenAuthoritySource;
  /** Crash seams used to prove the journal converges every local side effect. */
  prOpenEffectHookForTests?: (input: {
    intentId: string;
    phase:
      | "after_intent"
      | "after_observation"
      | "after_post"
      | "after_canonical"
      | "after_file";
  }) => void;
  /** Durable Review-transition handoff promoted into this exact-head intent. */
  prOpenHandoffId?: string;
}

export type OpenTaskPrResult =
  | {
      status: "ok";
      prNumber: number;
      created: boolean;
      url: string;
    }
  | GithubContextFailure
  | { status: "task_not_found" }
  | { status: "no_branch" }
  | { status: "scope_violation"; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  | { status: "nothing_to_review"; message: string }
  | { status: "target_mismatch"; message: string }
  | { status: "head_mismatch"; message: string }
  | { status: "network_unavailable"; message: string };

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head?: { sha?: string };
  base?: { ref?: string; repo?: { full_name?: string } };
}

interface GhRef {
  object?: { sha?: string };
}

interface PrOpenTarget {
  projectSlug: string;
  taskKey: string;
  taskIncarnation: string;
  repo: string;
  defaultBranch: string;
  branch: string;
  headSha: string;
}

interface GithubPrOpenIntentRow {
  id: string;
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  repo: string;
  default_branch: string;
  branch: string;
  head_sha: string;
  handoff_id: string | null;
  pr_title: string;
  pr_body: string;
  actor_user_id: string | null;
  actor_label: string;
  authority_source: PrOpenAuthoritySource;
  state: "staged" | "posting" | "observed";
  pr_number: number | null;
  pr_created: 0 | 1 | null;
  created_at: string;
  post_attempted_at: string | null;
  observed_at: string | null;
}

interface GithubPrOpenHandoffRow {
  id: string;
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  review_stage_id: string;
  review_revision: number;
  repo: string;
  default_branch: string;
  branch: string;
  actor_user_id: string | null;
  actor_label: string;
  authority_source: PrOpenAuthoritySource;
  created_at: string;
}

function normalizedRepo(repo: string | null | undefined): string {
  return (repo ?? "").trim().toLowerCase();
}

function inferredAuthority(
  actor: AuditActor,
  ctx: OpenTaskPrContext,
): PrOpenAuthoritySource {
  if (ctx.authoritySource) return ctx.authoritySource;
  if (actor.auditAuthoritySource === "org_admin_override") {
    return "org_admin_override";
  }
  if (actor.label === "operator" || actor.userId === "operator") {
    return "operator";
  }
  if (actor.userId === null) return "system_delivery";
  return "project_role";
}

function durableActor(
  actor: AuditActor,
  authoritySource: PrOpenAuthoritySource,
): AuditActor {
  return {
    userId:
      authoritySource === "operator" || authoritySource === "system_delivery"
        ? null
        : actor.userId,
    label: actor.label,
    ...(authoritySource === "org_admin_override"
      ? { auditAuthoritySource: "org_admin_override" as const }
      : {}),
  };
}

function intentActor(intent: GithubPrOpenIntentRow): AuditActor {
  return {
    userId: intent.actor_user_id,
    label: intent.actor_label,
    ...(intent.authority_source === "org_admin_override"
      ? { auditAuthoritySource: "org_admin_override" as const }
      : {}),
  };
}

function handoffActor(handoff: GithubPrOpenHandoffRow): AuditActor {
  return {
    userId: handoff.actor_user_id,
    label: handoff.actor_label,
    ...(handoff.authority_source === "org_admin_override"
      ? { auditAuthoritySource: "org_admin_override" as const }
      : {}),
  };
}

function readHandoff(
  db: Database.Database,
  handoffId: string,
): GithubPrOpenHandoffRow | null {
  return (
    (db
      .prepare(
        `SELECT id, project_slug, task_key, task_incarnation,
                review_stage_id, review_revision, repo, default_branch, branch,
                actor_user_id, actor_label, authority_source, created_at
           FROM github_pr_open_handoffs
          WHERE id = ?`,
      )
      .get(handoffId) as GithubPrOpenHandoffRow | undefined) ?? null
  );
}

/**
 * Durable synchronous half of Automatic Review delivery. It is deliberately
 * staged before task.md moves into Review. Boot consumes it only when the
 * exact incarnation actually committed that Review stage; a pre-write crash
 * becomes a safely cancelled orphan rather than a fabricated open request.
 */
export function stageReviewPrOpenHandoff(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    reviewStageId: string;
  },
  actor: AuditActor,
  ctx: Pick<
    OpenTaskPrContext,
    "dataRoot" | "authoritySource" | "assertAuthorization"
  > = {},
): string | null {
  assertProjectActive(db, input.projectSlug, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  ctx.assertAuthorization?.();
  const task = readTaskFile({
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (
    !task ||
    !project ||
    task.parsed.frontmatter.createdAt !== input.taskIncarnation
  ) {
    throw new DOMException("Task lifecycle ownership changed.", "AbortError");
  }
  const repo =
    task.parsed.frontmatter.repo ?? project.parsed.frontmatter.repo ?? null;
  if (!repo) return null;
  const defaultBranch = project.parsed.frontmatter.defaultBranch || "main";
  const branch =
    task.parsed.frontmatter.branch ??
    taskBranchName(input.taskKey, task.parsed.frontmatter.title);
  const authoritySource = inferredAuthority(actor, ctx);
  const durable = durableActor(actor, authoritySource);
  const reviewRevision = task.parsed.frontmatter.reviewRevision + 1;
  const id = newId("pr_open_handoff");
  db.prepare(
    `INSERT OR IGNORE INTO github_pr_open_handoffs
       (id, project_slug, task_key, task_incarnation, review_stage_id, review_revision,
        repo, default_branch, branch, actor_user_id, actor_label,
        authority_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectSlug,
    input.taskKey,
    input.taskIncarnation,
    input.reviewStageId,
    reviewRevision,
    normalizedRepo(repo),
    defaultBranch,
    branch,
    durable.userId,
    durable.label,
    authoritySource,
    new Date().toISOString(),
  );
  const row = db
    .prepare(
      `SELECT id FROM github_pr_open_handoffs
        WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
          AND review_stage_id = ? AND review_revision = ? AND lower(repo) = lower(?)
          AND default_branch = ? AND branch = ?`,
    )
    .get(
      input.projectSlug,
      input.taskKey,
      input.taskIncarnation,
      input.reviewStageId,
      reviewRevision,
      repo,
      defaultBranch,
      branch,
    ) as { id: string } | undefined;
  if (!row) throw new Error("GitHub PR-open handoff could not be persisted.");
  return row.id;
}

function assertPrLifecycleActive(
  ctx: OpenTaskPrContext,
  currentCreatedAt?: string | null,
): void {
  ctx.assertAuthorization?.();
  if (ctx.signal?.aborted) {
    throw new DOMException(
      "Pull-request delivery was cancelled.",
      "AbortError",
    );
  }
  if (currentCreatedAt !== undefined) {
    assertTaskLifecycleActive(ctx.taskLifecycle, currentCreatedAt);
  }
}

function taskRef(
  target: Pick<PrOpenTarget, "projectSlug" | "taskKey">,
  dataRoot?: string,
) {
  return {
    projectSlug: target.projectSlug,
    taskKey: target.taskKey,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  };
}

function assertCanonicalTarget(
  target: PrOpenTarget,
  ctx: OpenTaskPrContext,
  parsed?: ParsedTaskFile,
): void {
  assertPrLifecycleActive(ctx);
  const ref = taskRef(target, ctx.dataRoot);
  const current = parsed ?? readTaskFile(ref)?.parsed ?? null;
  const project = readProjectFile({
    projectSlug: target.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!current || !project) {
    throw new DOMException(
      "Pull-request target ownership disappeared.",
      "AbortError",
    );
  }
  if (project.parsed.frontmatter.archived) {
    throw new DOMException(
      "Project lifecycle ownership was revoked.",
      "AbortError",
    );
  }
  assertPrLifecycleActive(ctx, current.frontmatter.createdAt);
  const currentRepo =
    current.frontmatter.repo ?? project.parsed.frontmatter.repo ?? null;
  const currentDefault = project.parsed.frontmatter.defaultBranch || "main";
  const currentBranch =
    current.frontmatter.branch ??
    taskBranchName(target.taskKey, current.frontmatter.title);
  if (
    current.frontmatter.createdAt !== target.taskIncarnation ||
    normalizedRepo(currentRepo) !== normalizedRepo(target.repo) ||
    currentDefault !== target.defaultBranch ||
    currentBranch !== target.branch
  ) {
    throw new DOMException(
      "Pull-request target ownership changed.",
      "AbortError",
    );
  }
}

function pullTargetFailure(
  pr: GhPull,
  target: PrOpenTarget,
): Extract<
  OpenTaskPrResult,
  { status: "target_mismatch" | "head_mismatch" }
> | null {
  if (
    pr.base?.ref !== target.defaultBranch ||
    normalizedRepo(pr.base?.repo?.full_name) !== normalizedRepo(target.repo)
  ) {
    return {
      status: "target_mismatch",
      message: `PR #${pr.number} targets ${pr.base?.repo?.full_name ?? "an unknown repository"}:${pr.base?.ref ?? "an unknown branch"}; expected ${target.repo}:${target.defaultBranch}.`,
    };
  }
  const liveHead = normalizeFullGitSha(pr.head?.sha);
  if (liveHead !== target.headSha) {
    return {
      status: "head_mismatch",
      message: `PR #${pr.number} is at ${liveHead ?? "an unknown head"}; expected exact head ${target.headSha}.`,
    };
  }
  return null;
}

function readIntent(
  db: Database.Database,
  target: PrOpenTarget,
): GithubPrOpenIntentRow | null {
  return (
    (db
      .prepare(
        `SELECT id, project_slug, task_key, task_incarnation, repo,
                default_branch, branch, head_sha, handoff_id, pr_title, pr_body,
                actor_user_id, actor_label, authority_source, state,
                pr_number, pr_created, created_at, post_attempted_at,
                observed_at
           FROM github_pr_open_intents
          WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
            AND lower(repo) = lower(?) AND default_branch = ? AND branch = ?
            AND head_sha = ?`,
      )
      .get(
        target.projectSlug,
        target.taskKey,
        target.taskIncarnation,
        target.repo,
        target.defaultBranch,
        target.branch,
        target.headSha,
      ) as GithubPrOpenIntentRow | undefined) ?? null
  );
}

function readRelatedIntents(
  db: Database.Database,
  target: PrOpenTarget,
): GithubPrOpenIntentRow[] {
  return db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation, repo,
                default_branch, branch, head_sha, handoff_id, pr_title, pr_body,
                actor_user_id, actor_label, authority_source, state,
                pr_number, pr_created, created_at, post_attempted_at,
                observed_at
           FROM github_pr_open_intents
          WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
            AND lower(repo) = lower(?) AND default_branch = ? AND branch = ?
          ORDER BY created_at, id`,
    )
    .all(
      target.projectSlug,
      target.taskKey,
      target.taskIncarnation,
      target.repo,
      target.defaultBranch,
      target.branch,
    ) as GithubPrOpenIntentRow[];
}

function stageIntent(
  db: Database.Database,
  input: {
    target: PrOpenTarget;
    title: string;
    body: string;
    actor: AuditActor;
    authoritySource: PrOpenAuthoritySource;
    handoffId?: string;
  },
): GithubPrOpenIntentRow {
  const actor = durableActor(input.actor, input.authoritySource);
  db.prepare(
    `INSERT OR IGNORE INTO github_pr_open_intents
       (id, project_slug, task_key, task_incarnation, repo, default_branch,
        branch, head_sha, handoff_id, pr_title, pr_body, actor_user_id, actor_label,
        authority_source, state, pr_number, pr_created, created_at,
        post_attempted_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, NULL,
             ?, NULL, NULL)`,
  ).run(
    newId("pr_open_intent"),
    input.target.projectSlug,
    input.target.taskKey,
    input.target.taskIncarnation,
    normalizedRepo(input.target.repo),
    input.target.defaultBranch,
    input.target.branch,
    input.target.headSha,
    input.handoffId ?? null,
    input.title,
    input.body,
    actor.userId,
    actor.label,
    input.authoritySource,
    new Date().toISOString(),
  );
  if (input.handoffId) {
    db.prepare(
      `UPDATE github_pr_open_intents
          SET handoff_id = COALESCE(handoff_id, ?)
        WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
          AND lower(repo) = lower(?) AND default_branch = ? AND branch = ?
          AND head_sha = ?`,
    ).run(
      input.handoffId,
      input.target.projectSlug,
      input.target.taskKey,
      input.target.taskIncarnation,
      input.target.repo,
      input.target.defaultBranch,
      input.target.branch,
      input.target.headSha,
    );
  }
  const intent = readIntent(db, input.target);
  if (!intent) throw new Error("GitHub PR-open intent could not be persisted.");
  return intent;
}

function markPosting(
  db: Database.Database,
  intent: GithubPrOpenIntentRow,
): GithubPrOpenIntentRow {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE github_pr_open_intents
        SET state = 'posting', post_attempted_at = ?
      WHERE id = ? AND state <> 'observed'`,
  ).run(now, intent.id);
  return { ...intent, state: "posting", post_attempted_at: now };
}

function markObserved(
  db: Database.Database,
  intent: GithubPrOpenIntentRow,
  prNumber: number,
  created: boolean,
): GithubPrOpenIntentRow {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE github_pr_open_intents
        SET state = 'observed', pr_number = ?, pr_created = ?, observed_at = ?
      WHERE id = ?`,
  ).run(prNumber, created ? 1 : 0, now, intent.id);
  return {
    ...intent,
    state: "observed",
    pr_number: prNumber,
    pr_created: created ? 1 : 0,
    observed_at: now,
  };
}

const ACTIVE_OPEN_INTENTS = Symbol.for("viberr.activeGithubPrOpenIntents");

function activeOpenIntents(): Set<string> {
  const cache = globalThis as unknown as Record<
    symbol,
    Set<string> | undefined
  >;
  return (cache[ACTIVE_OPEN_INTENTS] ??= new Set());
}

function tryOwnIntent(id: string): boolean {
  if (activeOpenIntents().has(id)) return false;
  activeOpenIntents().add(id);
  return true;
}

function releaseIntent(id: string): void {
  activeOpenIntents().delete(id);
}

function hasIntentAudit(db: Database.Database, intentId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM audit_events
        WHERE action = 'github.pr.opened'
          AND json_extract(details_json, '$.intentId') = ?
        LIMIT 1`,
    )
    .get(intentId);
}

function timelineActor(
  db: Database.Database,
  actor: AuditActor,
  authoritySource: PrOpenAuthoritySource,
) {
  if (authoritySource === "operator") return { kind: "operator" as const };
  if (actor.userId) {
    const user = db
      .prepare(`SELECT name FROM users WHERE id = ?`)
      .get(actor.userId) as { name: string } | undefined;
    return {
      kind: "human" as const,
      userId: actor.userId,
      nameHint: user?.name ?? null,
    };
  }
  return { kind: "system" as const, systemId: "github-delivery" };
}

async function writePrToTask(
  db: Database.Database,
  target: PrOpenTarget,
  pr: GhPull,
  actor: AuditActor,
  created: boolean,
  ctx: OpenTaskPrContext,
  intent: GithubPrOpenIntentRow | null = null,
): Promise<void> {
  assertCanonicalTarget(target, ctx);
  let changed = false;
  let timelineAdded = false;
  const ref = taskRef(target, ctx.dataRoot);
  await updateTaskFile(ref, (parsed) => {
    // Canonical commit point: re-read project.md here, inside the task-file
    // critical section, rather than trusting the projection/context captured
    // before one or more GitHub awaits.
    assertCanonicalTarget(target, ctx, parsed);
    const existingPr = parsed.frontmatter.pr;
    const live = mapPrToCacheState(pr);
    const samePr = existingPr !== null && existingPr.number === pr.number;
    // The live SHA is the truth. A caller's earlier verified SHA is an expected
    // value checked before this function; it can never overwrite contradiction.
    const headSha = normalizeFullGitSha(pr.head?.sha);
    if (headSha !== target.headSha) {
      throw new DOMException("Pull-request live head changed.", "AbortError");
    }
    const observedHeadChanged =
      samePr &&
      normalizeFullGitSha(existingPr.headSha) !== null &&
      normalizeFullGitSha(existingPr.headSha) !== headSha;
    const state =
      samePr &&
      live === "review" &&
      !observedHeadChanged &&
      (existingPr.state === "accepted" || existingPr.state === "merged")
        ? existingPr.state
        : live;
    const next: PrRef = {
      ...(samePr ? existingPr : {}),
      number: pr.number,
      state,
      title: pr.title,
      headSha,
      baseRepo: pr.base!.repo!.full_name!,
      baseRef: pr.base!.ref!,
    };
    changed = JSON.stringify(existingPr) !== JSON.stringify(next);
    if (changed) parsed.frontmatter.pr = next;
    if (observedHeadChanged) {
      parsed.frontmatter.reviewerVerdicts = [];
      parsed.frontmatter.humanValidation = null;
      if (parsed.frontmatter.validation !== "failing") {
        parsed.frontmatter.validation = "changed";
      }
    }
    if (
      created &&
      !parsed.timeline.some(
        (event) => intent && event.sourceIntentId === intent.id,
      )
    ) {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: timelineActor(
          db,
          actor,
          intent?.authority_source ?? inferredAuthority(actor, ctx),
        ),
        title: null,
        text: `Opened **PR #${pr.number}** for review.`,
        toAgent: false,
        ...(intent ? { sourceIntentId: intent.id } : {}),
        evidence: null,
      });
      timelineAdded = true;
    }
  });
  assertCanonicalTarget(target, ctx);
  ctx.prOpenEffectHookForTests?.({
    intentId: intent?.id ?? "untracked",
    phase: "after_canonical",
  });
  // Recovery may be replaying a crash after task.md committed but before its
  // projection did. An intent therefore always forces this convergence step.
  if (changed || timelineAdded || intent) {
    rebuildPath(db, resolveTaskFilePath(ref), {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  }
  ctx.prOpenEffectHookForTests?.({
    intentId: intent?.id ?? "untracked",
    phase: "after_file",
  });
  assertCanonicalTarget(target, ctx);
  if (!intent || !hasIntentAudit(db, intent.id)) {
    recordAudit(db, {
      action: "github.pr.opened",
      actor,
      subjectKind: "pull_request",
      subjectId: `${target.repo}#${pr.number}`,
      projectSlug: target.projectSlug,
      taskKey: target.taskKey,
      details: {
        repo: target.repo,
        prNumber: pr.number,
        headSha: target.headSha,
        created,
        ...(intent
          ? {
              intentId: intent.id,
              ...(intent.handoff_id ? { handoffId: intent.handoff_id } : {}),
              authoritySource: intent.authority_source,
            }
          : {}),
      },
    });
  }
  if (intent && hasIntentAudit(db, intent.id)) {
    db.transaction(() => {
      db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(
        intent.id,
      );
      if (intent.handoff_id) {
        db.prepare(`DELETE FROM github_pr_open_handoffs WHERE id = ?`).run(
          intent.handoff_id,
        );
      }
    })();
  }
}

async function readExactPull(
  gh: GithubContext,
  prNumber: number,
  target: PrOpenTarget,
  ctx: OpenTaskPrContext,
): Promise<OpenTaskPrResult | GhPull> {
  const live = await gh.client.request<GhPull>(
    "GET",
    `/repos/${target.repo}/pulls/${prNumber}`,
    { signal: ctx.signal },
  );
  assertCanonicalTarget(target, ctx);
  if (live.ok) {
    const mismatch = pullTargetFailure(live.data, target);
    return mismatch ?? live.data;
  }
  if (live.kind === "network") {
    return { status: "network_unavailable", message: live.message };
  }
  if (live.kind === "http" && live.status === 401) {
    return { status: "auth_failed", message: live.message };
  }
  return {
    status: "target_mismatch",
    message: `PR #${prNumber} could not be confirmed at the pinned target.`,
  };
}

function isResult(value: OpenTaskPrResult | GhPull): value is OpenTaskPrResult {
  return "status" in value;
}

async function findExactOpenPull(
  gh: GithubContext,
  target: PrOpenTarget,
  ctx: OpenTaskPrContext,
): Promise<OpenTaskPrResult | GhPull | null> {
  const existing = await gh.client.request<GhPull[]>(
    "GET",
    `/repos/${target.repo}/pulls`,
    {
      searchParams: {
        head: `${gh.owner}:${target.branch}`,
        base: target.defaultBranch,
        state: "open",
        per_page: 100,
      },
      signal: ctx.signal,
    },
  );
  assertCanonicalTarget(target, ctx);
  if (existing.ok) {
    for (const pr of existing.data) {
      if (!pullTargetFailure(pr, target)) return pr;
    }
    if (existing.data.length > 0) {
      return pullTargetFailure(existing.data[0]!, target);
    }
    return null;
  }
  if (existing.kind === "network") {
    return { status: "network_unavailable", message: existing.message };
  }
  if (existing.kind === "http" && existing.status === 401) {
    return { status: "auth_failed", message: existing.message };
  }
  return null;
}

async function scopeFailure(
  db: Database.Database,
  target: PrOpenTarget,
  actor: AuditActor,
  ctx: OpenTaskPrContext,
): Promise<Extract<OpenTaskPrResult, { status: "scope_violation" }>> {
  assertCanonicalTarget(target, ctx);
  const { violation } = await flagScopeViolation(
    db,
    {
      projectSlug: target.projectSlug,
      taskKey: target.taskKey,
      scope: "pull_request:write",
      detail: policyViolationText(
        "pull_request:write",
        "opening the review pull request",
      ),
      actor,
    },
    {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      expectedTaskCreatedAt: target.taskIncarnation,
      ...((ctx.taskLifecycle?.signal ?? ctx.signal)
        ? { signal: ctx.taskLifecycle?.signal ?? ctx.signal }
        : {}),
    },
  );
  assertCanonicalTarget(target, ctx);
  return {
    status: "scope_violation",
    scope: "pull_request:write",
    violationId: violation.id,
  };
}

async function convergeObservedIntent(
  db: Database.Database,
  gh: GithubContext,
  target: PrOpenTarget,
  intent: GithubPrOpenIntentRow,
  ctx: OpenTaskPrContext,
): Promise<OpenTaskPrResult> {
  const live = await readExactPull(gh, intent.pr_number!, target, ctx);
  if (isResult(live)) return live;
  const actor = intentActor(intent);
  await writePrToTask(
    db,
    target,
    live,
    actor,
    intent.pr_created === 1,
    ctx,
    intent,
  );
  return {
    status: "ok",
    prNumber: live.number,
    created: intent.pr_created === 1,
    url: live.html_url,
  };
}

async function adoptObservedPull(
  db: Database.Database,
  target: PrOpenTarget,
  pr: GhPull,
  actor: AuditActor,
  title: string,
  body: string,
  ctx: OpenTaskPrContext,
): Promise<OpenTaskPrResult> {
  let intent = stageIntent(db, {
    target,
    title,
    body,
    actor,
    authoritySource: inferredAuthority(actor, ctx),
    ...(ctx.prOpenHandoffId ? { handoffId: ctx.prOpenHandoffId } : {}),
  });
  intent = markObserved(db, intent, pr.number, false);
  ctx.prOpenEffectHookForTests?.({
    intentId: intent.id,
    phase: "after_observation",
  });
  await writePrToTask(db, target, pr, intentActor(intent), false, ctx, intent);
  return {
    status: "ok",
    prNumber: pr.number,
    created: false,
    url: pr.html_url,
  };
}

async function continueIntent(
  db: Database.Database,
  gh: GithubContext,
  target: PrOpenTarget,
  initialIntent: GithubPrOpenIntentRow,
  ctx: OpenTaskPrContext,
): Promise<OpenTaskPrResult> {
  if (!tryOwnIntent(initialIntent.id)) {
    return {
      status: "network_unavailable",
      message: "The exact PR-open intent is already being reconciled.",
    };
  }
  let intent = initialIntent;
  try {
    assertCanonicalTarget(target, ctx);
    if (intent.state === "observed") {
      // A known PR number is proof that POST returned. Never POST again, even
      // when the subsequent exact read is unavailable or contradictory.
      return await convergeObservedIntent(db, gh, target, intent, ctx);
    }

    const existing = await findExactOpenPull(gh, target, ctx);
    if (existing && !isResult(existing)) {
      intent = markObserved(
        db,
        intent,
        existing.number,
        intent.state === "posting",
      );
      return await convergeObservedIntent(db, gh, target, intent, ctx);
    }
    if (existing && isResult(existing)) return existing;

    if (intent.state === "posting") {
      // POST may have reached GitHub. An empty list (including eventual
      // consistency) or an HTTP observation failure proves nothing, so this
      // intent becomes observation/manual-reconciliation only. Never POST a
      // second time from an ambiguous state.
      return {
        status: "network_unavailable",
        message:
          "PR creation is uncertain. Viberr retained the exact intent and will only observe or reconcile it; it will not repeat the POST.",
      };
    }

    assertCanonicalTarget(target, ctx);
    intent = markPosting(db, intent);
    ctx.prOpenEffectHookForTests?.({
      intentId: intent.id,
      phase: "after_intent",
    });
    // The intent and exact authority/target are durable before this remote
    // mutation. A timeout now leaves `posting`, which recovery observes first.
    assertCanonicalTarget(target, ctx);
    const created = await gh.client.request<GhPull>(
      "POST",
      `/repos/${target.repo}/pulls`,
      {
        body: {
          title: intent.pr_title,
          head: target.branch,
          base: target.defaultBranch,
          body: intent.pr_body,
        },
        signal: ctx.signal,
      },
    );
    assertCanonicalTarget(target, ctx);

    if (created.ok) {
      // Persist the returned identity before any validation/file/audit await.
      // This state proves creation and permanently closes the repeat-POST path.
      intent = markObserved(db, intent, created.data.number, true);
      ctx.prOpenEffectHookForTests?.({
        intentId: intent.id,
        phase: "after_post",
      });
      return await convergeObservedIntent(db, gh, target, intent, ctx);
    }
    if (created.kind === "network") {
      return { status: "network_unavailable", message: created.message };
    }
    if (created.kind === "http" && created.status === 401) {
      db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(
        intent.id,
      );
      return { status: "auth_failed", message: created.message };
    }
    if (created.kind === "http" && created.status === 403) {
      db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(
        intent.id,
      );
      return await scopeFailure(db, target, intentActor(intent), ctx);
    }
    if (created.kind === "http" && created.status === 422) {
      // A timed-out earlier POST commonly surfaces as "already exists". Read
      // once more before classifying a genuine empty diff.
      const raced = await findExactOpenPull(gh, target, ctx);
      if (raced && !isResult(raced)) {
        intent = markObserved(db, intent, raced.number, true);
        return await convergeObservedIntent(db, gh, target, intent, ctx);
      }
      if (raced && isResult(raced)) return raced;
      db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(
        intent.id,
      );
      return { status: "nothing_to_review", message: created.message };
    }
    return {
      status: "network_unavailable",
      message: created.kind === "http" ? created.message : "unknown",
    };
  } finally {
    releaseIntent(initialIntent.id);
  }
}

async function resolveTarget(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  ctx: OpenTaskPrContext,
): Promise<
  | {
      status: "ok";
      file: NonNullable<ReturnType<typeof readTaskFile>>;
      gh: GithubContext;
      target: PrOpenTarget;
    }
  | Exclude<OpenTaskPrResult, { status: "ok" }>
> {
  assertPrLifecycleActive(ctx);
  assertProjectActive(db, input.projectSlug, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const ref = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found" };
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) return { status: "task_not_found" };
  const taskIncarnation = file.parsed.frontmatter.createdAt;
  if (!taskIncarnation) {
    throw new DOMException(
      "Task lifecycle ownership is missing.",
      "AbortError",
    );
  }
  ctx.taskLifecycle ??= {
    expectedCreatedAt: taskIncarnation,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  assertPrLifecycleActive(ctx, taskIncarnation);
  const repo =
    file.parsed.frontmatter.repo ?? project.parsed.frontmatter.repo ?? null;
  if (!repo) return { status: "no_repo_configured" };
  const defaultBranch = project.parsed.frontmatter.defaultBranch || "main";
  const branch =
    file.parsed.frontmatter.branch ??
    taskBranchName(input.taskKey, file.parsed.frontmatter.title);
  if (!branch) return { status: "no_branch" };
  if (ctx.prOpenHandoffId) {
    const handoff = readHandoff(db, ctx.prOpenHandoffId);
    if (
      !handoff ||
      handoff.project_slug !== input.projectSlug ||
      handoff.task_key !== input.taskKey ||
      handoff.task_incarnation !== taskIncarnation ||
      file.parsed.frontmatter.stage !== handoff.review_stage_id ||
      file.parsed.frontmatter.reviewRevision !== handoff.review_revision ||
      normalizedRepo(repo) !== normalizedRepo(handoff.repo) ||
      defaultBranch !== handoff.default_branch ||
      branch !== handoff.branch
    ) {
      throw new DOMException(
        "Review pull-request handoff ownership changed.",
        "AbortError",
      );
    }
  }
  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: repo,
    defaultBranchOverride: defaultBranch,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;
  let headSha = normalizeFullGitSha(ctx.verifiedHeadSha);
  if (!headSha) {
    const branchRef = await gh.client.request<GhRef>(
      "GET",
      `/repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
      { signal: ctx.signal },
    );
    assertPrLifecycleActive(
      ctx,
      readTaskFile(ref)?.parsed.frontmatter.createdAt ?? null,
    );
    const currentProject = readProjectFile({
      projectSlug: input.projectSlug,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    const currentTask = readTaskFile(ref);
    if (
      !currentProject ||
      !currentTask ||
      normalizedRepo(
        currentTask.parsed.frontmatter.repo ??
          currentProject.parsed.frontmatter.repo,
      ) !== normalizedRepo(repo) ||
      (currentProject.parsed.frontmatter.defaultBranch || "main") !==
        defaultBranch
    ) {
      throw new DOMException(
        "Pull-request target ownership changed.",
        "AbortError",
      );
    }
    if (!branchRef.ok) {
      if (branchRef.kind === "network") {
        return { status: "network_unavailable", message: branchRef.message };
      }
      if (branchRef.kind === "http" && branchRef.status === 401) {
        return { status: "auth_failed", message: branchRef.message };
      }
      if (branchRef.kind === "http" && branchRef.status === 404) {
        return { status: "no_branch" };
      }
      return {
        status: "network_unavailable",
        message: branchRef.kind === "http" ? branchRef.message : "unknown",
      };
    }
    headSha = normalizeFullGitSha(branchRef.data.object?.sha);
    if (!headSha) {
      return {
        status: "network_unavailable",
        message: "GitHub did not return the full task-branch head SHA.",
      };
    }
  }
  const target: PrOpenTarget = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    taskIncarnation,
    repo,
    defaultBranch,
    branch,
    headSha,
  };
  assertCanonicalTarget(target, ctx);
  return { status: "ok", file, gh, target };
}

/**
 * Open or reuse the exact review PR. Reuse requires a live repo/base/head
 * match. Creation is journaled before POST and recovery preserves the first
 * actor's attribution across POST/file/projection/audit crash boundaries.
 */
export async function openTaskPr(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: OpenTaskPrContext = {},
): Promise<OpenTaskPrResult> {
  const resolved = await resolveTarget(db, input, ctx);
  if (resolved.status !== "ok") return resolved;
  const { file, gh, target } = resolved;

  const pending = readIntent(db, target);
  if (pending) return continueIntent(db, gh, target, pending, ctx);
  const related = readRelatedIntents(db, target);
  if (related.some((intent) => intent.state !== "staged")) {
    return {
      status: "network_unavailable",
      message:
        "A prior PR-open request for this branch remains uncertain at a different exact head. Viberr will not create another PR until that durable intent is reconciled.",
    };
  }
  for (const stale of related) {
    // No POST was attempted for this stale exact head. Drop only the exact
    // intent; its Review handoff (if any) remains and can promote the current
    // live branch head without losing the original actor.
    db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(stale.id);
  }

  const fm = file.parsed.frontmatter;
  const title = `[${input.taskKey}] ${fm.title}`;
  const body = composePrBody({
    taskKey: input.taskKey,
    title: fm.title,
    goal: file.parsed.goal,
    taskUrl: taskUrl(input.projectSlug, input.taskKey, ctx.appOrigin),
    changeSummary: fm.github?.changed
      ? `${fm.github.changed.files} file(s) changed (+${fm.github.changed.add}/-${fm.github.changed.del}).`
      : null,
  });
  if (fm.pr && fm.pr.state !== "closed") {
    const cached = await readExactPull(gh, fm.pr.number, target, ctx);
    if (!isResult(cached)) {
      return adoptObservedPull(db, target, cached, actor, title, body, ctx);
    }
    if (
      cached.status === "network_unavailable" ||
      cached.status === "auth_failed" ||
      cached.status === "target_mismatch" ||
      cached.status === "head_mismatch"
    ) {
      return cached;
    }
  }

  const existing = await findExactOpenPull(gh, target, ctx);
  if (existing && isResult(existing)) return existing;
  if (existing) {
    return adoptObservedPull(db, target, existing, actor, title, body, ctx);
  }

  const intent = stageIntent(db, {
    target,
    title,
    body,
    actor,
    authoritySource: inferredAuthority(actor, ctx),
    ...(ctx.prOpenHandoffId ? { handoffId: ctx.prOpenHandoffId } : {}),
  });
  return continueIntent(db, gh, target, intent, ctx);
}

export interface GithubPrOpenRecoverySummary {
  completed: number;
  cancelled: number;
  deferred: number;
  errors: number;
}

/** Boot replay for Automatic Review opens and interrupted direct delivery. */
export async function recoverGithubPrOpenIntents(
  db: Database.Database,
  ctx: Pick<OpenTaskPrContext, "dataRoot" | "fetchImpl" | "signal"> = {},
): Promise<GithubPrOpenRecoverySummary> {
  const summary: GithubPrOpenRecoverySummary = {
    completed: 0,
    cancelled: 0,
    deferred: 0,
    errors: 0,
  };

  // First promote durable Review transitions. This queue exists before the
  // deferred GitHub microtask does, so it is the boot entry point for a crash
  // immediately after task.md committed Review.
  const handoffs = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation,
              review_stage_id, review_revision, repo, default_branch, branch,
              actor_user_id, actor_label, authority_source, created_at
         FROM github_pr_open_handoffs
        ORDER BY created_at, id`,
    )
    .all() as GithubPrOpenHandoffRow[];
  for (const handoff of handoffs) {
    if (ctx.signal?.aborted) {
      summary.deferred += 1;
      continue;
    }
    const task = readTaskFile({
      projectSlug: handoff.project_slug,
      taskKey: handoff.task_key,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    const project = readProjectFile({
      projectSlug: handoff.project_slug,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    // Archive is a reversible admission closure, not evidence that the handoff
    // was wrong. Retain it for restore rather than running GitHub or cancelling.
    if (project?.parsed.frontmatter.archived) {
      summary.deferred += 1;
      continue;
    }
    const currentRepo =
      task?.parsed.frontmatter.repo ?? project?.parsed.frontmatter.repo ?? null;
    const currentBranch = task
      ? (task.parsed.frontmatter.branch ??
        taskBranchName(handoff.task_key, task.parsed.frontmatter.title))
      : null;
    if (
      !task ||
      !project ||
      task.parsed.frontmatter.createdAt !== handoff.task_incarnation ||
      task.parsed.frontmatter.stage !== handoff.review_stage_id ||
      task.parsed.frontmatter.reviewRevision !== handoff.review_revision ||
      normalizedRepo(currentRepo) !== normalizedRepo(handoff.repo) ||
      (project.parsed.frontmatter.defaultBranch || "main") !==
        handoff.default_branch ||
      currentBranch !== handoff.branch
    ) {
      db.prepare(`DELETE FROM github_pr_open_handoffs WHERE id = ?`).run(
        handoff.id,
      );
      recordAudit(db, {
        action: "github.pr.open.cancelled",
        actor: handoffActor(handoff),
        subjectKind: "pull_request_handoff",
        subjectId: handoff.id,
        projectSlug: project ? handoff.project_slug : undefined,
        taskKey: task ? handoff.task_key : undefined,
        details: {
          repo: handoff.repo,
          defaultBranch: handoff.default_branch,
          reason: "review_handoff_not_committed",
          authoritySource: handoff.authority_source,
        },
      });
      summary.cancelled += 1;
      continue;
    }
    try {
      const result = await openTaskPr(
        db,
        { projectSlug: handoff.project_slug, taskKey: handoff.task_key },
        handoffActor(handoff),
        {
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          taskLifecycle: {
            expectedCreatedAt: handoff.task_incarnation,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
          authoritySource: handoff.authority_source,
          prOpenHandoffId: handoff.id,
        },
      );
      if (result.status === "ok") summary.completed += 1;
      else summary.deferred += 1;
    } catch {
      // A concurrent archive may close admission after the pre-check.
      const currentProject = readProjectFile({
        projectSlug: handoff.project_slug,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      });
      if (currentProject?.parsed.frontmatter.archived) summary.deferred += 1;
      else summary.errors += 1;
    }
  }

  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation, repo,
              default_branch, branch, head_sha, handoff_id, pr_title, pr_body,
              actor_user_id, actor_label, authority_source, state,
              pr_number, pr_created, created_at, post_attempted_at,
              observed_at
         FROM github_pr_open_intents
        ORDER BY created_at, id`,
    )
    .all() as GithubPrOpenIntentRow[];
  for (const intent of rows) {
    if (ctx.signal?.aborted) {
      summary.deferred += 1;
      continue;
    }
    const task = readTaskFile({
      projectSlug: intent.project_slug,
      taskKey: intent.task_key,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    const project = readProjectFile({
      projectSlug: intent.project_slug,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    if (project?.parsed.frontmatter.archived) {
      summary.deferred += 1;
      continue;
    }
    const currentRepo =
      task?.parsed.frontmatter.repo ?? project?.parsed.frontmatter.repo ?? null;
    const currentBranch = task
      ? (task.parsed.frontmatter.branch ??
        taskBranchName(intent.task_key, task.parsed.frontmatter.title))
      : null;
    if (
      !task ||
      !project ||
      task.parsed.frontmatter.createdAt !== intent.task_incarnation ||
      normalizedRepo(currentRepo) !== normalizedRepo(intent.repo) ||
      (project.parsed.frontmatter.defaultBranch || "main") !==
        intent.default_branch ||
      currentBranch !== intent.branch
    ) {
      db.transaction(() => {
        db.prepare(`DELETE FROM github_pr_open_intents WHERE id = ?`).run(
          intent.id,
        );
        if (intent.handoff_id) {
          db.prepare(`DELETE FROM github_pr_open_handoffs WHERE id = ?`).run(
            intent.handoff_id,
          );
        }
      })();
      recordAudit(db, {
        action: "github.pr.open.cancelled",
        actor: intentActor(intent),
        subjectKind: "pull_request_intent",
        subjectId: intent.id,
        projectSlug: project ? intent.project_slug : undefined,
        taskKey: task ? intent.task_key : undefined,
        details: {
          repo: intent.repo,
          defaultBranch: intent.default_branch,
          headSha: intent.head_sha,
          reason: "canonical_target_changed",
          authoritySource: intent.authority_source,
        },
      });
      summary.cancelled += 1;
      continue;
    }
    const gh = getProjectGithubContext(db, intent.project_slug, {
      repoOverride: intent.repo,
      defaultBranchOverride: intent.default_branch,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    if (gh.status !== "ok") {
      summary.deferred += 1;
      continue;
    }
    const target: PrOpenTarget = {
      projectSlug: intent.project_slug,
      taskKey: intent.task_key,
      taskIncarnation: intent.task_incarnation,
      repo: intent.repo,
      defaultBranch: intent.default_branch,
      branch: intent.branch,
      headSha: intent.head_sha,
    };
    try {
      const result = await continueIntent(db, gh, target, intent, {
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        taskLifecycle: {
          expectedCreatedAt: intent.task_incarnation,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        authoritySource: intent.authority_source,
      });
      if (result.status === "ok") summary.completed += 1;
      else if (
        result.status === "target_mismatch" ||
        result.status === "head_mismatch"
      ) {
        // An observed PR number is proof of the earlier POST. Retain it so no
        // boot or user retry can repeat the mutation against a contradiction.
        summary.deferred += 1;
      } else {
        summary.deferred += 1;
      }
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}
