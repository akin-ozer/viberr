import type Database from "better-sqlite3";
import type { UserRole } from "~/shared/mapping/user.server";
import {
  recordAudit,
  withProjectAuditAuthority,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { createUser } from "~/server/auth/user-admin.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-role-guard.server";
import { resolveOrgRole } from "~/server/auth/identity.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { projectFilePath } from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  convergeProjectOwnershipCleanup,
  markProjectOwnershipCleanupCommitted,
  stageProjectOwnershipCleanup,
} from "~/server/tasks/ownership-cleanup.server";
import {
  authorizeProjectAction,
  type ProjectAuthoritySource,
} from "~/shared/rbac";
import {
  cancelProjectDeletion,
  commitProjectDirectoryDeletion,
  completeProjectDeletion,
  stageProjectDeletion,
  type ProjectDeletionTombstone,
} from "~/server/projects/project-operational-state.server";
import type {
  ParsedProjectFile,
  ProjectRole,
  StageDef,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";
import {
  stopProjectRuns,
  waitForProjectRunTermination,
} from "~/server/runtimes/run-service.server";
import {
  allowProjectCompletionEffects,
  completeProjectRunEffects,
  revokeProjectCompletionEffects,
  waitForProjectCompletionEffects,
} from "~/server/runtimes/run-completion-state.server";
import { cancelAutoOperatorDispatchesForProject } from "~/server/runtimes/operator-dispatch.server";
import {
  cancelPendingOperatorTriggersForProject,
  clearOperatorLeasesForProject,
} from "~/server/runtimes/operator-run.server";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import {
  PROJECT_LIFECYCLE_INTENT_MARKER,
  convergeProjectLifecycleIntent,
  getProjectLifecycleIntent,
  stageProjectLifecycleIntent,
  type ProjectLifecycleIntent,
} from "~/server/projects/project-lifecycle.server";

/**
 * Project-settings mutations (project-settings spec §5): identity, the
 * workflow-stages editor, membership CRUD, the repo-override policy flag,
 * and the danger-zone delete. Every mutation follows the canonical order
 * file write → incremental reproject → audit (SSE `project.updated` rides
 * the rebuild — open Boards re-render columns via the shell's project
 * scope).
 *
 * RBAC (contracts §3.2, enforced HERE): identity/stages/override/delete =
 * "Edit workflow & policy" → admin; membership CRUD = "Manage members &
 * roles" → admin. (Grant-scope stays admin|maintainer in the route,
 * matching the GitHub view.) Guards the mock did client-side (locked
 * stages, non-empty stages, self-removal, last-admin) are re-checked
 * server-side with the spec-verbatim toast copy as the error message.
 */

export interface SettingsActor {
  userId: string;
  label: string;
  orgRole?: UserRole;
}

export interface SettingsMutationContext {
  dataRoot?: string;
  /** Deterministic pause after archive/delete revokes admission. Tests use it
   * to prove a concurrent restore is serialized behind the lifecycle drain. */
  lifecycleDrainHookForTests?: (
    operation: "archive" | "delete",
  ) => void | Promise<void>;
  /** Shorten the provider-exit deadline in lifecycle timeout regressions. */
  lifecycleTerminationTimeoutMsForTests?: number;
  /** Fault/authorization seam after provider/effect drain but before the
   * canonical archive/delete commit boundary. */
  beforeProjectLifecycleCommitHookForTests?: (
    operation: "archive" | "restore" | "delete",
  ) => void | Promise<void>;
  /** Fault seam for projection failures after a canonical lifecycle write. */
  reprojectHookForTests?: () => void;
  /** Crash seam after lifecycle attribution is durable but before project.md
   * carries the intent marker and changed archived flag. */
  afterProjectLifecycleIntentStagedForTests?: (
    operation: "archive" | "restore",
  ) => void;
  /** Crash seam after the canonical project directory has atomically left its
   * live path but before operational cleanup and audit convergence. */
  afterProjectRemovalHookForTests?: () => void;
  /** Fault seam while journaling owner-seat candidates before the authorized
   * membership write. No task ownership changes before that write commits. */
  beforeOwnershipReleaseForTests?: (input: {
    taskKey: string;
    releasedTaskKeys: readonly string[];
  }) => void | Promise<void>;
  afterOwnershipCanonicalReleaseForTests?: (input: {
    taskKey: string;
  }) => void | Promise<void>;
}

/**
 * The entry (first) and terminal (last) stages are structural and cannot be
 * removed — regardless of their ids (a Lightweight board is `todo … done`, a
 * custom board is anything). Returns a lock reason if `stageId` is one of them,
 * else null. Replaces the old literal-id `STAGE_LOCK` map keyed on
 * "triage"/"done", which silently failed to protect non-default boards.
 */
export function stageLockReason(
  stageId: string,
  stages: readonly { id: string }[],
): string | null {
  if (stages.length === 0) return null;
  if (stageId === stages[0]!.id) return "it's the entry point";
  if (stageId === stages[stages.length - 1]!.id)
    return "human acceptance stays terminal";
  return null;
}

export const NEW_STAGE_COLORS = [
  "var(--blue)",
  "var(--yellow-dark)",
  "var(--agent)",
  "var(--teal-dark)",
] as const;

/**
 * The settings editor presents one ordered stage path, so that order is the
 * canonical workflow graph. Entering a destination inherits that
 * destination's prior boundary when possible; a new intermediate destination
 * defaults to approval. The terminal edge is always human and locked.
 */
export function workflowForStageOrder(
  stages: readonly StageDef[],
  previous: readonly WorkflowBoundary[],
): WorkflowBoundary[] {
  return stages.slice(0, -1).map((from, index) => {
    const to = stages[index + 1]!;
    const entering =
      previous.find((edge) => edge.from === from.id && edge.to === to.id) ??
      previous.find((edge) => edge.to === to.id);
    const terminal = index === stages.length - 2;
    if (terminal) {
      return {
        from: from.id,
        to: to.id,
        boundary: "human",
        by: entering?.by ?? "Human acceptance of the completion report",
        locked: true,
      };
    }
    return {
      from: from.id,
      to: to.id,
      // Preserve the destination's prior boundary, including an intermediate
      // "Human only" the Policy page legitimately allows; coercing it to
      // approval here silently weakened a human gate on any stage reorder.
      boundary: entering?.boundary ?? "approval",
      by:
        entering?.by ??
        "Operator transition request under the configured project policy",
      locked: false,
    };
  });
}

function forbidden(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.FORBIDDEN,
    status: 403,
    userMessage,
    kind: "user",
  });
}

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
}

const PROJECT_LIFECYCLE_LOCKS = Symbol.for("viberr.projectLifecycleLocks");

function projectLifecycleLocks(): WeakMap<
  Database.Database,
  Map<string, Promise<void>>
> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Map<string, Promise<void>>> | undefined
  >;
  return (cache[PROJECT_LIFECYCLE_LOCKS] ??= new WeakMap());
}

/** Archive, restore and delete are one serialized state machine per project.
 * Register the successor synchronously before awaiting its predecessor so a
 * concurrent restore can never reopen admission during an archive/delete
 * drain. */
async function withProjectLifecycleLock<T>(
  db: Database.Database,
  projectSlug: string,
  operation: () => Promise<T>,
): Promise<T> {
  const byProject = projectLifecycleLocks().get(db) ?? new Map();
  projectLifecycleLocks().set(db, byProject);
  const previous = byProject.get(projectSlug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  byProject.set(projectSlug, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (byProject.get(projectSlug) === current) {
      byProject.delete(projectSlug);
    }
  }
}

function requireProjectAdmin(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
  actor: SettingsActor,
  what: string,
): ReturnType<typeof assertProjectAction> {
  // Single canonical guard: project settings (identity/stages/repo/members/
  // archive/delete) are admin-only (`edit-policy` tier in ACTION_ROLES).
  return assertProjectAction("edit-policy", projectSlug, actor.userId, what, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    orgRole: currentOrgRole(db, actor),
  });
}

function currentOrgRole(db: Database.Database, actor: SettingsActor): UserRole {
  const cached = db
    .prepare(`SELECT role, disabled FROM users WHERE id = ?`)
    .get(actor.userId) as { role: string; disabled: number } | undefined;
  if (!cached || cached.disabled === 1) {
    throw forbidden(
      "Your account is no longer active and cannot change project settings.",
    );
  }
  const fallback: UserRole = cached.role === "admin" ? "admin" : "member";
  return resolveOrgRole(db, actor.userId, fallback);
}

/** Commit-boundary authority against the exact project.md snapshot which will
 * be written or removed. This closes the drain window where project role or
 * emergency org-admin authority can be revoked after request admission. */
function requireCurrentProjectAdmin(
  db: Database.Database,
  parsed: ParsedProjectFile,
  actor: SettingsActor,
  what: string,
): {
  projectName: string;
  role: ProjectRole;
  authoritySource: Exclude<ProjectAuthoritySource, "denied">;
} {
  const projectRole = parsed.frontmatter.members.find(
    (member) => member.userId === actor.userId,
  )?.role;
  const authority = authorizeProjectAction(
    projectRole,
    currentOrgRole(db, actor),
    "edit-policy",
  );
  if (!authority.allowed) {
    throw forbidden(`Only project admins can ${what}.`);
  }
  return {
    projectName: parsed.frontmatter.name,
    role: authority.source === "org_admin_override" ? "admin" : projectRole!,
    authoritySource: authority.source as Exclude<
      ProjectAuthoritySource,
      "denied"
    >,
  };
}

function projectRef(ctx: SettingsMutationContext, projectSlug: string) {
  return {
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
}

function reopenCompletionAdmissionIfActive(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
  revocation: number,
): boolean {
  if (!db.open) return false;
  const current = readProjectFile(projectRef(ctx, projectSlug));
  if (!current || current.parsed.frontmatter.archived) return false;
  return allowProjectCompletionEffects(db, projectSlug, revocation);
}

/** Timeout is a request boundary, not a provider-ownership boundary. Keep the
 * slug revoked until every detached provider acknowledges exit and every
 * already-owned completion/tool effect has settled. The revocation generation
 * prevents this continuation from reopening admission underneath a retry. */
function reopenCompletionAdmissionAfterTermination(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
  revocation: number,
): void {
  void (async () => {
    await waitForProjectRunTermination(db, projectSlug, null);
    await waitForProjectCompletionEffects(db, projectSlug);
    reopenCompletionAdmissionIfActive(db, ctx, projectSlug, revocation);
  })().catch((error) => {
    logger.error("failed to converge project lifecycle admission", {
      projectSlug,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });
}

function settingsAuditActor(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
  actor: SettingsActor,
): AuditActor {
  const project = readProjectFile(projectRef(ctx, projectSlug));
  const projectRole = project?.parsed.frontmatter.members.find(
    (member) => member.userId === actor.userId,
  )?.role;
  return withProjectAuditAuthority(
    actor,
    authorizeProjectAction(
      projectRole,
      currentOrgRole(db, actor),
      "edit-policy",
    ).source,
  );
}

function reprojectProject(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
): void {
  ctx.reprojectHookForTests?.();
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

// ----------------------------------------------------------------- identity

export async function updateProjectIdentity(
  db: Database.Database,
  input: {
    projectSlug: string;
    name: string;
    prefix: string;
    description: string;
  },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "change project settings",
  );

  const name = input.name.trim();
  const prefix = input.prefix.trim().toUpperCase().slice(0, 4);
  if (!name) throw AppError.validation("Project name is required.");
  if (!/^[A-Z]{1,4}$/.test(prefix)) {
    throw AppError.validation("Task prefix must be 1–4 letters.");
  }
  const description = input.description.trim();

  const changedFields: string[] = [];
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.name !== name) {
      parsed.frontmatter.name = name;
      changedFields.push("name");
    }
    // Prefix changes affect FUTURE keys only — existing task keys/dirs are
    // immutable (spec §5.1).
    if (parsed.frontmatter.taskPrefix !== prefix) {
      parsed.frontmatter.taskPrefix = prefix;
      changedFields.push("prefix");
    }
    if (parsed.description !== description) {
      parsed.description = description;
      changedFields.push("description");
    }
  });

  if (changedFields.length === 0) {
    return { toast: "Project settings saved", changed: false };
  }
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.settings.updated",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { fields: changedFields },
  });
  return { toast: "Project settings saved", changed: true };
}

// ------------------------------------------------------------------- stages

export async function renameStage(
  db: Database.Database,
  input: { projectSlug: string; stageId: string; name: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "edit workflow stages",
  );
  const name = input.name.trim();
  if (!name) throw AppError.validation("Stage name is required.");

  let changed = false;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    if (stage.name === name) return;
    stage.name = name;
    changed = true;
  });

  const toast = `Stage renamed to "${name}" — board and policy follow`;
  if (!changed) return { toast, changed: false };
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.renamed",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name },
  });
  return { toast, changed: true };
}

export async function addStage(
  db: Database.Database,
  input: { projectSlug: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; stageId: string }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "edit workflow stages",
  );

  // Server-generated id (spec §5.2 — never the mock's Date.now scheme).
  const stageId = newId("stage").toLowerCase().replace(/_/g, "-");
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const stage = {
      id: stageId,
      name: "New stage",
      color: NEW_STAGE_COLORS[stages.length % NEW_STAGE_COLORS.length]!,
    };
    // Inserted immediately before the terminal (last) stage so Done stays last,
    // whatever its id.
    const insertIdx = stages.length > 0 ? stages.length - 1 : 0;
    stages.splice(insertIdx, 0, stage);
    parsed.frontmatter.workflow = workflowForStageOrder(
      stages,
      parsed.frontmatter.workflow,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.added",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "stage",
    subjectId: stageId,
    projectSlug: input.projectSlug,
    details: {},
  });
  return { toast: "Stage added — board and workflow updated", stageId };
}

export async function removeStage(
  db: Database.Database,
  input: { projectSlug: string; stageId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "edit workflow stages",
  );

  // Non-empty guard re-checked at ACTION time from projections (spec §5.2 —
  // client counts can be stale).
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_projections
          WHERE project_slug = ? AND stage = ?`,
      )
      .get(input.projectSlug, input.stageId) as { n: number }
  ).n;

  let stageName = input.stageId;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    stageName = stage.name;
    const locked = stageLockReason(input.stageId, parsed.frontmatter.stages);
    if (locked) {
      throw conflict(`${stage.name} can't be removed — ${locked}`);
    }
    if (count > 0) {
      throw conflict(
        `Move ${count} ${count === 1 ? "task" : "tasks"} out of ${stage.name} first`,
      );
    }
    parsed.frontmatter.stages = parsed.frontmatter.stages.filter(
      (s) => s.id !== input.stageId,
    );
    parsed.frontmatter.workflow = workflowForStageOrder(
      parsed.frontmatter.stages,
      parsed.frontmatter.workflow,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.removed",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name: stageName },
  });
  return { toast: `Stage "${stageName}" removed` };
}

export async function reorderStages(
  db: Database.Database,
  input: { projectSlug: string; orderedIds: string[] },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "edit workflow stages",
  );

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const byId = new Map(stages.map((s) => [s.id, s]));
    if (
      input.orderedIds.length !== stages.length ||
      input.orderedIds.some((id) => !byId.has(id))
    ) {
      throw AppError.validation("Stage order is out of date — try again.");
    }
    const next = input.orderedIds.map((id) => byId.get(id)!);
    // Server re-applies the normalization — never trust client order
    // (spec §5.2): the entry stage stays first and the terminal stage stays
    // last, pinned by their CURRENT identity (not the literal ids
    // "triage"/"done") so custom/lightweight boards are protected too.
    const entryId = stages[0]!.id;
    const terminalId = stages[stages.length - 1]!.id;
    const middle = next.filter((s) => s.id !== entryId && s.id !== terminalId);
    parsed.frontmatter.stages = [
      byId.get(entryId)!,
      ...middle,
      byId.get(terminalId)!,
    ];
    parsed.frontmatter.workflow = workflowForStageOrder(
      parsed.frontmatter.stages,
      parsed.frontmatter.workflow,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.reordered",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { order: input.orderedIds },
  });
  return { toast: "Stage order updated — board and workflow follow" };
}

// ------------------------------------------------------------------ members

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Grant project access (spec §5.3): registered email → membership entry.
 * Unregistered email → an OAuth whitelist user row is created first, then the
 * entry. Viberr has no mailer, so this must never claim that an invitation was
 * delivered: the administrator is told exactly how the member can sign in.
 */
export async function grantMemberAccess(
  db: Database.Database,
  input: { projectSlug: string; name: string; email: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; userId: string }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "manage members & roles",
  );

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    throw AppError.validation("Enter a name and a valid email");
  }

  const auditActor = { userId: actor.userId, label: actor.label };
  let user = findUserByEmail(db, email);
  const runtimeEnv = getEnv();
  const githubOAuthConfigured = Boolean(
    runtimeEnv.GITHUB_OAUTH_CLIENT_ID && runtimeEnv.GITHUB_OAUTH_CLIENT_SECRET,
  );
  const googleOAuthConfigured = Boolean(
    runtimeEnv.GOOGLE_OAUTH_CLIENT_ID && runtimeEnv.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  let provisionedProvider: "GitHub" | "Google" | null = null;
  if (!user) {
    provisionedProvider = githubOAuthConfigured
      ? "GitHub"
      : googleOAuthConfigured
        ? "Google"
        : null;
    if (!provisionedProvider) {
      throw AppError.validation(
        "Configure GitHub or Google OAuth before granting a new passwordless account. Existing Viberr users can still be added directly.",
      );
    }
    user = createUser(
      db,
      { email, name, role: "member", tempPassword: null },
      auditActor,
    );
  } else {
    if (user.disabled) {
      throw AppError.validation(
        `${email} belongs to a disabled Viberr account. Re-enable the account before granting project access.`,
      );
    }
    // Existing passwordless rows are usable only through their configured
    // identity provider. Do not turn a historical whitelist row into a project
    // membership while claiming the user can sign in when that provider is off.
    if (!user.passwordHash) {
      if (user.idp === "github" && !githubOAuthConfigured) {
        throw AppError.validation(
          `Configure GitHub OAuth before granting access to this passwordless GitHub account.`,
        );
      }
      if (user.idp === "google" && !googleOAuthConfigured) {
        throw AppError.validation(
          `Configure Google OAuth before granting access to this passwordless Google account.`,
        );
      }
      if (
        user.idp !== "github" &&
        user.idp !== "google" &&
        !githubOAuthConfigured &&
        !googleOAuthConfigured
      ) {
        throw AppError.validation(
          `Configure GitHub or Google OAuth before granting access to this passwordless account.`,
        );
      }
      provisionedProvider =
        user.idp === "github"
          ? "GitHub"
          : user.idp === "google"
            ? "Google"
            : githubOAuthConfigured
              ? "GitHub"
              : "Google";
    }
  }
  const userId = user.id;

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.members.some((m) => m.userId === userId)) {
      throw conflict(`${email} is already a member`);
    }
    // An invite IS the membership (X15): viberr uses a whitelist auth model with
    // no separate accept-invite step, so the member gets access immediately and
    // we no longer stamp a decorative `status: invited` that never gated
    // anything. The member joins as a viewer, editable in Policy afterwards.
    parsed.frontmatter.members.push({ userId, role: "viewer" as const });
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.access_granted",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "user",
    subjectId: userId,
    projectSlug: input.projectSlug,
    details: {
      email,
      role: "viewer",
    },
  });
  return {
    toast: provisionedProvider
      ? `Access granted to ${email} as Viewer · sign in with ${provisionedProvider} using this email`
      : `Access granted to ${email} as Viewer · sign in with the existing account`,
    userId,
  };
}

export async function removeMember(
  db: Database.Database,
  input: { projectSlug: string; targetUserId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  const { projectName, authoritySource } = requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "manage members & roles",
  );

  if (input.targetUserId === actor.userId) {
    throw conflict(`You can't remove yourself from ${projectName}`);
  }

  const userRow = db
    .prepare(`SELECT name, email FROM users WHERE id = ?`)
    .get(input.targetUserId) as { name: string; email: string } | undefined;
  const displayName = userRow?.name ?? input.targetUserId;

  const initial = readProjectFile(projectRef(ctx, input.projectSlug));
  const initialMember = initial?.parsed.frontmatter.members.find(
    (member) => member.userId === input.targetUserId,
  );
  if (!initial || !initialMember) {
    throw AppError.notFound("That user is not a member of this project.");
  }
  if (
    initialMember.role === "admin" &&
    initial.parsed.frontmatter.members.filter(
      (member) => member.role === "admin",
    ).length <= 1
  ) {
    throw conflict(
      `${displayName} is the only admin — assign another admin in Policy first`,
    );
  }

  // Journal exact owner-seat candidates while membership is unchanged. The
  // project-file write below commits the matching batch marker and membership
  // removal atomically; only then may task ownership be released.
  const ownershipCleanup = await stageProjectOwnershipCleanup(
    db,
    {
      projectSlug: input.projectSlug,
      targetUserId: input.targetUserId,
      targetName: displayName,
      reason: "member_removed",
    },
    withProjectAuditAuthority(actor, authoritySource),
    {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      ...(ctx.beforeOwnershipReleaseForTests
        ? { beforeTaskReleaseForTests: ctx.beforeOwnershipReleaseForTests }
        : {}),
      ...(ctx.afterOwnershipCanonicalReleaseForTests
        ? {
            afterTaskCanonicalReleaseForTests:
              ctx.afterOwnershipCanonicalReleaseForTests,
          }
        : {}),
    },
  );

  let committedAuthoritySource = authoritySource;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    committedAuthoritySource = requireCurrentProjectAdmin(
      db,
      parsed,
      actor,
      "manage members & roles",
    ).authoritySource;
    const member = parsed.frontmatter.members.find(
      (m) => m.userId === input.targetUserId,
    );
    if (!member) {
      throw AppError.notFound("That user is not a member of this project.");
    }
    if (member.role === "admin") {
      const admins = parsed.frontmatter.members.filter(
        (m) => m.role === "admin",
      ).length;
      if (admins <= 1) {
        throw conflict(
          `${displayName} is the only admin — assign another admin in Policy first`,
        );
      }
    }
    markProjectOwnershipCleanupCommitted(parsed, ownershipCleanup);
    parsed.frontmatter.members = parsed.frontmatter.members.filter(
      (m) => m.userId !== input.targetUserId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  const releasedTaskKeys = await convergeProjectOwnershipCleanup(
    db,
    ownershipCleanup,
    {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      ...(ctx.afterOwnershipCanonicalReleaseForTests
        ? {
            afterTaskCanonicalReleaseForTests:
              ctx.afterOwnershipCanonicalReleaseForTests,
          }
        : {}),
    },
  );
  db.prepare(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, ?)
     WHERE user_id = ? AND project_slug = ?`,
  ).run(new Date().toISOString(), input.targetUserId, input.projectSlug);
  recordAudit(db, {
    action: "project.member.removed",
    actor: withProjectAuditAuthority(actor, committedAuthoritySource),
    subjectKind: "user",
    subjectId: input.targetUserId,
    projectSlug: input.projectSlug,
    details: { releasedTaskKeys },
  });
  return {
    toast: `${displayName} removed from ${projectName}`,
  };
}

// ----------------------------------------------------------------- override

export async function setRepoOverride(
  db: Database.Database,
  input: { projectSlug: string; enabled: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "change project settings",
  );

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.unknownFrontmatter.taskRepoOverride = input.enabled;
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.repo_override.changed",
    actor: settingsAuditActor(db, ctx, input.projectSlug, actor),
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { enabled: input.enabled },
  });
  return {
    toast: input.enabled
      ? "Task-level repo override enabled"
      : "Task-level repo override disabled",
  };
}

// -------------------------------------------------------------- danger zone

/**
 * Archive / restore a project (admin-only). Archiving flips the `archived`
 * frontmatter flag; the project is then hidden from the active workspace and
 * moved to the home "Archived" section, restorable anytime. Canonical truth is
 * the file, so the change persists via reproject like every other setting.
 */
export function setProjectArchived(
  db: Database.Database,
  input: { projectSlug: string; archived: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; archived: boolean }> {
  return withProjectLifecycleLock(db, input.projectSlug, () =>
    setProjectArchivedOwned(db, input, actor, ctx),
  );
}

async function setProjectArchivedOwned(
  db: Database.Database,
  input: { projectSlug: string; archived: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext,
): Promise<{ toast: string; archived: boolean }> {
  let { projectName, authoritySource } = requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    input.archived ? "archive this project" : "restore this project",
  );
  let currentProject = readProjectFile(projectRef(ctx, input.projectSlug));
  if (!currentProject) {
    throw AppError.notFound(`Project ${input.projectSlug} not found.`);
  }

  // A previous request may have crossed the canonical file boundary and died
  // before projection/audit. Converge it under its original attribution before
  // treating an already-matching boolean as a no-op. A marker-less staged row
  // is cancelled here and cannot mutate project.md.
  const pendingIntent = getProjectLifecycleIntent(db, input.projectSlug);
  if (pendingIntent) {
    convergeProjectLifecycleIntent(db, pendingIntent, {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      ...(ctx.reprojectHookForTests
        ? { beforeProjectionForTests: ctx.reprojectHookForTests }
        : {}),
    });
    currentProject = readProjectFile(projectRef(ctx, input.projectSlug));
    if (!currentProject) {
      throw AppError.notFound(`Project ${input.projectSlug} not found.`);
    }
    projectName = currentProject.parsed.frontmatter.name;
  }

  const expectedArchived = Boolean(currentProject.parsed.frontmatter.archived);
  if (expectedArchived === input.archived) {
    return {
      toast: input.archived
        ? `Project "${projectName}" is already archived`
        : `Project "${projectName}" is already active`,
      archived: input.archived,
    };
  }

  let cancelledDispatches = 0;
  let cancelledPendingTriggers = 0;
  let stoppedRuns = 0;
  let committedProjectName = projectName;
  let committedAuthoritySource = authoritySource;
  let lifecycleIntent: ProjectLifecycleIntent | null = null;
  if (input.archived) {
    // Revoke runtime/completion ownership before flipping canonical lifecycle
    // state. Every subsequent drain step belongs to one failure boundary: if
    // any hook, provider acknowledgement, effect drain, or file write fails,
    // reopen admission only for the exact unchanged active project we revoked.
    const revocation = revokeProjectCompletionEffects(db, input.projectSlug);
    let providerShutdownStarted = false;
    let safeToReopen = false;
    try {
      await ctx.lifecycleDrainHookForTests?.("archive");
      cancelledDispatches = cancelAutoOperatorDispatchesForProject(
        db,
        input.projectSlug,
        ctx.dataRoot,
      );
      providerShutdownStarted = true;
      clearOperatorLeasesForProject(input.projectSlug);
      cancelledPendingTriggers = cancelPendingOperatorTriggersForProject(
        db,
        input.projectSlug,
      );
      stoppedRuns = stopProjectRuns(db, input.projectSlug);
      const terminated = await waitForProjectRunTermination(
        db,
        input.projectSlug,
        ctx.lifecycleTerminationTimeoutMsForTests,
      );
      if (!terminated) {
        throw new AppError({
          code: ERROR_CODES.CONFLICT,
          status: 409,
          userMessage:
            "Agent shutdown is still in progress. Retry archive shortly.",
          kind: "user",
        });
      }
      await waitForProjectCompletionEffects(db, input.projectSlug);
      safeToReopen = true;
      await ctx.beforeProjectLifecycleCommitHookForTests?.("archive");
      await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
        if (parsed.frontmatter.archived !== expectedArchived) {
          throw conflict(
            "Project lifecycle changed while this request was in progress. Refresh and try again.",
          );
        }
        const currentAuthority = requireCurrentProjectAdmin(
          db,
          parsed,
          actor,
          "archive this project",
        );
        committedProjectName = currentAuthority.projectName;
        committedAuthoritySource = currentAuthority.authoritySource;
        lifecycleIntent = stageProjectLifecycleIntent(db, {
          projectSlug: input.projectSlug,
          operation: "archive",
          expectedArchived,
          targetArchived: true,
          projectName: committedProjectName,
          actorUserId: actor.userId,
          actorLabel: actor.label,
          authoritySource: committedAuthoritySource,
          stoppedRuns,
          cancelledDispatches,
          cancelledPendingTriggers,
        });
        ctx.afterProjectLifecycleIntentStagedForTests?.("archive");
        parsed.unknownFrontmatter[PROJECT_LIFECYCLE_INTENT_MARKER] =
          lifecycleIntent.id;
        parsed.frontmatter.archived = true;
      });
      // Canonical archived truth is the recovery authority. Only now may old
      // replayable specialist/operator effects be permanently abandoned.
      completeProjectRunEffects(db, input.projectSlug);
    } catch (error) {
      if (providerShutdownStarted && !safeToReopen) {
        reopenCompletionAdmissionAfterTermination(
          db,
          ctx,
          input.projectSlug,
          revocation,
        );
      } else {
        reopenCompletionAdmissionIfActive(
          db,
          ctx,
          input.projectSlug,
          revocation,
        );
      }
      throw error;
    }
  } else {
    await ctx.beforeProjectLifecycleCommitHookForTests?.("restore");
    await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
      if (parsed.frontmatter.archived !== expectedArchived) {
        throw conflict(
          "Project lifecycle changed while this request was in progress. Refresh and try again.",
        );
      }
      const currentAuthority = requireCurrentProjectAdmin(
        db,
        parsed,
        actor,
        "restore this project",
      );
      committedProjectName = currentAuthority.projectName;
      committedAuthoritySource = currentAuthority.authoritySource;
      lifecycleIntent = stageProjectLifecycleIntent(db, {
        projectSlug: input.projectSlug,
        operation: "restore",
        expectedArchived,
        targetArchived: false,
        projectName: committedProjectName,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        authoritySource: committedAuthoritySource,
        stoppedRuns,
        cancelledDispatches,
        cancelledPendingTriggers,
      });
      ctx.afterProjectLifecycleIntentStagedForTests?.("restore");
      parsed.unknownFrontmatter[PROJECT_LIFECYCLE_INTENT_MARKER] =
        lifecycleIntent.id;
      parsed.frontmatter.archived = false;
    });
    // Canonical active state is the admission authority. Reopen immediately;
    // projection/audit are convergent side effects and a failure between the
    // file write and either one must not leave an active project disabled.
    allowProjectCompletionEffects(db, input.projectSlug);
  }

  if (!lifecycleIntent) {
    throw new Error("Project lifecycle committed without a durable intent.");
  }
  const converged = convergeProjectLifecycleIntent(db, lifecycleIntent, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    ...(ctx.reprojectHookForTests
      ? { beforeProjectionForTests: ctx.reprojectHookForTests }
      : {}),
  });
  if (converged !== "completed") {
    throw conflict(
      "Project lifecycle evidence changed before it could be finalized. Refresh and try again.",
    );
  }
  return {
    toast: input.archived
      ? `Project "${committedProjectName}" archived read-only — ${stoppedRuns} active ${stoppedRuns === 1 ? "run" : "runs"} stopped`
      : `Project "${committedProjectName}" restored`,
    archived: input.archived,
  };
}

/**
 * Delete project (spec §5.6): destructive, typed-name confirmation
 * required, admin-only. Removes the project directory (project.md + every
 * task file), then purges every project-keyed operational row and runtime log.
 * The deletion fact remains in the organization audit, but is intentionally
 * not scoped to the deleted slug so a future project cannot inherit it.
 */
export function deleteProject(
  db: Database.Database,
  input: { projectSlug: string; confirmName: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  return withProjectLifecycleLock(db, input.projectSlug, () =>
    deleteProjectOwned(db, input, actor, ctx),
  );
}

async function deleteProjectOwned(
  db: Database.Database,
  input: { projectSlug: string; confirmName: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext,
): Promise<{ toast: string }> {
  const { projectName, authoritySource } = requireProjectAdmin(
    db,
    ctx,
    input.projectSlug,
    actor,
    "delete this project",
  );
  if (input.confirmName.trim() !== projectName) {
    throw AppError.validation("Type the project name to confirm deletion.");
  }
  const canonicalProjectPath = projectFilePath(input.projectSlug, ctx.dataRoot);

  // Cancel live handles and queued completion effects before removing the
  // canonical directory. purgeProjectOperationalState repeats this
  // idempotently after the projection rebuild and deletes the durable rows.
  const revocation = revokeProjectCompletionEffects(db, input.projectSlug);
  let providerShutdownStarted = false;
  let safeToReopen = false;
  let deletionTombstone: ProjectDeletionTombstone | null = null;
  let committedProjectName = projectName;
  let committedAuthoritySource = authoritySource;
  try {
    await ctx.lifecycleDrainHookForTests?.("delete");
    providerShutdownStarted = true;
    clearOperatorLeasesForProject(input.projectSlug);
    cancelAutoOperatorDispatchesForProject(db, input.projectSlug, ctx.dataRoot);
    cancelPendingOperatorTriggersForProject(db, input.projectSlug);
    stopProjectRuns(db, input.projectSlug);
    const terminated = await waitForProjectRunTermination(
      db,
      input.projectSlug,
      ctx.lifecycleTerminationTimeoutMsForTests,
    );
    if (!terminated) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        userMessage:
          "Agent shutdown is still in progress. Retry project deletion shortly.",
        kind: "user",
      });
    }
    await waitForProjectCompletionEffects(db, input.projectSlug);
    safeToReopen = true;
    await ctx.beforeProjectLifecycleCommitHookForTests?.("delete");

    // Hold the same mutex used by every project.md writer across the final
    // authority/name check and the atomic directory rename. No settings write
    // can slip between confirmation and the deletion commit point.
    await withFileLock(canonicalProjectPath, () => {
      const current = readProjectFile(projectRef(ctx, input.projectSlug));
      if (!current) {
        throw AppError.notFound(`Project ${input.projectSlug} not found.`);
      }
      const currentAuthority = requireCurrentProjectAdmin(
        db,
        current.parsed,
        actor,
        "delete this project",
      );
      if (input.confirmName.trim() !== currentAuthority.projectName) {
        throw AppError.validation(
          "Type the current project name to confirm deletion.",
        );
      }
      committedProjectName = currentAuthority.projectName;
      committedAuthoritySource = currentAuthority.authoritySource;
      deletionTombstone = stageProjectDeletion(db, {
        projectSlug: input.projectSlug,
        projectName: committedProjectName,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        authoritySource:
          committedAuthoritySource === "org_admin_override"
            ? committedAuthoritySource
            : null,
      });
      commitProjectDirectoryDeletion(deletionTombstone, ctx.dataRoot);
    });
    ctx.afterProjectRemovalHookForTests?.();
    const committedTombstone =
      deletionTombstone as ProjectDeletionTombstone | null;
    if (!committedTombstone) {
      throw new Error("Project deletion reached commit without a tombstone.");
    }
    completeProjectDeletion(db, committedTombstone, ctx.dataRoot);
  } catch (error) {
    const canonical = readProjectFile(projectRef(ctx, input.projectSlug));
    if (canonical && deletionTombstone) {
      cancelProjectDeletion(db, deletionTombstone);
    }
    if (providerShutdownStarted && !safeToReopen) {
      reopenCompletionAdmissionAfterTermination(
        db,
        ctx,
        input.projectSlug,
        revocation,
      );
    } else {
      reopenCompletionAdmissionIfActive(db, ctx, input.projectSlug, revocation);
    }
    throw error;
  }
  return { toast: `Project "${committedProjectName}" deleted` };
}
