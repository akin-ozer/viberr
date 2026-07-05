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
import type { TaskSummary } from "~/shared/mapping/task.server";

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
}

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
    consultants: [],
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

  return {
    key,
    task: summaryOrThrow(db, input.projectSlug, key),
    stageName: stage.name,
  };
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
  input: { projectSlug: string; taskKey: string; text: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AppendCommentResult> {
  const text = input.text.trim();
  if (!text) throw AppError.validation("Comment text is required.");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    throw AppError.notFound(`Task ${input.taskKey} not found.`);
  }

  const toAgent = AGENT_HANDLE_RE.test(text);
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

  // Phase 8: when scheduling fires, the operator "schedules execution" — spin
  // up a REAL operator run so the run strip / agent logs reflect the reaction
  // (generalizes the Phase-5 stand-in; the operator timeline event copy above
  // is unchanged). Best-effort: a runtime failure never breaks the ownership
  // mutation (file write + audit already committed). Dynamically imported to
  // avoid a module cycle; skipped when a seeded operator run already exists.
  if (scheduling) {
    const { scheduleOperatorRun } = await import(
      "~/server/runtimes/run-service.server"
    );
    await scheduleOperatorRun(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      ownerName: userName(db, input.targetUserId),
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
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
  input: { projectSlug: string; taskKey: string; toStageId: string },
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

  const boundary = project.workflow.find(
    (w) => w.from === fromStageId && w.to === input.toStageId,
  );
  if (!boundary) {
    throw AppError.validation(
      `No governed boundary from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`,
    );
  }

  if (boundary.boundary === "auto") {
    requireMemberRole(project, actor, "any-member", "move this task");
  } else if (boundary.boundary === "approval") {
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

  const firstStageId = project.stages[0]?.id;
  const lastStageId = project.stages[project.stages.length - 1]?.id;

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "transition",
    actor: humanActorRef(db, actor),
    title: null,
    text: `**Transition:** moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`,
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
    details: {
      from: fromStageId,
      to: input.toStageId,
      boundary: boundary.boundary,
    },
  });

  // Approving a requested transition resolves its approval notifications.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
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
  requireMemberRole(project, actor, "any-member", "resolve decision packets");

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
      event = {
        occurredAt: now,
        type: "completion",
        actor: human,
        title: "Completion accepted",
        text: "Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge.",
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.stage = doneStageId;
        fm.readiness = "ready";
        fm.waiting = "none";
        if (fm.pr) fm.pr = { ...fm.pr, state: "merged" };
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

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    option,
  };
}
