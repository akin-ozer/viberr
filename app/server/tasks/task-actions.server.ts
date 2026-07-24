import type { DatabaseSync } from "node:sqlite";
import {
  acceptanceBlockedReason,
  deliveringEngagement,
  deriveValidation,
  type PacketOption,
  type TaskFileEvent,
  type TaskFrontmatter,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { type RbacAction, roleCan, rolesForAction } from "~/shared/rbac";
import {
  canRunAgents,
  requireProjectAuthority,
  requireProjectMutable,
} from "~/server/auth/project-authority.server";
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
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  agentRoleDisplay,
  encodeActorRef,
} from "~/server/files/actor-ref.server";
import {
  buildAgentQuestionPacket,
  type AgentOutcomeQuestion,
} from "./agent-outcome.server";
import { AppError } from "~/server/errors/app-error.server";
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
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";

/** Task mutations write the canonical file before projections, audit, and notifications. */

export interface TaskActor {
  userId: string;
  /** Human-readable audit label, e.g. the email. */
  label: string;
}

export interface TaskMutationContext {
  /** Override the data root (tests). Defaults to env VIBERR_DATA_ROOT. */
  dataRoot?: string;
  /** In-process operator authority; routes must never set this. */
  operatorAuthorized?: boolean;
  /** Operator-run state needed to continue the bounded reply/react loop. */
  operatorRun?: {
    backend: RealBackend;
    autonomy: "supervised" | "full";
    reactDepth: number;
    /** Consecutive operator-authored transition chain depth (see
     *  OPERATOR_TRANSITION_CHAIN_CAP). Optional: only the operator drive sets
     *  it; absent reads as 0. */
    transitionDepth?: number;
  };
}

/** Hard cap on the operator's react re-invocation chain (runaway backstop). */
const OPERATOR_REACT_DEPTH_CAP = 4;

/**
 * Hard cap on CONSECUTIVE operator-authored stage transitions (runaway
 * backstop for the P11-70 every-transition re-trigger). Each link is a full
 * LLM operator run, and the chain's normal termination — the operator reaches
 * a stage where it deploys a specialist or opens a packet — is model behavior,
 * not structure. A cyclic `auto` stage graph or a model bouncing a task
 * between two stages it can transition would otherwise loop unbounded. Any
 * human action or agent reply re-invokes the operator WITHOUT a threaded
 * depth, which is what resets the chain; legitimate consecutive auto-boundary
 * walks (Triage → Ready → In Progress) stay far under the cap.
 */
export const OPERATOR_TRANSITION_CHAIN_CAP = 8;

/** Depth of the NEXT transition-chain link: a human-authored transition always
 *  restarts at 0; an operator-authored one extends its drive's threaded depth. */
export function nextTransitionChainDepth(ctx: TaskMutationContext): number {
  return ctx.operatorAuthorized ? (ctx.operatorRun?.transitionDepth ?? 0) + 1 : 0;
}

/** Continue the operator loop only after a new, successful reply within its depth cap. */
export function operatorShouldReactToReply(
  finishedState: string,
  replyText: string | null,
  prevReply: string | null,
  reactDepth: number | undefined,
): boolean {
  if (finishedState !== "finished" || !replyText) return false;
  if (prevReply !== null && prevReply.trim() === replyText.trim()) return false;
  if (reactDepth === undefined || reactDepth >= OPERATOR_REACT_DEPTH_CAP) return false;
  return true;
}

/** Audit actor for operator-performed mutations (no human user id). */
export const OPERATOR_AUDIT_ACTOR = { userId: null, label: "operator" } as const;

/** Placeholder TaskActor the operator toolkit threads through the shared
 *  mutations; its user id is never read once `operatorAuthorized` is set (the
 *  RBAC check is skipped and audit uses {@link OPERATOR_AUDIT_ACTOR}). */
export const OPERATOR_TASK_ACTOR: TaskActor = {
  userId: "operator",
  label: "operator",
};

// ---------------------------------------------------------------- helpers

interface ProjectContext {
  slug: string;
  stages: { id: string; name: string }[];
  workflow: {
    from: string;
    to: string;
    boundary: "auto" | "approval" | "human";
  }[];
  memberRoles: Map<string, ProjectRole>;
  /** Archived projects are read-only (owner ruling R6-3): every governed
   *  mutation is refused until the project is restored. */
  archived: boolean;
}

function loadProjectContext(
  ctx: TaskMutationContext,
  projectSlug: string,
): ProjectContext {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const fm = file.parsed.frontmatter;
  return {
    slug: fm.slug,
    stages: fm.stages.map((s) => ({ id: s.id, name: s.name })),
    workflow: fm.workflow.map((w) => ({
      from: w.from,
      to: w.to,
      boundary: w.boundary,
    })),
    memberRoles: new Map(fm.members.map((m) => [m.userId, m.role])),
    archived: fm.archived === true,
  };
}

// The archived read-only gate (R6-3) — ONE implementation, shared with the
// config-surface guard. Re-exported so existing importers keep working.
export { requireProjectMutable };

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

/** Notify the owner and project supervisors, respecting routing preferences. */
export function notifyTaskWatchers(
  db: DatabaseSync,
  notice: TaskWatcherNotice,
  ctx: TaskMutationContext = {},
): string[] {
  let recipients: Set<string>;
  try {
    const project = loadProjectContext(ctx, notice.projectSlug);
    recipients = new Set<string>();
    for (const [userId, role] of project.memberRoles) {
      if (role === "admin" || role === "maintainer") recipients.add(userId);
    }
    const owner = readTaskFile(
      taskRef(ctx, notice.projectSlug, notice.taskKey),
    )?.parsed.frontmatter.ownerUserId;
    if (owner) recipients.add(owner);
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

/** The loosest membership gate: ANY live member (idempotent/no-op paths).
 *  Routes through the single authority resolution, so an org admin passes as
 *  the audited D2 override. */
function requireAnyMember(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  what: string,
): ProjectRole {
  return requireProjectAuthority(db, project, actor, "any-member", {
    action: "any-member",
    what,
  }).role;
}

/** Enforce the shared action-role policy and return the actor's effective role. */
export function requireAction(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  action: RbacAction,
  what: string,
): ProjectRole {
  // Archived projects are read-only (R6-3). Every governed mutation names an
  // RbacAction and routes through here, so this is the single chokepoint that
  // freezes an archived project's mutations while leaving reads intact.
  requireProjectMutable(project, what);
  return requireProjectAuthority(db, project, actor, rolesForAction(action), {
    action,
    what,
  }).role;
}

/** A live contributor-or-higher owner may accept their assigned task. */
function ownerException(
  project: ProjectContext,
  actor: TaskActor,
  ownerUserId: string | null | undefined,
): boolean {
  return (
    !!actor.userId &&
    !!ownerUserId &&
    ownerUserId === actor.userId &&
    roleCan(project.memberRoles.get(actor.userId), "own-task")
  );
}

/** Require normal acceptance authority or the live task-owner exception. */
function requireAcceptCompletion(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  ownerUserId: string | null | undefined,
  what: string,
): void {
  if (ownerException(project, actor, ownerUserId)) return;
  requireAction(db, project, actor, "accept-completion", what);
}

function userName(db: DatabaseSync, userId: string): string {
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId) as
    | { name: string }
    | undefined;
  return row?.name ?? userId;
}

function humanActorRef(db: DatabaseSync, actor: TaskActor) {
  return {
    kind: "human" as const,
    userId: actor.userId,
    nameHint: userName(db, actor.userId),
  };
}

export function taskRef(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
  return {
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  };
}

/** file write already happened — reproject the task file incrementally. */
export function reprojectTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    dataRoot: ctx.dataRoot,
  });
}

function summaryOrThrow(
  db: DatabaseSync,
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
  db: DatabaseSync,
  input: CreateTaskInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ key: string; task: TaskSummary; stageName: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "create-task", "create tasks");

  const title = input.title.trim();
  if (title.length < 3) {
    throw AppError.validation("A title of at least 3 characters is required.");
  }
  const stageId = input.stageId ?? project.stages[0]?.id ?? "triage";
  const stage = project.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw AppError.validation(`Stage ${stageId} does not exist in this project.`);
  }
  const doneStageId = project.stages[project.stages.length - 1]?.id;
  if (stageId === doneStageId) {
    throw AppError.validation("New tasks cannot be created in the done stage.");
  }

  const projectRef = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
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
    engagements: [],
    recommendations: [],
    schedules: [],
    // Operator assigned unless the task starts in triage (contracts §1.1).
    operator:
      stageId === project.stages[0]?.id
        ? null
        : { assignedAtStageId: stageId },
    urgent: input.urgent ?? false,
    validation: "none",
    workRevision: null,
    verdicts: [],
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
    dataRoot: ctx.dataRoot,
  });
  reprojectTask(db, ctx, input.projectSlug, key);

  recordAudit(db, {
    action: "task.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: key,
    projectSlug: input.projectSlug,
    taskKey: key,
    details: { title, stage: stageId },
  });

  // A dedicated operator coordinates every active task (ADR-002): auto-invoke
  // it to pick up the new task. Fire-and-forget — it never blocks or fails the
  // create, and it is a no-op when the project has no operator deployed.
  void autoInvokeOperator(db, ctx, input.projectSlug, key, "create");

  return {
    key,
    task: summaryOrThrow(db, input.projectSlug, key),
    stageName: stage.name,
  };
}

/** Edit the canonical goal, audit it, and re-engage the operator. */
export async function updateTaskGoal(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; goal: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "update-goal", "edit the task goal");
  const goal = input.goal.trim();
  if (goal.length < 3) {
    throw AppError.validation("A goal of at least 3 characters is required.");
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (existing.parsed.goal.trim() === goal) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
  }

  let clearedPacket = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.goal = goal;
    // A confirmed `edit_goal` packet decision is fulfilled by THIS edit —
    // clear the packet immediately (no operator round-trip). A blocked packet
    // lifted its own readiness gate with it.
    if (parsed.packet?.awaiting === "goal_edit") {
      const wasBlocked = parsed.packet.type === "blocked";
      parsed.packet = null;
      clearedPacket = true;
      if (wasBlocked && parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "transition",
        actor: humanActorRef(db, actor),
        title: null,
        text: "**Packet resolved:** the requested goal edit landed.",
        toAgent: false,
        evidence: null,
      });
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "policy",
      actor: humanActorRef(db, actor),
      title: "Goal updated",
      text: "The task goal / acceptance criteria were edited — downstream agents re-anchor on the new goal.",
      toAgent: false,
      evidence: null,
    });
  });
  if (clearedPacket) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  }
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.goal.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {},
  });
  // Re-engage the operator so it reads the amended goal on its next turn —
  // the dedicated trigger tells it to withdraw a now-moot scope packet
  // (resolve_decision_packet) instead of treating this as a generic poke.
  void autoInvokeOperator(db, ctx, input.projectSlug, input.taskKey, "goal-updated");

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
}

/** Best-effort operator handoff; dynamically imported to avoid a module cycle. */
async function autoInvokeOperator(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  trigger: "create" | "transition" | "goal-updated",
  /** Transition-chain depth to thread into the run (transition trigger only —
   *  see OPERATOR_TRANSITION_CHAIN_CAP). Omitted → the run starts a fresh chain. */
  transitionDepth?: number,
): Promise<void> {
  try {
    const { resolveOperatorAuthority } = await import("./operator-actions.server");
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    if (!authority.deployed) return; // no operator in this project — nothing to run
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    await runOperator(db, {
      projectSlug,
      taskKey,
      trigger,
      ...(transitionDepth !== undefined ? { transitionDepth } : {}),
      dataRoot: ctx.dataRoot,
    });
  } catch (error) {
    logger.error("auto operator invocation failed", {
      taskKey,
      trigger,
      err: error instanceof Error ? error : new Error(String(error)),
    });
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
  db: DatabaseSync,
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

  // Archived projects are read-only (R6-3). Commenting is app-wide (not gated by
  // requireAction), so guard it explicitly — an archived project's timeline is
  // frozen until it is restored.
  requireProjectMutable(loadProjectContext(ctx, input.projectSlug), "comment on this task");

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
  const { guardrailOn, guardrailValue } = await import(
    "./comment-guardrails.server"
  );
  const compactOn = guardrailOn(ctx, input.projectSlug, "compression-threshold");
  const compactAt = guardrailValue(ctx, input.projectSlug, "compression-threshold");
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
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
  });
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
              (db
                .prepare(`SELECT avatar_tone FROM users WHERE id = ?`)
                .get(actor.userId) as { avatar_tone: string | null } | undefined)
                ?.avatar_tone ?? "",
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
  /** Agent-log group to select after a reply run starts. */
  logThreadId: string | null;
  /**
   * True when an agent was mentioned but the commenter lacks the runtime role
   * (admin|maintainer) — the comment is recorded, the run is NOT triggered.
   * The route can toast about this; we never throw for a well-formed comment.
   */
  runtimeDenied: boolean;
}

/** Append a comment and, when authorized, resume or start its mentioned agent. */
export async function commentToAgent(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; text: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<CommentToAgentResult> {
  // Resolve the mentioned agent FIRST (dynamic import avoids a module cycle:
  // agent-reply → specialist-run → task-actions). We need it before appending
  // so a named mention like `@dev` still flags the comment as routed-to-agent
  // (AGENT_HANDLE_RE alone only matches the reserved backend/role handles).
  const { resolveMentionedAgent, resumeWorkdir } = await import(
    "./agent-reply.server"
  );
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
    return { ...base, agent: null, triggered: null, logThreadId: null, runtimeDenied: false };
  }

  const agentIdentity = {
    profileId: target.profileId,
    name: target.name,
    role: target.role,
  };

  // 3. RBAC: only admin|maintainer trigger runtime work. A lower role still
  //    got their comment recorded above — just skip the run (no throw).
  if (!hasRuntimeRole(db, ctx, input.projectSlug, actor)) {
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
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    const result = await runOperator(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      trigger: "manual",
      humanComment: input.text.trim(),
      dataRoot: ctx.dataRoot,
      actor: { userId: actor.userId, label: actor.label },
    });
    const logThreadId = resolveReplyLogThread(
      db,
      input.projectSlug,
      input.taskKey,
      result.runId,
    );
    return { ...base, agent: agentIdentity, triggered: "started", logThreadId, runtimeDenied: false };
  }

  const commenterName = userName(db, actor.userId);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  const title = existing?.parsed.frontmatter.title ?? input.taskKey;
  const repo = existing?.parsed.frontmatter.repo ?? projectRepoFor(ctx, input.projectSlug);

  // The follow-up prompt built from the comment (autonomous reply).
  const followUp =
    `A human (${commenterName}) commented on task ${input.taskKey} ("${title}"): ` +
    `"${input.text.trim()}". Respond to their comment directly. Continue or ` +
    `adjust your work on the repository in your working directory as needed, ` +
    `then give a concise reply.`;

  const { resumeRun } = await import(
    "~/server/runtimes/run-service.server"
  );

  let runId: string;
  let triggered: "resumed" | "started";
  let resumeOutcomeKey: string | undefined;

  if (target.session) {
    // 4a. Resume the agent's existing provider session, reusing the clone
    //     workdir so it keeps its repo context.
    const workdir = resumeWorkdir(
      input.projectSlug,
      input.taskKey,
      repo,
      ctx.dataRoot,
    );
    // Re-establish the specialist's run confinement — denylist, git ceiling,
    // MCP set, persona — that the fresh-run path applies. Without this a
    // resumed (@mention) specialist runs unconfined (XS-1).
    const { resolveResumeConfinement } = await import("./specialist-run.server");
    const confinement = resolveResumeConfinement(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: target.profileId,
      backend: target.session.backend === "codex" ? "codex" : "claude",
      role: target.role,
      delivers: target.isPrimary,
    });
    const resumed = await resumeRun(db, {
      runId: target.session.id,
      prompt: followUp,
      workdir,
      disallowedTools: confinement.disallowedTools,
      env: confinement.env,
      ...(confinement.mcpServers ? { mcpServers: confinement.mcpServers } : {}),
      ...(confinement.systemPrompt ? { systemPrompt: confinement.systemPrompt } : {}),
      // F7: re-arm the Codex outcome envelope so a resumed reviewer emits a
      // structured verdict/questions instead of falling back to the prose regex.
      ...(confinement.outputSchema ? { outputSchema: confinement.outputSchema } : {}),
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
      dataRoot: ctx.dataRoot,
      actor: { userId: actor.userId, label: actor.label },
    });
    runId = resumed.runId;
    resumeOutcomeKey = confinement.outcomeKey;
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
    const hasPrimary =
      !!existing && !!deliveringEngagement(existing.parsed.frontmatter);
    if (target.isPrimary || !hasPrimary) {
      const { assignSpecialist, startAgentRun } = await import(
        "./specialist-run.server"
      );
      if (!hasPrimary) {
        await assignSpecialist(
          db,
          { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: target.profileId },
          actor,
          ctx,
        );
      }
      const started = await startAgentRun(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        actor,
        ctx,
      );
      runId = started.runId;
    } else {
      const { assignReviewer, startAgentRun } = await import(
        "./specialist-run.server"
      );
      // Engage as a reviewer if not already (idempotent), then run as reviewer.
      await assignReviewer(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: target.profileId },
        actor,
        ctx,
      );
      const started = await startAgentRun(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: target.profileId },
        actor,
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
      profileId: target.profileId,
      role: target.role,
      delivers: target.isPrimary,
      ...(resumeOutcomeKey ? { outcomeKey: resumeOutcomeKey } : {}),
      workdir: null,
      agentHandle: target.name.toLowerCase(),
      ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
    });
  }

  // BUG 3: the Agent-logs selection id for the reply run's grouped entry. The
  // reply run is the NEWEST for this agent → the group representative, so its
  // group's RunView.id is the thread the UI should auto-select + stream. Look
  // it up from the freshly-projected grouped list (best-effort — a projection
  // hiccup just yields null and the UI simply doesn't auto-select).
  const logThreadId = resolveReplyLogThread(db, input.projectSlug, input.taskKey, runId);

  return { ...base, agent: agentIdentity, triggered, logThreadId, runtimeDenied: false };
}

/**
 * The grouped RunView.id (Agent-logs selection key) that the just-started reply
 * `runId` will appear under. Finds the grouped run whose representative is this
 * run's DB id; falls back to the run's own thread id, then null.
 */
function resolveReplyLogThread(
  db: DatabaseSync,
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

/** `run-agents` against project membership (runtime-action gate) — the single
 *  authority resolution, so an org admin passes as the audited D2 override.
 *  Non-throwing: a lower role's comment is still recorded, the run is skipped. */
function hasRuntimeRole(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
): boolean {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) return false;
  // Delegate the run-agents tier + audit to the ONE shared helper (§4g dedup).
  return canRunAgents(
    db,
    {
      slug: projectSlug,
      memberRoles: new Map(
        file.parsed.frontmatter.members.map((m) => [m.userId, m.role]),
      ),
      archived: file.parsed.frontmatter.archived === true,
    },
    actor,
    "trigger an agent run by @mention",
  );
}

function projectRepoFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): string | null {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  return file?.parsed.frontmatter.repo ?? null;
}

/** The outcome of building an agent-reply comment: a ready-to-unshift timeline
 *  event, an empty reply (no comment), or a guardrail drop. */
type PreparedReply =
  | { status: "empty" }
  | { status: "dropped" }
  | { status: "event"; event: TaskFileEvent };

/** Build the reply event without writing so completion effects can land atomically. */
async function prepareAgentReplyEvent(
  ctx: TaskMutationContext,
  projectSlug: string,
  actorRef: FileActorRef,
  replyText: string | null,
): Promise<PreparedReply> {
  if (!replyText) return { status: "empty" };
  // Anti-noise guardrails on AGENT replies (owner ruling Q3): trivial status
  // chatter is rejected; raw output dumps are trimmed to a head + reference
  // (the full transcript stays in the agent logs). Both per-project toggles.
  const { guardrailOn, isMeaninglessComment, separateEvidence } = await import(
    "./comment-guardrails.server"
  );
  if (
    guardrailOn(ctx, projectSlug, "meaningful-comment") &&
    isMeaninglessComment(replyText)
  ) {
    return { status: "dropped" };
  }
  const separated = guardrailOn(ctx, projectSlug, "evidence-separation")
    ? separateEvidence(replyText)
    : replyText;
  return {
    status: "event",
    event: {
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: actorRef,
      title: null,
      text: separated,
      toAgent: false,
      evidence: null,
    },
  };
}

/** Records the boot-recovery idempotency audit for a processed reply (keyed on
 *  `task.agent.replied`), noting a guardrail drop so a dropped reply isn't
 *  reprocessed on every restart (adversarial-review #11). */
function recordAgentRepliedAudit(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  runId: string,
  dropped: boolean,
): void {
  recordAudit(db, {
    action: "task.agent.replied",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: dropped
      ? { runId, droppedByGuardrail: "meaningful-comment" }
      : { runId },
  });
}

export async function postAgentReplyComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    actorRef: FileActorRef;
    replyText: string | null;
  },
): Promise<void> {
  const prepared = await prepareAgentReplyEvent(
    ctx,
    input.projectSlug,
    input.actorRef,
    input.replyText,
  );
  if (prepared.status === "empty") {
    logger.info("agent reply run produced no text — no comment posted", {
      taskKey: input.taskKey,
      runId: input.runId,
    });
    return;
  }
  if (prepared.status === "dropped") {
    logger.info("agent reply dropped by the meaningful-comment guardrail", {
      taskKey: input.taskKey,
      runId: input.runId,
    });
    recordAgentRepliedAudit(db, input.projectSlug, input.taskKey, input.runId, true);
    return;
  }
  // Returns the write promise so a caller (the operator react loop) can await
  // the reply landing before it re-reads the task. Errors are logged, never
  // propagated — the run finished and the transcript is in the logs.
  return updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(prepared.event);
  })
    .then(() => {
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      recordAgentRepliedAudit(db, input.projectSlug, input.taskKey, input.runId, false);
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
 * The agent's most-recent reply comment text on a task, or null when it has
 * never replied. `before` excludes comments emitted by the current run.
 */
function latestAgentReplyText(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  backend: RealBackend,
  profileId: string,
  before?: string | null,
): string | null {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) return null;
  const beforeMs = before ? Date.parse(before) : NaN;
  for (const e of file.parsed.timeline) {
    if (
      e.type === "comment" &&
      e.actor.kind === "agent" &&
      e.actor.backend === backend &&
      e.actor.profileId === profileId
    ) {
      // Skip comments from the current run (occurredAt >= run start).
      if (!Number.isNaN(beforeMs) && Date.parse(e.occurredAt) >= beforeMs) {
        continue;
      }
      return e.text;
    }
  }
  return null;
}

/** Open one recovery packet when the bounded operator loop stalls. */
async function openStuckLoopPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    agentHandle: string;
    reason: string;
    /** Failure-specific recovery options prepended to the standard three
     *  (e.g. retry_other_backend after a backend-unavailability failure). A
     *  recommended extra takes the recommendation from the default redirect. */
    extraOptions?: import("./operator-actions.server").OperatorPacketOptionInput[];
  },
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!existing || existing.parsed.packet) return; // already escalated
    const { operatorOpenPacket, resolveOperatorAuthority } = await import(
      "./operator-actions.server"
    );
    const authority = resolveOperatorAuthority(ctx, input.projectSlug, {});
    const extra = input.extraOptions ?? [];
    const extraRecommended = extra.some((o) => o.recommended);
    const result = await operatorOpenPacket(
      db,
      ctx,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title: `Work stalled — pick a recovery path`,
        body: `${input.reason} Coordination is paused until a human chooses how to proceed.`,
        observations: [
          { k: "Agent", v: `@${input.agentHandle}` },
          { k: "Signal", v: input.reason },
        ],
        options: [
          ...extra,
          {
            kind: "redirect",
            title: "Redirect with sharper guidance",
            detail: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
            ...(extraRecommended ? {} : { recommended: true }),
          },
          {
            kind: "request_edit",
            title: "Send back for another attempt",
            detail: "Ask the same specialist to try again from its last report.",
          },
          {
            kind: "hold_runtime_debug",
            title: "Hold for runtime debugging",
            detail: "Freeze coordination while the provider-native session is inspected.",
          },
        ],
      },
      authority,
    );
    if (result.outcome !== "done") {
      logger.info("stuck-loop packet not opened", {
        taskKey: input.taskKey,
        reason: result.message,
      });
    }
  } catch (error) {
    logger.warn("stuck-loop packet escalation failed", {
      taskKey: input.taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Withdraw a matching stale recovery packet after successful agent work. */
async function withdrawSupersededStuckPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    delivers: boolean;
    role: string;
    runProfileId: string;
  },
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const packet = existing?.parsed.packet;
    if (!packet || packet.type !== "blocked") return;
    if (packet.options.some((o) => o.kind === "accept_completion")) return;
    const retryOptions = packet.options.filter(
      (o) => o.kind === "retry_other_backend",
    );
    if (retryOptions.length > 0) {
      const subjectProfileId =
        retryOptions.find((o) => o.profileId)?.profileId ?? null;
      // profileId is the join key when the packet names one (a reviewer retry);
      // an UNSTAMPED option is about the primary specialist — the operator's
      // open_decision_packet option shape carries no profileId at all — so the
      // delivering agent's success is what falsifies it.
      const matches = subjectProfileId
        ? input.runProfileId === subjectProfileId
        : input.delivers;
      if (!matches) return;
    }
    let withdrawn = false;
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      const p = parsed.packet;
      // Re-check inside the write — the read above raced other writers.
      if (!p || p.type !== "blocked") return;
      if (p.options.some((o) => o.kind === "accept_completion")) return;
      parsed.packet = null;
      // A blocked packet held the readiness gate down with it (same lift as the
      // goal-edit auto-clear above).
      if (parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "transition",
        actor: { kind: "operator" },
        title: null,
        text: `**Packet withdrawn:** "${p.title}" is moot — the ${input.role} agent run completed successfully after it was opened.`,
        toAgent: false,
        evidence: null,
      });
      withdrawn = true;
    });
    if (!withdrawn) return;
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    recordAudit(db, {
      action: "task.packet.withdrawn_superseded",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { delivers: input.delivers, role: input.role },
    });
  } catch (error) {
    logger.warn("superseded-packet withdrawal failed", {
      taskKey: input.taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Classify a reviewer's reply into a verdict (FR15/FR35). Conservative: returns
 * a verdict only on a clear signal, else null (no validation change). Pure —
 * exported for tests.
 */
export function classifyReviewerVerdict(
  text: string | null,
): "request_changes" | "approve" | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // 1. An EXPLICIT verdict line is the strongest signal and reviewers emit one
  //    ("Verdict: approve", "## Review verdict — PASS"). It wins over incidental
  //    words elsewhere in the prose, so a thorough APPROVE that happens to say
  //    "no tests fail" is not misread as a rejection.
  const verdictApprove = /verdict[\s:—–-]*\**\s*(pass|approv|lgtm|ship it)/.test(t);
  const verdictReject =
    /verdict[\s:—–-]*\**\s*(fail|request|reject|chang|block|no-?go)/.test(t);
  if (verdictReject && !verdictApprove) return "request_changes";
  if (verdictApprove && !verdictReject) return "approve";

  // 2. Strong request-changes PHRASES always count (assertive, not negated).
  if (
    /request(ing)?\s+changes?/.test(t) ||
    /\bchanges? (are )?(required|needed|requested)\b/.test(t) ||
    /\bnothing (was )?implemented\b/.test(t) ||
    /\bno-?op\b/.test(t) ||
    /\bnot (yet )?(implemented|done|complete)\b/.test(t) ||
    /\breject(ed|s|ing)?\b/.test(t)
  ) {
    return "request_changes";
  }

  // 3. Weak negatives ("fail", "failure", "blocker") ONLY count when NOT
  //    locally negated — "no blockers" / "none of the tests fail" / "nothing
  //    fails" / "doesn't fail" are POSITIVE. Scan each occurrence's preceding
  //    context for a negator (a bare `/\bfail\b/` test misclassified clean
  //    approvals — the bug this guard fixes).
  for (const m of t.matchAll(/\b(fail(?:ed|ing|s|ures?)?|blockers?)\b/g)) {
    const pre = t.slice(Math.max(0, m.index - 28), m.index);
    // A negator anywhere in the local lead-in flips it positive. `n't` is a
    // contraction suffix (don't/doesn't/won't) so it needs no leading boundary.
    if (
      !/(?:\b(?:no|not|none|nothing|zero|without|never|any)\b|n't)[^.!?]*$/.test(
        pre,
      )
    ) {
      return "request_changes";
    }
  }

  if (
    /\bapprove(d|s)?\b/.test(t) ||
    /\blgtm\b/.test(t) ||
    /\blooks good to merge\b/.test(t) ||
    /\bready (to|for) (merge|accept)/.test(t) ||
    /\bno (blocking )?issues\b/.test(t)
  ) {
    return "approve";
  }
  return null;
}

/** Atomically record a finished run's reply, verdict, and human question. */
export async function recordAgentCompletion(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  input: {
    actorRef: FileActorRef;
    runId: string;
    /** The prose reply (Claude full text · Codex envelope summary). */
    replyText: string | null;
    verdict: "approve" | "request_changes" | null;
    question: AgentOutcomeQuestion | null;
  },
): Promise<void> {
  const { actorRef, runId, replyText, verdict, question } = input;
  const prepared = await prepareAgentReplyEvent(
    ctx,
    projectSlug,
    actorRef,
    replyText,
  );
  // Nothing to record at all.
  if (!verdict && !question && prepared.status !== "event") {
    // Still stamp the recovery-idempotency audit for a guardrail-dropped reply,
    // so boot recovery doesn't reprocess it forever.
    if (prepared.status === "dropped") {
      recordAgentRepliedAudit(db, projectSlug, taskKey, runId, true);
    }
    return;
  }
  const roleDisplay =
    actorRef.kind === "agent" ? agentRoleDisplay(actorRef) : "Agent";
  let questionOpened = false;
  let validation: TaskFrontmatter["validation"] = "healthy";
  // The title/summary are computed from the RESOLVED (derived) validation, not
  // the raw verdict, so the event can never read "Review passed / Validation:
  // failing" (F7-REV3): an approve that lands while another required reviewer is
  // outstanding (or requesting changes) on the current revision is an "Approval
  // noted, rework still needed", NOT a pass.
  let title = "";
  let summary = "";
  try {
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      if (verdict) {
        // F10-15: bind the verdict to the CURRENT work revision, last-write-wins
        // per (profileId, revisionId). A NEW revision (delivered head/tree
        // change) makes it stale automatically — no comment/stage-bounce
        // heuristic (F10-32). The derived `validation` cache is then recomputed
        // from the required reviewers' verdicts on the current revision.
        const rev = parsed.frontmatter.workRevision;
        const reviewerProfileId =
          actorRef.kind === "agent" ? actorRef.profileId : null;
        if (rev && reviewerProfileId) {
          parsed.frontmatter.verdicts = [
            ...parsed.frontmatter.verdicts.filter(
              (v) =>
                !(v.profileId === reviewerProfileId && v.revisionId === rev.id),
            ),
            {
              profileId: reviewerProfileId,
              revisionId: rev.id,
              headSha: rev.headSha,
              result: verdict,
              reason: (replyText ?? "").trim().slice(0, 2000),
              at: new Date().toISOString(),
            },
          ];
        }
        validation = deriveValidation(parsed.frontmatter);
        parsed.frontmatter.validation = validation;
        if (verdict === "request_changes") {
          title = "Changes requested";
          summary = `${roleDisplay} requested changes.`;
        } else if (!rev || !reviewerProfileId) {
          // Approve with nothing to bind to — no delivered revision yet. Record
          // the prose but never claim a pass.
          title = "Approval noted";
          summary = `${roleDisplay} approved, but there is no delivered revision to bind the verdict to yet.`;
        } else if (validation === "healthy") {
          title = "Review passed";
          summary = `${roleDisplay} approved the work.`;
        } else {
          // Approved, but not yet cleared: another required reviewer is
          // outstanding or has requested changes on the current revision.
          title = "Approval noted — rework still needed";
          summary = `${roleDisplay} approved, but the current revision is not yet cleared by all required reviewers.`;
        }
        // A not-yet-acceptable state makes a pending accept-completion
        // recommendation stale (the acceptance gate would 409), so drop it: the
        // UI must not show a misleading "Accept completion" card. The operator
        // re-recommends the right next step on its next turn.
        if (validation !== "healthy") {
          parsed.frontmatter.recommendations =
            parsed.frontmatter.recommendations.filter(
              (r) => r.kind !== "accept_completion",
            );
        }
      }
      // ATOMIC: the agent's reply comment, its verdict, and its question land
      // in this ONE write. Unshift the reply first, then the verdict, so the
      // verdict reads newest and the agent's reply sits just below it.
      if (prepared.status === "event") parsed.timeline.unshift(prepared.event);
      if (verdict) {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "quality",
          // D8: the outcome is the AGENT'S judgment — attribute it honestly.
          actor: actorRef,
          title,
          text: `**Validation:** ${validation}. ${summary}`,
          toAgent: false,
          evidence: null,
        });
      }
      // Ask-human question from the outcome envelope (Codex transport; the
      // Claude toolkit opens its packet live mid-run). One packet slot per
      // task — never clobber an open decision.
      if (question && !parsed.packet) {
        parsed.packet = buildAgentQuestionPacket(actorRef, question);
        parsed.frontmatter.waiting = "human";
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: actorRef,
          title: null,
          text: `**Question for a human:** ${question.title.trim()}`,
          toAgent: false,
          evidence: null,
        });
        questionOpened = true;
      }
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    // Recovery-idempotency audit for the reply (posted or guardrail-dropped).
    if (prepared.status !== "empty") {
      recordAgentRepliedAudit(
        db,
        projectSlug,
        taskKey,
        runId,
        prepared.status === "dropped",
      );
    }
    if (questionOpened) {
      recordAudit(db, {
        action: "task.agent.packet_opened",
        actor: OPERATOR_AUDIT_ACTOR,
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: { runId, title: question!.title.trim() },
      });
      notifyTaskWatchers(
        db,
        {
          projectSlug,
          taskKey,
          kind: "approval",
          title: `${roleDisplay} asks: ${question!.title.trim()}`,
          text: question!.body ?? "An engaged agent needs a human decision.",
        },
        ctx,
      );
    }
    if (verdict) {
      recordAudit(db, {
        action: "task.quality.flagged",
        actor: OPERATOR_AUDIT_ACTOR,
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: { verdict, validation, actorRef: encodeActorRef(actorRef) },
      });
      // Ping the owner + supervisors so the quality inbox card appears on real
      // runs (not just seed). Each recipient's `quality` routing pref is honored
      // inside notifyTaskWatchers → createNotification.
      notifyTaskWatchers(
        db,
        { projectSlug, taskKey, kind: "quality", title, text: summary },
        ctx,
      );
    }
  } catch (error) {
    logger.warn("agent completion recording failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Register the single completion pipeline: record, reconcile, and continue coordination. */
export async function registerAgentCompletion(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    backend: RealBackend;
    /** The engaged profile's stable identity. */
    profileId: string;
    role: string;
    /** The engagement owns the workspace/branch/PR (G1) — gates delivery
     *  reconcile + the single-flight semantics; NEVER a behavior kind. */
    delivers: boolean;
    /** Staging key for a Claude toolkit report_outcome envelope (absent for
     *  Codex/recovered runs — their envelope re-parses from the stored reply). */
    outcomeKey?: string;
    workdir: string | null;
    /** The agent's @mention handle, for the stuck-loop packet copy. */
    agentHandle: string;
    /** Present when started inside an operator react loop (continue the chain). */
    operatorRun?: { backend: RealBackend; autonomy: OperatorAutonomy; reactDepth: number };
  },
): Promise<void> {
  // Persist the staging key on the run row so boot recovery can re-find the
  // staged report_outcome envelope after a restart (AO-1) — the in-process
  // callback below holds it only in a closure that dies with the process.
  if (input.outcomeKey) {
    db.prepare(`UPDATE agent_runs SET outcome_key = ? WHERE id = ?`).run(
      input.outcomeKey,
      input.runId,
    );
  }
  const { registerRunCompletion } = await import(
    "~/server/runtimes/run-service.server"
  );
  registerRunCompletion(input.runId, (finished) => {
    void applyAgentCompletionEffects(db, ctx, input, {
      id: finished.id,
      state: finished.state,
    }).catch((error: unknown) => {
      logger.error("agent-run completion handler failed", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }, db);
}

/**
 * The completion EFFECTS (reply → reconcile → verdict → react/stuck-packet/
 * waiting-flip) — shared by the live callback above and the boot-recovery
 * reconciler, so a run recovered after a restart behaves byte-for-byte like one
 * whose callback fired in-process.
 */
export async function applyAgentCompletionEffects(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    backend: RealBackend;
    profileId: string;
    role: string;
    delivers: boolean;
    outcomeKey?: string;
    workdir: string | null;
    agentHandle: string;
    operatorRun?: { backend: RealBackend; autonomy: OperatorAutonomy; reactDepth: number };
  },
  finished: { id: string; state: string },
): Promise<void> {
  const { fullReplyTextForRun } = await import("./agent-reply.server");
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: input.backend,
    profileId: input.profileId,
    roleHint: input.role,
  };
  // The timeline comment stores the FULL reply (2026-07-17 ruling — the old
  // 1,200-char cap made "(truncated — full report in the agent logs)" the only
  // way to read a long report; the timeline UI clamps + expands instead). The
  // operator snapshot caps per-comment text on ITS side, so prompts stay
  // bounded.
  const fullText = fullReplyTextForRun(db, finished.id);
  // The prior reply must predate THIS run so a mid-run post_comment from this
  // same run can't be mistaken for it (corrupting no-progress detection).
  const thisRunStartedAt = getRun(db, finished.id)?.started_at ?? null;
  const prevReply = latestAgentReplyText(
    ctx,
    input.projectSlug,
    input.taskKey,
    input.backend,
    input.profileId,
    thisRunStartedAt,
  );
  // 1. Resolve this run's OUTCOME ENVELOPE (G4) + collaboration gates, then
  //    land the reply + verdict + question in ONE atomic write for EVERY
  //    finished run (the reviewer's atomic path is now the universal path —
  //    the two-write split silently lost comments on the docker bind mount).
  //    A non-finished run (interrupt) has no outcome; it still reports its
  //    partial reply below.
  const {
    parseAgentOutcomeJson,
    resolveAgentCollab,
    takeStagedOutcome,
  } = await import("./agent-outcome.server");
  // Gates resolve at COMPLETION time from the live deployment (recovery gets
  // identical behavior); an undeployed profile falls back to the transition
  // defaults (supporting → verdict on, delivering → verdict off).
  let grants: { capabilityId: string; mode: "direct" | "recommend" | "human" | "off" }[] = [];
  if (input.profileId) {
    try {
      const { resolveDeployedSpecialist } = await import("./specialist-run.server");
      grants = resolveDeployedSpecialist(
        ctx,
        input.projectSlug,
        input.profileId,
      ).capabilities;
    } catch {
      // undeployed — defaults apply
    }
  }
  const collab = resolveAgentCollab(grants);
  // F10-15 consistency: the REQUIRED-reviewer set (acceptanceBlockedReason /
  // requiredReviewers) is computed from the engagement's engage-time
  // `verdictCapable` snapshot. Verdict RECORDING must use the SAME source, or a
  // required reviewer whose live grant was later removed/undeployed can approve
  // but never record — leaving the task un-acceptable forever (neither accept
  // path has a force bypass). Prefer the engagement snapshot; fall back to the
  // live grant only when there is no engagement row (legacy/ad-hoc runs).
  const verdictEngagement = input.profileId
    ? readTaskFile(
        taskRef(ctx, input.projectSlug, input.taskKey),
      )?.parsed.frontmatter.engagements.find(
        (e) => e.profileId === input.profileId,
      )
    : null;
  const verdictAuthorized = verdictEngagement
    ? verdictEngagement.verdictCapable === true
    : collab.verdict;
  // Envelope: a Claude toolkit-staged outcome first; else a Codex
  // outputSchema reply (JSON) parsed from the stored full text.
  let outcome = input.outcomeKey ? takeStagedOutcome(db, input.outcomeKey) : null;
  let replyText = fullText;
  if (!outcome && input.backend === "codex" && fullText) {
    const parsedEnvelope = parseAgentOutcomeJson(fullText);
    if (parsedEnvelope) {
      outcome = parsedEnvelope;
      // The raw JSON must never become the timeline comment.
      replyText = parsedEnvelope.summary ?? null;
    }
  }
  if (!replyText && outcome?.summary) replyText = outcome.summary;
  if (finished.state === "finished") {
    // Verdict: envelope first; a verdict-AUTHORIZED agent with no envelope falls
    // back to the prose classifier (G4). The regex NEVER runs without authority
    // (R1 — a developer's "tests pass" can't flip validation).
    let verdict = verdictAuthorized ? (outcome?.verdict ?? null) : null;
    if (!verdict && verdictAuthorized) {
      verdict = classifyReviewerVerdict(replyText);
      if (verdict) {
        logger.info("agent verdict resolved by prose fallback (no envelope)", {
          taskKey: input.taskKey,
          runId: finished.id,
          verdict,
        });
      } else {
        // F10: a verdict-GRANTED agent finished but neither the structured
        // envelope nor the prose classifier produced a verdict. Behaviour is
        // fail-safe — validation is LEFT UNCHANGED (never silently flipped to
        // `healthy`), so acceptance stays gated on whatever it was — but the
        // reviewer's judgment was effectively lost, so flag the anomaly loudly
        // for monitoring rather than dropping it in silence.
        logger.warn(
          "verdict-granted agent finished with NO determinable verdict — validation left unchanged (not marked healthy)",
          {
            taskKey: input.taskKey,
            runId: finished.id,
            backend: input.backend,
            profileId: input.profileId,
          },
        );
      }
    }
    // P11-26: question authority deliberately uses the LIVE ask grant, not the
    // engage-time snapshot the verdict path uses. The snapshot exists ONLY for
    // verdicts, where a live-grant read would let a removed grant leave a task
    // permanently un-acceptable (a required reviewer that can approve but never
    // record). A question is open-only — it never blocks acceptance — so there
    // is no equivalent hazard, and honoring the current grant (an admin who just
    // revoked ask-human means it now) is the correct behavior. The asymmetry is
    // intentional, not an oversight.
    const question = collab.ask ? (outcome?.question ?? null) : null;
    await recordAgentCompletion(db, ctx, input.projectSlug, input.taskKey, {
      actorRef,
      runId: finished.id,
      replyText,
      verdict,
      question,
    });
  } else {
    await postAgentReplyComment(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: finished.id,
      actorRef,
      replyText,
    });
  }
  // 1b. A run that ENDED IN ERROR (backend quota/auth/crash) previously left NO
  //     trace on the timeline and never re-invoked the operator — the task just
  //     silently reverted to waiting=human (F8). Surface the failure as a typed
  //     event, escalate a recovery packet so it reaches a human's queue, and stop
  //     (no reconcile/verdict/react on a failed run). Interrupts are a deliberate
  //     human action and are handled elsewhere, so only `error` lands here.
  if (finished.state === "error") {
    const { runFailureReason } = await import("./agent-reply.server");
    const failure = runFailureReason(db, finished.id);
    const backendLabel = input.backend === "claude" ? "Claude Code" : "Codex";
    const roleLabel = "agent";
    const failText = failure?.text
      ? failure.text.length > 180
        ? failure.text.slice(0, 177) + "…"
        : failure.text
      : "";
    const reasonText =
      failure?.kind === "quota"
        ? `${backendLabel} is over its usage quota`
        : failure?.kind === "auth"
          ? `${backendLabel} rejected the credentials`
          : failure?.kind === "unavailable"
            ? `${backendLabel} is unavailable (no usable credential configured — the run was refused, no agent process started)`
            : failure?.kind === "max_turns"
              ? `the ${backendLabel} run hit its turn cap and was CUT OFF mid-work — not a task failure (its partial report, if any, is above)`
              : failText
                ? `${backendLabel} run failed: ${failText}`
                : `the ${backendLabel} run ended in an error`;
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "blocked",
        actor: actorRef,
        title: null,
        text: `The ${input.role} ${roleLabel} run did not complete — ${reasonText}.${
          failure?.kind === "max_turns" ? "" : " No changes were delivered."
        }${
          failure?.kind === "quota" || failure?.kind === "auth"
            ? " Retry on the other backend, or fix the credential and re-run."
            : failure?.kind === "unavailable"
              ? " Configure a credential for this backend, or retry on the other backend."
              : failure?.kind === "max_turns"
                ? " Re-prompt the agent to continue from its session, or raise the turn cap (VIBERR_CLAUDE_MAX_TURNS)."
                : ""
        }`,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    // Backend-level failure (quota / auth / no credential): the packet's first
    // recovery option is a one-click retry on the OTHER backend (D4) — the
    // switch persists to the assignment, so later operator prompts follow it.
    const backendFailure =
      failure?.kind === "quota" ||
      failure?.kind === "auth" ||
      failure?.kind === "unavailable";
    const altBackend: RealBackend = input.backend === "codex" ? "claude" : "codex";
    const altLabel = altBackend === "claude" ? "Claude Code" : "Codex";
    const failedProfileId = input.profileId;
    const retryOption =
      backendFailure
        ? [
            {
              kind: "retry_other_backend" as const,
              title: `Retry on ${altLabel}`,
              detail: `Re-run the ${roleLabel} on ${altLabel} with a fresh context. The switch sticks — later prompts follow it.`,
              recommended: true,
              backend: altBackend,
              profileId: failedProfileId,
            },
          ]
        : [];
    await openStuckLoopPacket(db, { ...ctx, operatorAuthorized: true }, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      agentHandle: input.agentHandle,
      reason: `The ${input.role} ${roleLabel} run failed — ${reasonText}.`,
      ...(retryOption.length ? { extraOptions: retryOption } : {}),
    });
    notifyTaskWatchers(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        kind: "quality",
        text: `${input.role} run failed — ${reasonText}.`,
      },
      ctx,
    );
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  // 1c. A SUCCESSFUL run withdraws a stale "work stalled" packet about this
  //     same agent (owner ruling 2026-07-18) — done BEFORE the operator reacts
  //     so its snapshot already sees the packet gone instead of asking a human
  //     to dismiss it. Completion/acceptance packets are never touched.
  if (finished.state === "finished") {
    await withdrawSupersededStuckPacket(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      delivers: input.delivers,
      role: input.role,
      runProfileId: input.profileId,
    });
  }
  // 2. Reconcile agent-side delivery (NFR15) — real PRIMARY runs only. A
  //    reviewer (F7-REV1) delivers nothing: it clones the repo to READ the diff,
  //    so its workspace HEAD/branch is incidental. Reconciling delivery off a
  //    reviewer's clone raced the reviewer's just-posted reply comment (its
  //    read-modify-write of task.md could drop it) and could stamp task.md's
  //    branch/pr from the reviewer's checkout. Only the specialist that produced
  //    the change reconciles delivery.
  if (input.delivers && finished.state === "finished") {
    const { reconcileWorkspaceDelivery } = await import(
      "~/server/github/workspace-delivery.server"
    );
    await reconcileWorkspaceDelivery({
      db,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      backend: input.backend,
      profileId: input.profileId,
      role: input.role,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      dataRoot: ctx.dataRoot,
    }).catch((error) => {
      // F13: best-effort (must not break completion) but no longer SILENT — a
      // delivery-reconcile failure (git/network) was invisible, so a broken
      // branch/PR link went undiagnosed. Surface it for operators.
      logger.warn("post-run delivery reconcile failed (best-effort)", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }
  // 3. (The verdict/question are recorded ATOMICALLY with the reply in step 1
  //    — there is no separate verdict write to race anything.)
  // 4. React: continue an operator chain, or start a fresh one against the
  //    deployed operator. Resolve the effective react context.
  const { resolveOperatorAuthority } = await import("./operator-actions.server");
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
  // No-progress detection compares the STORED comment forms (adversarial-
  // review #4): both sides must be the same form or a repeat never matches.
  // Comments now store the FULL reply, so compare `fullText` against
  // `prevReply` (the prior stored comment — also full for new comments; a
  // legacy truncated prevReply simply won't match, which errs toward reacting
  // and is bounded by the depth cap).
  // Compare + hand off the RESOLVED prose reply (a Codex envelope run's
  // fullText is raw JSON — the stored comment and the operator both see the
  // summary, so both sides of the comparison must too).
  const shouldReact = operatorShouldReactToReply(
    finished.state,
    replyText,
    prevReply,
    currentDepth,
  );
  if (!shouldReact) {
    const noProgress =
      !!replyText && prevReply !== null && prevReply.trim() === replyText.trim();
    const depthCapped =
      !!replyText &&
      !noProgress &&
      finished.state === "finished" &&
      currentDepth >= OPERATOR_REACT_DEPTH_CAP;
    if (noProgress) {
      logger.info("operator react skipped — agent made no progress (repeated its reply)", {
        taskKey: input.taskKey,
        runId: finished.id,
      });
    }
    if (noProgress || depthCapped) {
      await openStuckLoopPacket(db, { ...ctx, operatorAuthorized: true }, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        agentHandle: input.agentHandle,
        reason: noProgress
          ? "The agent repeated its previous report verbatim — no forward progress."
          : `The coordination loop hit its ${OPERATOR_REACT_DEPTH_CAP}-cycle depth cap without reaching a boundary.`,
      });
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
  await runOperator(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    trigger: "agent-reply",
    reactDepth: currentDepth + 1,
    backend: reactBackend,
    autonomy: reactAutonomy,
    // Hand the reply DIRECTLY to the react turn. The operator used to depend
    // on the timeline comment for the agent's report — when that comment went
    // missing (stale bind-mount read, guardrail drop), the operator re-prompted
    // the next agent with no findings ("pull up the reviewer's comments…").
    // The run store is the source of truth for the reply; the prompt carries it.
    ...(replyText ? { agentReply: replyText } : {}),
    dataRoot: ctx.dataRoot,
  });
}

/** Flip a task from `waiting: agent` back to `waiting: human` once no further
 *  agent work follows a completion. No-op when it's already not agent-waiting.
 *  Exported for the operator lease release (settle after the last drive). */
export async function clearWaitingToHuman(
  db: DatabaseSync,
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

/** Set `waiting: agent` when a provider run is put in flight, so the
 *  board reads "working" (not "waiting on human") while the agent runs. */
export async function markWaitingAgent(
  db: DatabaseSync,
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
  db: DatabaseSync,
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
  await updateTaskFile(taskRef(opCtx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(comment);
  });
  reprojectTask(db, opCtx, input.projectSlug, input.taskKey);

  // 2. Trigger the agent's run with the operator's directive as its turn focus.
  const { startAgentRun } = await import("./specialist-run.server");
  let runId: string;
  if (input.kind === "reviewer") {
    if (!input.profileId) {
      throw AppError.validation("A reviewer profile id is required to run a reviewer.");
    }
    const started = await startAgentRun(
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
    const started = await startAgentRun(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, directive },
      OPERATOR_TASK_ACTOR,
      opCtx,
    );
    runId = started.runId;
  }

  // 3. The completion handler (reply → reconcile → verdict → react) is already
  //    installed by startAgentRun above, which read
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
 * Take or hand off ownership. Exact typed `assign` event copy from
 * task-detail spec §5.2. RBAC: any project member may take (all four
 * roles hold the "Take / release task ownership" grant); handing off
 * requires being the current owner or a project admin, and the target
 * must be a member.
 */
export async function setOwner(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; targetUserId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const actorRole = requireAction(
    db,
    project,
    actor,
    "own-task",
    "take or assign task ownership",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  const isTake = input.targetUserId === actor.userId;
  if (!isTake) {
    // Hand off: current owner, or the tier that may manage OTHERS' ownership
    // (`release-any-ownership` — admin today, single-sourced in ACTION_ROLES
    // instead of a hardcoded role literal); target must be able to OWN
    // (contributor+ — a viewer is read+comment only and can't hold the owner seat).
    if (currentOwnerId !== actor.userId && !roleCan(actorRole, "release-any-ownership")) {
      throw AppError.forbidden("Only the current owner or a project admin can hand off ownership.");
    }
    const targetRole = project.memberRoles.get(input.targetUserId);
    if (!targetRole || !roleCan(targetRole, "own-task")) {
      throw AppError.forbidden(
        "Ownership can only be handed to a project member who can own tasks (contributor or above).",
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

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.ownerUserId = input.targetUserId;
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: isTake ? "task.ownership.taken" : "task.ownership.handed_off",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      previousOwnerUserId: currentOwnerId,
      newOwnerUserId: input.targetUserId,
    },
  });

  // Ownership is a human bookkeeping action (claiming the review/acceptance
  // seat) — deliberately orthogonal to operator scheduling, so the operator is
  // NOT auto-invoked here. It is driven by its real lifecycle triggers (task
  // creation, stage transitions, goal updates, @mentions, and the explicit
  // "Run operator" control). The former reaction (a ready/agent flip + a
  // synthesized "scheduling execution" narration + a fire-and-forget run) only
  // animated the seeded VIB-148 demo — its trigger was a hardcoded
  // `**Quality gate:**` text match the real operator never emits — and was
  // removed with that mock stand-in (F19).

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/**
 * Release ownership. Any member releases their own seat; project admins
 * may release anyone (recorded as an admin action in audit + event copy).
 */
export async function releaseOwner(
  db: DatabaseSync,
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
    requireAnyMember(db, project, actor, "release task ownership");
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  const isSelf = currentOwnerId === actor.userId;
  if (isSelf) {
    // Releasing your OWN seat: needs the own-task capability (contributor+).
    requireAction(db, project, actor, "own-task", "release task ownership");
  } else {
    // Releasing SOMEONE ELSE's seat: admin only (release-any-ownership).
    requireAction(db, project, actor, "release-any-ownership", "release another member's ownership");
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

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.ownerUserId = null;
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: isSelf ? "task.ownership.released" : "task.ownership.admin_released",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { previousOwnerUserId: currentOwnerId, forced: !isSelf },
  });

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

// -------------------------------------------------------------- transition

/** Apply a declared workflow transition with its configured authority boundary. */
export async function transitionStage(
  db: DatabaseSync,
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
    /** Operator rework routing (R7-4): a BACKWARD move to an earlier stage on a
     *  task whose latest review is `failing`, so the operator can send a
     *  rejected task back to the developer without a human. Only honored under
     *  operator authority; validated below (must be backward + validation
     *  failing). Off-graph like `manual`, but operator-scoped and rework-gated. */
    rework?: boolean;
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
  // Operator rework routing (R7-4): a backward move on a `failing` task is a
  // legitimate off-graph transition (the governed graph is forward-only). Vet it
  // here so it can't be abused for a forward jump or on a healthy task.
  const fromIndex = project.stages.findIndex((s) => s.id === fromStageId);
  const toIndex = project.stages.findIndex((s) => s.id === input.toStageId);
  const isReworkMove =
    input.rework === true &&
    ctx.operatorAuthorized === true &&
    toIndex >= 0 &&
    toIndex < fromIndex &&
    existing.parsed.frontmatter.validation === "failing";
  if (!boundary && !input.manual && !isReworkMove) {
    throw AppError.validation(
      `No governed boundary from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`,
    );
  }

  const firstStageId = project.stages[0]?.id;
  const lastStageId = project.stages[project.stages.length - 1]?.id;

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
      throw AppError.forbidden(
        "The operator reaches Done only by accepting completion, not a bare transition.",
      );
    }
  } else if (input.manual) {
    // Manual stage override (board/task dropdown) — a maintainer-level action,
    // regardless of the boundary crossed (forward, backward, or off-graph).
    requireAction(db, project, actor, "approve-transition", "change the task stage");
  } else if (boundary!.boundary === "auto") {
    // An auto boundary crossed by a human (unreachable from the UI, which always
    // sends manual:true) — the loosest gate: any member.
    requireAnyMember(db, project, actor, "move this task");
  } else if (boundary!.boundary === "approval") {
    requireAction(db, project, actor, "approve-transition", "approve stage transitions");
  } else {
    // human boundary (review→done locked in V1): acceptance authority, with the
    // task-owner exception (R6-2) — the owner may accept its own completion.
    requireAcceptCompletion(
      db,
      project,
      actor,
      existing.parsed.frontmatter.ownerUserId,
      "accept completion into Done",
    );
  }

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "transition",
    actor: ctx.operatorAuthorized ? { kind: "operator" } : humanActorRef(db, actor),
    title: null,
    text: ctx.operatorAuthorized
      ? `**Transition:** operator moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`
      : `**Transition:** moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`,
    toAgent: false,
    evidence: null,
  };

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
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
    if (
      fromStageId === firstStageId &&
      input.toStageId !== firstStageId &&
      parsed.frontmatter.readiness === "input_required"
    ) {
      parsed.frontmatter.readiness = "ready";
    }
    // F10-15/F10-32: validation is now DERIVED from the current work revision +
    // per-reviewer verdicts, so review entry no longer laundates it. A bare
    // re-entry can NOT clear a standing `failing` — that only happens when a NEW
    // work revision is delivered (which makes prior verdicts stale). Just
    // recompute the derived cache so the board pill is fresh on entry.
    if (input.toStageId === reviewStageIdOf(project)) {
      parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
    }
    // A stage move makes any pending transition recommendation stale — drop it
    // so a Done task never shows a "move to <stage>" card.
    parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
      (r) => r.kind !== "transition",
    );
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.transition",
    actor: ctx.operatorAuthorized
      ? OPERATOR_AUDIT_ACTOR
      : { userId: actor.userId, label: actor.label },
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
    },
  });

  // Approving a requested transition resolves its approval notifications.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  // A stage transition is a coordination trigger: ANY move of a task onto a new
  // (non-Done) stage hands off to the operator so it picks the task up AT THAT
  // STAGE and does the stage-right thing (ADR-002 — one operator per active
  // task). This includes the operator's OWN transitions: a single operator run
  // may advance only one auto boundary (e.g. Triage → Ready) and stop, which
  // used to strand the task at a pre-work stage with `waiting: human` and no
  // packet (P11-70). `runOperator` holds a single-flight process lease per task
  // and QUEUES a trigger that arrives mid-run (newest wins), firing it when the
  // current drive ends; the chain normally terminates once the operator reaches
  // a stage where it deploys a specialist and waits (a specialist run is not a
  // transition) or opens a packet. That termination is model behavior, not
  // structure — so consecutive OPERATOR-authored transitions also thread a
  // depth (`transitionDepth`, the reactDepth idiom) and a hard cap turns a
  // runaway transition loop into a stuck-loop packet instead of unbounded LLM
  // spend. Any human or agent-reply trigger restarts the chain at 0.
  // Fire-and-forget — it never blocks or fails the transition, and it is a
  // no-op when no operator is deployed.
  if (input.toStageId !== lastStageId) {
    const chainDepth = nextTransitionChainDepth(ctx);
    if (chainDepth >= OPERATOR_TRANSITION_CHAIN_CAP) {
      logger.warn(
        "operator transition chain hit its depth cap — pausing auto-coordination",
        { taskKey: input.taskKey, toStageId: input.toStageId, depth: chainDepth },
      );
      // Same escalation the react loop uses at ITS cap: a blocked packet a
      // human resolves (best-effort — no-ops if one is already open). The
      // resolution itself is the human action that restarts coordination.
      await openStuckLoopPacket(db, { ...ctx, operatorAuthorized: true }, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        agentHandle: "operator",
        reason:
          `The operator made ${OPERATOR_TRANSITION_CHAIN_CAP} consecutive stage ` +
          `transitions with no agent run or human action in between — a coordination loop.`,
      });
    } else {
      void autoInvokeOperator(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        "transition",
        chainDepth,
      );
    }
  }

  // Delivery spine (FR31): entering the REVIEW stage is the point a PR is
  // opened for review — the developer's branch is put up for human-authorized
  // review, carrying a link back to this task. Best-effort + fire-and-forget:
  // it degrades cleanly (no throw) when the repo/PAT isn't configured, so a
  // transition never fails on GitHub state. The review stage is the one with a
  // governed edge into the final (Done) stage.
  const reviewStageId = reviewStageIdOf(project);
  if (reviewStageId && input.toStageId === reviewStageId) {
    void openReviewPrBestEffort(db, ctx, input.projectSlug, input.taskKey, actor);
  }

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/**
 * Whether the server-owned Review push may commit+push the delivering profile's
 * workspace (F10-03). Resolves the DELIVERING profile's `execute-code-or-write-repo`
 * authorization; a withheld grant → false. P11-13: when a deliverer is NAMED but
 * its profile can no longer be resolved (undeployed between the run and Review),
 * fall back CONSERVATIVE (false) — never push a workspace whose grant we can't
 * confirm. Only a task with NO deliverer at all (no grant to enforce) is
 * permissive. Extracted + exported so the guard is unit-tested directly.
 */
export async function resolveDeliveryPushGrant(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<boolean> {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const deliverer = file ? deliveringEngagement(file.parsed.frontmatter) : null;
  if (!deliverer) return true; // no grant to enforce
  try {
    const { resolveDeployedSpecialist } = await import(
      "~/server/tasks/specialist-run.server"
    );
    const { resolveDeliveryPermissions } = await import(
      "~/server/tasks/specialist-tool-policy"
    );
    const resolved = resolveDeployedSpecialist(ctx, projectSlug, deliverer.profileId);
    return resolveDeliveryPermissions(resolved.capabilities).canCommitPush;
  } catch {
    // Known deliverer, unresolvable grant → conservative deny.
    return false;
  }
}

/** Push and open the review PR without letting GitHub failure break the transition. */
async function openReviewPrBestEffort(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<void> {
  const dataCtx = { dataRoot: ctx.dataRoot };
  try {
    const canCommitPush = await resolveDeliveryPushGrant(ctx, projectSlug, taskKey);

    // 1. Push the workspace commits to the remote task branch (best-effort).
    const { pushWorkspaceBranch } = await import(
      "~/server/github/push-workspace.server"
    );
    const push = await pushWorkspaceBranch({
      db,
      projectSlug,
      taskKey,
      canCommitPush,
      ...dataCtx,
    });
    if (push.status !== "pushed" && push.status !== "up_to_date") {
      logger.info("workspace push before review PR did not push", {
        taskKey,
        status: push.status,
      });
    }

    // P11-12: a capability-policy refusal is NOT an empty delivery — surface it
    // as its own signal so a human sees the branch was blocked, not stalled.
    if (push.status === "grant_withheld") {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery withheld by policy",
        `${taskKey} reached Review but its delivering agent's repo-write capability is ` +
          `withheld, so its workspace branch was not pushed. Grant the capability or ` +
          `deliver the change by hand before accepting.`,
      );
      return;
    }

    // P11-11: a push that FAILED (bad/absent credential, non-zero git push) can
    // leave the remote carrying stale or partial content while the PR still
    // opens over it — a silent "newest work is missing" hazard. Surface it.
    if (push.status === "push_failed" || push.status === "no_pat") {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery push failed",
        `${taskKey} reached Review but pushing its execution branch failed (${push.status}). ` +
          `Any review PR may not reflect the newest commits — check the credential and re-scan.`,
      );
      // Still attempt the PR below (a prior push may carry earlier content), now
      // that the failure is visible.
    }

    // P11-10: `pushed` means the push may have AUTO-COMMITTED an uncommitted
    // working tree just now (push-workspace.server), so the remote head can
    // postdate the workRevision minted at run completion — reviewer verdicts
    // would bind to a stale sha. Re-reconcile the workspace so the revision
    // reflects exactly what the PR delivers. Best-effort; never blocks the PR.
    if (push.status === "pushed") {
      try {
        const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
        const deliverer = file
          ? deliveringEngagement(file.parsed.frontmatter)
          : null;
        if (deliverer) {
          const { reconcileWorkspaceDelivery } = await import(
            "~/server/github/workspace-delivery.server"
          );
          await reconcileWorkspaceDelivery({
            db,
            projectSlug,
            taskKey,
            profileId: deliverer.profileId,
            ...(deliverer.backend ? { backend: deliverer.backend } : {}),
            ...(deliverer.role ? { role: deliverer.role } : {}),
            ...dataCtx,
          });
        }
      } catch (reconcileErr) {
        logger.warn("post-push delivery reconcile failed (best-effort)", {
          taskKey,
          err:
            reconcileErr instanceof Error
              ? reconcileErr
              : new Error(String(reconcileErr)),
        });
      }
    }

    // 2. Open (or reuse) the review PR now that the remote carries the diff.
    const { openTaskPr } = await import("~/server/github/pr-open.server");
    const result = await openTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      dataCtx,
    );
    if (result.status === "ok") return;
    logger.info("review PR not opened", { taskKey, reason: result.status });

    // 3. An empty-diff branch (nothing_to_review) that ALSO had no local commits
    //    to push means the delivery produced no change — but only when the push
    //    itself did not already explain WHY (a withheld grant / failed push was
    //    surfaced above with a precise reason). Avoid a misleading "no change"
    //    message on top of a policy refusal or push failure (P11-12/P11-11).
    if (
      result.status === "nothing_to_review" &&
      push.status !== "push_failed" &&
      push.status !== "no_pat"
    ) {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Review has no PR",
        "No review pull request could be opened — the execution branch has no " +
          "commits ahead of the default branch. The delivery may have produced no " +
          "change, or the commits never reached the remote.",
      );
    }
    // DG-5: a GitHub/credential FAILURE at the review boundary (auth, network,
    // missing PAT/repo) previously only logged — the task silently reached Review
    // with no PR and no explanation. Surface it so a human knows the review PR is
    // missing and why. (scope_violation already carries its own task-visible
    // violation; nothing_to_review is handled above.)
    else if (
      result.status === "auth_failed" ||
      result.status === "network_unavailable" ||
      result.status === "no_pat_configured" ||
      result.status === "no_repo_configured"
    ) {
      const why =
        result.status === "auth_failed"
          ? "GitHub rejected the credential (authentication failed)"
          : result.status === "network_unavailable"
            ? "GitHub was unreachable (network error)"
            : result.status === "no_pat_configured"
              ? "no GitHub credential is configured for this project"
              : "no GitHub repository is configured for this task";
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Review PR could not be opened",
        `${taskKey} reached Review but no pull request could be opened — ${why}. ` +
          "Fix the repository/credential settings, then use “Update status” to open the review PR.",
      );
    }
  } catch (error) {
    logger.warn("review PR open failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Surface a delivery-stage signal as a timeline event + watcher notification
 * (P11-11/P11-12): a policy refusal, a push failure, or an empty-diff review is
 * something a human must see, not just a log line. Best-effort — a failure to
 * surface only logs.
 */
async function surfaceDeliveryEvent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  title: string,
  text: string,
): Promise<void> {
  try {
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: { kind: "system", systemId: "delivery" },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    notifyTaskWatchers(
      db,
      { projectSlug, taskKey, kind: "policy", title, text },
      ctx,
    );
  } catch (surfaceErr) {
    logger.warn("failed to surface delivery event", {
      taskKey,
      title,
      err: surfaceErr instanceof Error ? surfaceErr : new Error(String(surfaceErr)),
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<boolean> {
  if (!actor.userId) return false;
  try {
    const { mergeTaskPr } = await import("~/server/github/github-reconciler.server");
    const result = await mergeTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      { dataRoot: ctx.dataRoot },
    );
    return result.status === "merged";
  } catch (error) {
    logger.warn("PR merge on acceptance failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return false;
  }
}

// ------------------------------------------------------------ reorderTask

/** Reorder one card by midpoint rank, using the governed transition path if it moves stages. */
export async function reorderTask(
  db: DatabaseSync,
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
  requireAction(db, project, actor, "reorder-board", "reorder the board");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (!project.stages.some((s) => s.id === input.toStageId)) {
    throw AppError.validation(`Unknown stage ${input.toStageId} for this project.`);
  }

  const movedStage = existing.parsed.frontmatter.stage !== input.toStageId;
  // A stage change goes through the governed manual transition (comment +
  // operator hand-off + reproject); the rank is set afterwards.
  if (movedStage) {
    await transitionStage(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, toStageId: input.toStageId, manual: true },
      actor,
      ctx,
    );
  }

  // Midpoint of the requested gap in the target column's CURRENT order.
  const { listProjectTasks, effectiveBoardRank, compareBoardOrder, taskKeyNumber, BOARD_RANK_BASE } =
    await import("~/server/projections/board-query.server");
  const inStage = listProjectTasks(db, input.projectSlug)
    .filter((t) => t.stage === input.toStageId && t.key !== input.taskKey)
    .sort(compareBoardOrder);
  const beforeKey = input.beforeKey ?? null;
  const idx = beforeKey == null ? -1 : inStage.findIndex((t) => t.key === beforeKey);

  let newRank: number;
  if (inStage.length === 0) {
    newRank = taskKeyNumber(input.taskKey) * BOARD_RANK_BASE;
  } else if (idx < 0) {
    // append to the end (beforeKey null or no longer present)
    newRank = effectiveBoardRank(inStage[inStage.length - 1]!) + BOARD_RANK_BASE;
  } else if (idx === 0) {
    newRank = effectiveBoardRank(inStage[0]!) - BOARD_RANK_BASE;
  } else {
    newRank =
      (effectiveBoardRank(inStage[idx - 1]!) + effectiveBoardRank(inStage[idx]!)) / 2;
  }

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.boardRank = newRank;
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  const toName =
    project.stages.find((s) => s.id === input.toStageId)?.name ?? input.toStageId;
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

/** Resolve the active packet by stable option kind and mark its notifications read. */
/** Identify a packet across an awaited resolution so replacements cannot be cleared. */
export function packetIdentity(p: TaskPacket): string {
  if (p.id) return `id:${p.id}`;
  return `fp:${JSON.stringify({
    kind: p.kind,
    title: p.title,
    from: p.from,
    awaiting: p.awaiting ?? null,
    options: p.options.map((o) => ({
      kind: o.kind,
      t: o.t,
      profileId: o.profileId ?? null,
      backend: o.backend ?? null,
    })),
  })}`;
}

export async function resolvePacket(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    optionIndex: number;
    /** P11-71: optional free-text the human types when resolving — recorded on
     *  the decision event so an option that asks for input ("specify the
     *  expected behavior", "which target") actually has a channel to carry it. */
    note?: string;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; option: PacketOption }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const packet = existing.parsed.packet;
  if (!packet) {
    throw AppError.conflict("This packet was already resolved.");
  }
  const option = packet.options[input.optionIndex];
  if (!option) {
    throw AppError.validation("Unknown packet option.");
  }
  // F10-09: snapshot the packet's identity BEFORE any await/lock. The
  // accept_completion path awaits a remote merge, widening the window in which a
  // replacement packet could be opened; the locked update below re-checks this
  // identity so a stale resolution can't stamp/clear a different packet.
  const resolvedPacketIdentity = packetIdentity(packet);

  // Packet-resolution authority (owner ruling Q2, 2026-07-11): a decision packet
  // is addressed to the task OWNER, so the owner (whatever their project role)
  // OR an admin|maintainer may resolve it — a contributor who took ownership is
  // no longer told "decision needed" and then handed a 403. The
  // `accept_completion` option is the one exception: merging + moving to Done
  // stays admin|maintainer (re-gated below), preserving the human-only-Done
  // authority split.
  // `ownerException` additionally requires CURRENT contributor+ membership
  // (adversarial-review #8) — a user removed from the project who still holds a
  // stale ownerUserId must not resolve packets.
  const isOwner =
    !ctx.operatorAuthorized &&
    ownerException(project, actor, existing.parsed.frontmatter.ownerUserId);
  if (option.kind === "accept_completion") {
    // Acceptance is guarded below by requireAcceptCompletion (the owner exception,
    // R6-2) — do NOT gate it here on resolve-packet, which would block a
    // contributor-owner before the owner check runs.
  } else if (isOwner) {
    // owner is allowed — skip the maintainer gate (the owner must still be able
    // to own the task, i.e. contributor+; a demoted viewer-owner is caught above)
  } else {
    requireAction(db, project, actor, "resolve-packet", "resolve decision packets");
  }

  const now = new Date().toISOString();
  const human = humanActorRef(db, actor);
  const key = input.taskKey;

  let event: TaskFileEvent;
  let mutate: (fm: TaskFrontmatter) => void;
  let clearPacket = false;

  switch (option.kind) {
    case "accept_completion": {
      // Human-only Review → Done boundary (always-human invariant), with the
      // task-owner exception (R6-2).
      requireAcceptCompletion(
        db,
        project,
        actor,
        existing.parsed.frontmatter.ownerUserId,
        "accept completion into Done",
      );
      // F10-15: acceptance requires every required reviewer to have approved the
      // CURRENT work revision (and none to have requested changes on it). A
      // stale acceptance packet can't merge work the current review hasn't
      // cleared.
      {
        const blockReason = acceptanceBlockedReason(existing.parsed.frontmatter);
        if (blockReason) throw AppError.conflict(blockReason);
      }
      const doneStageId =
        terminalStageIdOf(project) ??
        project.stages[project.stages.length - 1]?.id ??
        "done";
      // Attempt the REAL merge (FR31) and only claim "merged" when it truly
      // happened; otherwise record "accepted" (merge pending) — never a false
      // merge (D3 / NFR15).
      const reallyMerged = await mergeTaskPrIfPossible(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        actor,
      );
      const hasPr = !!existing.parsed.frontmatter.pr;
      event = {
        occurredAt: now,
        type: "completion",
        actor: human,
        title: "Completion accepted",
        text: !hasPr
          ? "Human acceptance recorded. Task transitioned to **Done** (no linked pull request)."
          : reallyMerged
            ? "Human acceptance recorded. Task transitioned to **Done** and the review PR was merged."
            : "Human acceptance recorded. Task transitioned to **Done**; the review PR is **accepted, merge pending** (no reachable GitHub merge).",
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.stage = doneStageId;
        fm.readiness = "ready";
        fm.waiting = "none";
        fm.validation = "healthy"; // accepted work is validated (FR24)
        // Acceptance consumes standing recommendations — a leftover transition
        // card on a Done task would move it back OUT of Done if applied.
        fm.recommendations = [];
        if (fm.pr) fm.pr = { ...fm.pr, state: reallyMerged ? "merged" : "accepted" };
      };
      clearPacket = true;
      break;
    }
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
    case "edit_goal": {
      // The human chose to refine the goal themselves. The packet's ask is
      // only fulfilled when the edit LANDS, so the packet stays open (stamped)
      // and updateTaskGoal clears it the moment the new goal is saved — no
      // operator round-trip needed. The UI reads this option kind and opens
      // the goal editor.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Waiting for the edited goal — the packet clears as soon as it lands.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "human";
      };
      break;
    }
    case "retry_other_backend": {
      // Backend-failure recovery (D4): the run restarts below on the option's
      // target backend; startSpecialistRun/startReviewerRun persist the switch
      // to the assignment snapshot so later prompts follow it.
      const targetLabel =
        (option.backend ?? "claude") === "claude" ? "Claude Code" : "Codex";
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Re-running on ${targetLabel} with a fresh context.`,
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

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    if (!parsed.packet) {
      // Raced with a concurrent resolve inside the lock window.
      throw AppError.conflict("This packet was already resolved.");
    }
    // F10-09: the packet in the file must be the SAME one we read and validated
    // the option against. A replacement (opened during our await) has a
    // different identity — reject rather than apply the stale choice to it.
    if (packetIdentity(parsed.packet) !== resolvedPacketIdentity) {
      throw AppError.conflict(
        "This decision was replaced by a newer one — refresh the task and choose again.",
      );
    }
    mutate(parsed.frontmatter);
    if (clearPacket) parsed.packet = null;
    // edit_goal keeps the packet but marks the decision made — updateTaskGoal
    // clears it when the edited goal lands.
    if (option.kind === "edit_goal" && parsed.packet) {
      parsed.packet.awaiting = "goal_edit";
    }
    // P11-71: carry the human's free-text into the recorded decision so an
    // option that asked for input isn't resolved with an unstated reading — the
    // operator (and reviewers reading the timeline) see exactly what was said.
    const note = input.note?.trim();
    const eventWithNote = note
      ? { ...event, text: `${event.text}\n\n> ${note.replace(/\n/g, "\n> ")}` }
      : event;
    parsed.timeline.unshift(eventWithNote);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.packet.resolved",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      optionKind: option.kind,
      optionTitle: option.t,
      packetKind: packet.kind,
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
    void autoInvokeOperator(db, ctx, input.projectSlug, input.taskKey, "transition");
  }

  // retry_other_backend: actually start the promised run. Operator-authorized
  // like the redirect path's re-engage (the packet is the human decision; the
  // execution is coordination machinery — an owner-contributor may resolve).
  // A start failure must not un-resolve the packet: record it on the timeline.
  if (option.kind === "retry_other_backend") {
    const target: RealBackend = option.backend === "codex" ? "codex" : "claude";
    const opCtx: TaskMutationContext = { ...ctx, operatorAuthorized: true };
    try {
      const { startAgentRun } = await import("./specialist-run.server");
      await startAgentRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          ...(typeof option.profileId === "string" && option.profileId
            ? { profileId: option.profileId }
            : {}),
          backendOverride: target,
        },
        OPERATOR_TASK_ACTOR,
        opCtx,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("retry_other_backend start failed", {
        taskKey: input.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: { kind: "operator" },
          title: null,
          text: `The retry could not start — ${message}`,
          toAgent: false,
          evidence: null,
        });
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    }
  }

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    option,
  };
}

// ---------------------------------------------------- operator recommendations

/** Apply human acceptance through the shared Done transition and merge path. */
async function acceptCompletion(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; force?: boolean },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<void> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // R6-2: maintainer+ OR the task's human owner (even a Contributor) may accept.
  requireAcceptCompletion(
    db,
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
    "accept completion into Done",
  );

  // F10-15: acceptance requires every required reviewer to have approved the
  // CURRENT work revision (none requesting changes on it). `force` is the
  // explicit human override. Replaces the old scalar-`failing` gate, which a
  // maintainer could clear by bouncing a rejected task out of and back into
  // review without any re-review.
  if (!input.force) {
    const blockReason = acceptanceBlockedReason(existing.parsed.frontmatter);
    if (blockReason) throw AppError.conflict(blockReason);
  }

  // Refuse to accept while an operator-raised BLOCKED decision is still open
  // (F7-VAL1/F7-PKT1). A blocked packet means the operator hit something it
  // couldn't resolve (a denied commit, a crashed run); accepting would bury that
  // decision. This replaces the old validation="failing"-on-block hack: the
  // packet, not a fake review verdict, is what holds acceptance. Resolving the
  // packet clears readiness → acceptance proceeds.
  if (
    !input.force &&
    existing.parsed.frontmatter.readiness === "blocked" &&
    existing.parsed.packet?.type === "blocked"
  ) {
    throw AppError.conflict(
      "This task has an open blocked decision — resolve the operator's packet before accepting it.",
    );
  }

  const doneStageId =
    terminalStageIdOf(project) ??
    project.stages[project.stages.length - 1]?.id ??
    "done";

  if (existing.parsed.frontmatter.stage === doneStageId) return; // already Done.

  // Human acceptance merges the review PR (FR31: "accepting a completion merges
  // its PR"). Attempt the REAL merge first when a PR + reachable GitHub exist —
  // mergeTaskPr writes state=merged + a `github` event + audit on success and
  // returns true. When the real merge CAN'T run (no GitHub / no PAT / not
  // mergeable) we do NOT claim "merged" — we record "accepted" (merge pending)
  // so the task record never diverges from GitHub truth (NFR15).
  const reallyMerged = await mergeTaskPrIfPossible(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    actor,
  );
  const hasPr = !!existing.parsed.frontmatter.pr;

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "completion",
    actor: humanActorRef(db, actor),
    title: "Completion accepted",
    text: !hasPr
      ? `Human acceptance recorded. ${input.taskKey} transitioned to **Done** (no linked pull request).`
      : reallyMerged
        ? `Human acceptance recorded. ${input.taskKey} transitioned to **Done** and the review PR was merged.`
        : `Human acceptance recorded. ${input.taskKey} transitioned to **Done**; the review PR is **accepted, merge pending** (no reachable GitHub merge — merge it manually or reconcile once credentials are set).`,
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.stage = doneStageId;
    parsed.frontmatter.readiness = "ready";
    parsed.frontmatter.waiting = "none";
    parsed.frontmatter.validation = "healthy"; // accepted work is validated (FR24)
    if (parsed.frontmatter.pr) {
      parsed.frontmatter.pr = {
        ...parsed.frontmatter.pr,
        state: reallyMerged ? "merged" : "accepted",
      };
    }
    // A Done task carries no pending transition/acceptance recommendations.
    parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
      (r) => r.kind !== "transition" && r.kind !== "accept_completion",
    );
    parsed.packet = null;
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.transition",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { to: doneStageId, boundary: "human", via: "accept_completion" },
  });
}

/**
 * Admin-only override of the acceptance gate (DG-2). When a task is wedged —
 * a required reviewer that can no longer record a verdict, or a stale blocked
 * packet — a plain accept throws forever. An admin may force it: we record the
 * exact reason being bypassed to the audit log, then accept with `force: true`.
 */
export async function forceAcceptCompletion(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(
    db,
    project,
    actor,
    "force-accept-completion",
    "force-accept past the review gate",
  );
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const bypassed =
    acceptanceBlockedReason(existing.parsed.frontmatter) ??
    (existing.parsed.frontmatter.readiness === "blocked"
      ? "an open blocked decision packet"
      : "no gate (already acceptable)");
  recordAudit(db, {
    action: "task.acceptance.forced",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { bypassed },
  });
  await acceptCompletion(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey, force: true },
    actor,
    ctx,
  );
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
}

/** Complete a real GitHub merge after an offline acceptance left it pending. */
export async function completeTaskMerge(
  db: DatabaseSync,
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
  // Completing a merge-pending acceptance is part of the same acceptance
  // authority — maintainer+ OR the task's owner (R6-2).
  requireAcceptCompletion(
    db,
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
    "complete a PR merge",
  );
  const pr = existing.parsed.frontmatter.pr;
  if (!pr) {
    throw AppError.validation("This task has no linked pull request to merge.");
  }
  if (pr.state !== "accepted") {
    throw AppError.conflict(
      pr.state === "merged"
        ? "This PR is already merged."
        : `This PR is "${pr.state}", not an accepted merge-pending PR.`,
    );
  }

  const { mergeTaskPr } = await import("~/server/github/github-reconciler.server");
  const result = await mergeTaskPr(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
    { userId: actor.userId, label: actor.label },
    { dataRoot: ctx.dataRoot },
  );

  if (result.status === "merged") {
    // mergeTaskPr already wrote pr.state="merged" + a github event + audit.
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      merged: true,
      message: `PR #${result.prNumber} merged.`,
    };
  }

  const message =
    result.status === "no_repo_configured" || result.status === "no_pat_configured"
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
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; recId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; label: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Applying an operator recommendation resolves a pending governance decision
  // (symmetric with dismissRecommendation/resolvePacket) — authorize BEFORE any
  // task read so an unauthorized caller can't probe task/recommendation
  // existence through the notFound/conflict responses below. The inner governed
  // mutations still enforce their own finer-grained caps.
  requireAction(db, project, actor, "resolve-packet", "apply recommendations");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const rec = existing.parsed.frontmatter.recommendations.find(
    (r) => r.id === input.recId,
  );
  if (!rec) throw AppError.conflict("That recommendation was already resolved.");

  // Execute the recommended action through the governed mutation (RBAC inside).
  if (rec.kind === "assign_specialist" && rec.profileId) {
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: rec.profileId },
      actor,
      ctx,
    );
  } else if (rec.kind === "assign_reviewer" && rec.profileId) {
    const { assignReviewer } = await import("./specialist-run.server");
    await assignReviewer(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: rec.profileId },
      actor,
      ctx,
    );
  } else if (rec.kind === "run_specialist") {
    // The operator recommended starting the delivering agent's run (it can't
    // under `recommend` autonomy) — applying it (admin|maintainer, re-checked
    // in startAgentRun) starts the run.
    const { startAgentRun } = await import("./specialist-run.server");
    await startAgentRun(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
  } else if (rec.kind === "run_reviewer" && rec.profileId) {
    const { startAgentRun } = await import("./specialist-run.server");
    await startAgentRun(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: rec.profileId },
      actor,
      ctx,
    );
  } else if (rec.kind === "transition" && rec.toStageId) {
    await transitionStage(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, toStageId: rec.toStageId },
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
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
      (r) => r.id !== input.recId,
    );
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // Resolving the recommendation clears its "Waiting on you" bell (transition
  // recs already clear it inside transitionStage; this covers assign/accept).
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  recordAudit(db, {
    action: "task.recommendation.applied",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kind: rec.kind, label: rec.label },
  });

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), label: rec.label };
}

/**
 * Dismiss a pending operator recommendation without acting on it (admin|
 * maintainer — symmetric with resolvePacket; the UI hides the control from
 * lower roles). Idempotent — a missing id is a no-op.
 */
export async function dismissRecommendation(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; recId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; label: string | null }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Dismissing an operator recommendation resolves a pending governance decision
  // (the non-packet equivalent of resolving a packet) — admin|maintainer only,
  // symmetric with resolvePacket.
  requireAction(db, project, actor, "resolve-packet", "dismiss recommendations");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const rec = existing.parsed.frontmatter.recommendations.find(
    (r) => r.id === input.recId,
  );
  if (!rec) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), label: null };
  }

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
      (r) => r.id !== input.recId,
    );
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // Resolving the recommendation (either way) clears its "Waiting on you" bell.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  recordAudit(db, {
    action: "task.recommendation.dismissed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kind: rec.kind, label: rec.label },
  });

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), label: rec.label };
}
