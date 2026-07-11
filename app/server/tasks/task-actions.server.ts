import type Database from "better-sqlite3";
import type {
  PacketOption,
  TaskFileEvent,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
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
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";

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
}

export interface TaskMutationContext {
  /** Override the data root (tests). Defaults to env VIBERR_DATA_ROOT. */
  dataRoot?: string;
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

/** The review stage id — the one with a governed edge into the final stage. */
function reviewStageIdOf(project: ProjectContext): string | null {
  const lastStageId = project.stages[project.stages.length - 1]?.id;
  return project.workflow.find((w) => w.to === lastStageId)?.from ?? null;
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
  return requireMemberRole(loadProjectContext(ctx, projectSlug), actor, allowed, what);
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
    const owner = readTaskFile(
      taskRef(ctx, notice.projectSlug, notice.taskKey),
    )?.parsed.frontmatter.ownerUserId;
    if (owner) recipients.add(owner);
  } catch {
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
  if (!role) {
    throw forbidden(`Only project members can ${what}.`);
  }
  if (allowed !== "any-member" && !allowed.includes(role)) {
    throw forbidden(`Your project role (${role}) cannot ${what}.`);
  }
  return role;
}

function userName(db: Database.Database, userId: string): string {
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId) as
    | { name: string }
    | undefined;
  return row?.name ?? userId;
}

function humanActorRef(db: Database.Database, actor: TaskActor) {
  return {
    kind: "human" as const,
    userId: actor.userId,
    nameHint: userName(db, actor.userId),
  };
}

function taskRef(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
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
): Promise<{ key: string; task: TaskSummary; stageName: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const role = requireMemberRole(project, actor, "any-member", "create tasks");
  if (role === "viewer") throw forbidden("Viewers cannot create tasks.");

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
    recommendations: [],
    // Operator assigned unless the task starts in triage (contracts §1.1).
    operator:
      stageId === project.stages[0]?.id
        ? null
        : { assignedAtStageId: stageId },
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
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  } catch (error) {
    logger.error("auto operator invocation failed", {
      taskKey,
      trigger,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Re-invoke the operator to react after a boot-recovered agent reply (NFR17,
 * B9). A thin wrapper over autoInvokeOperator so the run-recovery reconciler can
 * restart the coordination chain without importing the private helper. Uses the
 * `transition` coordination trigger (a fresh react chain, reactDepth 0).
 */
export async function autoInvokeOperatorForRecovery(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  await autoInvokeOperator(db, ctx, projectSlug, taskKey, "transition");
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

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(event);
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
  const {
    resolveMentionedAgent,
    replyTextForRun,
    resumeWorkdir,
    buildReplyScript,
  } = await import("./agent-reply.server");
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
  if (!hasRuntimeRole(ctx, input.projectSlug, actor)) {
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
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
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

  const { registerRunCompletion, resumeRun } = await import(
    "~/server/runtimes/run-service.server"
  );

  let runId: string;
  let triggered: "resumed" | "started";

  if (target.session) {
    // 4a. Resume the agent's existing provider session, reusing the clone
    //     workdir so it keeps its repo context.
    const workdir = resumeWorkdir(
      input.projectSlug,
      input.taskKey,
      repo,
      ctx.dataRoot,
    );
    const script = buildReplyScript(
      target.session.backend === "codex" ? "codex" : "claude",
      target.model,
    );
    const resumed = await resumeRun(db, {
      runId: target.session.id,
      prompt: followUp,
      workdir,
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
      actor: { userId: actor.userId, label: actor.label },
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
      const { assignSpecialist, startSpecialistRun } = await import(
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
      const started = await startSpecialistRun(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        actor,
        ctx,
      );
      runId = started.runId;
    } else {
      const { assignReviewer, startReviewerRun } = await import(
        "./specialist-run.server"
      );
      // Engage as a reviewer if not already (idempotent), then run as reviewer.
      await assignReviewer(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: target.profileId },
        actor,
        ctx,
      );
      const started = await startReviewerRun(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: target.profileId },
        actor,
        ctx,
      );
      runId = started.runId;
    }
    triggered = "started";
  }

  // 5. Post the agent's reply as an agent-authored comment when it finishes.
  registerRunCompletion(runId, (finished) => {
    postAgentReplyComment(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: finished.id,
      actorRef: target.actorRef,
      replyText: replyTextForRun(db, finished.id),
    });
  });

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
function hasRuntimeRole(
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
): boolean {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const role = file?.parsed.frontmatter.members.find(
    (m) => m.userId === actor.userId,
  )?.role;
  return role === "admin" || role === "maintainer";
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
export function postAgentReplyComment(
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
    ? `_(simulated run — no real repository work was performed)_\n\n${input.replyText}`
    : input.replyText;
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
  return updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(event);
  })
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

/**
 * Register the DEFAULT completion hook for an agent run: when it finishes, post
 * the agent's final text as an agent-authored reply comment. Every agent run
 * (specialist or reviewer, however it was started — including the UI "Run"
 * button) gets this, so an agent always reports back on the timeline.
 *
 * Registration is last-writer-wins per run id (run-service), so a richer caller
 * (the operator prompt loop, or an @mention resume) may overwrite this with a
 * callback that ALSO reacts/threads its own reply — no double post. Best-effort
 * and non-blocking.
 */
export async function registerAgentReply(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    backend: RealBackend;
    role: string;
  },
): Promise<void> {
  const [{ registerRunCompletion }, { replyTextForRun }] = await Promise.all([
    import("~/server/runtimes/run-service.server"),
    import("./agent-reply.server"),
  ]);
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: input.backend,
    role: input.role,
  };
  registerRunCompletion(input.runId, (finished) => {
    void postAgentReplyComment(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: finished.id,
      actorRef,
      replyText: replyTextForRun(db, finished.id),
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
 * capability gate — when generate-packets is withheld, no packet opens and the
 * stall stays visible only via waiting=human (the pre-existing behavior).
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
    const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!existing || existing.parsed.packet) return; // already escalated
    const { operatorOpenPacket, resolveOperatorAuthority } = await import(
      "./operator-actions.server"
    );
    const authority = resolveOperatorAuthority(ctx, input.projectSlug, {});
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
          {
            kind: "redirect",
            title: "Redirect with sharper guidance",
            detail: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
            recommended: true,
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

  // 3. Weak negatives ("fail", "blocker") ONLY count when NOT locally negated —
  //    "no blockers" / "no tests fail" / "doesn't fail" are POSITIVE. Scan each
  //    occurrence's preceding context for a negator (a bare `/\bfail\b/` test
  //    misclassified clean approvals — the bug this guard fixes).
  for (const m of t.matchAll(/\b(fail(?:ed|ing|s)?|blockers?)\b/g)) {
    const pre = t.slice(Math.max(0, m.index - 28), m.index);
    // A negator anywhere in the local lead-in flips it positive. `n't` is a
    // contraction suffix (don't/doesn't/won't) so it needs no leading boundary.
    if (!/(?:\b(?:no|not|zero|without|never|any)\b|n't)[^.!?]*$/.test(pre)) {
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

/**
 * Emit a typed `quality` event from a reviewer's verdict and set the task's
 * validation health accordingly (FR15/FR24/FR35). request_changes → failing;
 * approve → healthy. Silent when the verdict is unclear. Idempotent-friendly:
 * writes one typed event per reviewer run.
 *
 * A clear verdict ALSO fans a `quality` notification to the task's watchers
 * (owner + supervisors, routing-prefs honored — FIX #6): before this, the
 * quality inbox card only ever existed in seed data, so a real reviewer verdict
 * updated the timeline + board but never pinged the human who owns acceptance.
 * Exported for tests.
 */
export async function recordReviewerVerdict(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  replyText: string | null,
): Promise<void> {
  const verdict = classifyReviewerVerdict(replyText);
  if (!verdict) return;
  const validation: "failing" | "healthy" =
    verdict === "request_changes" ? "failing" : "healthy";
  const summary =
    verdict === "request_changes"
      ? "Reviewer requested changes."
      : "Reviewer approved the work.";
  const title = verdict === "request_changes" ? "Changes requested" : "Review passed";
  try {
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.frontmatter.validation = validation;
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "quality",
        actor: { kind: "operator" },
        title,
        text: `**Validation:** ${validation}. ${summary}`,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.quality.flagged",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: { verdict, validation },
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
  await updateTaskFile(taskRef(opCtx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(comment);
  });
  reprojectTask(db, opCtx, input.projectSlug, input.taskKey);

  // 2. Trigger the agent's run with the operator's directive as its turn focus.
  const { startSpecialistRun, startReviewerRun } = await import(
    "./specialist-run.server"
  );
  let runId: string;
  if (input.kind === "reviewer") {
    if (!input.profileId) {
      throw AppError.validation("A reviewer profile id is required to run a reviewer.");
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

  // 3. When the agent finishes, post its reply as an agent-authored comment,
  //    THEN re-invoke the operator so it READS that reply and proposes the next
  //    state change (the "prompt → read output → propose" loop). The react
  //    re-invocation is bounded by OPERATOR_REACT_DEPTH_CAP so it never runs away.
  const [{ registerRunCompletion }, { replyTextForRun }] = await Promise.all([
    import("~/server/runtimes/run-service.server"),
    import("./agent-reply.server"),
  ]);
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: input.backend,
    role: input.role,
  };
  const opRun = ctx.operatorRun;
  registerRunCompletion(runId, (finished) => {
    void (async () => {
      const replyText = replyTextForRun(db, finished.id);
      // Capture the agent's PREVIOUS reply (before we post the new one) so we can
      // detect a no-progress repeat.
      const prevReply = latestAgentReplyText(
        opCtx,
        input.projectSlug,
        input.taskKey,
        input.backend,
        input.role,
      );
      // Land the agent's reply on the timeline first, so the reacting operator
      // reads it in its snapshot.
      await postAgentReplyComment(db, opCtx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        runId: finished.id,
        actorRef,
        replyText,
      });
      // Capture agent-side delivery into the canonical record (NFR15): a real
      // specialist may have branched/pushed/opened a PR through its OWN git/gh
      // credentials — outside the server's stored-PAT path — leaving task.md at
      // branch:null/pr:null. This callback REPLACES the run's default reply
      // hook (last-writer-wins), so reconcile here too, before the operator
      // reacts and reads the snapshot. Best-effort, never blocks the react loop.
      if (finished.state === "finished" && !finished.simulated) {
        const { reconcileWorkspaceDelivery } = await import(
          "~/server/github/workspace-delivery.server"
        );
        await reconcileWorkspaceDelivery({
          db,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          backend: input.backend,
          role: input.role,
          simulated: false,
          ...(opCtx.dataRoot !== undefined ? { dataRoot: opCtx.dataRoot } : {}),
        }).catch(() => {});
      }
      // A REVIEWER's verdict is a first-class quality signal (FR15/FR35): emit a
      // typed `quality` event and drive the board's validation health (FR24) so
      // a task that keeps failing review reads "failing", not "none". Conservative
      // heuristic — only a clear verdict flips validation.
      if (input.kind === "reviewer" && finished.state === "finished") {
        await recordReviewerVerdict(
          db,
          opCtx,
          input.projectSlug,
          input.taskKey,
          replyText,
        );
      }
      // Decide whether to re-invoke the operator to react. Skips interrupted/
      // empty runs, no-progress repeats (the CTL-3 spiral), and the depth cap.
      if (!operatorShouldReactToReply(finished.state, replyText, prevReply, opRun?.reactDepth)) {
        const noProgress =
          !!replyText && prevReply !== null && prevReply.trim() === replyText.trim();
        const depthCapped =
          !!replyText &&
          !noProgress &&
          finished.state === "finished" &&
          opRun !== undefined &&
          opRun.reactDepth >= OPERATOR_REACT_DEPTH_CAP;
        if (noProgress) {
          logger.info("operator react skipped — agent made no progress (repeated its reply)", {
            taskKey: input.taskKey,
            runId: finished.id,
          });
        }
        // Stuck-loop escalation (Journey 2: failure must be governable and
        // recoverable, not a silent stall). The guard just killed the react
        // chain — without this, the task sits at waiting=human with no packet,
        // no card, and no notification, and the human must archaeology the
        // timeline. Open a BLOCKED recovery packet instead so the supervisors
        // are pinged with concrete options.
        if (noProgress || depthCapped) {
          await openStuckLoopPacket(db, opCtx, {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            agentHandle: input.handle,
            reason: noProgress
              ? "The agent repeated its previous report verbatim — no forward progress."
              : `The coordination loop hit its ${OPERATOR_REACT_DEPTH_CAP}-cycle depth cap without reaching a boundary.`,
          });
        }
        return;
      }
      if (!opRun) return; // the predicate already guarantees this; narrows the type
      // Only re-invoke while an operator is still deployed on the project.
      const { resolveOperatorAuthority } = await import("./operator-actions.server");
      const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
        backend: opRun.backend,
        autonomy: opRun.autonomy,
      });
      if (!authority.deployed) return;
      const { runOperator } = await import("~/server/runtimes/operator-run.server");
      await runOperator(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        trigger: "agent-reply",
        reactDepth: opRun.reactDepth + 1,
        backend: opRun.backend,
        autonomy: opRun.autonomy,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      });
    })().catch((error: unknown) => {
      logger.error("operator react on agent reply failed", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  });

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
  const actorRole = requireMemberRole(
    project,
    actor,
    "any-member",
    "take or assign task ownership",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  const isTake = input.targetUserId === actor.userId;
  if (!isTake) {
    // Hand off: current owner or project admin only; target must be a member.
    if (currentOwnerId !== actor.userId && actorRole !== "admin") {
      throw forbidden("Only the current owner or a project admin can hand off ownership.");
    }
    if (!project.memberRoles.has(input.targetUserId)) {
      throw forbidden("Ownership can only be handed to a project member.");
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
  const scheduling = !currentOwnerId && operatorSchedulesOnOwner(existing.parsed);
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

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.ownerUserId = input.targetUserId;
    parsed.timeline.unshift(event);
    if (operatorEvent) {
      parsed.frontmatter.readiness = "ready";
      parsed.frontmatter.waiting = "agent";
      parsed.timeline.unshift(operatorEvent);
    }
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
    void autoInvokeOperator(db, ctx, input.projectSlug, input.taskKey, "transition");
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
  const actorRole = requireMemberRole(
    project,
    actor,
    "any-member",
    "release task ownership",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  if (!currentOwnerId) {
    // Idempotent: nothing to release.
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  const isSelf = currentOwnerId === actor.userId;
  if (!isSelf && actorRole !== "admin") {
    throw forbidden("Only project admins can release another member's ownership.");
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
    requireMemberRole(
      project,
      actor,
      ["admin", "maintainer"],
      "change the task stage",
    );
  } else if (boundary!.boundary === "auto") {
    requireMemberRole(project, actor, "any-member", "move this task");
  } else if (boundary!.boundary === "approval") {
    requireMemberRole(
      project,
      actor,
      ["admin", "maintainer"],
      "approve stage transitions",
    );
  } else {
    // human boundary (review→done locked in V1): acceptance authority.
    requireMemberRole(
      project,
      actor,
      ["admin", "maintainer"],
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
    // Live validation-health (FR24, B7): the board's validation signal was
    // seed-only, so a real task always read "none". Derive it from governance
    // state — entering review means the work is up for review ("changed").
    // A failing verdict ("failing") and acceptance ("healthy") are set on the
    // packet/accept paths. Don't stomp a "failing" flag on a re-review.
    if (
      input.toStageId === reviewStageIdOf(project) &&
      parsed.frontmatter.validation === "none"
    ) {
      parsed.frontmatter.validation = "changed";
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

  // A stage transition is a coordination trigger: when a NON-operator moves a
  // task onto a new (non-Done) stage, hand off to the operator so it picks the
  // task up at that stage and prompts the stage's agent (ADR-002 — one operator
  // per active task). Operator-authored transitions are excluded: the operator's
  // own run already coordinates the stages it moves through, so re-invoking it
  // here would be redundant and could recurse. Fire-and-forget — it never blocks
  // or fails the transition, and it is a no-op when no operator is deployed.
  if (!ctx.operatorAuthorized && input.toStageId !== lastStageId) {
    void autoInvokeOperator(db, ctx, input.projectSlug, input.taskKey, "transition");
  }

  // Delivery spine (FR31): entering the REVIEW stage is the point a PR is
  // opened for review — the developer's branch is put up for human-authorized
  // review, carrying a link back to this task. Best-effort + fire-and-forget:
  // it degrades cleanly (no throw) when the repo/PAT isn't configured, so a
  // transition never fails on GitHub state. The review stage is the one with a
  // governed edge into the final (Done) stage.
  const reviewStageId = project.workflow.find((w) => w.to === lastStageId)?.from;
  if (reviewStageId && input.toStageId === reviewStageId) {
    void openReviewPrBestEffort(db, ctx, input.projectSlug, input.taskKey, actor);
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
    const { openTaskPr } = await import("~/server/github/pr-open.server");
    const result = await openTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      { ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}) },
    );
    if (result.status !== "ok") {
      logger.info("review PR not opened", { taskKey, reason: result.status });
    }
  } catch (error) {
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
): Promise<boolean> {
  if (!actor.userId) return false;
  try {
    const { mergeTaskPr } = await import("~/server/github/github-reconciler.server");
    const result = await mergeTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      { ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}) },
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
): Promise<{ task: TaskSummary; movedStage: boolean; toName: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireMemberRole(project, actor, ["admin", "maintainer"], "reorder the board");

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
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), movedStage, toName };
}

// ------------------------------------------------------------ resolvePacket

/**
 * Resolves the task's active decision packet by option index, dispatching
 * on the option's stable `kind` (ruling 7) — NEVER on the English title.
 *
 *   accept_completion   human-only acceptance (admin|maintainer): stage →
 *                       done, waiting → none, pr.state → merged, packet
 *                       cleared, `completion` event ("Completion accepted").
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
): Promise<{ task: TaskSummary; option: PacketOption }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Resolving a decision packet steers agent work and can advance/redirect the
  // task — a consequential governance action (FR27), so it is admin|maintainer,
  // matching the "Approve stage transitions" row. The accept_completion option
  // is additionally re-gated below; other options (redirect/hold/request_edit)
  // are covered by this base gate.
  requireMemberRole(
    project,
    actor,
    ["admin", "maintainer"],
    "resolve decision packets",
  );

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

  const now = new Date().toISOString();
  const human = humanActorRef(db, actor);
  const key = input.taskKey;

  let event: TaskFileEvent;
  let mutate: (fm: TaskFrontmatter) => void;
  let clearPacket = false;

  switch (option.kind) {
    case "accept_completion": {
      // Human-only Review → Done boundary (always-human invariant).
      requireMemberRole(
        project,
        actor,
        ["admin", "maintainer"],
        "accept completion into Done",
      );
      const doneStageId =
        project.stages.find((s) => s.id === "done")?.id ??
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
        text:
          !hasPr || reallyMerged
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
      throw conflict("This packet was already resolved.");
    }
    mutate(parsed.frontmatter);
    if (clearPacket) parsed.packet = null;
    parsed.timeline.unshift(event);
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
/**
 * Human acceptance of the review→done boundary: move the task to Done, mark the
 * review PR merged, clear any open packet, and record a `completion` event. RBAC:
 * admin|maintainer (acceptance authority — the always-human Done invariant). This
 * is the shared acceptance used by both the acceptance packet and the operator's
 * `accept_completion` recommendation card, so both paths reach Done identically.
 */
async function acceptCompletion(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<void> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireMemberRole(
    project,
    actor,
    ["admin", "maintainer"],
    "accept completion into Done",
  );
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const doneStageId =
    project.stages.find((s) => s.id === "done")?.id ??
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
    text:
      !hasPr || reallyMerged
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
 * Dismiss a pending operator recommendation without acting on it (any member).
 * Idempotent — a missing id is a no-op.
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
  requireMemberRole(
    project,
    actor,
    ["admin", "maintainer"],
    "dismiss recommendations",
  );

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
