import type Database from "better-sqlite3";
import type {
  PacketOption,
  ParsedTaskFile,
  TaskFileEvent,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import type { ProjectRole } from "~/schemas/project-file.schema";
import type { UserRole } from "~/shared/mapping/user.server";
import {
  authorizeProjectAction,
  type RbacAction,
  roleCan,
  rolesForAction,
} from "~/shared/rbac";
import type { OperatorAutonomy } from "./operator-actions.server";
import {
  compactTimelineEvents,
  DEFAULT_COMPACTION,
} from "./timeline-compaction.server";
import {
  resolveStageRoles,
  isTerminalStage,
  type StageRoles,
} from "~/shared/workflow/stage-roles";
import {
  recordAudit,
  withProjectAuditAuthority,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  resolveTaskFilePath,
  createTaskFile,
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  allocateTaskKey,
  readProjectFile,
} from "~/server/files/project-writer.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  createNotification,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import { projectRunsForTask } from "~/server/runtimes/run-projection.server";
import { getRun } from "~/server/runtimes/run-store.server";
import {
  isBackendAvailable,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import type { DeliveryPermissions } from "./specialist-tool-policy";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import {
  clearReviewEvidence,
  reviewEvidenceFingerprint,
} from "./review-evidence.server";

/**
 * Task mutations (Phase 3 server functions; Phase 4/5 route actions call
 * them). Every mutation follows the canonical order:
 *
 *   file write → incremental reproject → audit → notification fan-out
 *
 * RBAC is enforced HERE against project membership roles (contracts §3.2
 * grant table); callers only authenticate the session user. All identity
 * comparisons are by user id (ruling 6).
 */

export interface TaskActor {
  userId: string;
  /** Human-readable audit label, e.g. the email. */
  label: string;
  /** Authenticated organization role. Omitted internal/test actors are members. */
  orgRole?: UserRole;
}

export interface TaskMutationContext {
  /** Override the data root (tests). Defaults to env VIBERR_DATA_ROOT. */
  dataRoot?: string;
  /** Mock GitHub transport used by completion race tests. */
  githubFetchImpl?: typeof fetch;
  /**
   * Set by the operator runtime (operator-actions.server) when an action is
   * performed by the OPERATOR agent rather than a human. It bypasses the
   * human project-membership RBAC (operator authority is enforced upstream by
   * the operator's capability policy) and stamps operator actor/audit refs so
   * the timeline and audit trail attribute the action to the operator, not a
   * user. Never set from a route — only the in-process operator toolkit sets it.
   */
  operatorAuthorized?: boolean;
  /**
   * Set by the operator runtime for the duration of an operator run. Carries the
   * run's backend + autonomy + react-depth so that when an operator-triggered
   * agent replies, the reply-completion hook can RE-INVOKE the operator (trigger
   * `agent-reply`) to read the reply and propose the next state change: the
   * "prompt the agent, read its output, propose a state change" loop. The depth
   * bounds that re-invocation chain so it can never run away.
   */
  operatorRun?: {
    backend: RealBackend;
    autonomy: "supervised" | "full";
    reactDepth: number;
  };
}

/** Hard cap on the operator's react re-invocation chain (runaway backstop). */
const OPERATOR_REACT_DEPTH_CAP = 4;

/**
 * Whether an operator-triggered agent run should re-invoke the operator to
 * REACT to its reply. False when the run did not finish cleanly, produced no
 * report, merely REPEATED its previous reply (no progress — reacting again would
 * only spiral, the CTL-3 bug), or the react-depth cap is reached (an undefined
 * depth means there is no active operator run to continue). Pure — exported for
 * tests.
 */
export function operatorShouldReactToReply(
  finishedState: string,
  replyText: string | null,
  prevReply: string | null,
  reactDepth: number | undefined,
): boolean {
  if (finishedState !== "finished" || !replyText) return false;
  if (prevReply !== null && prevReply.trim() === replyText.trim()) return false;
  if (reactDepth === undefined || reactDepth >= OPERATOR_REACT_DEPTH_CAP)
    return false;
  return true;
}

/** Audit actor for operator-performed mutations (no human user id). */
export const OPERATOR_AUDIT_ACTOR = {
  userId: null,
  label: "operator",
} as const;

/** Placeholder TaskActor the operator toolkit threads through the shared
 *  mutations; its user id is never read once `operatorAuthorized` is set (the
 *  RBAC check is skipped and audit uses {@link OPERATOR_AUDIT_ACTOR}). */
export const OPERATOR_TASK_ACTOR: TaskActor = {
  userId: "operator",
  label: "operator",
};

// ---------------------------------------------------------------- helpers

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

interface ProjectContext {
  slug: string;
  repo: string | null;
  stages: { id: string; name: string }[];
  workflow: {
    from: string;
    to: string;
    boundary: "auto" | "approval" | "human";
  }[];
  memberRoles: Map<string, ProjectRole>;
}

function loadProjectContext(
  ctx: TaskMutationContext,
  projectSlug: string,
): ProjectContext {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const fm = file.parsed.frontmatter;
  return {
    slug: fm.slug,
    repo: fm.repo,
    stages: fm.stages.map((s) => ({ id: s.id, name: s.name })),
    workflow: fm.workflow.map((w) => ({
      from: w.from,
      to: w.to,
      boundary: w.boundary,
    })),
    memberRoles: new Map(fm.members.map((m) => [m.userId, m.role])),
  };
}

function stageName(project: ProjectContext, stageId: string): string {
  return project.stages.find((s) => s.id === stageId)?.name ?? stageId;
}

/** The four structural stage roles, resolved once from the workflow graph. */
function stageRolesOf(project: ProjectContext): StageRoles {
  return resolveStageRoles(project.stages, project.workflow);
}

/** The review stage id — the one with a governed edge into the final stage. */
function reviewStageIdOf(project: ProjectContext): string | null {
  return stageRolesOf(project).reviewId;
}

/** The terminal (Done-equivalent) stage id. */
function terminalStageIdOf(project: ProjectContext): string | null {
  return stageRolesOf(project).terminalId;
}

/**
 * Route-level project-membership guard. Use in loaders/actions of project-scoped
 * config surfaces (policy / agents / settings / github) and instance-wide
 * triggers reached from a project (board rescan). Throws 404 for an unknown
 * project and 403 when the actor isn't a member (or lacks the required role).
 * Returns the actor's role. Reads the canonical project.md fresh every call
 * (no session caching), consistent with every other governed mutation.
 */
export function requireProjectRole(
  projectSlug: string,
  actor: TaskActor,
  allowed: ProjectRole[] | "any-member",
  what: string,
  ctx: TaskMutationContext = {},
): ProjectRole {
  return requireProjectRoleAuthority(projectSlug, actor, allowed, what, ctx)
    .role;
}

/** Same route-level guard, retaining the authorization source for audit flow. */
export function requireProjectRoleAuthority(
  projectSlug: string,
  actor: TaskActor,
  allowed: ProjectRole[] | "any-member",
  what: string,
  ctx: TaskMutationContext = {},
): {
  role: ProjectRole;
  authoritySource: "project_role" | "org_admin_override";
} {
  const project = loadProjectContext(ctx, projectSlug);
  const role = project.memberRoles.get(actor.userId);
  const explicitlyAllowed =
    role !== undefined && (allowed === "any-member" || allowed.includes(role));
  if (explicitlyAllowed) {
    return { role, authoritySource: "project_role" };
  }
  if (actor.orgRole === "admin") {
    return { role: "admin", authoritySource: "org_admin_override" };
  }
  if (!role) throw forbidden(`Only project members can ${what}.`);
  throw forbidden(`Your project role (${role}) cannot ${what}.`);
}

/** The operator's canonical notification actor. */
const OPERATOR_NOTIFY_FROM: ActorRender = { kind: "agent", name: "Operator" };

export interface TaskWatcherNotice {
  projectSlug: string;
  taskKey: string;
  kind: NotificationKind;
  ptype?: "input" | "blocked" | null;
  title?: string | null;
  text: string;
  from?: ActorRender | null;
  occurredAt?: string;
  /** Skip this user (e.g. the human who triggered the event). */
  exceptUserId?: string;
}

/**
 * Fan a governance event out to the humans who supervise a task: its owner (if
 * any) plus the project's admins and maintainers — the people entitled to act
 * on it. This is what turns a waiting-on-human task into a real "Waiting on you"
 * inbox item + bell increment, instead of a state a supervisor must discover by
 * scanning the board (FR26, Journey 2, and the "blocked tasks reach a human
 * decision quickly" success metric). Recipients are deduped and the triggering
 * user is skipped. Returns the user ids that were ACTUALLY notified — each
 * recipient's routing prefs are honored inside createNotification, so a
 * supervisor who silenced this category is dropped from the result. Never
 * throws on a missing task/project — a notification failure must not fail the
 * governed mutation.
 */
export function notifyTaskWatchers(
  db: Database.Database,
  notice: TaskWatcherNotice,
  ctx: TaskMutationContext = {},
): string[] {
  let recipients: Set<string>;
  try {
    const project = loadProjectContext(ctx, notice.projectSlug);
    recipients = new Set(
      [...project.memberRoles.entries()]
        .filter(([, role]) => role === "admin" || role === "maintainer")
        .map(([userId]) => userId),
    );
    const owner = readTaskFile(taskRef(ctx, notice.projectSlug, notice.taskKey))
      ?.parsed.frontmatter.ownerUserId;
    if (owner && roleCan(project.memberRoles.get(owner), "own-task")) {
      recipients.add(owner);
    }
  } catch (error) {
    // A corrupt project/task file (or context load failure) must NOT silently
    // notify nobody of a real governance event — log it so the blind spot is
    // diagnosable instead of an undiagnosable "no one got the alert".
    logger.error("notifyTaskWatchers: recipient resolution failed", {
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
      kind: notice.kind,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return [];
  }
  if (notice.exceptUserId) recipients.delete(notice.exceptUserId);

  const notified: string[] = [];
  for (const userId of recipients) {
    // createNotification consults this recipient's routing prefs and returns
    // null when they've silenced this category — only count real deliveries.
    const id = createNotification(db, {
      userId,
      kind: notice.kind,
      ptype: notice.ptype ?? null,
      title: notice.title ?? null,
      text: notice.text,
      from: notice.from ?? OPERATOR_NOTIFY_FROM,
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
      ...(notice.occurredAt ? { occurredAt: notice.occurredAt } : {}),
    });
    if (id) notified.push(userId);
  }
  return notified;
}

function requireMemberRole(
  project: ProjectContext,
  actor: TaskActor,
  allowed: ProjectRole[] | "any-member",
  what: string,
): ProjectRole {
  const role = project.memberRoles.get(actor.userId);
  if (actor.orgRole === "admin") return role ?? "admin";
  if (!role) {
    throw forbidden(`Only project members can ${what}.`);
  }
  if (allowed !== "any-member" && !allowed.includes(role)) {
    throw forbidden(`Your project role (${role}) cannot ${what}.`);
  }
  return role;
}

/**
 * THE canonical project-role guard: resolves the actor's role and checks it
 * against the single-source `ACTION_ROLES` map (app/shared/rbac.ts) — the same
 * object the Policy page renders. Every governed project mutation names its
 * `RbacAction` here instead of hard-coding a role list, so enforcement and
 * display can never drift. Returns the actor's role for downstream branching.
 */
export function requireAction(
  project: ProjectContext,
  actor: TaskActor,
  action: RbacAction,
  what: string,
): ProjectRole {
  const role = project.memberRoles.get(actor.userId) ?? null;
  const authority = authorizeProjectAction(role, actor.orgRole, action);
  if (!authority.allowed) {
    return requireMemberRole(project, actor, [...rolesForAction(action)], what);
  }
  return authority.source === "org_admin_override"
    ? "admin"
    : authority.projectRole!;
}

function authorityAuditActor(
  project: ProjectContext,
  actor: TaskActor,
  action: RbacAction,
): AuditActor {
  const authority = authorizeProjectAction(
    project.memberRoles.get(actor.userId) ?? null,
    actor.orgRole,
    action,
  );
  return authority.source === "org_admin_override"
    ? withProjectAuditAuthority(actor, authority.source)
    : actor;
}

type CompletionAuthoritySource =
  "project_role" | "task_owner" | "org_admin_override";

function requireCompletionAuthority(
  project: ProjectContext,
  task: { frontmatter: TaskFrontmatter },
  actor: TaskActor,
): CompletionAuthoritySource {
  const role = project.memberRoles.get(actor.userId) ?? null;
  if (roleCan(role, "accept-completion")) return "project_role";
  if (
    task.frontmatter.ownerUserId === actor.userId &&
    roleCan(role, "own-task")
  ) {
    return "task_owner";
  }
  if (actor.orgRole === "admin") return "org_admin_override";
  requireAction(
    project,
    actor,
    "accept-completion",
    "accept completion into Done",
  );
  return "project_role";
}

function userName(db: Database.Database, userId: string): string {
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId) as
    { name: string } | undefined;
  return row?.name ?? userId;
}

function humanActorRef(db: Database.Database, actor: TaskActor) {
  return {
    kind: "human" as const,
    userId: actor.userId,
    nameHint: userName(db, actor.userId),
  };
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
  };
}

/** file write already happened — reproject the task file incrementally. */
function reprojectTask(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

function summaryOrThrow(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): TaskSummary {
  const summary = getTaskSummary(db, projectSlug, taskKey);
  if (!summary) {
    throw AppError.internal(
      `Task ${projectSlug}/${taskKey} vanished after write.`,
    );
  }
  return summary;
}

// -------------------------------------------------------------- createTask

export const DEFAULT_GOAL = "Goal to be refined at the triage quality gate.";

export interface CreateTaskInput {
  projectSlug: string;
  title: string;
  goal?: string;
  /** Defaults to the first stage ("triage" in the default template). */
  stageId?: string;
  urgent?: boolean;
}

/**
 * Board "New task" flow: allocates the next `<PREFIX>-<n>` key atomically
 * from the per-project counter in project.md, writes the task file with the
 * mock create defaults, reprojects, audits.
 * RBAC: any project member except viewers (board spec §5.1).
 */
export async function createTask(
  db: Database.Database,
  input: CreateTaskInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{
  key: string;
  task: TaskSummary;
  stageName: string;
  operatorTrigger: "queued" | "awaiting_input" | "not_deployed" | "coalesced";
}> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(project, actor, "create-task", "create tasks");

  const title = input.title.trim();
  if (title.length < 3) {
    throw AppError.validation("A title of at least 3 characters is required.");
  }
  const stageId = input.stageId ?? project.stages[0]?.id ?? "triage";
  const stage = project.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw AppError.validation(
      `Stage ${stageId} does not exist in this project.`,
    );
  }
  const doneStageId = project.stages[project.stages.length - 1]?.id;
  if (stageId === doneStageId) {
    throw AppError.validation("New tasks cannot be created in the done stage.");
  }

  const projectRef = {
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
  const key = await allocateTaskKey(projectRef);
  const now = new Date().toISOString();

  const frontmatter: TaskFrontmatter = {
    key,
    title,
    stage: stageId,
    readiness: "input_required",
    waiting: "human",
    ownerUserId: null,
    specialist: null,
    reviewers: [],
    reviewerVerdicts: [],
    recommendations: [],
    // Operator assigned unless the task starts in triage (contracts §1.1).
    operator:
      stageId === project.stages[0]?.id ? null : { assignedAtStageId: stageId },
    urgent: input.urgent ?? false,
    validation: "none",
    branch: null,
    repo: null,
    pr: null,
    github: null,
    createdAt: now,
    updatedAt: now,
    boardRank: null,
  };

  await createTaskFile(taskRef(ctx, input.projectSlug, key), {
    frontmatter,
    goal: input.goal?.trim() || DEFAULT_GOAL,
  });

  // project.md changed too (counter bump) — reproject both.
  rebuildPath(db, projectFilePath(input.projectSlug, ctx.dataRoot), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  reprojectTask(db, ctx, input.projectSlug, key);

  recordAudit(db, {
    action: "task.created",
    actor: authorityAuditActor(project, actor, "create-task"),
    subjectKind: "task",
    subjectId: key,
    projectSlug: input.projectSlug,
    taskKey: key,
    details: { title, stage: stageId },
  });

  // Creation enqueues a visible, bounded Triage assessment instead of
  // launching an unbounded paid run per task. A placeholder goal is cheaper and
  // safer to stop deterministically: it stays input-required until a human
  // supplies concrete intent. Enqueueing is awaited, execution is not.
  const operatorTrigger = await autoInvokeOperator(
    db,
    ctx,
    input.projectSlug,
    key,
    "create",
  );

  return {
    key,
    task: summaryOrThrow(db, input.projectSlug, key),
    stageName: stage.name,
    operatorTrigger,
  };
}

/**
 * Edit a task's Goal / acceptance criteria (X11) — the canonical `## Goal`
 * body every agent re-anchors on. Previously nothing in the app could change
 * the goal after creation, so an @mention couldn't add acceptance criteria (the
 * agent re-reads the canonical goal and ignores comment-only criteria). RBAC:
 * admin|maintainer (it steers all downstream agent work). A `policy` timeline
 * event records the change so the edit is auditable on the task itself; the
 * operator is re-engaged so it re-reads the new goal.
 */
export async function updateTaskGoal(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; goal: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(project, actor, "update-goal", "edit the task goal");
  const goal = input.goal.trim();
  if (goal.length < 3) {
    throw AppError.validation("A goal of at least 3 characters is required.");
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (existing.parsed.goal.trim() === goal) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
  }

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.goal = goal;
      clearReviewEvidence(parsed, reviewStageIdOf(project));
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "policy",
        actor: humanActorRef(db, actor),
        title: "Goal updated",
        text: "The task goal / acceptance criteria were edited — downstream agents re-anchor on the new goal.",
        toAgent: false,
        evidence: null,
      });
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.goal.updated",
    actor: authorityAuditActor(project, actor, "update-goal"),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {},
  });
  // Re-engage the operator so it reads the amended goal on its next turn.
  void autoInvokeOperator(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    "transition",
  );

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
}

/**
 * Auto-invoke the operator to start coordinating a freshly-created task under
 * its deployed capability policy + autonomy (ADR-002 — one operator per active
 * task). Best-effort and non-blocking:
 *   - skipped when the project has no operator deployed (returns immediately,
 *     so a project without an operator behaves exactly as before);
 *   - a runtime failure is logged and never propagates to the create.
 * Dynamically imported to avoid a module cycle (operator-run → operator-actions
 * → task-actions).
 */
async function autoInvokeOperator(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  trigger: "create" | "transition",
): Promise<"queued" | "awaiting_input" | "not_deployed" | "coalesced"> {
  try {
    if (!db.open) return "coalesced";
    const { resolveOperatorAuthority } =
      await import("./operator-actions.server");
    if (!db.open) return "coalesced";
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    if (!authority.deployed) return "not_deployed";

    const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (
      trigger === "create" &&
      (!task || task.parsed.goal.trim() === DEFAULT_GOAL)
    ) {
      if (task) {
        await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
          parsed.timeline.unshift({
            occurredAt: new Date().toISOString(),
            type: "quality",
            actor: { kind: "operator" },
            title: null,
            text: "**Automatic Triage paused:** the goal is still a placeholder. Add a concrete outcome and verification boundary, then run the operator; no paid agent turn was started.",
            toAgent: false,
            evidence: null,
          });
        });
        if (!db.open) return "coalesced";
        reprojectTask(db, ctx, projectSlug, taskKey);
      }
      recordAudit(db, {
        action: "task.operator.auto_skipped_missing_intent",
        actor: OPERATOR_AUDIT_ACTOR,
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: { trigger },
      });
      return "awaiting_input";
    }

    const { enqueueAutoOperator } =
      await import("~/server/runtimes/operator-dispatch.server");
    if (!db.open) return "coalesced";
    const queued = enqueueAutoOperator(db, {
      projectSlug,
      taskKey,
      trigger,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    return queued.queued ? "queued" : "coalesced";
  } catch (error) {
    if (!db.open) return "coalesced";
    logger.error("auto operator invocation failed", {
      taskKey,
      trigger,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return "coalesced";
  }
}

// ------------------------------------------------------------ appendComment

/** Mock routing rule (task-detail §5.1): mentions of these handles route
 * the comment to the agent side (`to: agent` tint). */
const AGENT_HANDLE_RE = /@(agent|operator|codex|claude)\b/i;
const MENTION_RE = /@([A-Za-z][\w-]*)/g;
const RESERVED_HANDLES = new Set(["agent", "operator", "codex", "claude"]);

export interface AppendCommentResult {
  task: TaskSummary;
  toAgent: boolean;
  mentionedUserIds: string[];
}

/**
 * App-wide commenting: EVERY registered user may comment, including
 * non-members (they render with the guest pill). @mentions fan out
 * `mention` notifications to resolved users (by email local-part or first
 * name, case-insensitive); agent handles route the comment to the operator.
 */
export async function appendComment(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    text: string;
    /** Force the routed-to-agent tint (commentToAgent sets this when a named
     *  agent like `@dev` is mentioned — the reserved-handle regex alone would
     *  miss profile-name mentions). */
    forceToAgent?: boolean;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AppendCommentResult> {
  const text = input.text.trim();
  if (!text) throw AppError.validation("Comment text is required.");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    throw AppError.notFound(`Task ${input.taskKey} not found.`);
  }

  const toAgent = input.forceToAgent === true || AGENT_HANDLE_RE.test(text);
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent,
    evidence: null,
  };

  // Timeline compaction fires on HUMAN comments too — a comment flood used to
  // never compact because compaction only ran inside operator writes.
  const { guardrailOn, guardrailValue } =
    await import("./comment-guardrails.server");
  const compactOn = guardrailOn(
    ctx,
    input.projectSlug,
    "compression-threshold",
  );
  const compactAt = guardrailValue(
    ctx,
    input.projectSlug,
    "compression-threshold",
  );
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(event);
      if (compactOn) {
        parsed.timeline = compactTimelineEvents(
          parsed.timeline,
          compactAt != null
            ? {
                threshold: compactAt,
                keepRecent: Math.min(
                  DEFAULT_COMPACTION.keepRecent,
                  Math.max(4, Math.floor(compactAt / 2)),
                ),
              }
            : DEFAULT_COMPACTION,
        );
      }
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.comment",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { toAgent },
  });

  // Mention fan-out (notification kind `mention`, contracts §4).
  const mentionedUserIds: string[] = [];
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1]!.toLowerCase();
    if (!RESERVED_HANDLES.has(handle)) handles.add(handle);
  }
  if (handles.size > 0) {
    const users = db
      .prepare(`SELECT id, email, name FROM users WHERE disabled = 0`)
      .all() as { id: string; email: string; name: string }[];
    const actorName = userName(db, actor.userId);
    for (const user of users) {
      if (user.id === actor.userId) continue;
      const local = user.email.split("@")[0]?.toLowerCase() ?? "";
      const first = user.name.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (handles.has(local) || handles.has(first)) {
        mentionedUserIds.push(user.id);
        createNotification(db, {
          userId: user.id,
          kind: "mention",
          text: `mentioned you — “${text}”`,
          from: {
            kind: "human",
            userId: actor.userId,
            name: actorName,
            initials: actorName
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase() ?? "")
              .join(""),
            tone:
              (
                db
                  .prepare(`SELECT avatar_tone FROM users WHERE id = ?`)
                  .get(actor.userId) as
                  { avatar_tone: string | null } | undefined
              )?.avatar_tone ?? "",
          },
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          occurredAt: event.occurredAt,
        });
      }
    }
  }

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    toAgent,
    mentionedUserIds,
  };
}

// ----------------------------------------------------------- commentToAgent

export interface CommentToAgentResult extends AppendCommentResult {
  /** The agent the comment @mentioned, or null when none was mentioned. */
  agent: { profileId: string; name: string; role: string } | null;
  /** How the mentioned agent was engaged (null when no agent was engaged). */
  triggered: "resumed" | "started" | null;
  /**
   * The Agent-logs selection id (a RunView.id — the grouped representative
   * thread) for the engaged agent's reply run, so the UI can auto-select and
   * stream it (BUG 3). Null when no run was triggered. Since the reply run is
   * the newest for that agent, it is the group representative → selecting this
   * shows its live output.
   */
  logThreadId: string | null;
  /**
   * True when an agent was mentioned but the commenter lacks the runtime role
   * (admin|maintainer) — the comment is recorded, the run is NOT triggered.
   * The route can toast about this; we never throw for a well-formed comment.
   */
  runtimeDenied: boolean;
}

/**
 * App-wide commenting that ALSO resumes a mentioned agent's provider session
 * and posts the agent's reply back into the timeline as an agent-authored
 * comment (the "comment → resume that agent → reply as a comment" flow).
 *
 * Behavior:
 *  1. Always append the comment (existing `appendComment` behavior, `toAgent`
 *     when an agent handle is present). Non-agent comments behave exactly as
 *     before — this is a superset of `appendComment`.
 *  2. Resolve the @mentioned agent on the task (name/backend/role/generic).
 *     No agent mentioned → returns like `appendComment` with `agent: null`.
 *  3. RBAC: triggering a run is a runtime action — admin|maintainer only
 *     (mirrors specialist runs). A viewer/reviewer @mention still RECORDS the
 *     comment but does NOT trigger the run (`runtimeDenied: true`, no throw).
 *  4. If the agent has a prior session → RESUME it (reuse its clone workdir).
 *     If it has no prior session → start a FRESH specialist run (first-mention
 *     fallback so the agent still replies). Autonomous either way.
 *  5. Register a completion callback: when the run finishes, extract the final
 *     assistant text and append it as an AGENT-authored `comment` event
 *     (actor = the agent's actorRef, NOT toAgent) → reproject → SSE.
 */
export async function commentToAgent(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; text: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<CommentToAgentResult> {
  // Resolve the mentioned agent FIRST (dynamic import avoids a module cycle:
  // agent-reply → specialist-run → task-actions). We need it before appending
  // so a named mention like `@dev` still flags the comment as routed-to-agent
  // (AGENT_HANDLE_RE alone only matches the reserved backend/role handles).
  const { resolveMentionedAgent, resumeWorkdir, buildReplyScript } =
    await import("./agent-reply.server");
  const target = resolveMentionedAgent(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    input.text,
  );

  // 1. Record the comment (existing behavior, incl. mention fan-out). Flag
  //    the routed tint when an agent was resolved.
  const base = await appendComment(
    db,
    { ...input, ...(target ? { forceToAgent: true } : {}) },
    actor,
    ctx,
  );

  if (!target) {
    return {
      ...base,
      agent: null,
      triggered: null,
      logThreadId: null,
      runtimeDenied: false,
    };
  }

  const agentIdentity = {
    profileId: target.profileId,
    name: target.name,
    role: target.role,
  };

  // 3. RBAC: only admin|maintainer trigger runtime work. A lower role still
  //    got their comment recorded above — just skip the run (no throw).
  const runtimeActor = authorizedRuntimeActor(ctx, input.projectSlug, actor);
  if (!runtimeActor) {
    return {
      ...base,
      agent: agentIdentity,
      triggered: null,
      logThreadId: null,
      runtimeDenied: true,
    };
  }

  // 3b. `@operator` → run the OPERATOR (a governed run), not a specialist. The
  //     human's comment is already on the timeline (appended above), so the
  //     operator reads it in its snapshot; it is also passed as the run's human
  //     directive. The operator responds via its own comments during the run.
  if (target.isOperator) {
    const { runOperator } =
      await import("~/server/runtimes/operator-run.server");
    const result = await runOperator(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      trigger: "manual",
      humanComment: input.text.trim(),
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      actor: runtimeActor,
    });
    const logThreadId = resolveReplyLogThread(
      db,
      input.projectSlug,
      input.taskKey,
      result.runId,
    );
    return {
      ...base,
      agent: agentIdentity,
      triggered: "started",
      logThreadId,
      runtimeDenied: false,
    };
  }

  const commenterName = userName(db, actor.userId);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  const title = existing?.parsed.frontmatter.title ?? input.taskKey;
  const repo =
    existing?.parsed.frontmatter.repo ?? projectRepoFor(ctx, input.projectSlug);

  // The follow-up prompt built from the comment (autonomous reply).
  const followUp =
    `A human (${commenterName}) commented on task ${input.taskKey} ("${title}"): ` +
    `"${input.text.trim()}". Respond to their comment directly. Continue or ` +
    `adjust your work on the repository in your working directory as needed. ` +
    `Commit completed changes locally, but do not push, run gh, or open a PR; ` +
    `Viberr finalizes authenticated remote delivery. Then give a concise reply.`;

  const { resumeRun } = await import("~/server/runtimes/run-service.server");

  let runId: string;
  let triggered: "resumed" | "started";
  let resumedWorkdir: string | null = null;
  let resumedDelivery: DeliveryPermissions | undefined;

  if (target.session) {
    // 4a. Resume the agent's existing provider session, reusing the clone
    //     workdir so it keeps its repo context.
    const sessionBackend: RealBackend =
      target.session.backend === "codex" ? "codex" : "claude";
    const specialistRuntime = await import("./specialist-run.server");
    const workdir = isBackendAvailable(sessionBackend)
      ? await specialistRuntime.requireSpecialistWorkspace(db, ctx, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          role: target.role,
          ...(!target.isPrimary
            ? { workspaceKey: `reviewer-${target.profileId}` }
            : {}),
        })
      : resumeWorkdir(
          input.projectSlug,
          input.taskKey,
          repo,
          ctx.dataRoot,
          !target.isPrimary ? `reviewer-${target.profileId}` : undefined,
        );
    const script = buildReplyScript(
      target.session.backend === "codex" ? "codex" : "claude",
      target.model,
    );
    // Re-establish the specialist's run confinement — denylist, git ceiling,
    // MCP set, persona — that the fresh-run path applies. Without this a
    // resumed (@mention) specialist runs unconfined (XS-1).
    const confinement = specialistRuntime.resolveResumeConfinement(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: target.profileId,
    });
    resumedWorkdir = workdir;
    resumedDelivery = confinement.delivery;
    const resumed = await resumeRun(db, {
      runId: target.session.id,
      prompt: followUp,
      workdir,
      disallowedTools: confinement.disallowedTools,
      env: confinement.env,
      ...(confinement.mcpServers ? { mcpServers: confinement.mcpServers } : {}),
      ...(confinement.systemPrompt
        ? { systemPrompt: confinement.systemPrompt }
        : {}),
      // Apply the agent's CURRENT profile model/effort on resume — not the
      // stale value on the prior run row (editing an agent to a new model
      // must take effect when its session is resumed via a comment).
      model: target.model,
      ...(target.effort ? { effort: target.effort } : {}),
      // Stamp the agent's identity so the reply run groups under (and labels)
      // the agent's own Agent-logs entry ("dev"), even when resuming a seeded
      // session row that predates the identity columns.
      agentName: target.name,
      agentProfileId: target.profileId,
      autonomous: true,
      script,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      actor: runtimeActor,
    });
    runId = resumed.runId;
    triggered = "resumed";
  } else {
    // 4b. No prior session for THIS agent — start a FRESH run, routed by how
    //     the agent is engaged so a reviewer mention never clobbers the
    //     primary specialist (the bug where `@reviewer` ran as / answered as
    //     the dev):
    //       · the primary — or the FIRST agent on a task with no primary yet —
    //         is assigned as the primary specialist and run as primary;
    //       · anyone else is engaged as a reviewer (idempotent) and run as a
    //         reviewer on its own thread.
    const hasPrimary = !!existing?.parsed.frontmatter.specialist;
    if (target.isPrimary || !hasPrimary) {
      const { assignSpecialist, startSpecialistRun } =
        await import("./specialist-run.server");
      if (!hasPrimary) {
        await assignSpecialist(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            profileId: target.profileId,
          },
          runtimeActor,
          ctx,
        );
      }
      const started = await startSpecialistRun(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        runtimeActor,
        ctx,
      );
      runId = started.runId;
    } else {
      const { assignReviewer, startReviewerRun } =
        await import("./specialist-run.server");
      // Engage as a reviewer if not already (idempotent), then run as reviewer.
      await assignReviewer(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          profileId: target.profileId,
        },
        runtimeActor,
        ctx,
      );
      const started = await startReviewerRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          profileId: target.profileId,
        },
        runtimeActor,
        ctx,
      );
      runId = started.runId;
    }
    triggered = "started";
  }

  // 5. Install THE canonical completion handler (reply → reconcile → verdict →
  //    react). A FRESH run's start fn (startSpecialistRun/startReviewerRun)
  //    already registered it with the real workspace dir; a RESUMED session
  //    (resumeRun ran no start fn) registers it here. An @mention carries no
  //    operator run in ctx, so completion begins a FRESH react chain against the
  //    deployed operator — the reviewer's verdict is recorded and the operator
  //    reads the reply and proposes the next step (fixes the old bug where an
  //    @mention dropped the verdict/reconcile and never re-engaged the operator).
  if (triggered === "resumed") {
    await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);
    await registerAgentCompletion(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId,
      backend: target.session?.backend === "codex" ? "codex" : "claude",
      role: target.role,
      kind: target.isPrimary ? "primary" : "reviewer",
      profileId: target.profileId,
      workdir: resumedWorkdir,
      ...(resumedDelivery ? { delivery: resumedDelivery } : {}),
      agentHandle: target.name.toLowerCase(),
      ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
    });
  }

  // BUG 3: the Agent-logs selection id for the reply run's grouped entry. The
  // reply run is the NEWEST for this agent → the group representative, so its
  // group's RunView.id is the thread the UI should auto-select + stream. Look
  // it up from the freshly-projected grouped list (best-effort — a projection
  // hiccup just yields null and the UI simply doesn't auto-select).
  const logThreadId = resolveReplyLogThread(
    db,
    input.projectSlug,
    input.taskKey,
    runId,
  );

  return {
    ...base,
    agent: agentIdentity,
    triggered,
    logThreadId,
    runtimeDenied: false,
  };
}

/**
 * The grouped RunView.id (Agent-logs selection key) that the just-started reply
 * `runId` will appear under. Finds the grouped run whose representative is this
 * run's DB id; falls back to the run's own thread id, then null.
 */
function resolveReplyLogThread(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  runId: string,
): string | null {
  try {
    const runViews = projectRunsForTask(db, projectSlug, taskKey);
    const byRepresentative = runViews.find((r) => r.serverRunId === runId);
    if (byRepresentative) return byRepresentative.id;
    // Fallback: the run's own thread id (it may not yet be the representative
    // if a concurrent run is also running for the same agent).
    const row = getRun(db, runId);
    return row?.thread_id ?? null;
  } catch {
    return null;
  }
}

/** admin|maintainer against project membership (runtime-action gate). */
function authorizedRuntimeActor(
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
): TaskActor | null {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const role = file?.parsed.frontmatter.members.find(
    (m) => m.userId === actor.userId,
  )?.role;
  const authority = authorizeProjectAction(role, actor.orgRole, "run-agents");
  if (!authority.allowed) return null;
  return authority.source === "org_admin_override"
    ? withProjectAuditAuthority(actor, authority.source)
    : actor;
}

function projectRepoFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): string | null {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return file?.parsed.frontmatter.repo ?? null;
}

/**
 * Append the agent's reply as an agent-authored `comment` timeline event
 * (actor = the agent's actorRef, type "comment", NOT toAgent) → reproject
 * (SSE rides the file write). Best-effort: a failure here is logged and
 * never propagated (the run already finished; the transcript is in the logs).
 * When the run produced no usable text, we skip posting a comment.
 */
export async function postAgentReplyComment(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    actorRef: FileActorRef;
    replyText: string | null;
  },
): Promise<void> {
  if (!input.replyText) {
    logger.info("agent reply run produced no text — no comment posted", {
      taskKey: input.taskKey,
      runId: input.runId,
    });
    return Promise.resolve();
  }
  // Anti-noise guardrails on AGENT replies (owner ruling Q3): trivial status
  // chatter is rejected before it reaches the canonical record, and raw output
  // dumps are trimmed to a head + reference (the full transcript stays in the
  // agent logs). Both per-project toggles.
  const { guardrailOn, isMeaninglessComment, separateEvidence } =
    await import("./comment-guardrails.server");
  if (
    guardrailOn(ctx, input.projectSlug, "meaningful-comment") &&
    isMeaninglessComment(input.replyText)
  ) {
    logger.info("agent reply dropped by the meaningful-comment guardrail", {
      taskKey: input.taskKey,
      runId: input.runId,
    });
    // Record the reply audit EVEN when dropping the comment (adversarial-review
    // #11) — boot recovery keys idempotency on the `task.agent.replied` audit
    // row, so without this a dropped-by-guardrail run would be reprocessed on
    // every restart (re-triggering the operator forever).
    recordAudit(db, {
      action: "task.agent.replied",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { runId: input.runId, droppedByGuardrail: "meaningful-comment" },
    });
    return Promise.resolve();
  }
  const separated = guardrailOn(ctx, input.projectSlug, "evidence-separation")
    ? separateEvidence(input.replyText)
    : input.replyText;
  // Honesty guard (PRD "process theater" risk): a report from a SIMULATED run is
  // fabricated (canned "done: implemented…" text with no real work). Mark it as
  // such in the canonical timeline — the run row already carries simulated=1, but
  // the timeline is the source of truth agents and humans re-anchor on, and an
  // unmarked fabricated "tests pass" is exactly the theater the PRD warns about.
  const simulated =
    (
      db
        .prepare(`SELECT simulated FROM agent_runs WHERE id = ?`)
        .get(input.runId) as { simulated: number } | undefined
    )?.simulated === 1;
  const replyText = simulated
    ? `_(simulated run — no real repository work was performed)_\n\n${separated}`
    : separated;
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: input.actorRef,
    title: null,
    text: replyText,
    toAgent: false,
    evidence: null,
  };
  // Returns the write promise so a caller (the operator react loop) can await
  // the reply landing before it re-reads the task; other callers ignore it
  // (fire-and-forget). Errors are logged, never propagated — the run already
  // finished and the transcript is in the logs.
  return updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(event);
    },
  )
    .then(() => {
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      recordAudit(db, {
        action: "task.agent.replied",
        actor: { userId: null, label: "operator" },
        subjectKind: "task",
        subjectId: input.taskKey,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        details: { runId: input.runId },
      });
    })
    .catch((error: unknown) => {
      logger.error("agent reply comment write failed", {
        taskKey: input.taskKey,
        runId: input.runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
}

// ------------------------------------------------------------ operatorPromptAgent

/**
 * Operator engages + PROMPTS an agent for the current stage: posts an
 * operator-authored comment that prompts the agent about the task (routed
 * to-agent, so the humans see the hand-off), triggers the agent's run with that
 * prompt woven in as its turn directive, and registers the agent's reply so its
 * response posts back as a comment. This is the mechanism the operator uses to
 * "hand the task to" the stage's specialist/reviewer when a task enters a new
 * stage — the operator triggers agents with a task-related prompt, not silently.
 *
 * Operator-only: it stamps operator authority (skips the human runtime RBAC on
 * the run) and attributes the prompt comment to the operator. The gating
 * (assign-primary-specialist / summon-reviewers) is applied by the callers in
 * operator-actions before they reach this direct-execution path.
 */
/**
 * The agent's most-recent reply comment text on a task (matched by backend +
 * role), or null when it has never replied. Used to detect a no-progress repeat
 * before re-inviting the operator to react.
 */
function latestAgentReplyText(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  backend: RealBackend,
  role: string,
): string | null {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) return null;
  for (const e of file.parsed.timeline) {
    if (
      e.type === "comment" &&
      e.actor.kind === "agent" &&
      e.actor.backend === backend &&
      e.actor.role === role
    ) {
      return e.text;
    }
  }
  return null;
}

/**
 * Deterministic stuck-loop escalation (E1): the react guard stopped the
 * prompt↔react chain (no-progress repeat or depth cap), so raise a BLOCKED
 * recovery packet with concrete options instead of leaving a silent stall.
 * Idempotent: a task with an open packet is left alone (the human already has
 * a decision in front of them). Falls back through the operator's own
 * system recovery path — infrastructure/loop failures are not optional
 * operator actions and therefore never depend on `generate-packets`.
 */
async function openStuckLoopPacket(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    agentHandle: string;
    reason: string;
  },
): Promise<void> {
  try {
    const existing = readTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
    );
    if (!existing || existing.parsed.packet) return; // already escalated
    const { openSystemRecovery } = await import("./task-recovery.server");
    const result = await openSystemRecovery(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        code: "coordination_stalled",
        title: `Work stalled — pick a recovery path`,
        body: `${input.reason} Coordination is paused until a human chooses how to proceed.`,
        observations: [
          { k: "Agent", v: `@${input.agentHandle}`, code: false },
          { k: "Signal", v: input.reason, code: false },
        ],
        options: [
          {
            kind: "redirect",
            t: "Redirect with sharper guidance",
            d: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
            rec: true,
          },
          {
            kind: "request_edit",
            t: "Send back for another attempt",
            d: "Ask the same specialist to try again from its last report.",
            rec: false,
          },
          {
            kind: "hold_runtime_debug",
            t: "Hold for runtime debugging",
            d: "Freeze coordination while the provider-native session is inspected.",
            rec: false,
          },
        ],
      },
      ctx,
    );
    if (!result.recorded) {
      logger.info("stuck-loop packet not opened", {
        taskKey: input.taskKey,
        reason: "already recorded or task missing",
      });
    }
  } catch (error) {
    logger.warn("stuck-loop packet escalation failed", {
      taskKey: input.taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

export interface StructuredReviewerVerdict {
  verdict: "request_changes" | "approve";
  summary: string;
}

/** Parse the one machine-readable reviewer contract. Ordinary prose never
 * becomes governance state, even if it contains words such as "approve" or
 * "fail". The marker must occupy one line and contain valid JSON. */
export function parseReviewerVerdict(
  text: string | null,
): StructuredReviewerVerdict | null {
  if (!text) return null;
  const matches = [
    ...text.matchAll(/^VIBERR_REVIEW_VERDICT:\s*(\{[^\r\n]*\})\s*$/gm),
  ];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(matches[0]![1]!) as Record<string, unknown>;
    if (
      (value.verdict !== "approve" && value.verdict !== "request_changes") ||
      typeof value.summary !== "string" ||
      !value.summary.trim()
    ) {
      return null;
    }
    return { verdict: value.verdict, summary: value.summary.trim() };
  } catch {
    return null;
  }
}

/** Compatibility-shaped pure helper used by governance callers/tests. It is
 * intentionally strict: only the structured marker above is classified. */
export function classifyReviewerVerdict(
  text: string | null,
): "request_changes" | "approve" | null {
  return parseReviewerVerdict(text)?.verdict ?? null;
}

/** Required reviewer profiles that do not currently have an explicit approval
 * in this review cycle. A request-changes verdict is therefore also missing an
 * approval until that same reviewer re-runs and approves. */
export function missingReviewerApprovalProfileIds(
  task: Pick<
    import("~/schemas/task-file.schema").ParsedTaskFile,
    "goal" | "frontmatter"
  >,
  projectRepo: string | null,
): string[] {
  const currentEvidence = reviewEvidenceFingerprint(task, projectRepo);
  const verdicts = new Map(
    task.frontmatter.reviewerVerdicts
      .filter((item) => item.evidenceFingerprint === currentEvidence)
      .map((item) => [item.profileId, item.verdict]),
  );
  return task.frontmatter.reviewers
    .map((reviewer) => reviewer.profileId)
    .filter((profileId) => verdicts.get(profileId) !== "approve");
}

/**
 * Emit a typed `quality` event from a reviewer's verdict and set the task's
 * validation health accordingly (FR15/FR24/FR35). A rejection fails validation
 * and returns the task to implementation. Approvals become healthy only after
 * every assigned reviewer approves in the current review cycle. Missing or
 * malformed structured output is surfaced and never counts as a verdict.
 *
 * A clear verdict ALSO fans a `quality` notification to the task's watchers
 * (owner + supervisors, routing-prefs honored — FIX #6): before this, the
 * quality inbox card only ever existed in seed data, so a real reviewer verdict
 * updated the timeline + board but never pinged the human who owns acceptance.
 * Exported for tests.
 */
/**
 * Rework evidence since the last rejection: scanning the newest-first timeline,
 * is there a primary-specialist agent reply or a stage `transition` NEWER than
 * the most recent failing `quality` event? (Reviewer-authored comments don't
 * count — a reviewer talking is not the developer fixing.) Used to decide
 * whether an approve may clear a standing `failing` validation. Pure — exported
 * for tests.
 *
 * `primary` (the task's assigned specialist {backend, role}) lets us match the
 * developer's reply by IDENTITY rather than a role-name regex (adversarial-
 * review #6/#14): a reviewer whose role string dodges the review/qa/test regex
 * would otherwise have its own reply counted as developer rework. When `primary`
 * is absent (or a reply's actor doesn't carry a backend to compare) we fall
 * back to the regex heuristic.
 */
export function hasReworkSinceLastRejection(
  timeline: readonly TaskFileEvent[],
  primary?: { backend: string; role: string } | null,
): boolean {
  for (const e of timeline) {
    // Newest-first walk: everything seen BEFORE the failing quality event is
    // newer than it.
    if (e.type === "quality" && /\*\*Validation:\*\* failing/.test(e.text)) {
      return false; // reached the rejection without seeing rework first
    }
    if (e.type === "transition") return true;
    if (e.type === "comment" && e.actor.kind === "agent") {
      const isPrimary = primary
        ? e.actor.backend === primary.backend && e.actor.role === primary.role
        : !/review|valid|qa|test/i.test(e.actor.role);
      if (isPrimary) return true; // a primary-specialist reply landed after the rejection
    }
  }
  // No failing quality event found at all — nothing to hold against the approve.
  return true;
}

export async function recordReviewerVerdict(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  input: {
    profileId: string;
    runId: string;
    replyText: string | null;
    simulated: boolean;
  },
): Promise<void> {
  // Simulated reports are useful UI demonstrations, never review evidence.
  if (input.simulated) return;
  const before = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (
    !before?.parsed.frontmatter.reviewers.some(
      (reviewer) => reviewer.profileId === input.profileId,
    )
  ) {
    return;
  }
  const structured = parseReviewerVerdict(input.replyText);
  const project = loadProjectContext(ctx, projectSlug);
  let validation: "changed" | "failing" | "healthy" = "changed";
  let title = "Structured verdict missing";
  let summary =
    "The reviewer run finished without VIBERR_REVIEW_VERDICT JSON, so it did not satisfy review.";
  let allRequiredApproved = false;
  let recorded = false;
  try {
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      const assigned = parsed.frontmatter.reviewers.some(
        (reviewer) => reviewer.profileId === input.profileId,
      );
      if (!assigned) return;
      recorded = true;

      // The latest completed real run is authoritative. Invalidate this
      // reviewer's previous result even when the new response is malformed;
      // otherwise an old approval could survive a newer unverifiable review.
      parsed.frontmatter.reviewerVerdicts =
        parsed.frontmatter.reviewerVerdicts.filter(
          (item) => item.profileId !== input.profileId,
        );
      if (structured) {
        parsed.frontmatter.reviewerVerdicts.push({
          profileId: input.profileId,
          verdict: structured.verdict,
          summary: structured.summary,
          runId: input.runId,
          reviewedAt: new Date().toISOString(),
          evidenceFingerprint: reviewEvidenceFingerprint(parsed, project.repo),
        });
        title =
          structured.verdict === "request_changes"
            ? "Changes requested"
            : "Reviewer approval recorded";
        summary = structured.summary;
      }

      const hasRejection = parsed.frontmatter.reviewerVerdicts.some(
        (item) =>
          parsed.frontmatter.reviewers.some(
            (reviewer) => reviewer.profileId === item.profileId,
          ) && item.verdict === "request_changes",
      );
      allRequiredApproved =
        parsed.frontmatter.reviewers.length > 0 &&
        missingReviewerApprovalProfileIds(parsed, project.repo).length === 0;
      const isReviewStage =
        parsed.frontmatter.stage === reviewStageIdOf(project);
      validation = hasRejection
        ? "failing"
        : allRequiredApproved && isReviewStage
          ? "healthy"
          : "changed";
      parsed.frontmatter.validation = validation;

      if (structured?.verdict === "request_changes") {
        const workStageId = stageRolesOf(project).workId;
        if (workStageId) parsed.frontmatter.stage = workStageId;
        parsed.frontmatter.waiting = "agent";
        parsed.frontmatter.readiness = "ready";
        parsed.frontmatter.recommendations =
          parsed.frontmatter.recommendations.filter(
            (item) =>
              item.kind !== "accept_completion" && item.kind !== "transition",
          );
        parsed.packet = null;
      }
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "quality",
        actor: { kind: "operator" },
        title,
        text: `**Validation:** ${validation}. ${summary}${
          structured?.verdict === "request_changes"
            ? " The task returned to implementation."
            : allRequiredApproved
              ? " All required reviewers approved."
              : " Waiting for every assigned reviewer to approve."
        }`,
        toAgent: false,
        evidence: null,
      });
    });
    if (!recorded) return;
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.quality.flagged",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {
        profileId: input.profileId,
        runId: input.runId,
        verdict: structured?.verdict ?? "missing",
        validation,
        allRequiredApproved,
      },
    });
    // Ping the owner + supervisors so the quality inbox card appears on real
    // runs (not just seed). Each recipient's `quality` routing pref is honored
    // inside notifyTaskWatchers → createNotification.
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "quality",
        title,
        text: summary,
      },
      ctx,
    );
  } catch (error) {
    logger.warn("reviewer verdict recording failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * THE single agent-run completion handler — installed by EVERY path that starts
 * or resumes a specialist/reviewer run (UI "Run", @mention, operator prompt,
 * boot recovery). `registerRunCompletion` is last-writer-wins, so a single
 * canonical hook prevents the old bug where the @mention path clobbered the
 * verdict + reconcile hook with a reply-only one. On completion it, in order:
 *
 *   1. posts the agent's reply as an agent-authored comment;
 *   2. reconciles agent-side GitHub delivery (branch/PR the agent opened with
 *      its own creds) into the canonical task file — real runs only;
 *   3. for a REVIEWER run, records the verdict (validation health + typed
 *      `quality` event + owner/supervisor notification) from the FULL reply;
 *   4. re-invokes the operator to READ the reply and propose the next state
 *      change — the "prompt → read → propose" loop — for EVERY completion, not
 *      just operator-initiated ones (a UI/@mention run starts a fresh react
 *      chain against the deployed operator). Bounded by the react-depth cap and
 *      the no-progress guard; a killed chain opens a BLOCKED recovery packet.
 *
 * `operatorRun` is set when this run was itself started inside an operator react
 * loop (so the chain continues at depth+1); absent for UI/@mention/recovery
 * (a fresh chain at depth 0). `waiting` is set to `agent` while the run is in
 * flight (by the start path) and cleared here when no further agent work
 * follows.
 */
export async function registerAgentCompletion(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    backend: RealBackend;
    role: string;
    kind: "primary" | "reviewer";
    /** Stable deployed profile identity; required for reviewer governance. */
    profileId?: string;
    workdir: string | null;
    delivery?: DeliveryPermissions;
    /** The agent's @mention handle, for the stuck-loop packet copy. */
    agentHandle: string;
    /** Present when started inside an operator react loop (continue the chain). */
    operatorRun?: {
      backend: RealBackend;
      autonomy: OperatorAutonomy;
      reactDepth: number;
    };
  },
): Promise<void> {
  const { registerRunCompletion } =
    await import("~/server/runtimes/run-service.server");
  registerRunCompletion(input.runId, (finished) => {
    void applyAgentCompletionEffects(db, ctx, input, {
      id: finished.id,
      state: finished.state,
      simulated: finished.simulated === 1,
    }).catch((error: unknown) => {
      if (!db.open) return;
      logger.error("agent-run completion handler failed", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  });
}

/**
 * The completion EFFECTS (reply → reconcile → verdict → react/stuck-packet/
 * waiting-flip) — shared by the live callback above and the boot-recovery
 * reconciler, so a run recovered after a restart behaves byte-for-byte like one
 * whose callback fired in-process.
 */
export async function applyAgentCompletionEffects(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    backend: RealBackend;
    role: string;
    kind: "primary" | "reviewer";
    profileId?: string;
    workdir: string | null;
    delivery?: DeliveryPermissions;
    agentHandle: string;
    operatorRun?: {
      backend: RealBackend;
      autonomy: OperatorAutonomy;
      reactDepth: number;
    };
  },
  finished: { id: string; state: string; simulated: boolean },
): Promise<void> {
  if (!db.open) return;
  const { replyTextForRun, fullReplyTextForRun } =
    await import("./agent-reply.server");
  if (!db.open) return;
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: input.backend,
    role: input.role,
  };
  const commentText = replyTextForRun(db, finished.id);
  const fullText = fullReplyTextForRun(db, finished.id);
  const prevReply = latestAgentReplyText(
    ctx,
    input.projectSlug,
    input.taskKey,
    input.backend,
    input.role,
  );
  // 1. Land the reply first so a reacting operator reads it in its snapshot.
  await postAgentReplyComment(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId: finished.id,
    actorRef,
    replyText: commentText,
  });
  if (!db.open) return;
  // 1b. A run that ENDED IN ERROR (backend quota/auth/crash) previously left NO
  //     trace on the timeline and never re-invoked the operator — the task just
  //     silently reverted to waiting=human (F8). Surface the failure as a typed
  //     event, escalate a recovery packet so it reaches a human's queue, and stop
  //     (no reconcile/verdict/react on a failed run). Interrupts are a deliberate
  //     human action and are handled elsewhere, so only `error` lands here.
  if (finished.state === "error" && !finished.simulated) {
    const { runFailureReason } = await import("./agent-reply.server");
    if (!db.open) return;
    const failure = runFailureReason(db, finished.id);
    const backendLabel = input.backend === "claude" ? "Claude Code" : "Codex";
    const roleLabel = input.kind === "reviewer" ? "reviewer" : "specialist";
    const reasonText =
      failure?.kind === "quota"
        ? `${backendLabel} is over its usage quota`
        : failure?.kind === "auth"
          ? `${backendLabel} rejected the credentials`
          : `the ${backendLabel} run ended in an error`;
    const { openSystemRecovery } = await import("./task-recovery.server");
    await openSystemRecovery(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        code: `agent_run_failed:${finished.id}`,
        title: `${input.role} ${roleLabel} run failed`,
        body: `The run did not complete — ${reasonText}. No changes were delivered. Retry on the other backend, fix the runtime credential, or redirect the task.`,
        observations: [
          { k: "Run", v: finished.id, code: true },
          { k: "Backend", v: backendLabel, code: false },
        ],
        notificationKind: "quality",
        notificationText: `${input.role} run failed — ${reasonText}.`,
      },
      ctx,
    );
    return;
  }
  // 2. Finalize delivery — real runs only. Fresh/resumed runs carry their
  // resolved permissions and use Viberr's server-owned authenticated push/PR
  // path. Boot-recovered legacy rows fall back to local reconciliation only.
  if (finished.state === "finished" && !finished.simulated) {
    if (input.delivery) {
      const { deliverSpecialistWorkspace } =
        await import("~/server/github/server-owned-delivery.server");
      const delivered = await deliverSpecialistWorkspace(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        workdir: input.workdir,
        backend: input.backend,
        role: input.role,
        permissions: input.delivery,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      });
      if (!db.open) return;
      if (delivered.status === "failed") {
        const { openSystemRecovery } = await import("./task-recovery.server");
        await openSystemRecovery(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            code: `delivery:${delivered.code}`,
            title: delivered.title,
            body: delivered.detail,
            observations: [
              { k: "Delivery", v: delivered.code, code: true },
              { k: "Run", v: finished.id, code: true },
            ],
          },
          ctx,
        );
        return;
      }
      if (delivered.status === "withheld") {
        const { reconcileWorkspaceDelivery } =
          await import("~/server/github/workspace-delivery.server");
        await reconcileWorkspaceDelivery({
          db,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          backend: input.backend,
          role: input.role,
          simulated: false,
          skipPrDetection: true,
          ...(input.workdir ? { workdir: input.workdir } : {}),
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        }).catch(() => {});
        if (!db.open) return;
      }
    } else {
      const { reconcileWorkspaceDelivery } =
        await import("~/server/github/workspace-delivery.server");
      await reconcileWorkspaceDelivery({
        db,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        backend: input.backend,
        role: input.role,
        simulated: false,
        ...(input.workdir ? { workdir: input.workdir } : {}),
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      }).catch(() => {});
      if (!db.open) return;
    }
  }
  // Any real primary completion begins a new evidence cycle. This matters for
  // repo-less work and for delivery paths whose live GitHub cache has not been
  // reconciled yet: an approval from before the specialist's latest turn may
  // never authorize completion after that turn.
  if (
    input.kind === "primary" &&
    finished.state === "finished" &&
    !finished.simulated
  ) {
    const project = loadProjectContext(ctx, input.projectSlug);
    let invalidated = false;
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        invalidated = clearReviewEvidence(parsed, reviewStageIdOf(project));
      },
    );
    if (invalidated) {
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    }
  }
  // 3. Reviewer verdict — classify on the FULL (untruncated) reply so a verdict
  //    past the 1200-char comment cap is never dropped.
  if (
    input.kind === "reviewer" &&
    input.profileId &&
    finished.state === "finished"
  ) {
    await recordReviewerVerdict(db, ctx, input.projectSlug, input.taskKey, {
      profileId: input.profileId,
      runId: finished.id,
      replyText: fullText,
      simulated: finished.simulated,
    });
    if (!db.open) return;
  }
  // 4. React: continue an operator chain, or start a fresh one against the
  //    deployed operator. Resolve the effective react context.
  const { resolveOperatorAuthority } =
    await import("./operator-actions.server");
  if (!db.open) return;
  let reactBackend: RealBackend;
  let reactAutonomy: OperatorAutonomy;
  let currentDepth: number;
  if (input.operatorRun) {
    reactBackend = input.operatorRun.backend;
    reactAutonomy = input.operatorRun.autonomy;
    currentDepth = input.operatorRun.reactDepth;
  } else {
    const authority = resolveOperatorAuthority(ctx, input.projectSlug, {});
    reactBackend = authority.backend;
    reactAutonomy = authority.autonomy;
    currentDepth = 0;
  }
  // No-progress detection compares the TRUNCATED comment forms (adversarial-
  // review #4): `prevReply` is the prior reply's stored (truncated) timeline
  // comment, so comparing it against the current UNtruncated `fullText` could
  // never match for a >1200-char reply, defeating the CTL-3 spiral guard. Use
  // `commentText` (same truncated form) for the react/no-progress decision;
  // `fullText` stays reserved for the reviewer verdict above.
  const shouldReact = operatorShouldReactToReply(
    finished.state,
    commentText,
    prevReply,
    currentDepth,
  );
  if (!shouldReact) {
    const noProgress =
      !!commentText &&
      prevReply !== null &&
      prevReply.trim() === commentText.trim();
    const depthCapped =
      !!commentText &&
      !noProgress &&
      finished.state === "finished" &&
      currentDepth >= OPERATOR_REACT_DEPTH_CAP;
    if (noProgress) {
      logger.info(
        "operator react skipped — agent made no progress (repeated its reply)",
        {
          taskKey: input.taskKey,
          runId: finished.id,
        },
      );
    }
    if (noProgress || depthCapped) {
      await openStuckLoopPacket(
        db,
        { ...ctx, operatorAuthorized: true },
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          agentHandle: input.agentHandle,
          reason: noProgress
            ? "The agent repeated its previous report verbatim — no forward progress."
            : `The coordination loop hit its ${OPERATOR_REACT_DEPTH_CAP}-cycle depth cap without reaching a boundary.`,
        },
      );
      if (!db.open) return;
    }
    // ALWAYS flip waiting off `agent` when the chain terminates (adversarial-
    // review HIGH #1). markWaitingAgent set it at run start; openStuckLoopPacket
    // only clears it when a packet actually opens — it silently no-ops when the
    // operator lacks generate-packets, a packet is already open, or it throws.
    // Without this fallback the board would read "agent working" forever with no
    // agent running. Idempotent (no-op once a packet flipped waiting to human).
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  // Re-invoke only while an operator is still deployed on the project.
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
    backend: reactBackend,
    autonomy: reactAutonomy,
  });
  if (!authority.deployed) {
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  const { runOperator } = await import("~/server/runtimes/operator-run.server");
  if (!db.open) return;
  await runOperator(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    trigger: "agent-reply",
    reactDepth: currentDepth + 1,
    backend: reactBackend,
    autonomy: reactAutonomy,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

/** Flip a task from `waiting: agent` back to `waiting: human` once no further
 *  agent work follows a completion. No-op when it's already not agent-waiting. */
async function clearWaitingToHuman(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || existing.parsed.frontmatter.waiting !== "agent") return;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.frontmatter.waiting = "human";
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
  } catch (error) {
    logger.warn("clearWaitingToHuman failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Set `waiting: agent` when a real/simulated agent run is put in flight, so the
 *  board reads "working" (not "waiting on human") while the agent runs. */
export async function markWaitingAgent(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || existing.parsed.frontmatter.waiting === "agent") return;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.frontmatter.waiting = "agent";
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
  } catch (error) {
    logger.warn("markWaitingAgent failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

export async function operatorPromptAgent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    role: string;
    backend: RealBackend;
    directive: string;
    kind: "primary" | "reviewer";
    /** The agent's @mention handle (e.g. its name), prepended to the prompt so
     *  the comment reads as directing the agent by name ("@dev implement …"). */
    handle: string;
    /** Required for a reviewer run (identifies which reviewer to run). */
    profileId?: string;
  },
  ctx: TaskMutationContext = {},
): Promise<{ runId: string }> {
  const opCtx: TaskMutationContext = { ...ctx, operatorAuthorized: true };
  const directive = withMention(input.handle, input.directive);

  // 1. Post the operator's prompting comment (routed to-agent) so the hand-off
  //    is visible on the board before the agent starts streaming. The comment
  //    @mentions the agent by handle, so it reads as the operator directing that
  //    agent by name ("@dev implement …").
  const comment: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: directive,
    toAgent: true,
    evidence: null,
  };
  await updateTaskFile(
    taskRef(opCtx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(comment);
    },
  );
  reprojectTask(db, opCtx, input.projectSlug, input.taskKey);

  // 2. Trigger the agent's run with the operator's directive as its turn focus.
  const { startSpecialistRun, startReviewerRun } =
    await import("./specialist-run.server");
  let runId: string;
  if (input.kind === "reviewer") {
    if (!input.profileId) {
      throw AppError.validation(
        "A reviewer profile id is required to run a reviewer.",
      );
    }
    const started = await startReviewerRun(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: input.profileId,
        directive,
      },
      OPERATOR_TASK_ACTOR,
      opCtx,
    );
    runId = started.runId;
  } else {
    const started = await startSpecialistRun(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, directive },
      OPERATOR_TASK_ACTOR,
      opCtx,
    );
    runId = started.runId;
  }

  // 3. The completion handler (reply → reconcile → verdict → react) is already
  //    installed by startSpecialistRun/startReviewerRun above, which read
  //    `ctx.operatorRun` from opCtx (preserved from this operator run) and pass
  //    the real workspace clone dir. So the chain continues at depth+1 with the
  //    correct workdir — no separate registration here.
  return { runId };
}

/** Prepend an `@handle` mention to a directive if it does not already lead with
 *  one, so an operator prompt always reads as directing the agent by name. */
function withMention(handle: string, directive: string): string {
  const text = directive.trim();
  const h = handle.trim();
  if (!h) return text;
  // Already leads with any @mention (custom directives may include their own).
  if (/^@[A-Za-z]/.test(text)) return text;
  return `@${h} ${text}`;
}

// --------------------------------------------------------------- ownership

/**
 * Operator scheduling rule (contracts §3.3, shell §5.2 — generalized from
 * the mock's VIB-148 demo script): when a quality-gated task that is
 * waiting only on a human owner gains one, the OPERATOR reacts — readiness
 * flips to ready, waiting flips to agent, and the operator writes its own
 * `agent` event. "Quality-gated" = the newest operator event on the
 * timeline announces a passed quality gate. This inline server rule is the
 * documented stand-in until the Phase-8 operator runtime owns the reaction.
 */
function operatorSchedulesOnOwner(parsed: {
  frontmatter: TaskFrontmatter;
  packet: unknown;
  timeline: TaskFileEvent[];
}): boolean {
  if (parsed.frontmatter.operator === null) return false;
  if (parsed.frontmatter.waiting !== "human") return false;
  if (parsed.packet) return false;
  const newestOperatorEvent = parsed.timeline.find(
    (e) => e.type === "agent" && e.actor.kind === "operator",
  );
  return (
    newestOperatorEvent !== undefined &&
    newestOperatorEvent.text.startsWith("**Quality gate:**")
  );
}

/**
 * Take or hand off ownership. Exact typed `assign` event copy from
 * task-detail spec §5.2. RBAC: any project member may take (all four
 * roles hold the "Take / release task ownership" grant); handing off
 * requires being the current owner or a project admin, and the target
 * must be a member.
 */
export async function setOwner(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; targetUserId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const actorRole = requireAction(
    project,
    actor,
    "own-task",
    "take or assign task ownership",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  const isTake = input.targetUserId === actor.userId;
  const targetRole = project.memberRoles.get(input.targetUserId);
  if (!targetRole || !roleCan(targetRole, "own-task")) {
    throw forbidden(
      isTake
        ? "Ownership can only be held by a project member who can own tasks (contributor or above)."
        : "Ownership can only be handed to a project member who can own tasks (contributor or above).",
    );
  }
  if (!isTake) {
    // Hand off: current owner or project admin only; target must be able to OWN
    // (contributor+ — a viewer is read+comment only and can't hold the owner seat).
    if (currentOwnerId !== actor.userId && actorRole !== "admin") {
      throw forbidden(
        "Only the current owner or a project admin can hand off ownership.",
      );
    }
  }

  if (currentOwnerId === input.targetUserId) {
    // Idempotent: already the owner — no duplicate event.
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  let text: string;
  if (isTake && !currentOwnerId) {
    text =
      "Took task ownership — owner is the human reviewer and acceptance authority for this task.";
  } else if (isTake) {
    text = `Took over task ownership from **${userName(db, currentOwnerId!)}** — owner is the human reviewer and acceptance authority.`;
  } else {
    text = `Handed task ownership to **${userName(db, input.targetUserId)}** — they hold review & acceptance for this task now.`;
  }

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "assign",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };

  // Operator scheduling stand-in: only an UNOWNED task gaining its owner
  // triggers the reaction (spec §5.2 — VIB-148 generalization).
  const scheduling =
    !currentOwnerId && operatorSchedulesOnOwner(existing.parsed);
  const operatorEvent: TaskFileEvent | null = scheduling
    ? {
        occurredAt: event.occurredAt,
        type: "agent",
        actor: { kind: "operator" },
        title: null,
        text: `Acceptance boundary now owned by **${userName(db, input.targetUserId)}** — scheduling execution against the quality-gated scope.`,
        toAgent: false,
        evidence: null,
      }
    : null;

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.ownerUserId = input.targetUserId;
      parsed.timeline.unshift(event);
      if (operatorEvent) {
        parsed.frontmatter.readiness = "ready";
        parsed.frontmatter.waiting = "agent";
        parsed.timeline.unshift(operatorEvent);
      }
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: isTake ? "task.ownership.taken" : "task.ownership.handed_off",
    actor: authorityAuditActor(project, actor, "own-task"),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      previousOwnerUserId: currentOwnerId,
      newOwnerUserId: input.targetUserId,
      operatorScheduled: scheduling,
    },
  });

  // When scheduling fires, the operator "schedules execution": hand off to the
  // SAME operator runtime the rest of the lifecycle uses (trigger `transition`),
  // not the deleted Phase-5 simulated-narration stand-in that always faked a run
  // even with a real backend (finding #9). Fire-and-forget: it never blocks or
  // fails the ownership mutation (file write + audit already committed), and it
  // is a no-op when the project has no operator deployed.
  if (scheduling) {
    void autoInvokeOperator(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      "transition",
    );
  }

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/**
 * Release ownership. Any member releases their own seat; project admins
 * may release anyone (recorded as an admin action in audit + event copy).
 */
export async function releaseOwner(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  if (!currentOwnerId) {
    // Idempotent: nothing to release. Still require membership so a non-member
    // can't probe task state through this path.
    requireMemberRole(project, actor, "any-member", "release task ownership");
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  const isSelf = currentOwnerId === actor.userId;
  if (isSelf) {
    // Releasing your OWN seat: needs the own-task capability (contributor+).
    requireAction(project, actor, "own-task", "release task ownership");
  } else {
    // Releasing SOMEONE ELSE's seat: admin only (release-any-ownership).
    requireAction(
      project,
      actor,
      "release-any-ownership",
      "release another member's ownership",
    );
  }

  const text = isSelf
    ? "Released task ownership — review & acceptance stall until another member takes the seat."
    : `Released **${userName(db, currentOwnerId)}** from task ownership (admin) — the seat is open to any project member.`;

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "assign",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.ownerUserId = null;
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  const commonAudit = {
    subjectKind: "task" as const,
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      previousOwnerUserId: currentOwnerId,
      forced: !isSelf,
    },
  };
  if (isSelf) {
    recordAudit(db, {
      action: "task.ownership.released",
      actor: authorityAuditActor(project, actor, "own-task"),
      ...commonAudit,
    });
  } else {
    recordAudit(db, {
      action: "task.ownership.admin_released",
      actor: authorityAuditActor(project, actor, "release-any-ownership"),
      ...commonAudit,
    });
  }

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

// -------------------------------------------------------------- transition

/**
 * Governed stage transition. The move must be a declared workflow boundary;
 * enforcement per boundary type (contracts §3.2 grants):
 *   auto      → any project member
 *   approval  → admin | maintainer ("Approve stage transitions")
 *   human     → admin | maintainer ("Accept completion → Done") — humans
 *               only by construction here; agent-triggered transitions get
 *               capability-checked in Phase 8.
 * Side effects: entering the final stage sets waiting → none; leaving the
 * first stage assigns the operator when none is attached (ruling 16).
 */
export async function transitionStage(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    toStageId: string;
    /** Manual board-management move from the stage dropdown: allows moving to
     *  ANY stage (not just a declared workflow boundary — the governed graph is
     *  linear, so a boundary-only dropdown would offer nothing). Reserved for
     *  admin|maintainer (the transition authority). Governed flows (packets,
     *  recommendations, operator) never set this and keep boundary-only rules. */
    manual?: boolean;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fromStageId = existing.parsed.frontmatter.stage;

  if (fromStageId === input.toStageId) {
    // Idempotent: already there.
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  // Guard: the target must be a real stage of this project (manual moves skip
  // the boundary graph, so validate the destination explicitly).
  if (!project.stages.some((s) => s.id === input.toStageId)) {
    throw AppError.validation(
      `Unknown stage ${input.toStageId} for this project.`,
    );
  }

  const boundary = project.workflow.find(
    (w) => w.from === fromStageId && w.to === input.toStageId,
  );
  if (!boundary && !input.manual) {
    throw AppError.validation(
      `No governed boundary from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`,
    );
  }

  const firstStageId = project.stages[0]?.id;
  const lastStageId = project.stages[project.stages.length - 1]?.id;
  const resolvesReadiness =
    !ctx.operatorAuthorized &&
    fromStageId === firstStageId &&
    input.toStageId !== firstStageId &&
    existing.parsed.frontmatter.readiness === "input_required";
  let transitionAuditActor: AuditActor = actor;

  // A HUMAN manually moving a task INTO the final stage IS accepting completion
  // — route it through the full acceptance contract (real merge attempt,
  // `completion` event, validation → healthy, packet/recs cleared) rather than a
  // bare `transition` that would leave a Done task with an unmerged PR and no
  // completion record. RBAC (admin|maintainer) is re-checked inside.
  if (
    !ctx.operatorAuthorized &&
    input.toStageId === lastStageId &&
    lastStageId !== undefined
  ) {
    await acceptCompletion(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  if (ctx.operatorAuthorized) {
    // Operator authority is gated upstream by its capability policy; skip the
    // human RBAC. The final stage stays off this path — the operator reaches
    // Done only through the controlled accept-completion route (full autonomy),
    // never a bare stage move.
    if (input.toStageId === lastStageId) {
      throw forbidden(
        "The operator reaches Done only by accepting completion, not a bare transition.",
      );
    }
  } else if (input.manual) {
    // Manual stage override (board/task dropdown) — a maintainer-level action,
    // regardless of the boundary crossed (forward, backward, or off-graph).
    requireAction(
      project,
      actor,
      "approve-transition",
      "change the task stage",
    );
    transitionAuditActor = authorityAuditActor(
      project,
      actor,
      "approve-transition",
    );
  } else if (boundary!.boundary === "auto") {
    // An auto boundary crossed by a human (unreachable from the UI, which always
    // sends manual:true) — the loosest gate: any member.
    requireMemberRole(project, actor, "any-member", "move this task");
    if (!project.memberRoles.has(actor.userId) && actor.orgRole === "admin") {
      transitionAuditActor = withProjectAuditAuthority(
        actor,
        "org_admin_override",
      );
    }
  } else if (boundary!.boundary === "approval") {
    requireAction(
      project,
      actor,
      "approve-transition",
      "approve stage transitions",
    );
    transitionAuditActor = authorityAuditActor(
      project,
      actor,
      "approve-transition",
    );
  } else {
    // human boundary (review→done locked in V1): acceptance authority.
    requireAction(
      project,
      actor,
      "accept-completion",
      "accept completion into Done",
    );
    transitionAuditActor = authorityAuditActor(
      project,
      actor,
      "accept-completion",
    );
  }

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "transition",
    actor: ctx.operatorAuthorized
      ? { kind: "operator" }
      : humanActorRef(db, actor),
    title: null,
    text: ctx.operatorAuthorized
      ? `**Transition:** operator moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`
      : `**Transition:** moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.${
          resolvesReadiness
            ? " The authorized human transition also resolved readiness from input_required to ready."
            : ""
        }`,
    toAgent: false,
    evidence: null,
  };

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.stage = input.toStageId;
      if (input.toStageId === lastStageId) {
        parsed.frontmatter.waiting = "none";
      }
      if (
        fromStageId === firstStageId &&
        input.toStageId !== firstStageId &&
        !parsed.frontmatter.operator
      ) {
        parsed.frontmatter.operator = { assignedAtStageId: input.toStageId };
      }
      // Leaving the first (triage) stage means the task was accepted into the
      // workflow, so the triage-time `input_required` gate is cleared — otherwise
      // a task with agents actively working would keep showing "input required"
      // on the board forever. `blocked` / `inconsistency_risk_detected` are real
      // states set elsewhere and must survive a transition, so only clear the
      // triage default.
      if (resolvesReadiness) {
        parsed.frontmatter.readiness = "ready";
      }
      // Live validation-health (FR24, B7): the board's validation signal was
      // seed-only, so a real task always read "none". Derive it from governance
      // state — entering review means the work is up for review ("changed").
      // ANY stale verdict is reset: a `healthy` from a prior round no longer
      // describes the new evidence, and a `failing` from a prior round starts a
      // NEW review cycle (the fix that ends "failing forever" — the reviewer
      // re-verdicts the fresh evidence). BUT a bare re-entry must NOT launder a
      // standing `failing` (adversarial-review #9): only reset failing→changed
      // when there is genuine rework since the rejection — otherwise a maintainer
      // could bounce a rejected task out of and back into review to clear the
      // flag and accept without a re-review. A non-failing validation always
      // resets to `changed` on review entry.
      if (input.toStageId === reviewStageIdOf(project)) {
        // Every review entry starts a new evidence round. Prior reviewer verdicts
        // remain represented in timeline/audit history but cannot satisfy the new
        // round's required approvals.
        parsed.frontmatter.reviewerVerdicts = [];
        const stale = parsed.frontmatter.validation;
        if (
          stale !== "failing" ||
          hasReworkSinceLastRejection(
            parsed.timeline,
            parsed.frontmatter.specialist,
          )
        ) {
          parsed.frontmatter.validation = "changed";
        }
      }
      // A stage move makes any pending transition recommendation stale — drop it
      // so a Done task never shows a "move to <stage>" card.
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter(
          (r) => r.kind !== "transition",
        );
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.transition",
    actor: ctx.operatorAuthorized ? OPERATOR_AUDIT_ACTOR : transitionAuditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      from: fromStageId,
      to: input.toStageId,
      boundary: boundary?.boundary ?? "manual",
      ...(input.manual ? { manual: true } : {}),
      ...(ctx.operatorAuthorized ? { by: "operator" } : {}),
      ...(resolvesReadiness
        ? {
            readiness: {
              from: "input_required",
              to: "ready",
              resolvedBy: "authorized_transition",
            },
          }
        : {}),
    },
  });

  // Approving a requested transition resolves its approval notifications.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, [
    "approval",
  ]);

  // A stage transition is a coordination trigger: when a NON-operator moves a
  // task onto a new (non-Done) stage, hand off to the operator so it picks the
  // task up at that stage and prompts the stage's agent (ADR-002 — one operator
  // per active task). Operator-authored transitions are excluded: the operator's
  // own run already coordinates the stages it moves through, so re-invoking it
  // here would be redundant and could recurse. Fire-and-forget — it never blocks
  // or fails the transition, and it is a no-op when no operator is deployed.
  if (!ctx.operatorAuthorized && input.toStageId !== lastStageId) {
    void autoInvokeOperator(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      "transition",
    );
  }

  // Delivery spine (FR31): entering the REVIEW stage is the point a PR is
  // opened for review — the developer's branch is put up for human-authorized
  // review, carrying a link back to this task. Best-effort + fire-and-forget:
  // it degrades cleanly (no throw) when the repo/PAT isn't configured, so a
  // transition never fails on GitHub state. The review stage is the one with a
  // governed edge into the final (Done) stage.
  const reviewStageId = reviewStageIdOf(project);
  if (reviewStageId && input.toStageId === reviewStageId) {
    void openReviewPrBestEffort(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      actor,
    );
  }

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/**
 * Best-effort review-PR open on entering the review stage. Isolated so a
 * GitHub failure (or an unconfigured repo) can never fail the governed
 * transition — every non-ok result is swallowed after logging.
 */
async function openReviewPrBestEffort(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<void> {
  try {
    if (!db.open) return;
    const { openTaskPr } = await import("~/server/github/pr-open.server");
    if (!db.open) return;
    const result = await openTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      {
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        ...(ctx.githubFetchImpl ? { fetchImpl: ctx.githubFetchImpl } : {}),
      },
    );
    if (result.status !== "ok") {
      logger.info("review PR not opened", { taskKey, reason: result.status });
    }
  } catch (error) {
    if (!db.open) return;
    logger.warn("review PR open failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Attempt a REAL GitHub merge of the task's review PR (FR31, human-authorized).
 * Returns true only when GitHub actually merged (mergeTaskPr wrote state=merged
 * + a github event). Returns false — never throws — when there is no PR, no
 * repo/PAT, or GitHub is unreachable, so the caller falls back to the cache
 * flip for the offline/seed case. Only meaningful for a human actor.
 */
async function mergeTaskPrIfPossible(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<"merged" | "pending" | "head_changed"> {
  if (!actor.userId) return "pending";
  try {
    const { mergeTaskPr } =
      await import("~/server/github/github-reconciler.server");
    const result = await mergeTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      { ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}) },
    );
    return result.status === "merged"
      ? "merged"
      : result.status === "head_changed"
        ? "head_changed"
        : "pending";
  } catch (error) {
    logger.warn("PR merge on acceptance failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return "pending";
  }
}

// ------------------------------------------------------------ reorderTask

/**
 * Drag-to-reorder a card on the board: set its persistent `boardRank` so it
 * sits at the requested position within `toStageId`, and (when the stage
 * actually changes) route through the governed manual transition first — which
 * writes the **Transition:** timeline comment and hands the task to the operator
 * at its new stage. A pure same-stage reorder writes NO comment (a quiet
 * position change), only the rank.
 *
 * Position: `beforeKey` is the key of the card the moved card should land
 * immediately BEFORE (null = end of the column). The new rank is the midpoint
 * of that gap in the target column's current order (excluding the moved task),
 * so only THIS task's file is rewritten. RBAC: admin|maintainer.
 */
export async function reorderTask(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    toStageId: string;
    /** Insert immediately before this task; null/absent → append to the end. */
    beforeKey?: string | null;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{
  task: TaskSummary;
  movedStage: boolean;
  toName: string;
  acceptedIntoDone: boolean;
}> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(project, actor, "reorder-board", "reorder the board");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (!project.stages.some((s) => s.id === input.toStageId)) {
    throw AppError.validation(
      `Unknown stage ${input.toStageId} for this project.`,
    );
  }

  const movedStage = existing.parsed.frontmatter.stage !== input.toStageId;
  // A stage change goes through the governed manual transition (comment +
  // operator hand-off + reproject); the rank is set afterwards.
  if (movedStage) {
    const transitioned = await transitionStage(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        toStageId: input.toStageId,
        manual: true,
      },
      actor,
      ctx,
    );
    if (transitioned.stage !== input.toStageId) {
      return {
        task: transitioned,
        movedStage: false,
        toName:
          project.stages.find((stage) => stage.id === transitioned.stage)
            ?.name ?? transitioned.stage,
        acceptedIntoDone: false,
      };
    }
  }

  // Midpoint of the requested gap in the target column's CURRENT order.
  const {
    listProjectTasks,
    effectiveBoardRank,
    compareBoardOrder,
    taskKeyNumber,
    BOARD_RANK_BASE,
  } = await import("~/server/projections/board-query.server");
  const inStage = listProjectTasks(db, input.projectSlug)
    .filter((t) => t.stage === input.toStageId && t.key !== input.taskKey)
    .sort(compareBoardOrder);
  const beforeKey = input.beforeKey ?? null;
  const idx =
    beforeKey == null ? -1 : inStage.findIndex((t) => t.key === beforeKey);

  let newRank: number;
  if (inStage.length === 0) {
    newRank = taskKeyNumber(input.taskKey) * BOARD_RANK_BASE;
  } else if (idx < 0) {
    // append to the end (beforeKey null or no longer present)
    newRank =
      effectiveBoardRank(inStage[inStage.length - 1]!) + BOARD_RANK_BASE;
  } else if (idx === 0) {
    newRank = effectiveBoardRank(inStage[0]!) - BOARD_RANK_BASE;
  } else {
    newRank =
      (effectiveBoardRank(inStage[idx - 1]!) +
        effectiveBoardRank(inStage[idx]!)) /
      2;
  }

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.boardRank = newRank;
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.board.reordered",
    actor: authorityAuditActor(project, actor, "reorder-board"),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      fromStageId: existing.parsed.frontmatter.stage,
      toStageId: input.toStageId,
      beforeKey,
      boardRank: newRank,
    },
  });

  const toName =
    project.stages.find((s) => s.id === input.toStageId)?.name ??
    input.toStageId;
  // Dragging INTO the terminal stage runs the full acceptance contract (merge
  // attempt + completion event) via the H4 redirect — surface that honestly so
  // the toast isn't a bare "Moved" for what is actually an acceptance + merge.
  const acceptedIntoDone =
    movedStage && isTerminalStage(input.toStageId, project.stages);
  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    movedStage,
    toName,
    acceptedIntoDone,
  };
}

// ------------------------------------------------------------ resolvePacket

/**
 * Resolves the task's active decision packet by option index, dispatching
 * on the option's stable `kind` (ruling 7) — NEVER on the English title.
 *
 *   accept_completion   human-only acceptance (admin|maintainer, org-admin
 *                       override, or current contributor owner). Healthy
 *                       non-repository work moves to Done; repository work
 *                       remains in Review until its linked PR is truly merged.
 *   request_edit /
 *   redirect / custom   waiting → agent, readiness → ready, packet cleared,
 *                       `transition` event (option.ev or the fallback copy).
 *   block_on_policy     readiness → blocked, waiting → human, packet KEPT,
 *                       `blocked` event.
 *   hold_runtime_debug  readiness → blocked, packet KEPT, `blocked` event.
 *
 * Idempotent: a task without an open packet → 409 conflict (already
 * resolved elsewhere), never a crash. Every resolve marks the task's
 * packet + approval notifications read (server-side).
 */
export async function resolvePacket(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; optionIndex: number },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{
  task: TaskSummary;
  option: PacketOption;
  completion?: CompletionAcceptanceResult;
}> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const packet = existing.parsed.packet;
  if (!packet) {
    throw conflict("This packet was already resolved.");
  }
  const option = packet.options[input.optionIndex];
  if (!option) {
    throw AppError.validation("Unknown packet option.");
  }

  // Packet-resolution authority (owner ruling Q2, 2026-07-11): a decision packet
  // is addressed to the task OWNER, so the owner (whatever their project role)
  // OR an admin|maintainer may resolve it — a contributor who took ownership is
  // no longer told "decision needed" and then handed a 403. The
  // Completion uses the same task-scoped owner exception: the active
  // contributor+ owner may accept their own task, while non-owners still need
  // project-supervisor or org-admin emergency authority.
  // The owner path additionally requires CURRENT project membership
  // (adversarial-review #8) — a user removed from the project who still holds a
  // stale ownerUserId must not resolve packets. `memberRoles.has` is the live
  // membership check.
  const isOwner =
    !ctx.operatorAuthorized &&
    !!actor.userId &&
    existing.parsed.frontmatter.ownerUserId === actor.userId &&
    roleCan(project.memberRoles.get(actor.userId), "own-task");
  if (isOwner) {
    // owner is allowed — skip the maintainer gate (the owner must still be able
    // to own the task, i.e. contributor+; a demoted viewer-owner is caught above)
  } else {
    requireAction(project, actor, "resolve-packet", "resolve decision packets");
  }

  if (option.kind === "accept_completion") {
    const completionAuthority = requireCompletionAuthority(
      project,
      existing.parsed,
      actor,
    );
    const completion = await acceptCompletion(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
    recordAudit(db, {
      action: "task.packet.resolved",
      actor:
        completionAuthority === "org_admin_override"
          ? withProjectAuditAuthority(actor, completionAuthority)
          : actor,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        optionKind: option.kind,
        optionTitle: option.t,
        packetKind: packet.kind,
        authoritySource: completionAuthority,
        completed: completion.completed,
        mergePending: completion.mergePending,
      },
    });
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      option,
      completion,
    };
  }

  const now = new Date().toISOString();
  const human = humanActorRef(db, actor);
  const key = input.taskKey;

  let event: TaskFileEvent;
  let mutate: (fm: TaskFrontmatter) => void;
  let clearPacket = false;

  switch (option.kind) {
    case "block_on_policy": {
      event = {
        occurredAt: now,
        type: "blocked",
        actor: human,
        title: null,
        text: `**Decision:** hold on policy. ${key} stays blocked until the project credential policy is updated.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.readiness = "blocked";
        fm.waiting = "human";
        fm.validation = "failing"; // a policy block is an unhealthy state (FR24)
      };
      break;
    }
    case "hold_runtime_debug": {
      event = {
        occurredAt: now,
        type: "blocked",
        actor: human,
        title: null,
        text: `**Decision:** hold for runtime debug. ${key} stays blocked while the provider-native session is inspected — findings come back as task comments.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.readiness = "blocked";
      };
      break;
    }
    default: {
      // request_edit | redirect | custom — send back to the agent side.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Operator re-engages the specialist with a summon note.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "agent";
        fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
  }

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      if (!parsed.packet) {
        // Raced with a concurrent resolve inside the lock window.
        throw conflict("This packet was already resolved.");
      }
      mutate(parsed.frontmatter);
      if (clearPacket) parsed.packet = null;
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.packet.resolved",
    actor: isOwner
      ? actor
      : authorityAuditActor(project, actor, "resolve-packet"),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      optionKind: option.kind,
      optionTitle: option.t,
      packetKind: packet.kind,
      ...(isOwner ? { authoritySource: "task_owner" } : {}),
    },
  });

  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);

  // When a human sends work back to the agent side (request_edit / redirect /
  // custom), the packet event PROMISES "the operator re-engages the specialist"
  // — so actually do it. Re-invoke the operator to coordinate the next move
  // instead of leaving the task at waiting=agent with nothing running. Fire-and-
  // forget, non-blocking, a no-op when no operator is deployed.
  const sentBackToAgent =
    option.kind === "request_edit" ||
    option.kind === "redirect" ||
    option.kind === "custom";
  if (sentBackToAgent) {
    void autoInvokeOperator(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      "transition",
    );
  }

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    option,
  };
}

// ---------------------------------------------------- operator recommendations

/**
 * Apply a pending operator recommendation: a human accepts the operator's
 * recommended action (assign a specialist / engage a reviewer / move a stage),
 * executing it through the SAME governed mutation the manual affordance uses
 * (so RBAC + events are identical), then clearing the recommendation. RBAC is
 * enforced by the underlying mutation (admin|maintainer). Idempotent — an
 * already-resolved recommendation id is a friendly 409.
 */
interface CompletionAcceptanceResult {
  completed: boolean;
  mergePending: boolean;
}

interface CompletionEvidenceSnapshot {
  fingerprint: string;
  prNumber: number | null;
}

function assertCurrentCompletionInvariants(
  parsed: ParsedTaskFile,
  project: ProjectContext,
  actor: TaskActor,
  expected: CompletionEvidenceSnapshot,
): CompletionAuthoritySource {
  const authority = requireCompletionAuthority(project, parsed, actor);
  const reviewStageId = reviewStageIdOf(project);
  if (!reviewStageId || parsed.frontmatter.stage !== reviewStageId) {
    throw conflict(
      "Completion state changed while the request was in progress. The task must still be in Review.",
    );
  }
  if (parsed.frontmatter.validation !== "healthy") {
    throw conflict(
      "Completion state changed while the request was in progress. Validation is no longer healthy.",
    );
  }
  const missing = missingReviewerApprovalProfileIds(parsed, project.repo);
  if (missing.length > 0) {
    throw conflict(
      `Completion state changed while the request was in progress. Missing reviewer approval: ${missing.join(", ")}.`,
    );
  }
  if (
    reviewEvidenceFingerprint(parsed, project.repo) !== expected.fingerprint
  ) {
    throw conflict(
      "The goal or delivery evidence changed while completion was in progress. Review the current evidence before accepting it.",
    );
  }
  if ((parsed.frontmatter.pr?.number ?? null) !== expected.prNumber) {
    throw conflict(
      "The linked pull request changed while completion was in progress. Review the current PR before accepting it.",
    );
  }
  return authority;
}

function applyAcceptedCompletion(
  parsed: ParsedTaskFile,
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  doneStageId: string,
  mergedPr: boolean,
): void {
  parsed.frontmatter.stage = doneStageId;
  parsed.frontmatter.readiness = "ready";
  parsed.frontmatter.waiting = "none";
  parsed.frontmatter.recommendations =
    parsed.frontmatter.recommendations.filter(
      (recommendation) =>
        recommendation.kind !== "transition" &&
        recommendation.kind !== "accept_completion",
    );
  parsed.packet = null;
  parsed.timeline.unshift({
    occurredAt: new Date().toISOString(),
    type: "completion",
    actor: humanActorRef(db, actor),
    title: "Completion accepted",
    text: mergedPr
      ? `Human acceptance recorded. ${input.taskKey} transitioned to **Done** after its review PR was merged.`
      : `Human acceptance recorded. ${input.taskKey} transitioned to **Done** (no repository delivery required).`,
    toAgent: false,
    evidence: null,
  });
}

/** Finalize an already-valid acceptance after any required merge is real. */
async function finalizeAcceptedCompletion(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  mergedPr: boolean,
  expected: CompletionEvidenceSnapshot,
): Promise<void> {
  // Reload project authority after the external await as well. Task invariants
  // are then checked and mutated inside one per-file locked transaction.
  const project = loadProjectContext(ctx, input.projectSlug);
  const doneStageId =
    terminalStageIdOf(project) ??
    project.stages[project.stages.length - 1]?.id ??
    "done";
  let completionAuthority: CompletionAuthoritySource | null = null;
  let didFinalize = false;
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      if (parsed.frontmatter.stage === doneStageId) return;
      completionAuthority = assertCurrentCompletionInvariants(
        parsed,
        project,
        actor,
        expected,
      );
      const effectiveRepo = parsed.frontmatter.repo ?? project.repo;
      if (
        effectiveRepo &&
        (!mergedPr || parsed.frontmatter.pr?.state !== "merged")
      ) {
        throw conflict(
          "Repository-backed completion can finish only after the linked PR is confirmed merged.",
        );
      }
      if (!effectiveRepo && mergedPr) {
        throw conflict(
          "The delivery target changed while completion was in progress.",
        );
      }
      applyAcceptedCompletion(parsed, db, input, actor, doneStageId, mergedPr);
      didFinalize = true;
    },
  );
  if (!didFinalize) return;
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  const completionAuditActor =
    completionAuthority === "org_admin_override"
      ? withProjectAuditAuthority(actor, completionAuthority)
      : actor;
  recordAudit(db, {
    action: "task.transition",
    actor: completionAuditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      to: doneStageId,
      boundary: "human",
      via: "accept_completion",
      authoritySource: completionAuthority,
      mergedPr,
    },
  });
}

/**
 * Human acceptance of the review→done boundary. Repository-backed tasks remain
 * in Review until the linked PR is truly merged; non-repository tasks may
 * finish directly. Validation must already be healthy and the task must be at
 * the governed review stage, so acceptance cannot launder unknown evidence.
 */
async function acceptCompletion(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<CompletionAcceptanceResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const completionAuthority = requireCompletionAuthority(
    project,
    existing.parsed,
    actor,
  );
  const missingReviewerApprovals = missingReviewerApprovalProfileIds(
    existing.parsed,
    project.repo,
  );
  if (missingReviewerApprovals.length > 0) {
    throw conflict(
      `Completion requires explicit approval from every assigned reviewer. Missing: ${missingReviewerApprovals.join(", ")}.`,
    );
  }
  if (existing.parsed.frontmatter.validation !== "healthy") {
    throw conflict(
      "Completion requires a healthy validation verdict. Run or repeat review before accepting it.",
    );
  }

  const doneStageId =
    terminalStageIdOf(project) ??
    project.stages[project.stages.length - 1]?.id ??
    "done";

  if (existing.parsed.frontmatter.stage === doneStageId) {
    return { completed: true, mergePending: false };
  }
  const reviewStageId = reviewStageIdOf(project);
  if (!reviewStageId || existing.parsed.frontmatter.stage !== reviewStageId) {
    throw conflict(
      "Completion can be accepted only from the governed Review stage.",
    );
  }

  const effectiveRepo = existing.parsed.frontmatter.repo ?? project.repo;
  if (effectiveRepo && !existing.parsed.frontmatter.pr) {
    throw conflict(
      "Repository-backed completion requires a linked review pull request.",
    );
  }
  if (effectiveRepo && existing.parsed.frontmatter.pr?.state === "closed") {
    throw conflict(
      "A closed, unmerged pull request cannot satisfy repository completion. Open a new review PR and validate that evidence.",
    );
  }
  const completionAuditActor =
    completionAuthority === "org_admin_override"
      ? withProjectAuditAuthority(actor, completionAuthority)
      : actor;
  const expected: CompletionEvidenceSnapshot = {
    fingerprint: reviewEvidenceFingerprint(existing.parsed, project.repo),
    prNumber: existing.parsed.frontmatter.pr?.number ?? null,
  };
  const alreadyMerged = existing.parsed.frontmatter.pr?.state === "merged";
  const mergeStatus = alreadyMerged
    ? "merged"
    : effectiveRepo
      ? await mergeTaskPrIfPossible(
          db,
          ctx,
          input.projectSlug,
          input.taskKey,
          completionAuditActor,
        )
      : "pending";
  if (mergeStatus === "head_changed") {
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        clearReviewEvidence(parsed, reviewStageIdOf(project));
      },
    );
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    throw conflict(
      "The pull request head changed after review. Review the current head before accepting completion.",
    );
  }
  const reallyMerged = mergeStatus === "merged";

  if (effectiveRepo && !reallyMerged) {
    const currentProject = loadProjectContext(ctx, input.projectSlug);
    const currentDoneStageId =
      terminalStageIdOf(currentProject) ??
      currentProject.stages[currentProject.stages.length - 1]?.id ??
      "done";
    let currentAuthority: CompletionAuthoritySource | null = null;
    let externallyMerged = false;
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        currentAuthority = assertCurrentCompletionInvariants(
          parsed,
          currentProject,
          actor,
          expected,
        );
        if (parsed.frontmatter.pr?.state === "merged") {
          applyAcceptedCompletion(
            parsed,
            db,
            input,
            actor,
            currentDoneStageId,
            true,
          );
          externallyMerged = true;
          return;
        }
        if (
          !parsed.frontmatter.pr ||
          parsed.frontmatter.pr.state === "closed"
        ) {
          throw conflict(
            "The linked pull request changed while acceptance was in progress.",
          );
        }
        if (parsed.frontmatter.pr) {
          parsed.frontmatter.pr = {
            ...parsed.frontmatter.pr,
            state: "accepted",
          };
        }
        parsed.frontmatter.readiness = "ready";
        parsed.frontmatter.waiting = "human";
        parsed.frontmatter.recommendations =
          parsed.frontmatter.recommendations.filter(
            (recommendation) => recommendation.kind !== "accept_completion",
          );
        parsed.packet = null;
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "completion",
          actor: humanActorRef(db, actor),
          title: "Completion accepted · merge pending",
          text: `Acceptance is approved, but ${input.taskKey} remains in **Review** until its linked pull request is actually merged.`,
          toAgent: false,
          evidence: null,
        });
      },
    );
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    const latestAuditActor =
      currentAuthority === "org_admin_override"
        ? withProjectAuditAuthority(actor, currentAuthority)
        : actor;
    if (externallyMerged) {
      recordAudit(db, {
        action: "task.transition",
        actor: latestAuditActor,
        subjectKind: "task",
        subjectId: input.taskKey,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        details: {
          to: currentDoneStageId,
          boundary: "human",
          via: "accept_completion",
          authoritySource: currentAuthority,
          mergedPr: true,
        },
      });
      return { completed: true, mergePending: false };
    }
    recordAudit(db, {
      action: "task.completion.accepted_merge_pending",
      actor: latestAuditActor,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { authoritySource: currentAuthority },
    });
    return { completed: false, mergePending: true };
  }

  await finalizeAcceptedCompletion(
    db,
    ctx,
    input,
    actor,
    reallyMerged,
    expected,
  );
  return { completed: true, mergePending: false };
}

/**
 * Complete the REAL GitHub merge of a PR that was accepted "merge pending"
 * When acceptance is approved but merge is pending, the task intentionally
 * remains in Review with `pr.state=accepted`. A valid later merge finalizes the
 * same acceptance and moves the task to Done.
 */
export async function completeTaskMerge(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; merged: boolean; message: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  if (!actor.userId) {
    throw AppError.validation("A signed-in user is required to merge a PR.");
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const completionAuthority = requireCompletionAuthority(
    project,
    existing.parsed,
    actor,
  );
  const missingReviewerApprovals = missingReviewerApprovalProfileIds(
    existing.parsed,
    project.repo,
  );
  if (missingReviewerApprovals.length > 0) {
    throw conflict(
      `Completion requires explicit approval from every assigned reviewer. Missing: ${missingReviewerApprovals.join(", ")}.`,
    );
  }
  const completionAuditActor =
    completionAuthority === "org_admin_override"
      ? withProjectAuditAuthority(actor, completionAuthority)
      : actor;
  const pr = existing.parsed.frontmatter.pr;
  if (!pr) {
    throw AppError.validation("This task has no linked pull request to merge.");
  }
  if (pr.state !== "accepted" && pr.state !== "merged") {
    throw conflict(
      `This PR is "${pr.state}", not an accepted merge-pending or externally merged PR.`,
    );
  }
  if (existing.parsed.frontmatter.validation !== "healthy") {
    throw conflict(
      "The accepted work no longer has a healthy validation verdict. Re-review it before merging.",
    );
  }
  if (existing.parsed.frontmatter.stage !== reviewStageIdOf(project)) {
    throw conflict("A merge-pending completion must remain in Review.");
  }

  const expected: CompletionEvidenceSnapshot = {
    fingerprint: reviewEvidenceFingerprint(existing.parsed, project.repo),
    prNumber: pr.number,
  };

  // A reconcile may observe the accepted PR was merged externally. Consume
  // that fact without issuing a duplicate merge request.
  if (pr.state === "merged") {
    await finalizeAcceptedCompletion(db, ctx, input, actor, true, expected);
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      merged: true,
      message: `PR #${pr.number} was already merged · ${input.taskKey} moved to Done.`,
    };
  }

  const { mergeTaskPr } =
    await import("~/server/github/github-reconciler.server");
  const result = await mergeTaskPr(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
    completionAuditActor,
    {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      ...(ctx.githubFetchImpl ? { fetchImpl: ctx.githubFetchImpl } : {}),
    },
  );

  if (result.status === "merged") {
    // mergeTaskPr wrote the real GitHub fact; now and only now may the
    // repository-backed task cross Review → Done.
    await finalizeAcceptedCompletion(db, ctx, input, actor, true, expected);
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      merged: true,
      message: `PR #${result.prNumber} merged · ${input.taskKey} moved to Done.`,
    };
  }

  if (result.status === "head_changed") {
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        clearReviewEvidence(parsed, reviewStageIdOf(project));
      },
    );
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  }

  const message =
    result.status === "no_repo_configured" ||
    result.status === "no_pat_configured"
      ? "Configure a GitHub credential for this project first, then try again."
      : result.status === "scope_violation"
        ? "The credential is missing `pull_request:write`. Grant the scope, then retry."
        : result.status === "not_mergeable" || result.status === "head_changed"
          ? `GitHub can't merge it yet: ${result.message}`
          : "The PR could not be merged. It may be closed or already merged on GitHub.";
  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    merged: false,
    message,
  };
}

export async function applyRecommendation(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; recId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; label: string }> {
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const rec = existing.parsed.frontmatter.recommendations.find(
    (r) => r.id === input.recId,
  );
  if (!rec) throw conflict("That recommendation was already resolved.");

  // Execute the recommended action through the governed mutation (RBAC inside).
  if (rec.kind === "assign_specialist" && rec.profileId) {
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: rec.profileId,
      },
      actor,
      ctx,
    );
  } else if (rec.kind === "assign_reviewer" && rec.profileId) {
    const { assignReviewer } = await import("./specialist-run.server");
    await assignReviewer(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: rec.profileId,
      },
      actor,
      ctx,
    );
  } else if (rec.kind === "run_specialist") {
    // The operator recommended starting the primary specialist's run (it can't
    // under `recommend` autonomy) — applying it (admin|maintainer, re-checked in
    // startSpecialistRun) starts the run.
    const { startSpecialistRun } = await import("./specialist-run.server");
    await startSpecialistRun(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
  } else if (rec.kind === "run_reviewer" && rec.profileId) {
    const { startReviewerRun } = await import("./specialist-run.server");
    await startReviewerRun(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: rec.profileId,
      },
      actor,
      ctx,
    );
  } else if (rec.kind === "transition" && rec.toStageId) {
    await transitionStage(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        toStageId: rec.toStageId,
      },
      actor,
      ctx,
    );
  } else if (rec.kind === "accept_completion") {
    // The operator's "accept completion → Done" recommendation. Applying it is
    // the human acceptance of the review→done boundary: same semantics as
    // resolving an acceptance packet (Done, PR merged, completion event).
    await acceptCompletion(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
  } else {
    throw AppError.validation("This recommendation is malformed.");
  }

  // Clear the applied recommendation.
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter((r) => r.id !== input.recId);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // Resolving the recommendation clears its "Waiting on you" bell (transition
  // recs already clear it inside transitionStage; this covers assign/accept).
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, [
    "approval",
  ]);

  recordAudit(db, {
    action: "task.recommendation.applied",
    actor: authorityAuditActor(
      loadProjectContext(ctx, input.projectSlug),
      actor,
      rec.kind === "accept_completion" ? "accept-completion" : "resolve-packet",
    ),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kind: rec.kind, label: rec.label },
  });

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    label: rec.label,
  };
}

/**
 * Dismiss a pending operator recommendation without acting on it (admin|
 * maintainer — symmetric with resolvePacket; the UI hides the control from
 * lower roles). Idempotent — a missing id is a no-op.
 */
export async function dismissRecommendation(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; recId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; label: string | null }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Dismissing an operator recommendation resolves a pending governance decision
  // (the non-packet equivalent of resolving a packet) — admin|maintainer only,
  // symmetric with resolvePacket.
  requireAction(project, actor, "resolve-packet", "dismiss recommendations");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const rec = existing.parsed.frontmatter.recommendations.find(
    (r) => r.id === input.recId,
  );
  if (!rec) {
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      label: null,
    };
  }

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter((r) => r.id !== input.recId);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // Resolving the recommendation (either way) clears its "Waiting on you" bell.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, [
    "approval",
  ]);

  recordAudit(db, {
    action: "task.recommendation.dismissed",
    actor: authorityAuditActor(project, actor, "resolve-packet"),
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kind: rec.kind, label: rec.label },
  });

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    label: rec.label,
  };
}
