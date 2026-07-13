import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveOrgRole } from "~/server/auth/identity.server";
import type {
  AgentRef,
  FileActorRef,
  ParsedTaskFile,
  TaskFrontmatter,
  TaskFileEvent,
} from "~/schemas/task-file.schema";
import type {
  CapabilityGrant,
  ProjectRole,
} from "~/schemas/project-file.schema";
import {
  recordAudit,
  withProjectAuditAuthority,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  agentProfilesDir,
  skillDirPath,
  taskDir,
} from "~/server/files/file-store-root.server";
import {
  KB_INJECTION_BUDGET,
  readKbBody,
} from "~/server/files/kb-injection.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { effectiveProfileView } from "~/features/agents/agents-query.server";
import type { AgentProfileView } from "~/features/agents/agent-types";
import type {
  LogLine,
  SpecialistRunPurpose,
} from "~/features/runtime/runtime-types";
import {
  isBackendAvailable,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import {
  defaultModelFor,
  resolveRunModel,
  resolveRunEffort,
} from "~/server/runtimes/model-catalog.server";
import { taskBranchName } from "~/server/github/branch-sync.server";
import {
  buildScript,
  type SimulatedScript,
} from "~/server/runtimes/simulated-runtime.server";
import {
  listRunsForTask,
  registerRunTerminationFinalizer,
  startRun,
  stopRunForLifecycle,
} from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import {
  projectCompletionAdmissionOpen,
  projectCompletionSignal,
  RUN_COMPLETION_PHASE,
  runMatchesTaskIncarnation,
  withProjectCompletionEffect,
} from "~/server/runtimes/run-completion-state.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  authorizeProjectAction,
  type ProjectAuthoritySource,
} from "~/shared/rbac";
import {
  type DeliveryPermissions,
  resolveDeliveryPermissions,
  resolveSpecialistDisallowedTools,
  specialistBackendCapabilitySupport,
} from "./specialist-tool-policy";
import { resolveSpecialistMcpServers } from "./specialist-mcp.server";
import {
  preflightSpecialistWorkspace,
  workspaceNamespaceKey,
} from "./specialist-preflight.server";
import type {
  AgentCompletionEffectsInput,
  TaskActor,
  TaskMutationContext,
} from "./task-actions.server";
import {
  clearReviewEvidence,
  reviewEvidenceFingerprint,
} from "./review-evidence.server";

const NO_DELIVERY: DeliveryPermissions = {
  canBranch: false,
  canCommitPush: false,
  canOpenPr: false,
};

/**
 * Assign a deployed specialist agent to a task, and start a real (or
 * simulated-fallback) agent run for it from the task-detail UI.
 *
 * This is the "deploy a specialist to a task and run it" surface the app was
 * missing: today runs only appear from seed data or the operator-scheduling
 * reaction. `assignSpecialist` writes the `specialist` frontmatter + a typed
 * `agent` timeline event; `startSpecialistRun` clones the repo (best-effort)
 * and hands off to the Phase-8 run service, streaming a realistic simulated
 * dev-agent-analyzing-a-repo transcript when no real backend credential is
 * present (and a real SDK run when one is).
 *
 * RBAC (both fns): admin|maintainer — contracts §3.2 "Open agent runtime
 * sessions". Mirrors the transition/interrupt project-membership check.
 */

// ----------------------------------------------------------------- helpers

function forbidden(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.FORBIDDEN,
    status: 403,
    userMessage,
    kind: "user",
  });
}

function taskRef(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
) {
  return {
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    ...(ctx.expectedTaskIncarnation !== undefined
      ? { expectedTaskIncarnation: ctx.expectedTaskIncarnation }
      : {}),
  };
}

export interface TaskLaunchIncarnation {
  createdAt: string;
}

export interface TaskLaunchAuthorization extends TaskLaunchIncarnation {
  kind: "primary" | "reviewer";
  profileId: string;
  taskSnapshot: string;
  deploymentSnapshot: string;
  reviewEvidenceSnapshot: string | null;
}

export interface SpecialistWorkspaceLease {
  key: string;
  token: symbol;
  /** Set synchronously once a provider run owns this lease. The request-level
   * catch must then leave release to the run termination finalizer. */
  boundRunId: string | null;
}

const SPECIALIST_WORKSPACE_LEASES = Symbol.for(
  "viberr.specialistWorkspaceLeases",
);

function specialistWorkspaceLeases(): WeakMap<
  Database.Database,
  Map<string, symbol>
> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Map<string, symbol>> | undefined
  >;
  return (cache[SPECIALIST_WORKSPACE_LEASES] ??= new WeakMap());
}

function specialistWorkspaceLeaseKey(input: {
  projectSlug: string;
  taskKey: string;
  taskIncarnation: string;
  kind: "primary" | "reviewer";
  profileId: string;
}): string {
  const workspaceIdentity =
    input.kind === "primary" ? "primary" : `reviewer:${input.profileId}`;
  return `${input.projectSlug}/${input.taskKey}@${input.taskIncarnation}/${workspaceIdentity}`;
}

/** Atomically reserves the exact task workspace before checkout begins. The
 * lease stays held until the launched/resumed provider run terminates. */
export function acquireSpecialistWorkspaceLease(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    kind: "primary" | "reviewer";
    profileId: string;
  },
): SpecialistWorkspaceLease {
  // A process-local lease prevents concurrent checkout in this server. The
  // durable guard below covers both restart windows: a provider row can exist
  // before launch attachment persists its completion context, or a provider
  // can terminate and fail partway through delivery. Boot recovery still owns
  // that exact workspace until its monotonic completion checkpoint reaches
  // `complete`; admitting a new run sooner could let old recovery overwrite
  // waiting state or deliver the new run's commits.
  const incomplete = db
    .prepare(
      `SELECT id
         FROM agent_runs
        WHERE project_slug = ?
          AND task_key = ?
          AND task_incarnation = ?
          AND kind = ?
          AND completion_phase < ?
          AND id NOT LIKE 'run_seed_%'
          AND (
            ? = 'primary'
            OR agent_profile_id = ?
            OR agent_profile_id IS NULL
          )
        LIMIT 1`,
    )
    .get(
      input.projectSlug,
      input.taskKey,
      input.taskIncarnation,
      input.kind,
      RUN_COMPLETION_PHASE.complete,
      input.kind,
      input.profileId,
    ) as { id: string } | undefined;
  if (incomplete) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "That agent workspace still has an incomplete delivery or recovery. Let Viberr finish recovery before starting another run.",
      kind: "user",
    });
  }
  const byWorkspace = specialistWorkspaceLeases().get(db) ?? new Map();
  specialistWorkspaceLeases().set(db, byWorkspace);
  const key = specialistWorkspaceLeaseKey(input);
  if (byWorkspace.has(key)) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "That agent workspace already has a run in progress. Wait for it to finish before starting another.",
      kind: "user",
    });
  }
  const token = Symbol(key);
  byWorkspace.set(key, token);
  return { key, token, boundRunId: null };
}

export function releaseSpecialistWorkspaceLease(
  db: Database.Database,
  lease: SpecialistWorkspaceLease,
): void {
  const byWorkspace = specialistWorkspaceLeases().get(db);
  if (byWorkspace?.get(lease.key) !== lease.token) return;
  byWorkspace.delete(lease.key);
  if (byWorkspace.size === 0) specialistWorkspaceLeases().delete(db);
}

export function bindSpecialistWorkspaceLeaseToRun(
  db: Database.Database,
  runId: string,
  lease: SpecialistWorkspaceLease,
): void {
  if (lease.boundRunId === runId) return;
  if (lease.boundRunId !== null) {
    throw new Error(
      `Specialist workspace lease ${lease.key} is already bound to ${lease.boundRunId}.`,
    );
  }
  lease.boundRunId = runId;
  registerRunTerminationFinalizer(db, runId, () => {
    releaseSpecialistWorkspaceLease(db, lease);
  });
}

function taskLaunchIncarnation(
  frontmatter: TaskFrontmatter,
): TaskLaunchIncarnation {
  if (!frontmatter.createdAt) {
    throw launchOwnershipConflict(frontmatter.key);
  }
  return {
    createdAt: frontmatter.createdAt,
  };
}

function deploymentLaunchSnapshot(resolved: ResolvedSpecialist): string {
  return JSON.stringify({
    profileId: resolved.profileId,
    name: resolved.name,
    role: resolved.role,
    backend: resolved.backend,
    backends: resolved.backends,
    model: resolved.model,
    effort: resolved.effort,
    skills: resolved.skills,
    kb: resolved.kb,
    mcps: resolved.mcps,
    capabilities: resolved.capabilities,
    stages: resolved.stages,
    spanAll: resolved.spanAll,
  });
}

function taskAuthorizationSnapshot(
  parsed: ParsedTaskFile,
  projectRepo: string | null,
  projectDefaultBranch: string,
  kind: "primary" | "reviewer",
  profileId: string,
): string | null {
  const assignment =
    kind === "primary"
      ? parsed.frontmatter.specialist
      : (parsed.frontmatter.reviewers.find(
          (reviewer) => reviewer.profileId === profileId,
        ) ?? null);
  if (!assignment || assignment.profileId !== profileId) return null;
  return JSON.stringify({
    assignment,
    title: parsed.frontmatter.title,
    stage: parsed.frontmatter.stage,
    goal: parsed.goal,
    taskRepo: parsed.frontmatter.repo,
    projectRepo,
    projectDefaultBranch: projectDefaultBranch.trim() || "main",
    branch:
      parsed.frontmatter.branch ??
      taskBranchName(parsed.frontmatter.key, parsed.frontmatter.title),
  });
}

/** Capture every canonical input which authorizes and shapes a provider
 * launch. A same-incarnation task can still be reassigned, stage-moved, have
 * its goal/evidence changed, or lose deployment grants while checkout waits;
 * comparing this snapshot prevents launching the stale prompt/persona/tools. */
export function captureTaskLaunchAuthorization(
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    kind: "primary" | "reviewer";
    profileId: string;
  },
): TaskLaunchAuthorization {
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!project || project.parsed.frontmatter.archived || !task) {
    throw launchOwnershipConflict(input.taskKey);
  }
  const createdAt = task.parsed.frontmatter.createdAt;
  if (!createdAt) throw launchOwnershipConflict(input.taskKey);
  const resolved = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
  );
  assertStageEligible(resolved, task.parsed.frontmatter.stage);
  const taskSnapshot = taskAuthorizationSnapshot(
    task.parsed,
    project.parsed.frontmatter.repo,
    project.parsed.frontmatter.defaultBranch || "main",
    input.kind,
    input.profileId,
  );
  if (!taskSnapshot) throw launchOwnershipConflict(input.taskKey);
  return {
    createdAt,
    kind: input.kind,
    profileId: input.profileId,
    taskSnapshot,
    deploymentSnapshot: deploymentLaunchSnapshot(resolved),
    reviewEvidenceSnapshot:
      input.kind === "reviewer"
        ? reviewEvidenceFingerprint(
            task.parsed,
            project.parsed.frontmatter.repo,
          )
        : null,
  };
}

export function taskLaunchAuthorizationMatchesParsed(
  ctx: TaskMutationContext,
  projectSlug: string,
  parsed: ParsedTaskFile,
  expected: TaskLaunchAuthorization,
): boolean {
  if (parsed.frontmatter.createdAt !== expected.createdAt) return false;
  try {
    const project = readProjectFile({
      projectSlug,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    if (!project || project.parsed.frontmatter.archived) return false;
    const resolved = resolveDeployedSpecialist(
      ctx,
      projectSlug,
      expected.profileId,
    );
    assertStageEligible(resolved, parsed.frontmatter.stage);
    return (
      deploymentLaunchSnapshot(resolved) === expected.deploymentSnapshot &&
      taskAuthorizationSnapshot(
        parsed,
        project.parsed.frontmatter.repo,
        project.parsed.frontmatter.defaultBranch || "main",
        expected.kind,
        expected.profileId,
      ) === expected.taskSnapshot &&
      (expected.reviewEvidenceSnapshot === null ||
        reviewEvidenceFingerprint(parsed, project.parsed.frontmatter.repo) ===
          expected.reviewEvidenceSnapshot)
    );
  } catch {
    return false;
  }
}

export function taskLaunchAuthorizationMatches(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchAuthorization,
): boolean {
  if (!projectCompletionAdmissionOpen(db, projectSlug)) return false;
  try {
    const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    return (
      !!task &&
      taskLaunchAuthorizationMatchesParsed(
        ctx,
        projectSlug,
        task.parsed,
        expected,
      )
    );
  } catch {
    return false;
  }
}

export function assertTaskLaunchAuthorization(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchAuthorization,
): void {
  if (
    !taskLaunchAuthorizationMatches(db, ctx, projectSlug, taskKey, expected)
  ) {
    throw launchOwnershipConflict(taskKey);
  }
}

/**
 * A task key is reusable after project deletion, so existence alone does not
 * prove that a delayed launch still belongs to the task which authorized it.
 * `createdAt` is the canonical incarnation marker. A missing marker fails
 * closed because the old and replacement lifecycle cannot be distinguished.
 */
function ownsTaskLaunch(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchIncarnation,
): boolean {
  if (!projectCompletionAdmissionOpen(db, projectSlug)) return false;
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project || project.parsed.frontmatter.archived === true) return false;

  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!task) return false;
  return task.parsed.frontmatter.createdAt === expected.createdAt;
}

function launchOwnershipConflict(taskKey: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage: `Run not started because task ${taskKey} is no longer active. Refresh and try again.`,
    kind: "user",
  });
}

function assertTaskLaunchOwnership(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchIncarnation,
): void {
  if (!ownsTaskLaunch(db, ctx, projectSlug, taskKey, expected)) {
    throw launchOwnershipConflict(taskKey);
  }
}

function ownsStartedRunLaunch(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchAuthorization,
  runId: string,
): boolean {
  if (
    !taskLaunchAuthorizationMatches(db, ctx, projectSlug, taskKey, expected)
  ) {
    return false;
  }
  const run = getRun(db, runId);
  if (!run || run.state === "interrupted") return false;
  return runMatchesTaskIncarnation(db, runId, expected.createdAt);
}

function assertStartedRunLaunchOwnership(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchAuthorization,
  runId: string,
): void {
  if (!ownsStartedRunLaunch(db, ctx, projectSlug, taskKey, expected, runId)) {
    stopRunForLifecycle(db, runId);
    throw launchOwnershipConflict(taskKey);
  }
}

function stopRunWhenLaunchOwnershipWasLost(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchAuthorization,
  runId: string,
): void {
  if (ownsStartedRunLaunch(db, ctx, projectSlug, taskKey, expected, runId)) {
    return;
  }
  stopRunForLifecycle(db, runId);
  throw launchOwnershipConflict(taskKey);
}

function withProjectLaunchOwnership<T>(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  effect: () => Promise<T>,
): Promise<T> {
  if (!projectCompletionAdmissionOpen(db, projectSlug)) {
    return Promise.reject(launchOwnershipConflict(taskKey));
  }
  return withProjectCompletionEffect(db, projectSlug, effect);
}

function sameTaskIncarnationIgnoringAdmission(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  expected: TaskLaunchIncarnation,
): boolean {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  return task?.parsed.frontmatter.createdAt === expected.createdAt;
}

async function rollbackLaunchAttachment(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    expected: TaskLaunchIncarnation;
    priorWaiting: TaskFrontmatter["waiting"];
  },
): Promise<void> {
  if (
    !sameTaskIncarnationIgnoringAdmission(
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
    )
  ) {
    return;
  }
  try {
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        if (parsed.frontmatter.createdAt !== input.expected.createdAt) return;
        parsed.timeline = parsed.timeline.filter(
          (event) =>
            !(
              event.sourceRunId === input.runId &&
              event.type === "agent" &&
              event.text.startsWith("Started a ")
            ),
        );
        if (parsed.frontmatter.waiting === "agent") {
          parsed.frontmatter.waiting = input.priorWaiting;
        }
      },
    );
    reproject(db, ctx, input.projectSlug, input.taskKey);
  } catch (error) {
    logger.warn("failed to roll back an unowned run attachment", {
      taskKey: input.taskKey,
      runId: input.runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

async function attachFreshSpecialistRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    expected: TaskLaunchAuthorization;
    priorWaiting: TaskFrontmatter["waiting"];
    kind: "primary" | "reviewer";
    eventText: string;
    completion: AgentCompletionEffectsInput;
    auditAction: "task.specialist.run_started" | "task.reviewer.run_started";
    auditActor: AuditActor;
    auditDetails: Record<string, unknown>;
  },
): Promise<void> {
  try {
    assertStartedRunLaunchOwnership(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
      input.runId,
    );
    ctx.launchAttachmentHookForTests?.({
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: input.runId,
      kind: input.kind,
      resumed: false,
    });
    assertStartedRunLaunchOwnership(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
      input.runId,
    );

    // Resolve the callback module before the canonical file mutation. Every
    // await below is followed by an exact run+task ownership check.
    const { registerAgentCompletion } = await import("./task-actions.server");
    assertStartedRunLaunchOwnership(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
      input.runId,
    );

    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        if (
          !projectCompletionAdmissionOpen(db, input.projectSlug) ||
          !taskLaunchAuthorizationMatchesParsed(
            ctx,
            input.projectSlug,
            parsed,
            input.expected,
          ) ||
          getRun(db, input.runId)?.state === "interrupted" ||
          !runMatchesTaskIncarnation(db, input.runId, input.expected.createdAt)
        ) {
          throw launchOwnershipConflict(input.taskKey);
        }
        parsed.frontmatter.waiting = "agent";
        parsed.timeline.unshift({
          ...agentEvent(input.eventText),
          sourceRunId: input.runId,
        });
      },
    );
    reproject(db, ctx, input.projectSlug, input.taskKey);
    assertStartedRunLaunchOwnership(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
      input.runId,
    );

    await registerAgentCompletion(db, ctx, {
      ...input.completion,
      runId: input.runId,
    });
    assertStartedRunLaunchOwnership(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      input.expected,
      input.runId,
    );

    const auditEvent = {
      actor: input.auditActor,
      subjectKind: "task" as const,
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: input.auditDetails,
    };
    // Keep both governed action names in statically visible recorder calls. The
    // audit catalog intentionally rejects action names it cannot prove live.
    if (input.auditAction === "task.specialist.run_started") {
      recordAudit(db, {
        ...auditEvent,
        action: "task.specialist.run_started",
      });
    } else {
      recordAudit(db, {
        ...auditEvent,
        action: "task.reviewer.run_started",
      });
    }
  } catch (error) {
    stopRunForLifecycle(db, input.runId);
    await rollbackLaunchAttachment(db, ctx, input);
    throw error;
  }
}

/** A deployed specialist resolved from project.md `agents:` for a run. */
export interface ResolvedSpecialist {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  /** Every runtime backend this profile explicitly declares. */
  backends: RealBackend[];
  model: string;
  /** Reasoning/effort level threaded into the run (empty when unset). */
  effort: string;
  /** The agent's declared skills — loaded into its run persona at run time. */
  skills: string[];
  /** The agent's declared knowledge bases — docs injected into its run context. */
  kb: string[];
  /** The agent's declared MCP servers — wired into the selected SDK. */
  mcps: string[];
  /** The deployment's stored capability grants — drive run-time tool
   *  confinement (specialist-tool-policy). Empty for the list/display path. */
  capabilities: CapabilityGrant[];
  /** Stage ids this profile may work (F1 — enforced by the assign/run guards
   *  and the operator picker). Empty when spanAll or unset. */
  stages: string[];
  /** When true the profile is eligible across every stage. */
  spanAll: boolean;
}

/** Declared runtime choices in profile order. Legacy definitions with no
 * runnable entry retain their historical Claude default. */
function declaredBackends(view: AgentProfileView): RealBackend[] {
  const declared = view.backends.filter(
    (backend): backend is RealBackend =>
      backend === "claude" || backend === "codex",
  );
  return declared.length > 0 ? [...new Set(declared)] : ["claude"];
}

function toResolved(
  view: AgentProfileView,
  requestedBackend?: RealBackend,
): ResolvedSpecialist {
  const backends = declaredBackends(view);
  const nativeBackend = backends[0] ?? "claude";
  const backend = requestedBackend ?? nativeBackend;
  if (!backends.includes(backend)) {
    throw AppError.validation(
      `${view.name} does not declare the ${backend === "claude" ? "Claude Code" : "Codex"} backend. Choose one of: ${backends.join(", ")}.`,
    );
  }
  const nativeChoice = backend === nativeBackend;
  return {
    profileId: view.id,
    name: view.name,
    role: view.role || view.name,
    backend,
    backends,
    // Resolve to a VALID run model id — a seed/legacy display label like
    // "codex-large · claude-sonnet" must never reach the SDK (it 400s: "model
    // not supported when using Codex with a ChatGPT account").
    model: nativeChoice
      ? resolveRunModel(backend, view.model)
      : defaultModelFor(backend),
    effort: nativeChoice
      ? view.effort || ""
      : resolveRunEffort(backend, view.effort || ""),
    skills: view.resources.skills,
    kb: view.resources.kb ?? [],
    mcps: view.resources.mcps ?? [],
    capabilities: [],
    stages: view.stages ?? [],
    spanAll: view.spanAll ?? false,
  };
}

/** Resolve declared MCP names to the portable runtime MCP shape, or `{}`. */
function mcpServersFor(
  db: Database.Database,
  names: string[],
  backend: RealBackend,
): { mcpServers?: Record<string, unknown> } {
  const servers = resolveSpecialistMcpServers(db, names, backend);
  return Object.keys(servers).length ? { mcpServers: servers } : {};
}

/**
 * Resolve a deployed SPECIALIST agent (kind !== "operator") from the
 * project's `agents:` deployments by profile id. The effective profile merges
 * the org template file with the deployment's loose `definition` (the same
 * assembly the Agents surface uses). Throws a typed error when the profile id
 * is not a deployed specialist.
 */
export function resolveDeployedSpecialist(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
  backend?: RealBackend,
): ResolvedSpecialist {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const deployment = file.parsed.frontmatter.agents.find(
    (a) => a.profileId === profileId,
  );
  if (!deployment) {
    throw AppError.validation(
      `No agent \`${profileId}\` is deployed in this project.`,
    );
  }
  const view = effectiveProfileView(deployment, ctx.dataRoot);
  if (view.kind !== "specialist") {
    throw AppError.validation(
      `Agent \`${profileId}\` is not a specialist and cannot be assigned as one.`,
    );
  }
  // Carry the deployment's stored capability grants so the run can confine its
  // tools to them (specialist-tool-policy).
  return {
    ...toResolved(view, backend),
    capabilities: deployment.capabilities,
  };
}

function agentEvent(text: string, sourceIntentId?: string): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "agent",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    ...(sourceIntentId ? { sourceIntentId } : {}),
    evidence: null,
  };
}

// ------------------------------------------------------------- assignSpecialist

export interface AssignSpecialistResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
}

/**
 * Assigns a deployed specialist as the task's PRIMARY specialist: writes the
 * `specialist` frontmatter ({profileId, backend, role}) and appends a typed
 * `agent` timeline event announcing the deployment, then reprojects + audits
 * (SSE rides the reproject). RBAC: admin|maintainer.
 */
export async function assignSpecialist(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    backend?: RealBackend;
    /** Exact operator-routing intent that owns this binding. */
    sourceIntentId?: string;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignSpecialistResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "assign a specialist",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (
    existing.parsed.frontmatter.reviewers.some(
      (reviewer) => reviewer.profileId === input.profileId,
    )
  ) {
    throw AppError.validation(
      "Release this agent from the reviewer role before assigning it as the primary specialist.",
    );
  }

  const specialist = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
    input.backend,
  );
  assertStageEligible(specialist, existing.parsed.frontmatter.stage);

  const backendLabel =
    specialist.backend === "claude" ? "Claude Code" : "Codex";
  const ref: AgentRef = {
    profileId: specialist.profileId,
    backend: specialist.backend,
    role: specialist.role,
    ...(input.sourceIntentId ? { sourceIntentId: input.sourceIntentId } : {}),
  };
  const event = agentEvent(
    `Deployed **${specialist.name}** (${specialist.role}, ${backendLabel}) as the primary specialist.`,
    input.sourceIntentId,
  );

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      if (
        parsed.frontmatter.reviewers.some(
          (reviewer) => reviewer.profileId === specialist.profileId,
        )
      ) {
        throw AppError.validation(
          "Release this agent from the reviewer role before assigning it as the primary specialist.",
        );
      }
      parsed.frontmatter.specialist = ref;
      // Clear any pending "assign specialist" recommendation — it's now done.
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter(
          (r) => r.kind !== "assign_specialist",
        );
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.specialist.assigned",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      profileId: specialist.profileId,
      backend: specialist.backend,
      role: specialist.role,
      ...(input.sourceIntentId ? { sourceIntentId: input.sourceIntentId } : {}),
    },
  });

  return {
    profileId: specialist.profileId,
    name: specialist.name,
    role: specialist.role,
    backend: specialist.backend,
  };
}

// --------------------------------------------------------------- assignReviewer

export interface AssignReviewerResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  /** True when the profile was already engaged as a reviewer (idempotent no-op). */
  alreadyEngaged: boolean;
}

/**
 * Engages a deployed specialist as a REVIEWER (advisory, non-primary): appends
 * an AgentRef to the task's `reviewers` frontmatter array and announces it with
 * a typed `agent` timeline event, then reprojects + audits. Idempotent — a
 * the exact profile/backend pair already in `reviewers` is a no-op. Choosing a
 * different declared backend updates the engagement and invalidates stale
 * review evidence. RBAC: admin|maintainer.
 */
export async function assignReviewer(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    backend?: RealBackend;
    /** Exact operator-routing intent that owns this binding. */
    sourceIntentId?: string;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignReviewerResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "assign a reviewer",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (existing.parsed.frontmatter.specialist?.profileId === input.profileId) {
    throw AppError.validation(
      "The primary specialist cannot also review its own task. Assign a different reviewer.",
    );
  }

  const reviewer = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
    input.backend,
  );
  assertStageEligible(reviewer, existing.parsed.frontmatter.stage);

  const currentEngagement = existing.parsed.frontmatter.reviewers.find(
    (r) => r.profileId === reviewer.profileId,
  );
  if (
    currentEngagement?.backend === reviewer.backend &&
    (!input.sourceIntentId ||
      currentEngagement.sourceIntentId === input.sourceIntentId)
  ) {
    return {
      profileId: reviewer.profileId,
      name: reviewer.name,
      role: reviewer.role,
      backend: reviewer.backend,
      alreadyEngaged: true,
    };
  }

  const backendLabel = reviewer.backend === "claude" ? "Claude Code" : "Codex";
  const ref: AgentRef = {
    profileId: reviewer.profileId,
    backend: reviewer.backend,
    role: reviewer.role,
    ...(input.sourceIntentId ? { sourceIntentId: input.sourceIntentId } : {}),
  };
  const event = agentEvent(
    currentEngagement?.backend === reviewer.backend
      ? `Confirmed **${reviewer.name}** (${reviewer.role}, ${backendLabel}) as the reviewer for this routed action.`
      : currentEngagement
        ? `Switched **${reviewer.name}** (${reviewer.role}) to ${backendLabel} for this review.`
        : `Engaged **${reviewer.name}** (${reviewer.role}, ${backendLabel}) as a reviewer.`,
    input.sourceIntentId,
  );

  let changed = false;
  let becameIdempotent = false;
  let bindingOnly = false;
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      if (parsed.frontmatter.specialist?.profileId === reviewer.profileId) {
        throw AppError.validation(
          "The primary specialist cannot also review its own task. Assign a different reviewer.",
        );
      }
      const currentIndex = parsed.frontmatter.reviewers.findIndex(
        (engaged) => engaged.profileId === reviewer.profileId,
      );
      if (
        currentIndex >= 0 &&
        parsed.frontmatter.reviewers[currentIndex]?.backend === reviewer.backend
      ) {
        if (
          !input.sourceIntentId ||
          parsed.frontmatter.reviewers[currentIndex]?.sourceIntentId ===
            input.sourceIntentId
        ) {
          becameIdempotent = true;
          return;
        }
        parsed.frontmatter.reviewers[currentIndex] = ref;
        changed = true;
        bindingOnly = true;
      } else if (currentIndex >= 0) {
        parsed.frontmatter.reviewers[currentIndex] = ref;
        changed = true;
      } else {
        parsed.frontmatter.reviewers.push(ref);
        changed = true;
      }
      if (!bindingOnly) {
        parsed.frontmatter.reviewRevision += 1;
        clearReviewEvidence(parsed, null);
        if (parsed.frontmatter.validation !== "failing") {
          parsed.frontmatter.validation = "changed";
        }
      }
      // Clear a matching pending "engage reviewer" recommendation.
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter(
          (r) =>
            !(
              r.kind === "assign_reviewer" && r.profileId === reviewer.profileId
            ),
        );
      parsed.timeline.unshift(event);
    },
  );
  if (!changed && becameIdempotent) {
    return {
      profileId: reviewer.profileId,
      name: reviewer.name,
      role: reviewer.role,
      backend: reviewer.backend,
      alreadyEngaged: true,
    };
  }
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.assigned",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      profileId: reviewer.profileId,
      backend: reviewer.backend,
      role: reviewer.role,
      ...(input.sourceIntentId ? { sourceIntentId: input.sourceIntentId } : {}),
      ...(currentEngagement && currentEngagement.backend !== reviewer.backend
        ? { previousBackend: currentEngagement.backend }
        : {}),
    },
  });

  return {
    profileId: reviewer.profileId,
    name: reviewer.name,
    role: reviewer.role,
    backend: reviewer.backend,
    alreadyEngaged: bindingOnly,
  };
}

// --------------------------------------------------------------- removeReviewer

export interface RemoveReviewerResult {
  profileId: string;
  /** False when the profile wasn't engaged as a reviewer (nothing to remove). */
  removed: boolean;
}

/**
 * Releases a REVIEWER from a task: drops the matching AgentRef from `reviewers`
 * and appends a typed `agent` timeline event, then reprojects + audits. A
 * profile that isn't currently a reviewer is a no-op. RBAC: admin|maintainer.
 */
export async function removeReviewer(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<RemoveReviewerResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "remove a reviewer",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const target = existing.parsed.frontmatter.reviewers.find(
    (r) => r.profileId === input.profileId,
  );
  if (!target) return { profileId: input.profileId, removed: false };

  // Best-effort display name for the event; falls back to the role snapshot.
  let label = target.role;
  try {
    label = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      input.profileId,
    ).name;
  } catch {
    // Profile may have been undeployed since engagement — keep the role label.
  }
  const event = agentEvent(`Released reviewer **${label}** from the task.`);

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.reviewers = parsed.frontmatter.reviewers.filter(
        (r) => r.profileId !== input.profileId,
      );
      parsed.frontmatter.reviewRevision += 1;
      clearReviewEvidence(parsed, null);
      if (parsed.frontmatter.validation !== "failing") {
        parsed.frontmatter.validation = "changed";
      }
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.removed",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { profileId: input.profileId },
  });

  return { profileId: input.profileId, removed: true };
}

// --------------------------------------------------------- startSpecialistRun

export interface StartSpecialistRunResult {
  runId: string;
  backend: RealBackend;
  simulated: boolean;
  role: string;
}

export interface StartSpecialistRunInput {
  projectSlug: string;
  taskKey: string;
  directive?: string;
  /** Force this run onto a specific backend regardless of the profile's
   *  default — used by retry-on-other-backend. */
  backendOverride?: RealBackend;
  purpose?: Extract<SpecialistRunPurpose, "implementation" | "conversation">;
  /** Exact intelligent-routing intent that owns this launch. */
  sourceIntentId?: string;
}

/**
 * Starts a PRIMARY specialist run for a task with an assigned specialist.
 * Builds an "analyze the repo" prompt from the task title + goal, best-effort
 * clones the project repo into `<taskDir>/workspace/<repo>` (ephemeral
 * askpass authentication when bound, plain clone for public repos) and points
 * the run there. Hands off to
 * the run service with a realistic simulated fallback script so the console
 * streams meaningfully when no real credential is present; a real SDK run is
 * used when the backend's credential IS available.
 *
 * RBAC: admin|maintainer. `runtime.run.started` is audited by startRun — we
 * add a task-level `task.specialist.run_started` audit row + a typed `agent`
 * timeline event.
 */
export function startSpecialistRun(
  db: Database.Database,
  input: StartSpecialistRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<StartSpecialistRunResult> {
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const launchIncarnation = taskLaunchIncarnation(existing.parsed.frontmatter);
  const profileId = existing.parsed.frontmatter.specialist?.profileId;
  if (!profileId) {
    return Promise.reject(
      AppError.validation("Assign a specialist before starting a run."),
    );
  }
  const lease = acquireSpecialistWorkspaceLease(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    taskIncarnation: launchIncarnation.createdAt,
    kind: "primary",
    profileId,
  });
  const signal = projectCompletionSignal(db, input.projectSlug);
  const launchCtx: TaskMutationContext = {
    ...ctx,
    expectedTaskIncarnation: launchIncarnation.createdAt,
  };
  return withProjectLaunchOwnership(db, input.projectSlug, input.taskKey, () =>
    startSpecialistRunOwned(
      db,
      input,
      actor,
      launchCtx,
      existing,
      launchIncarnation,
      lease,
      signal,
    ),
  ).catch((error) => {
    if (lease.boundRunId === null) {
      releaseSpecialistWorkspaceLease(db, lease);
    }
    throw error;
  });
}

async function startSpecialistRunOwned(
  db: Database.Database,
  input: StartSpecialistRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext,
  existing: NonNullable<ReturnType<typeof readTaskFile>>,
  launchIncarnation: TaskLaunchIncarnation,
  lease: SpecialistWorkspaceLease,
  signal: AbortSignal,
): Promise<StartSpecialistRunResult> {
  assertTaskLaunchOwnership(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchIncarnation,
  );
  let auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "start a specialist run",
  );

  const sp = existing.parsed.frontmatter.specialist;
  if (!sp) {
    throw AppError.validation("Assign a specialist before starting a run.");
  }
  const backend: RealBackend =
    input.backendOverride ?? (sp.backend === "codex" ? "codex" : "claude");
  // Resolve the model + effort from the deployment (falls back to a sane
  // default). Effort is threaded into the run so the SDK gets the profile's
  // chosen reasoning level (claude options.effort · codex modelReasoningEffort).
  let model = defaultModelFor(backend);
  let effort = "";
  // The agent's display name for the Agent-logs picker (grouped one-per-agent).
  // Falls back to the profile id when the deployment can't be resolved.
  let agentName = sp.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  // Run-time tool confinement from the deployment's capability grants (a
  // specialist without push/PR/merge rights literally cannot run those
  // commands). Empty when nothing is withheld.
  let disallowedTools: string[] = [];
  let resolvedSpec: ResolvedSpecialist;
  try {
    resolvedSpec = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      sp.profileId,
      backend,
    );
  } catch (error) {
    if (
      error instanceof AppError &&
      error.userMessage.includes("does not declare")
    ) {
      throw error;
    }
    throw AppError.validation(
      "The assigned specialist profile is no longer deployed. Assign a current profile before starting a run.",
    );
  }
  agentName = resolvedSpec.name;
  skills = resolvedSpec.skills;
  kb = resolvedSpec.kb;
  mcpNames = resolvedSpec.mcps;
  disallowedTools = resolveSpecialistDisallowedTools(resolvedSpec.capabilities);
  model = resolvedSpec.model;
  effort = resolvedSpec.effort;
  // Stage eligibility holds at the RUN boundary too (F1): an already-assigned
  // specialist must not be re-run after the task moved to a stage it isn't
  // eligible for (assign-time checks alone would let a re-prompt bypass F1).
  // Outside the try so the graceful undeployed-profile fallback can't swallow it.
  assertStageEligible(resolvedSpec, existing.parsed.frontmatter.stage);
  const support = specialistBackendCapabilitySupport(
    resolvedSpec.capabilities,
    backend,
  );
  if (!support.supported) {
    throw AppError.validation(
      `Codex cannot enforce this profile's withheld local capabilities (${support.advisoryOnlyWithheld.join(
        ", ",
      )}). Use Claude or grant those capabilities explicitly.`,
    );
  }
  const launchAuthorization = captureTaskLaunchAuthorization(ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    kind: "primary",
    profileId: sp.profileId,
  });

  // The agent's run persona: its detailed definition + declared skills + KB docs.
  // This is what makes the specialist behave as itself (the Developer implements
  // + tests + reports back) rather than a generic analyzer. Claude takes it as a
  // system prompt; Codex receives the same persona through the supported
  // `developer_instructions` configuration channel.
  const persona = buildSpecialistPersona({
    profileId: sp.profileId,
    skills,
    kb,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const title = existing.parsed.frontmatter.title;
  const goal = existing.parsed.goal;
  const repo =
    existing.parsed.frontmatter.repo ?? projectRepo(ctx, input.projectSlug);
  const purpose = input.purpose ?? "implementation";

  const delivery =
    purpose === "implementation"
      ? resolveDeliveryPermissions(resolvedSpec?.capabilities ?? [])
      : NO_DELIVERY;
  // A real model never starts in an empty fallback workspace. Checkout/tool/
  // auth preflight either returns a verified Git worktree or opens the
  // system-owned recovery path and rejects before startRun creates a run row.
  // Simulated runs remain offline and do not require a checkout.
  const realBackend = isBackendAvailable(backend);
  const runWorkdir = realBackend
    ? await requireSpecialistWorkspace(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo,
        role: sp.role,
        signal,
        assertActive: () =>
          assertTaskLaunchAuthorization(
            db,
            ctx,
            input.projectSlug,
            input.taskKey,
            launchAuthorization,
          ),
      })
    : null;

  const analyzePrompt = buildAnalyzePrompt({
    role: sp.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    branch:
      existing.parsed.frontmatter.branch ??
      taskBranchName(input.taskKey, title),
    cloned: !!runWorkdir,
    delivery,
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = analyzePrompt;

  const script = buildAnalyzeScript({
    backend,
    model,
    repo,
    cloned: !!runWorkdir,
    role: sp.role,
    ...(input.directive ? { directive: input.directive } : {}),
  });

  // Checkout/preflight is asynchronous. Archive/delete/recreate may have
  // revoked this invocation while it was waiting, so re-read canonical truth
  // at the last synchronous boundary before a provider process is launched.
  assertTaskLaunchAuthorization(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchAuthorization,
  );
  ctx.runtimeLaunchAuthorizationHookForTests?.({
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    kind: "primary",
  });
  // Workspace preparation may take long enough for the launching human's
  // project or organization role to change. Recompute both sources at the
  // last synchronous boundary before the provider process exists, and use
  // that same live authority for the run-start audit.
  auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "start a specialist run",
  );

  const { runId, simulated } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    expectedTaskIncarnation: launchAuthorization.createdAt,
    // Unique thread per specialist run so re-running a task starts a fresh
    // stream instead of colliding with a prior run on the "primary" thread
    // (agent_runs is unique on project+task+thread). Each run shows in the
    // Agent-logs picker; the label comes from the role, not the thread id.
    threadId: "primary-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Primary specialist",
    kind: "primary",
    backend,
    model,
    ...(effort ? { effort } : {}),
    ...(persona ? { systemPrompt: persona } : {}),
    // Persist the agent identity so the Agent-logs picker groups this run's
    // resumes into one entry labeled by the specialist's name (e.g. "dev").
    agentName,
    agentProfileId: sp.profileId,
    runPurpose: purpose,
    sourceIntentId: input.sourceIntentId ?? null,
    prompt,
    script,
    actor: auditActor,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    // Wire the profile's declared MCP servers into the run (item-1/FR9): a
    // profile that declares an org MCP gets it on both supported SDKs.
    ...mcpServersFor(db, mcpNames, backend),
    ...(runWorkdir ? { workdir: runWorkdir } : {}),
    ...(realBackend
      ? { env: workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot) }
      : {}),
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  // Bind before any post-start ownership/attachment work can throw. Once the
  // provider exists, only its termination finalizer may release the workspace.
  bindSpecialistWorkspaceLeaseToRun(db, runId, lease);

  // `startRun` itself crosses an async boundary after starting the adapter.
  // If lifecycle ownership changed there, stop this exact handle before any
  // task timeline, waiting state, audit, or completion context is attached.
  stopRunWhenLaunchOwnershipWasLost(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchAuthorization,
    runId,
  );

  const backendLabel = backend === "claude" ? "Claude Code" : "Codex";
  await attachFreshSpecialistRun(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    expected: launchAuthorization,
    priorWaiting: existing.parsed.frontmatter.waiting,
    kind: "primary",
    eventText: `Started a ${backendLabel} run for the ${sp.role} specialist — streaming to the agent logs.`,
    completion: {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      backend,
      role: sp.role,
      kind: "primary",
      profileId: sp.profileId,
      workdir: runWorkdir,
      delivery,
      purpose,
      launchAuthorization,
      agentHandle: agentHandleFor(sp.role),
      ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
    },
    auditAction: "task.specialist.run_started",
    auditActor,
    auditDetails: {
      runId,
      profileId: sp.profileId,
      backend,
      simulated,
      cloned: !!runWorkdir,
    },
  });

  return { runId, backend, simulated, role: sp.role };
}

// ------------------------------------------------------------ startReviewerRun

export interface StartReviewerRunInput {
  projectSlug: string;
  taskKey: string;
  profileId: string;
  directive?: string;
  /** Force this run onto a specific backend (retry-on-other-backend). */
  backendOverride?: RealBackend;
  purpose?: Extract<SpecialistRunPurpose, "governance_review" | "conversation">;
  /** Exact intelligent-routing intent that owns this launch. */
  sourceIntentId?: string;
}

/**
 * Starts a REVIEWER run for a specific engaged reviewer (by profile id) —
 * the reviewer counterpart of {@link startSpecialistRun}. Same analyze prompt +
 * best-effort clone + simulated-fallback script, but the run is `kind:
 * "reviewer"` on its own `r<index>-…` thread so it groups under the reviewer's
 * own Agent-logs entry. RBAC: admin|maintainer.
 */
export function startReviewerRun(
  db: Database.Database,
  input: StartReviewerRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<StartSpecialistRunResult> {
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const launchIncarnation = taskLaunchIncarnation(existing.parsed.frontmatter);
  const lease = acquireSpecialistWorkspaceLease(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    taskIncarnation: launchIncarnation.createdAt,
    kind: "reviewer",
    profileId: input.profileId,
  });
  const signal = projectCompletionSignal(db, input.projectSlug);
  const launchCtx: TaskMutationContext = {
    ...ctx,
    expectedTaskIncarnation: launchIncarnation.createdAt,
  };
  return withProjectLaunchOwnership(db, input.projectSlug, input.taskKey, () =>
    startReviewerRunOwned(
      db,
      input,
      actor,
      launchCtx,
      existing,
      launchIncarnation,
      lease,
      signal,
    ),
  ).catch((error) => {
    if (lease.boundRunId === null) {
      releaseSpecialistWorkspaceLease(db, lease);
    }
    throw error;
  });
}

async function startReviewerRunOwned(
  db: Database.Database,
  input: StartReviewerRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext,
  existing: NonNullable<ReturnType<typeof readTaskFile>>,
  launchIncarnation: TaskLaunchIncarnation,
  lease: SpecialistWorkspaceLease,
  signal: AbortSignal,
): Promise<StartSpecialistRunResult> {
  assertTaskLaunchOwnership(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchIncarnation,
  );
  let auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "start a reviewer run",
  );

  const reviewers = existing.parsed.frontmatter.reviewers;
  const index = reviewers.findIndex((r) => r.profileId === input.profileId);
  if (index < 0) {
    throw AppError.validation(
      "That reviewer is not engaged on this task. Assign it first.",
    );
  }
  const rev = reviewers[index]!;
  const backend: RealBackend =
    input.backendOverride ?? (rev.backend === "codex" ? "codex" : "claude");

  let model = defaultModelFor(backend);
  let effort = "";
  let agentName = rev.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  let disallowedTools: string[] = [];
  let resolvedRev: ResolvedSpecialist;
  try {
    resolvedRev = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      rev.profileId,
      backend,
    );
  } catch (error) {
    if (
      error instanceof AppError &&
      error.userMessage.includes("does not declare")
    ) {
      throw error;
    }
    throw AppError.validation(
      "The reviewer profile is no longer deployed. Engage a current profile before starting a run.",
    );
  }
  agentName = resolvedRev.name;
  skills = resolvedRev.skills;
  kb = resolvedRev.kb;
  mcpNames = resolvedRev.mcps;
  disallowedTools = resolveSpecialistDisallowedTools(resolvedRev.capabilities);
  model = resolvedRev.model;
  effort = resolvedRev.effort;
  // Stage eligibility at the RUN boundary (F1) — same rationale as
  // startSpecialistRun: an engaged reviewer must not be re-run at a stage its
  // profile isn't eligible for. Outside the try so the fallback can't swallow it.
  assertStageEligible(resolvedRev, existing.parsed.frontmatter.stage);
  const support = specialistBackendCapabilitySupport(
    resolvedRev.capabilities,
    backend,
  );
  if (!support.supported) {
    throw AppError.validation(
      `Codex cannot enforce this profile's withheld local capabilities (${support.advisoryOnlyWithheld.join(
        ", ",
      )}). Use Claude or grant those capabilities explicitly.`,
    );
  }
  const launchAuthorization = captureTaskLaunchAuthorization(ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    kind: "reviewer",
    profileId: rev.profileId,
  });

  const persona = buildSpecialistPersona({
    profileId: rev.profileId,
    skills,
    kb,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const title = existing.parsed.frontmatter.title;
  const goal = existing.parsed.goal;
  const repo =
    existing.parsed.frontmatter.repo ?? projectRepo(ctx, input.projectSlug);
  const purpose = input.purpose ?? "governance_review";

  // Reviewers inspect and report. Their workspace is disposable and Viberr
  // never pushes from it, regardless of the profile modal's generic defaults.
  const delivery = NO_DELIVERY;
  const realBackend = isBackendAvailable(backend);
  const workspace = realBackend
    ? await requireReviewerWorkspace(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        repo,
        role: rev.role,
        workspaceKey: `reviewer-${rev.profileId}`,
        branch:
          existing.parsed.frontmatter.branch ??
          taskBranchName(input.taskKey, title),
        expectedHeadSha: existing.parsed.frontmatter.pr?.headSha ?? null,
        signal,
        assertActive: () =>
          assertTaskLaunchAuthorization(
            db,
            ctx,
            input.projectSlug,
            input.taskKey,
            launchAuthorization,
          ),
      })
    : null;
  const runWorkdir = workspace?.workdir ?? null;
  const reviewHeadSha = workspace?.headSha ?? null;
  const reviewFingerprint =
    purpose === "governance_review"
      ? reviewEvidenceFingerprint(
          existing.parsed,
          projectRepo(ctx, input.projectSlug),
        )
      : null;

  const analyzePrompt = buildAnalyzePrompt({
    role: rev.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    branch:
      existing.parsed.frontmatter.branch ??
      taskBranchName(input.taskKey, title),
    cloned: !!runWorkdir,
    delivery,
    structuredReviewVerdict: purpose === "governance_review",
    readOnlyReview: true,
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = analyzePrompt;

  const script = buildAnalyzeScript({
    backend,
    model,
    repo,
    cloned: !!runWorkdir,
    role: rev.role,
    ...(input.directive ? { directive: input.directive } : {}),
  });

  assertTaskLaunchAuthorization(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchAuthorization,
  );
  ctx.runtimeLaunchAuthorizationHookForTests?.({
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    kind: "reviewer",
  });
  auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "start a reviewer run",
  );

  const { runId, simulated } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    expectedTaskIncarnation: launchAuthorization.createdAt,
    // `r<index>-<uid>`: the index groups this reviewer's runs in the agents
    // deployment projection; the uid keeps re-runs from colliding on the thread.
    threadId: `r${index}-` + newId("t").replace("t_", "").slice(0, 8),
    role: "Reviewer",
    kind: "reviewer",
    backend,
    model,
    ...(effort ? { effort } : {}),
    ...(persona ? { systemPrompt: persona } : {}),
    agentName,
    agentProfileId: rev.profileId,
    runPurpose: purpose,
    sourceIntentId: input.sourceIntentId ?? null,
    reviewEvidenceFingerprint: reviewFingerprint,
    reviewHeadSha,
    prompt,
    script,
    actor: auditActor,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    ...mcpServersFor(db, mcpNames, backend),
    ...(runWorkdir ? { workdir: runWorkdir } : {}),
    ...(realBackend
      ? { env: workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot) }
      : {}),
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  // Provider start transfers release ownership to the termination finalizer,
  // before any attachment check or dynamic import can fail.
  bindSpecialistWorkspaceLeaseToRun(db, runId, lease);

  stopRunWhenLaunchOwnershipWasLost(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    launchAuthorization,
    runId,
  );

  const backendLabel = backend === "claude" ? "Claude Code" : "Codex";
  await attachFreshSpecialistRun(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    expected: launchAuthorization,
    priorWaiting: existing.parsed.frontmatter.waiting,
    kind: "reviewer",
    eventText: `Started a ${backendLabel} run for the ${rev.role} reviewer — streaming to the agent logs.`,
    completion: {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      backend,
      role: rev.role,
      kind: "reviewer",
      profileId: rev.profileId,
      workdir: runWorkdir,
      delivery,
      purpose,
      launchAuthorization,
      reviewEvidenceFingerprint: reviewFingerprint,
      reviewHeadSha,
      agentHandle: agentHandleFor(rev.role),
      ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
    },
    auditAction: "task.reviewer.run_started",
    auditActor,
    auditDetails: {
      runId,
      profileId: rev.profileId,
      backend,
      simulated,
      cloned: !!runWorkdir,
    },
  });

  return { runId, backend, simulated, role: rev.role };
}

// ----------------------------------------------------------------- persona

/** Read the shipped agent DEFINITION body (persona) for a profile, or "" when
 *  the store ships none. Definitions live next to the profiles in the store. */
function readAgentDefinition(profileId: string, dataRoot?: string): string {
  try {
    const file = path.join(
      agentProfilesDir(dataRoot),
      "..",
      "definitions",
      `${profileId}.md`,
    );
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
  } catch {
    // missing/unreadable definition — the run falls back to the analyze prompt
  }
  return "";
}

/** Read one skill's body from the store, or "" when absent. */
function readSkillBody(name: string, dataRoot?: string): string {
  try {
    const file = path.join(skillDirPath(name, dataRoot), "SKILL.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
  } catch {
    // missing/unreadable skill — skip it
  }
  return "";
}

/**
 * Assemble a specialist's run PERSONA: its detailed definition (who it is + how
 * it works) followed by each of its declared skill bodies (its craft). This is
 * what makes a built-in agent behave as itself — the Developer implements and
 * reports back, the Reviewer critiques AND validates (tests) — rather than a
 * generic "analyze the repo" agent. Returns "" when the store ships neither a
 * definition nor any skill (the run still works on the analyze prompt alone).
 *
 * Threaded into the run as the system prompt for Claude, or folded into the turn
 * prompt for Codex (which has no system-prompt channel). Exported for tests.
 */
export function buildSpecialistPersona(input: {
  profileId: string;
  skills: string[];
  kb?: string[];
  dataRoot?: string;
}): string {
  const parts: string[] = [];
  const definition = readAgentDefinition(input.profileId, input.dataRoot);
  if (definition) parts.push(definition);
  for (const name of input.skills) {
    const body = readSkillBody(name, input.dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (skill)\n\n${body}`);
  }
  // Inject declared knowledge-base docs (F6, FR9): the KB leg was decorative for
  // specialists — no run received KB content. Load each declared KB folder that
  // exists in the store. KB_INJECTION_BUDGET is a GLOBAL cap across all declared
  // KBs (F9) — a specialist with many KBs can't blow the prompt with N × 24k.
  let kbBudget = KB_INJECTION_BUDGET;
  for (const name of input.kb ?? []) {
    if (kbBudget <= 0) break;
    const body = readKbBody(name, input.dataRoot, kbBudget);
    if (body) {
      parts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
      kbBudget -= body.length;
    }
  }
  return parts.join("");
}

// readKbBody now lives in ~/server/files/kb-injection.server (shared with the
// operator runtime): it walks the KB tree recursively and matches every text-doc
// extension, so GitHub-imported / folder-uploaded / non-.md docs actually reach
// the agent instead of being silently dropped.

// ----------------------------------------------------------------- prompt/script

function buildAnalyzePrompt(input: {
  role: string;
  taskKey: string;
  title: string;
  goal: string;
  repo: string | null;
  /** The task-key branch the delivery must land on. */
  branch: string;
  cloned: boolean;
  /** Which delivery steps the profile's capabilities permit (XS-4). */
  delivery: DeliveryPermissions;
  /** Reviewer runs must close with a strict, machine-readable verdict. */
  structuredReviewVerdict?: boolean;
  /** Reviewer workspaces are exact-head inspection surfaces, never delivery
   * sources. */
  readOnlyReview?: boolean;
  /** An operator directive that becomes the run's turn focus (when present). */
  directive?: string;
}): string {
  let prompt = input.repo
    ? `You are the ${input.role} specialist on task ${input.taskKey}: ` +
      `"${input.title}". Goal: ${input.goal}. Analyze the repository and report ` +
      `your findings (structure, dependencies, architecture, notable risks/gaps) ` +
      `as a concise summary.`
    : `You are the ${input.role} specialist on task ${input.taskKey}: ` +
      `"${input.title}". Goal: ${input.goal}. This task has no configured ` +
      `repository. Work only in the isolated repository-free task directory; ` +
      `do not search parent directories, initialize or discover Git, or invent ` +
      `code evidence. Address the task context and report what can be concluded ` +
      `without a repository.`;
  // Workspace + delivery CONTRACT (NFR15 traceability). The run gets a dedicated
  // per-task cwd, and Git's ceiling prevents accidental parent-repo discovery.
  // This prompt is guidance, not an OS filesystem boundary.
  if (input.repo) {
    const { canBranch, canCommitPush, canOpenPr } = input.delivery;
    prompt +=
      `\n\n## Workspace & delivery contract (follow exactly)\n` +
      `- Work ONLY inside the current working directory — it is the dedicated ` +
      `workspace for this task. Never \`cd\` to a parent directory or touch any ` +
      `repository outside it.\n` +
      (input.cloned
        ? `- The repository \`${input.repo}\` is already checked out in the current directory.\n`
        : `- Clone \`https://github.com/${input.repo}\` INTO the current directory (\`git clone https://github.com/${input.repo}.git .\`) before making changes.\n`);
    if (input.readOnlyReview) {
      prompt += `- This is an exact server-prepared checkout of the task branch. Inspect and test this HEAD; do not create/switch branches, commit, push, or modify the implementation as a fix.\n`;
    } else if (canBranch) {
      prompt += `- Do all work on the branch \`${input.branch}\` (create it from the default branch if it does not exist): \`git checkout -B ${input.branch}\`.\n`;
    }
    if (canCommitPush) {
      prompt += `- Commit the finished local changes and prefix every commit message with \`[${input.taskKey}]\` so commits trace back to this task.\n`;
    }
    prompt +=
      `- Do NOT push, run \`gh\`, or open a pull request yourself. Viberr owns remote authentication and will ` +
      `${canCommitPush ? "push the verified local branch" : "leave remote delivery withheld by policy"}` +
      `${canCommitPush && canOpenPr ? " and open/reconcile the review PR" : ""} after your run finishes.\n`;
    // Reflect what the profile's capabilities actually allow so the run never
    // attempts (and fails) a step its tools deny.
    if (!input.readOnlyReview && !canBranch && !canCommitPush && !canOpenPr) {
      prompt += `- Your profile does not grant branch/commit/PR delivery — do the analysis and any in-workspace edits, then report findings; do NOT attempt to branch, commit, push, or open a PR.\n`;
    }
    prompt += input.readOnlyReview
      ? `- Report the exact HEAD SHA you reviewed; Viberr records the governance verdict separately.`
      : `- Report the exact local branch name and commit SHAs; Viberr reports the verified remote branch and PR result separately.`;
  }
  if (input.directive?.trim()) {
    prompt +=
      `\n\nThe operator has engaged you and directs: "${input.directive.trim()}" ` +
      `Address that directive as you work, then give a concise reply.`;
  }
  if (input.structuredReviewVerdict) {
    prompt +=
      `\n\n## Required structured review verdict\n` +
      `End your response with exactly one single-line marker in this format:\n` +
      `VIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"concise evidence-based reason"}\n` +
      `The verdict value must be either "approve" or "request_changes". ` +
      `Do not wrap the marker in a code fence. Prose such as LGTM or "Verdict: pass" is not accepted as a verdict.`;
  }
  return prompt;
}

/** Classify a specialist by its role label so the simulated report and persona
 *  match what the agent actually does. The Reviewer is the single quality
 *  specialist (it reviews the diff AND authors/runs tests), so review/test/QA
 *  roles all classify as "reviewer". Anything unrecognized reports as a
 *  developer. */
function classifyRole(role?: string): "developer" | "reviewer" {
  const r = (role ?? "").toLowerCase();
  if (/review|test|valid|qa/.test(r)) return "reviewer";
  return "developer";
}

/**
 * The simulated agent's CLOSING report — ROLE-AWARE, so the operator reads a
 * report that matches the agent it prompted: the Developer reports what it
 * implemented, the Reviewer reports a review verdict, the Tester reports a
 * validation verdict. When the operator engaged the agent with a directive this
 * reports the work as DONE (otherwise the operator, reading only a "findings"
 * summary, keeps re-prompting the same canned reply and spirals — the CTL-3
 * bug). The text is deterministic on purpose: if the operator ever re-prompts a
 * simulated agent, the identical repeat trips its no-progress guard and stops
 * the loop instead of spiralling. Exported for tests.
 */
export function simulatedFinalReport(
  backend: RealBackend,
  directive?: string,
  role?: string,
): string {
  const kind = classifyRole(role);
  if (directive?.trim()) {
    if (kind === "reviewer") {
      return (
        `@operator — reviewed and validated the change against the goal. ` +
        `Correctness: the logic holds on the paths that matter. Security: input ` +
        `is validated and no secrets leak. Tests: authored and ran coverage for ` +
        `the new behavior incl. the empty and boundary cases; full suite passes. ` +
        `No blocking findings (one nit: a comment could be clearer). Ready to accept.\n` +
        `VIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"The implementation matches the goal and the full suite passes."}`
      );
    }
    const test =
      backend === "codex" ? "a test that exercises" : "a test covering";
    return (
      `@operator — done: implemented what you asked for, wired into the existing ` +
      `structure (matching the conventions under src/), and added ${test} the new ` +
      `behavior. Ran the suite and it passes. No blockers remaining — ready to advance.`
    );
  }
  if (kind === "reviewer") {
    return "Review findings: the change is small and localized; no obvious correctness or security issues in the diff. The existing tests pass, but coverage of the new path is thin — the empty and boundary cases are not exercised yet, which I'd want closed before acceptance.";
  }
  return backend === "codex"
    ? "Findings: a small Node/TypeScript service (Express). Entry at src/index.ts, HTTP layer under src/server. Dependencies are lean; no test suite is wired yet — the main gap for this goal."
    : "Findings: a small Node/TypeScript service (Express). Entry point src/index.ts; the HTTP layer lives under src/server. Dependencies are lean. Notable gap: there is no test suite wired up yet, which is the main risk for this goal.";
}

/**
 * A realistic dev-agent-analyzing-a-repo stream for the simulated fallback:
 * system·init, a couple of tool_use Read/Bash lines, an assistant findings
 * summary, and a final result envelope with usage. Ignored by a real SDK run.
 */
function buildAnalyzeScript(input: {
  backend: RealBackend;
  model: string;
  repo: string | null;
  cloned: boolean;
  /** The agent's role — makes the simulated closing report role-appropriate. */
  role?: string;
  /** When the operator engaged this agent, its directive (shown as the opener). */
  directive?: string;
}): SimulatedScript {
  const sid = newId("run").replace("run_", "");
  const now = () => new Date().toISOString();
  const repoName = input.repo
    ? (input.repo.split("/").pop() ?? input.repo)
    : "workspace";
  const directive = input.directive?.trim();
  const opener = directive
    ? `The operator asked me to: ${directive} On it — scanning the repository first.`
    : "Scanning the repository layout to understand its structure.";
  const finalCodex = simulatedFinalReport("codex", directive, input.role);
  const finalClaude = simulatedFinalReport("claude", directive, input.role);

  const lines: LogLine[] =
    input.backend === "codex"
      ? [
          {
            t: "",
            ev: "init",
            tag: "thread.started",
            text: `codex thread · analyzing ${repoName}`,
          },
          { t: "", ev: "text", tag: "agent_message", text: opener },
          {
            t: "",
            ev: "tool",
            tag: "command_execution",
            name: "exec",
            text: "ls -R",
            input: { command: "ls -R" },
          },
          {
            t: "",
            ev: "out",
            tag: "command_output",
            text: "src/\n  index.ts\n  server/\npackage.json\nREADME.md",
          },
          {
            t: "",
            ev: "tool",
            tag: "command_execution",
            name: "exec",
            text: "cat package.json",
            input: { command: "cat package.json" },
          },
          {
            t: "",
            ev: "out",
            tag: "command_output",
            text: '{ "name": "app", "dependencies": { "express": "^4" } }',
          },
          {
            t: "",
            ev: "text",
            tag: "agent_message",
            text: finalCodex,
          },
          {
            t: "",
            ev: "result",
            tag: "turn.completed",
            text: "analysis complete",
            usage: {
              input_tokens: 4200,
              cached_input_tokens: 1800,
              output_tokens: 640,
            },
          },
        ]
      : [
          {
            t: "",
            ev: "init",
            tag: "system·init",
            text: `analyzing ${repoName} · read-only pass`,
          },
          {
            t: "",
            ev: "text",
            tag: "assistant",
            text: directive
              ? opener
              : "Scanning the repository layout to understand its structure and dependencies.",
          },
          {
            t: "",
            ev: "tool",
            tag: "tool_use",
            name: "Bash",
            text: "ls -R",
            input: { command: "ls -R" },
          },
          {
            t: "",
            ev: "out",
            tag: "tool_result",
            text: "src/\n  index.ts\n  server/\npackage.json\nREADME.md",
          },
          {
            t: "",
            ev: "tool",
            tag: "tool_use",
            name: "Read",
            text: "package.json",
            input: { file_path: "package.json" },
          },
          {
            t: "",
            ev: "out",
            tag: "tool_result",
            text: '{ "name": "app", "dependencies": { "express": "^4" } }',
          },
          {
            t: "",
            ev: "text",
            tag: "assistant",
            text: finalClaude,
          },
          {
            t: "",
            ev: "result",
            tag: "result",
            text: "analysis complete",
            stats: {
              subtype: "success",
              dur: 8400,
              api: 7100,
              turns: 3,
              cost: 0.06,
              in: 4200,
              cached: 1800,
              out: 640,
            },
          },
        ];

  return buildScript({
    lines,
    occurredAt: lines.map(() => now()),
    sessionId: sid,
    backend: input.backend,
    model: input.model,
    op: false,
    keepRunning: false,
  });
}

// ------------------------------------------------------------------- repo clone

function projectRepo(
  ctx: TaskMutationContext,
  projectSlug: string,
): string | null {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return file?.parsed.frontmatter.repo ?? null;
}

export async function requireSpecialistWorkspace(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string | null;
    role: string;
    workspaceKey?: string;
    checkoutRef?: string;
    expectedHeadSha?: string | null;
    signal?: AbortSignal;
    assertActive?: () => void;
  },
): Promise<string> {
  const assertActive = () => {
    if (input.signal?.aborted) {
      if (input.signal.reason instanceof Error) throw input.signal.reason;
      throw new DOMException(
        "Specialist workspace preparation was cancelled.",
        "AbortError",
      );
    }
    input.assertActive?.();
  };
  assertActive();
  if (!input.repo) {
    const workspaceKey = workspaceNamespaceKey(input.workspaceKey);
    const root = path.join(
      taskDir(input.projectSlug, input.taskKey, ctx.dataRoot),
      "workspace",
      ...(workspaceKey ? [workspaceKey] : []),
      "repo-less",
    );
    mkdirSync(root, { recursive: true });
    assertActive();
    return root;
  }
  const preflight = await preflightSpecialistWorkspace(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      repo: input.repo,
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      ...(input.checkoutRef ? { checkoutRef: input.checkoutRef } : {}),
      ...(input.expectedHeadSha !== undefined
        ? { expectedHeadSha: input.expectedHeadSha }
        : {}),
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    },
    { ...(input.signal ? { signal: input.signal } : {}) },
  );
  assertActive();
  if (preflight.status === "ready") return preflight.workdir;

  assertActive();
  const { openSystemRecovery } = await import("./task-recovery.server");
  assertActive();
  await openSystemRecovery(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      code: `specialist_preflight:${preflight.code}`,
      occurrenceId: newId("preflight"),
      title: preflight.title,
      body: `${preflight.detail} No ${input.role} model session was started.`,
      observations: [
        { k: "Preflight", v: preflight.code, code: true },
        {
          k: "Project credential",
          v: preflight.credentialBound ? "bound" : "not bound",
          code: false,
        },
      ],
    },
    ctx,
  );
  assertActive();
  throw AppError.validation(`Run not started — ${preflight.detail}`);
}

async function requireReviewerWorkspace(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string | null;
    role: string;
    workspaceKey: string;
    branch: string;
    expectedHeadSha: string | null;
    signal?: AbortSignal;
    assertActive?: () => void;
  },
): Promise<{ workdir: string; headSha: string | null }> {
  if (!input.repo) {
    return {
      workdir: await requireSpecialistWorkspace(db, ctx, input),
      headSha: null,
    };
  }
  input.assertActive?.();
  const preflight = await preflightSpecialistWorkspace(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      repo: input.repo,
      workspaceKey: input.workspaceKey,
      checkoutRef: input.branch,
      expectedHeadSha: input.expectedHeadSha,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    },
    { ...(input.signal ? { signal: input.signal } : {}) },
  );
  input.assertActive?.();
  if (preflight.status === "ready") {
    return { workdir: preflight.workdir, headSha: preflight.headSha };
  }
  input.assertActive?.();
  const { openSystemRecovery } = await import("./task-recovery.server");
  input.assertActive?.();
  await openSystemRecovery(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      code: `reviewer_preflight:${preflight.code}`,
      occurrenceId: newId("preflight"),
      title: preflight.title,
      body: `${preflight.detail} No ${input.role} review session was started.`,
      observations: [
        { k: "Review branch", v: input.branch, code: true },
        { k: "Preflight", v: preflight.code, code: true },
      ],
    },
    ctx,
  );
  input.assertActive?.();
  throw AppError.validation(`Review not started — ${preflight.detail}`);
}

/** The per-run env that stops Git from discovering a parent checkout. */
/**
 * Runtime settings a resumed specialist (@mention comment) must re-apply so it
 * gets the SAME denylist, git ceiling, MCP set, and persona as its fresh run.
 * The denylist is enforced by Claude only; Codex's direct SDK has no equivalent.
 * A removed deployment fails closed: resumed work must use a current profile
 * so its stage, capability, resource and backend policy can be re-evaluated.
 */
export function resolveResumeConfinement(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    backend: RealBackend;
  },
): {
  disallowedTools: string[];
  env: Record<string, string>;
  delivery: DeliveryPermissions;
  mcpServers?: Record<string, unknown>;
  systemPrompt?: string;
} {
  const env = workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot);
  const resolved = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
    input.backend,
  );
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!task) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  assertStageEligible(resolved, task.parsed.frontmatter.stage);
  const support = specialistBackendCapabilitySupport(
    resolved.capabilities,
    input.backend,
  );
  if (!support.supported) {
    throw AppError.validation(
      `Codex cannot enforce this profile's withheld local capabilities (${support.advisoryOnlyWithheld.join(
        ", ",
      )}). Use Claude or grant those capabilities explicitly.`,
    );
  }
  const persona = buildSpecialistPersona({
    profileId: input.profileId,
    skills: resolved.skills,
    kb: resolved.kb,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const mcpServers = resolveSpecialistMcpServers(
    db,
    resolved.mcps,
    input.backend,
  );
  return {
    disallowedTools: resolveSpecialistDisallowedTools(resolved.capabilities),
    env,
    delivery: resolveDeliveryPermissions(resolved.capabilities),
    ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(persona ? { systemPrompt: persona } : {}),
  };
}

function workspaceRunEnv(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): Record<string, string> {
  // The ceiling must be a STRICT ANCESTOR of the run cwd — `GIT_CEILING` only
  // blocks git from ascending INTO a listed dir, so a ceiling EQUAL to cwd is a
  // no-op (git's first step up lands in the ceiling's unblocked parent). The
  // run cwd is `<taskDir>/workspace/<repo>`, so we pin the ceiling to the TASK
  // dir. That stops git-repo discovery before it can reach a host `.git`
  // (adversarial-review HIGH #2).
  const ceiling = taskDir(projectSlug, taskKey, dataRoot);
  return {
    GIT_CEILING_DIRECTORIES: ceiling,
  };
}

// ------------------------------------------------------- completion hook

/** A short @mention handle for a specialist/reviewer role, used in the
 *  stuck-loop packet copy ("@dev repeated its report"). */
function agentHandleFor(role: string): string {
  const first = role.trim().split(/[\s/&]+/)[0] ?? role;
  return first.toLowerCase();
}

// --------------------------------------------------------------------- shared

function reproject(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

/** Audit actor for the current caller: the operator (no user id) when the
 *  context is operator-authorized, else the human — after enforcing the
 *  human runtime RBAC. Operator authority is gated upstream by its capability
 *  policy (operator-actions.server), so operator callers skip the human check. */
function runtimeAuditActor(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
  what: string,
): AuditActor {
  if (ctx.operatorAuthorized) return { userId: null, label: "operator" };
  const current = requireRuntimeRole(db, ctx, projectSlug, actor, what);
  return withProjectAuditAuthority(current.actor, current.source);
}

/**
 * RBAC gate reused by both fns: admin|maintainer against project membership
 * (contracts §3.2 "Open agent runtime sessions"). Mirrors the check
 * transition/interrupt use.
 */
function requireRuntimeRole(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
  what: string,
): {
  actor: TaskActor;
  source: Exclude<ProjectAuthoritySource, "denied">;
} {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const role = file.parsed.frontmatter.members.find(
    (m) => m.userId === actor.userId,
  )?.role;
  const user = db
    .prepare(`SELECT role, disabled FROM users WHERE id = ?`)
    .get(actor.userId) as
    { role: "admin" | "member"; disabled: number } | undefined;
  if (!user || user.disabled === 1) {
    throw forbidden(`Only active users can ${what}.`);
  }
  const currentActor: TaskActor = {
    ...actor,
    orgRole: resolveOrgRole(db, actor.userId, user.role),
  };
  const authority = authorizeProjectAction(
    role ?? null,
    currentActor.orgRole,
    "run-agents",
  );
  if (!authority.allowed) {
    if (!role) throw forbidden(`Only project members can ${what}.`);
    throw forbidden(`Your project role (${role}) cannot ${what}.`);
  }
  return {
    actor: currentActor,
    source: authority.source as Exclude<ProjectAuthoritySource, "denied">,
  };
}

/** One deployed specialist as the task-detail assign menu offers it. */
export interface DeployedSpecialistView {
  id: string;
  name: string;
  role: string;
  backend: RealBackend;
  /** Every backend explicitly available for assignment/routing. */
  backends: RealBackend[];
  model: string;
  /** Reasoning effort (empty when unset) — carried so a comment-resume can
   *  apply the agent's current effort, not the prior run's. */
  effort: string;
  /** Stage ids this profile is eligible to work (F1 — now enforced, not just
   *  displayed). Empty when spanAll. */
  stages: string[];
  /** When true the profile is eligible across every stage. */
  spanAll: boolean;
}

/**
 * True when a specialist may work a task at `stageId`: it spans all stages, OR
 * declares no eligible stages (treated as unrestricted, back-compat), OR lists
 * this stage. Consumed by the operator picker and the assign/run guards (F1).
 */
export function specialistEligibleForStage(
  spec: { stages: string[]; spanAll: boolean },
  stageId: string,
): boolean {
  if (spec.spanAll) return true;
  if (spec.stages.length === 0) return true;
  return spec.stages.includes(stageId);
}

/**
 * Enforce agent stage eligibility (F1): reject assigning/running a specialist on
 * a task whose current stage the specialist isn't eligible for. The Agents UI
 * shows "N of M stages" per profile; this makes that promise real instead of
 * decorative. `spanAll` and no-declared-stages profiles are always eligible.
 */
function assertStageEligible(
  spec: { name: string; stages: string[]; spanAll: boolean },
  stageId: string,
): void {
  if (specialistEligibleForStage(spec, stageId)) return;
  throw AppError.validation(
    `${spec.name} is not eligible for the "${stageId}" stage — its profile is scoped to ${
      spec.stages.join(", ") || "no stages"
    }. Change the task's stage or the profile's eligible stages.`,
  );
}

/**
 * The project's deployed SPECIALIST agents (kind !== "operator"), resolved
 * from project.md `agents:` — what the loader passes so the UI can offer them
 * in the "Assign specialist" menu. Reads the loose `definition` the same way
 * the Agents surface does.
 */
export function listDeployedSpecialists(
  db: Database.Database,
  projectSlug: string,
  ctx: TaskMutationContext = {},
): DeployedSpecialistView[] {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) return [];
  const out: DeployedSpecialistView[] = [];
  for (const deployment of file.parsed.frontmatter.agents) {
    const view = effectiveProfileView(deployment, ctx.dataRoot);
    if (view.kind !== "specialist") continue;
    const resolved = toResolved(view);
    out.push({
      id: resolved.profileId,
      name: resolved.name,
      role: resolved.role,
      backend: resolved.backend,
      backends: resolved.backends,
      model: resolved.model,
      effort: resolved.effort,
      stages: resolved.stages,
      spanAll: resolved.spanAll,
    });
  }
  return out;
}

/** True when a run for this task is currently `running` (UI disables Run). */
export function hasRunningRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): boolean {
  return listRunsForTask(db, projectSlug, taskKey).some(
    (r) => r.lifecycle === "running",
  );
}
