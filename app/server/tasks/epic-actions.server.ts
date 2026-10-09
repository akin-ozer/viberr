import type { DatabaseSync } from "node:sqlite";
import {
  EPIC_COLORS,
  EPIC_STATUS_LABEL,
  EPIC_STATUS_VALUES,
  EPIC_TITLE_MAX,
  defaultEpicColor,
  isEpicId,
  isEpicOpen,
  type EpicColor,
  type EpicFrontmatter,
  type EpicStatus,
} from "~/schemas/epic-file.schema";
import { isValidDueDate, type TaskFileEvent } from "~/schemas/task-file.schema";
import { OPERATOR_AUDIT_ACTOR, recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import {
  requireProjectAuthority,
  requireProjectMutable,
} from "~/server/auth/project-authority.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  createEpicFile,
  nextEpicId,
  readEpicFile,
  updateEpicFile,
  withEpicsLock,
  type EpicFileRef,
} from "~/server/files/epic-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { getEpic, getEpicDetail, type EpicDetail } from "~/server/projections/epic-query.server";
import { createNotification, epicLink } from "~/server/projections/notifications.server";
import { rebuildEpicFile } from "~/server/projections/rebuilder.server";
import { createActorResolver, type ActorRender } from "~/shared/mapping/actor.server";
import { rolesForAction, type RbacAction } from "~/shared/rbac";
import { toError } from "~/shared/errors";
import { countLabel } from "~/shared/text/plural";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import {
  loadProjectContext,
  reprojectTask,
  taskRef,
  type ProjectContext,
  type TaskActor,
  type TaskMutationContext,
} from "./task-mutation.server";
import { actorProseName, userDisplayName } from "./user-display-name.server";

/**
 * Epics (ruling 272): the actions.
 *
 * An epic is a named body of work in one project, the way Jira draws an epic
 * and Linear a project. Tasks join and leave it one at a time, whoever they
 * are and whatever stage they stand at, and the membership is the TASK's own
 * `epic` field: `setTasksEpic` below is its one writer after creation. An epic
 * never creates, starts, orders or holds a task. What a task waits on is its
 * own `blockedBy` (ruling 55), which the release engine honours whatever
 * epic the task is in.
 *
 * AUTHORITY
 * - Creating an epic and editing what it is (name, description, status,
 *   colour, lead, dates) is `manage-epics`: planning, held by every role that
 *   can create a task.
 * - Putting a task in an epic or taking it out is `edit-task-meta`, the grant
 *   that already covers a task's labels and priority. The operator does it for
 *   its own task (`set_epic`), under its in-process authority.
 * - There is no delete. An epic is closed by its status (`done`, `cancelled`)
 *   and stays readable, like every other record in the store.
 *
 * NOTICES: a task joining or leaving an epic, and every task in it being
 * done, are told to the epic's lead, or to its creator while nobody leads it,
 * never to the person who did it (kind `epic`).
 */

// ------------------------------------------------------------------ shared

function requireEpicAction(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  action: RbacAction,
  what: string,
): void {
  // Archived projects are read-only (R6-3), as at `requireAction`.
  requireProjectMutable(project, what);
  requireProjectAuthority(db, project, actor, rolesForAction(action), { action, what });
}

function epicRef(ctx: TaskMutationContext, projectSlug: string, epicId: string): EpicFileRef {
  return { projectSlug, epicId, dataRoot: ctx.dataRoot };
}

/** Who did it, as a sentence names them. */
function whoOf(db: DatabaseSync, actor: TaskActor, ctx: TaskMutationContext): string {
  return ctx.operatorAuthorized ? "The operator" : actorProseName(db, actor);
}

function auditActorOf(actor: TaskActor, ctx: TaskMutationContext): AuditActor {
  return ctx.operatorAuthorized ? OPERATOR_AUDIT_ACTOR : { userId: actor.userId, label: actor.label };
}

function notifyFromOf(db: DatabaseSync, actor: TaskActor, ctx: TaskMutationContext): ActorRender {
  if (ctx.operatorAuthorized) return { kind: "agent", name: "Operator" };
  return createActorResolver(db)({
    kind: "human",
    userId: actor.userId,
    nameHint: userDisplayName(db, actor.userId),
  });
}

/** The epic, read from its file, or a not-found naming it. */
export function requireEpicFile(ctx: TaskMutationContext, projectSlug: string, epicId: string, forOperator = false) {
  const file = isEpicId(epicId) ? readEpicFile(epicRef(ctx, projectSlug, epicId)) : null;
  if (!file) {
    // The operator has no `list_epics`: its snapshot's `openEpics` is its list.
    const where = forOperator ? "your snapshot's `openEpics` names the open ones" : "list_epics or the Epics page names them";
    throw AppError.notFound(`${epicId} is not an epic in this project. An epic is named like epic-3; ${where}.`);
  }
  return file;
}

/**
 * Check that a task may be put in `epicId` at creation, before a key is
 * allocated. The one other writer of `epic` (`createTask`) calls it, so the
 * refusal reads the same whichever door the task came through.
 */
export function requireEpicForNewTask(
  ctx: TaskMutationContext,
  projectSlug: string,
  epicId: string,
): string {
  return requireEpicFile(ctx, projectSlug, epicId.trim()).parsed.frontmatter.id;
}

/** "epic-3 (Checkout redesign)", the way a sentence names an epic. */
function epicName(fm: Pick<EpicFrontmatter, "id" | "title">): string {
  return `**${fm.id}** (${fm.title})`;
}

/** An epic notice goes to the lead, or to the creator while nobody leads it,
 *  and never to the person whose act it reports. Fails open: the change it
 *  reports has already landed. */
function notifyEpicLead(
  db: DatabaseSync,
  fm: EpicFrontmatter,
  input: {
    projectSlug: string;
    text: string;
    exceptUserId: string | null;
    from: ActorRender;
    taskKey?: string | null;
  },
): void {
  const recipient = fm.leadUserId ?? fm.createdBy;
  if (!recipient || recipient === input.exceptUserId) return;
  try {
    createNotification(db, {
      userId: recipient,
      kind: "epic",
      title: `${fm.id} · ${fm.title}`,
      text: input.text,
      from: input.from,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey ?? null,
      href: epicLink(input.projectSlug, fm.id),
    });
  } catch (error) {
    logger.warn("epic notice could not be written", {
      projectSlug: input.projectSlug,
      epicId: fm.id,
      err: toError(error),
    });
  }
}

// ------------------------------------------------------------- validation

function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length < 3) {
    throw AppError.validation("Give the epic a name of at least 3 characters.");
  }
  if (title.length > EPIC_TITLE_MAX) {
    throw AppError.validation(
      `An epic's name is at most ${EPIC_TITLE_MAX} characters; put the rest in its description.`,
    );
  }
  return title;
}

function normalizeStatus(raw: string): EpicStatus {
  const status = EPIC_STATUS_VALUES.find((s) => s === raw);
  if (!status) {
    throw AppError.validation(
      `"${raw}" is not an epic status. Use one of: ${EPIC_STATUS_VALUES.join(", ")}.`,
    );
  }
  return status;
}

function normalizeColor(raw: string): EpicColor {
  const color = EPIC_COLORS.find((c) => c === raw);
  if (!color) {
    throw AppError.validation(`"${raw}" is not an epic colour. Use one of: ${EPIC_COLORS.join(", ")}.`);
  }
  return color;
}

/** `YYYY-MM-DD`, or null (blank clears). */
function normalizeDate(raw: string | null, which: "start" | "target"): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (!isValidDueDate(value)) {
    throw AppError.validation(`The ${which} date must be a calendar date (YYYY-MM-DD); got "${raw}".`);
  }
  return value;
}

function requireDateOrder(start: string | null, target: string | null): void {
  if (start && target && target < start) {
    throw AppError.validation(`The target date (${target}) is before the start date (${start}).`);
  }
}

/** A lead is a member of the project: the one the epic's notices reach. */
function normalizeLead(project: ProjectContext, raw: string | null): string | null {
  const userId = raw?.trim() ?? "";
  if (userId === "") return null;
  if (!project.memberRoles.has(userId)) {
    throw AppError.validation("An epic's lead must be a member of this project.");
  }
  return userId;
}

// ------------------------------------------------------------------ create

export interface CreateEpicInput {
  projectSlug: string;
  title: string;
  description?: string;
  status?: string;
  color?: string;
  leadUserId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  /** The controller conversation it is being planned in. */
  conversationId?: string | null;
  /** Existing tasks to put in the epic as it is created. */
  taskKeys?: readonly string[];
}

export interface EpicActionResult {
  epic: EpicDetail;
  /** A sentence saying what happened, for a toast or a tool reply. */
  message: string;
}

export async function createEpic(
  db: DatabaseSync,
  input: CreateEpicInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<EpicActionResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireEpicAction(db, project, actor, "manage-epics", "create epics");
  const title = normalizeTitle(input.title);
  const status = input.status === undefined ? "planned" : normalizeStatus(input.status);
  const color = input.color === undefined ? null : normalizeColor(input.color);
  const leadUserId = normalizeLead(project, input.leadUserId ?? null);
  const startDate = normalizeDate(input.startDate ?? null, "start");
  const targetDate = normalizeDate(input.targetDate ?? null, "target");
  requireDateOrder(startDate, targetDate);
  // The tasks are checked BEFORE an id is minted, so a wrong key leaves no
  // empty epic behind it.
  const taskKeys = [...new Set((input.taskKeys ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean))];
  if (taskKeys.length > 0) {
    requireEpicAction(db, project, actor, "edit-task-meta", "put tasks in an epic");
    for (const key of taskKeys) requireMovableTask(ctx, input.projectSlug, key);
  }

  const who = actorProseName(db, actor);
  const epicId = await withEpicsLock(input.projectSlug, ctx.dataRoot, async () => {
    const id = nextEpicId(input.projectSlug, ctx.dataRoot);
    const now = new Date().toISOString();
    await createEpicFile(epicRef(ctx, input.projectSlug, id), {
      frontmatter: {
        id,
        title,
        status,
        color: color ?? defaultEpicColor(id),
        leadUserId,
        startDate,
        targetDate,
        createdBy: actor.userId,
        createdByLabel: actor.label,
        conversationId: input.conversationId ?? null,
        convertedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
      description: input.description?.trim() ?? "",
      timeline: [{ occurredAt: now, text: `Created by ${who}.` }],
    });
    return id;
  });
  rebuildEpicFile(db, input.projectSlug, epicId, { dataRoot: ctx.dataRoot });
  recordAudit(db, {
    action: "epic.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "epic",
    subjectId: epicId,
    projectSlug: input.projectSlug,
    details: { title, status, total: taskKeys.length },
  });
  // A lead named by someone else hears that they lead it.
  if (leadUserId && leadUserId !== actor.userId) {
    const fm = readEpicFile(epicRef(ctx, input.projectSlug, epicId))?.parsed.frontmatter;
    if (fm) {
      notifyEpicLead(db, fm, {
        projectSlug: input.projectSlug,
        text: `${who} created ${epicName(fm)} with you as its lead.`,
        exceptUserId: actor.userId,
        from: notifyFromOf(db, actor, ctx),
      });
    }
  }
  let added: string[] = [];
  if (taskKeys.length > 0) {
    const moved = await setTasksEpic(
      db,
      { projectSlug: input.projectSlug, taskKeys, epicId },
      actor,
      ctx,
    );
    added = moved.changed.map((c) => c.taskKey);
  }
  const epic = getEpicDetail(db, input.projectSlug, epicId, { dataRoot: ctx.dataRoot });
  if (!epic) throw AppError.internal(`Epic ${epicId} vanished after write.`);
  return {
    epic,
    message:
      `Created ${epicId} (${title})` +
      (added.length > 0 ? ` with ${added.join(", ")} in it.` : "."),
  };
}

// ------------------------------------------------------------------ update

export interface UpdateEpicInput {
  projectSlug: string;
  epicId: string;
  /** Absent leaves a field alone; for the nullable ones `null` (or a blank
   *  string) clears it. */
  title?: string;
  description?: string;
  status?: string;
  color?: string;
  leadUserId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export async function updateEpic(
  db: DatabaseSync,
  input: UpdateEpicInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<EpicActionResult & { changed: string[] }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireEpicAction(db, project, actor, "manage-epics", "edit epics");
  const current = requireEpicFile(ctx, input.projectSlug, input.epicId).parsed;
  // Everything is validated before the write, so a bad value fails the whole
  // edit and never lands half of it.
  const title = input.title === undefined ? undefined : normalizeTitle(input.title);
  const status = input.status === undefined ? undefined : normalizeStatus(input.status);
  const color = input.color === undefined ? undefined : normalizeColor(input.color);
  const leadUserId =
    input.leadUserId === undefined ? undefined : normalizeLead(project, input.leadUserId);
  const startDate = input.startDate === undefined ? undefined : normalizeDate(input.startDate, "start");
  const targetDate =
    input.targetDate === undefined ? undefined : normalizeDate(input.targetDate, "target");
  requireDateOrder(
    startDate === undefined ? current.frontmatter.startDate : startDate,
    targetDate === undefined ? current.frontmatter.targetDate : targetDate,
  );
  const description = input.description === undefined ? undefined : input.description.trim();

  const who = actorProseName(db, actor);
  const changed: string[] = [];
  // What the notices compare against: the file as it stood before this edit.
  const previousLead = current.frontmatter.leadUserId;
  const previousStatus = current.frontmatter.status;
  const updated = await updateEpicFile(epicRef(ctx, input.projectSlug, input.epicId), (epic) => {
    const fm = epic.frontmatter;
    if (title !== undefined && title !== fm.title) {
      changed.push(`renamed it from "${fm.title}" to "${title}"`);
      fm.title = title;
    }
    if (description !== undefined && description !== epic.description) {
      changed.push(description === "" ? "cleared the description" : "rewrote the description");
      epic.description = description;
    }
    if (status !== undefined && status !== fm.status) {
      changed.push(`set the status to ${EPIC_STATUS_LABEL[status]}`);
      fm.status = status;
    }
    if (color !== undefined && color !== fm.color) {
      changed.push(`changed the colour to ${color}`);
      fm.color = color;
    }
    if (leadUserId !== undefined && leadUserId !== fm.leadUserId) {
      changed.push(
        leadUserId === null ? "cleared the lead" : `made ${userDisplayName(db, leadUserId)} the lead`,
      );
      fm.leadUserId = leadUserId;
    }
    if (startDate !== undefined && startDate !== fm.startDate) {
      changed.push(startDate === null ? "cleared the start date" : `set the start date to ${startDate}`);
      fm.startDate = startDate;
    }
    if (targetDate !== undefined && targetDate !== fm.targetDate) {
      changed.push(
        targetDate === null ? "cleared the target date" : `set the target date to ${targetDate}`,
      );
      fm.targetDate = targetDate;
    }
    return changed.length > 0 ? `${who} ${joinClauses(changed)}.` : undefined;
  });
  const fm = updated.frontmatter;
  if (changed.length > 0) {
    rebuildEpicFile(db, input.projectSlug, input.epicId, { dataRoot: ctx.dataRoot });
    recordAudit(db, {
      action: "epic.updated",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "epic",
      subjectId: input.epicId,
      projectSlug: input.projectSlug,
      details: {
        title: fm.title,
        summary: joinClauses(changed),
        status: status !== undefined && status !== previousStatus ? status : undefined,
      },
    });
    const from = notifyFromOf(db, actor, ctx);
    // A new lead hears that they lead it; the lead hears when someone else
    // closes or reopens their epic.
    if (leadUserId && leadUserId !== previousLead) {
      notifyEpicLead(db, fm, {
        projectSlug: input.projectSlug,
        text: `${who} made you the lead of ${epicName(fm)}.`,
        exceptUserId: actor.userId,
        from,
      });
    } else if (status !== undefined && status !== previousStatus) {
      notifyEpicLead(db, fm, {
        projectSlug: input.projectSlug,
        text: `${who} set ${epicName(fm)} to ${EPIC_STATUS_LABEL[status]}.`,
        exceptUserId: actor.userId,
        from,
      });
    }
  }
  const epic = getEpicDetail(db, input.projectSlug, input.epicId, { dataRoot: ctx.dataRoot });
  if (!epic) throw AppError.internal(`Epic ${input.epicId} vanished after write.`);
  return {
    epic,
    changed,
    message:
      changed.length > 0
        ? `Updated ${input.epicId}: ${joinClauses(changed)}.`
        : `${input.epicId} already reads that way; nothing changed.`,
  };
}

/** "a", "a and b", "a, b and c". */
export function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses.join("");
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]!}`;
}

// -------------------------------------------------------------- membership

/** A task that can change epics: it exists and is not archived (an archived
 *  task's planning metadata is frozen, F26-13). */
function requireMovableTask(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  if (file.parsed.frontmatter.archived) {
    throw AppError.validation(`${taskKey} is archived; restore it before changing its epic.`);
  }
  return file;
}

export interface SetTasksEpicInput {
  projectSlug: string;
  taskKeys: readonly string[];
  /** The epic they join, or null to take them out of whichever they are in. */
  epicId: string | null;
  /** Take them out of THIS epic only (with `epicId: null`): a task that is in
   *  another epic, or in none, is refused and nothing is written. An epic's
   *  page and the controller's `removeTasks` pass it, so a stale page never
   *  takes a task out of the epic it has since moved to. */
  fromEpicId?: string;
}

export interface EpicMembershipChange {
  taskKey: string;
  from: string | null;
  to: string | null;
}

export interface SetTasksEpicResult {
  changed: EpicMembershipChange[];
  /** Already where they were asked to be: nothing written. */
  unchanged: string[];
  message: string;
}

/** What `setTasksEpic` would do: the epic the tasks join (null: out of their
 *  epic), the moves, and the tasks already where they were asked to be. */
export interface TasksEpicPlan {
  target: EpicFrontmatter | null;
  plan: EpicMembershipChange[];
  unchanged: string[];
}

/**
 * Every check `setTasksEpic` makes, and the moves it would make, with nothing
 * written: the actor may move tasks, the epic exists, and every task exists,
 * is not archived and (with `fromEpicId`) is in that epic. A request that also
 * writes something else (the controller's `update_epic` renames an epic and
 * adds tasks in one call) plans first, so a bad key refuses all of it instead
 * of landing half.
 */
export function planTasksEpic(
  db: DatabaseSync,
  input: SetTasksEpicInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): TasksEpicPlan {
  const project = loadProjectContext(ctx, input.projectSlug);
  const what = input.epicId ? "put tasks in an epic" : "take tasks out of an epic";
  if (ctx.operatorAuthorized) requireProjectMutable(project, what);
  else requireEpicAction(db, project, actor, "edit-task-meta", what);
  const keys = [...new Set(input.taskKeys.map((k) => k.trim().toUpperCase()).filter(Boolean))];
  if (keys.length === 0) throw AppError.validation("Name at least one task.");
  const target =
    input.epicId === null
      ? null
      : requireEpicFile(ctx, input.projectSlug, input.epicId, ctx.operatorAuthorized === true).parsed.frontmatter;
  const plan: EpicMembershipChange[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const file = requireMovableTask(ctx, input.projectSlug, key);
    const from = file.parsed.frontmatter.epic;
    if (input.fromEpicId !== undefined && from !== input.fromEpicId) {
      throw AppError.validation(`${key} is not in ${input.fromEpicId}; nothing was changed.`);
    }
    const to = target?.id ?? null;
    if (from === to) unchanged.push(key);
    else plan.push({ taskKey: key, from, to });
  }
  return { target, plan, unchanged };
}

/**
 * THE writer of a task's `epic` after creation: a person on the task page, the
 * Epics pages and the board, the controller's `update_task` and
 * `update_epic`, and the operator's `set_epic` all land here, so the timeline
 * note, the epic's history line, the audit row and the lead's notice read the
 * same whichever door moved the task.
 *
 * Every key is checked before anything is written. A task already in the
 * target is left alone and reported as unchanged.
 */
export async function setTasksEpic(
  db: DatabaseSync,
  input: SetTasksEpicInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<SetTasksEpicResult> {
  const { target, plan, unchanged } = planTasksEpic(db, input, actor, ctx);
  if (plan.length === 0) {
    return {
      changed: [],
      unchanged,
      message: target
        ? `${joinClauses(unchanged)} ${unchanged.length === 1 ? "is" : "are"} already in ${target.id}.`
        : `${joinClauses(unchanged)} ${unchanged.length === 1 ? "is" : "are"} in no epic already.`,
    };
  }

  // The epics a sentence names, read once.
  const titles = new Map<string, string>();
  const titleOf = (id: string): string => {
    let title = titles.get(id);
    if (title === undefined) {
      title = readEpicFile(epicRef(ctx, input.projectSlug, id))?.parsed.frontmatter.title ?? "";
      titles.set(id, title);
    }
    return title;
  };
  const named = (id: string) => (titleOf(id) ? `**${id}** (${titleOf(id)})` : `**${id}**`);

  const now = new Date().toISOString();
  const actorRef = ctx.operatorAuthorized
    ? ({ kind: "operator" } as const)
    : ({ kind: "human", userId: actor.userId, nameHint: userDisplayName(db, actor.userId) } as const);
  const done: EpicMembershipChange[] = [];
  // The epics an OPEN task left: only those can have just become all done.
  const leftOpen = new Set<string>();
  const { stages } = loadProjectContext(ctx, input.projectSlug);
  for (const change of plan) {
    let wrote = false;
    await updateTaskFile(taskRef(ctx, input.projectSlug, change.taskKey), (parsed) => {
      // Re-read under the task's own lock: a concurrent move wins, and this
      // one reports what it found instead of writing over it.
      if (parsed.frontmatter.epic !== change.from || parsed.frontmatter.archived) return;
      if (change.from && !isTerminalStage(parsed.frontmatter.stage, stages)) leftOpen.add(change.from);
      parsed.frontmatter.epic = change.to;
      const text =
        change.from && change.to
          ? `Moved from ${named(change.from)} to ${named(change.to)}.`
          : change.to
            ? `Added to ${named(change.to)}.`
            : `Removed from ${named(change.from!)}.`;
      const event: TaskFileEvent = {
        occurredAt: now,
        type: "note",
        actor: actorRef,
        title: "Epic",
        text,
        toAgent: false,
        evidence: null,
      };
      parsed.timeline.unshift(event);
      wrote = true;
    });
    if (!wrote) continue;
    reprojectTask(db, ctx, input.projectSlug, change.taskKey);
    recordAudit(db, {
      action: "task.epic.changed",
      actor: auditActorOf(actor, ctx),
      subjectKind: "task",
      subjectId: change.taskKey,
      projectSlug: input.projectSlug,
      taskKey: change.taskKey,
      details: {
        from: change.from,
        to: change.to,
        title: change.to ? titleOf(change.to) : change.from ? titleOf(change.from) : null,
      },
    });
    done.push(change);
  }

  // One history line and one notice per epic touched, however many tasks.
  const who = whoOf(db, actor, ctx);
  const from = notifyFromOf(db, actor, ctx);
  const exceptUserId = ctx.operatorAuthorized ? null : actor.userId;
  const touched = new Set<string>();
  for (const change of done) {
    if (change.from) touched.add(change.from);
    if (change.to) touched.add(change.to);
  }
  for (const epicId of touched) {
    const joined = done.filter((c) => c.to === epicId);
    const left = done.filter((c) => c.from === epicId);
    const clauses: string[] = [];
    const plain = joined.filter((c) => c.from === null).map((c) => c.taskKey);
    if (plain.length > 0) clauses.push(`added ${joinClauses(plain)}`);
    for (const c of joined.filter((j) => j.from !== null)) {
      clauses.push(`moved ${c.taskKey} here from ${c.from}`);
    }
    const removed = left.filter((c) => c.to === null).map((c) => c.taskKey);
    if (removed.length > 0) clauses.push(`removed ${joinClauses(removed)}`);
    for (const c of left.filter((l) => l.to !== null)) clauses.push(`moved ${c.taskKey} to ${c.to}`);
    const sentence = `${who} ${joinClauses(clauses)}.`;
    try {
      const epic = await updateEpicFile(epicRef(ctx, input.projectSlug, epicId), () => sentence);
      rebuildEpicFile(db, input.projectSlug, epicId, { dataRoot: ctx.dataRoot });
      const one = joined.length + left.length === 1 ? (joined[0] ?? left[0])!.taskKey : null;
      notifyEpicLead(db, epic.frontmatter, {
        projectSlug: input.projectSlug,
        text: `${who} ${joinClauses(clauses)} in ${epicName(epic.frontmatter)}.`,
        exceptUserId,
        from,
        taskKey: one,
      });
    } catch (error) {
      // The tasks moved; the epic's own history is the record that lags. An
      // epic file that cannot be read is the store doctor's to name.
      logger.warn("epic history could not record a membership change", {
        projectSlug: input.projectSlug,
        epicId,
        err: toError(error),
      });
    }
  }
  // An open task leaving can be the last open one: the epic it left may now be
  // done. A done task leaving completes nothing new.
  for (const epicId of leftOpen) await noteEpicCompleteIfDone(db, ctx, input.projectSlug, epicId);

  const moved = done.map((c) => c.taskKey);
  const message =
    moved.length === 0
      ? "Nothing changed: each task had already moved."
      : target
        ? `${joinClauses(moved)} ${moved.length === 1 ? "is" : "are"} now in ${target.id} (${target.title}).`
        : `${joinClauses(moved)} ${moved.length === 1 ? "is" : "are"} no longer in an epic.`;
  return { changed: done, unchanged, message };
}

/**
 * A task made in an epic joined it, so the epic's history says so and its lead
 * is told, as for a task added later ("Arda made WEB-7 in this epic"). The
 * task's own "Epic" note and the `task.created` row's `epic` are `createTask`'s.
 * Fails open: the task exists.
 */
export async function noteTaskMadeInEpic(
  db: DatabaseSync,
  input: { projectSlug: string; epicId: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<void> {
  const who = whoOf(db, actor, ctx);
  try {
    const epic = await updateEpicFile(
      epicRef(ctx, input.projectSlug, input.epicId),
      () => `${who} made ${input.taskKey} in this epic.`,
    );
    rebuildEpicFile(db, input.projectSlug, input.epicId, { dataRoot: ctx.dataRoot });
    notifyEpicLead(db, epic.frontmatter, {
      projectSlug: input.projectSlug,
      text: `${who} made ${input.taskKey} in ${epicName(epic.frontmatter)}.`,
      exceptUserId: ctx.operatorAuthorized ? null : actor.userId,
      from: notifyFromOf(db, actor, ctx),
      taskKey: input.taskKey,
    });
  } catch (error) {
    logger.warn("epic history could not record a task made in it", {
      projectSlug: input.projectSlug,
      epicId: input.epicId,
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

// ---------------------------------------------------------- all done notice

const ALL_DONE_PREFIX = "Every task is done";

/**
 * When the last open task of an OPEN epic is done (it reached the terminal
 * stage, or the one still open left or was archived), say so once on the
 * epic's history and tell its lead. The epic's status stays theirs to set:
 * a Jira epic and a Linear project are closed by a person too, because "every
 * task I filed is done" and "the work has landed" are not the same claim.
 *
 * Idempotent: the newest history line already saying so is left alone, so the
 * hooks that call this on every stage move cost one projection read.
 */
async function noteEpicCompleteIfDone(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  epicId: string,
): Promise<void> {
  const epic = getEpic(db, projectSlug, epicId);
  if (!epic || !isEpicOpen(epic.status)) return;
  const { total, done } = epic.progress;
  if (total === 0 || done < total) return;
  const line = `${ALL_DONE_PREFIX} (${countLabel(total, "task")}).`;
  let wrote = false;
  const updated = await updateEpicFile(epicRef(ctx, projectSlug, epicId), (file) => {
    if (!isEpicOpen(file.frontmatter.status)) return;
    if (file.timeline[0]?.text === line) return;
    wrote = true;
    return line;
  });
  if (!wrote) return;
  rebuildEpicFile(db, projectSlug, epicId, { dataRoot: ctx.dataRoot });
  notifyEpicLead(db, updated.frontmatter, {
    projectSlug,
    text: `Every task in ${epicName(updated.frontmatter)} is done. Set the epic to Done once the work has landed.`,
    exceptUserId: null,
    from: { kind: "system", name: "Viberr" },
  });
}

/**
 * Hook: a task moved stage, was archived or restored. Fire-and-forget from the
 * task write paths, like the dependency release beside it; a task in no epic
 * costs one file read.
 */
export function maybeNoteEpicComplete(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  void (async () => {
    const epicId = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter.epic;
    if (epicId) await noteEpicCompleteIfDone(db, ctx, projectSlug, epicId);
  })().catch((error) => {
    logger.warn("epic completion check failed", {
      projectSlug,
      taskKey,
      err: toError(error),
    });
  });
}
