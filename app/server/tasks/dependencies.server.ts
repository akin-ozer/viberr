import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import {
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { findUserById } from "~/server/auth/user-store.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import {
  requireProjectAuthority,
  requireProjectMutable,
} from "~/server/auth/project-authority.server";
import { rolesForAction } from "~/shared/rbac";
import { logger } from "~/server/logging/logger.server";
import type { ParsedTaskFile, TaskFileEvent } from "~/schemas/task-file.schema";
import type { TaskSummary } from "~/shared/mapping/task.server";
import {
  DEPENDENCY_GRAMMAR_HINT,
  formatDependencyRef,
  parseDependencyRef,
  type DependencyRef,
} from "~/shared/dependencies";
import { getTaskSummary } from "~/server/projections/task-query.server";
import {
  loadProjectContext,
  notifyTaskWatchers,
  reprojectTask,
  taskRef,
  type TaskActor,
} from "./task-mutation.server";
// Type-only: the action context carries the injectable `runOperator` seam the
// release hands the re-invoke to; no runtime edge back into task-actions.
import type { TaskActionContext } from "./task-actions.server";

/**
 * Ruling 131 (pass 34, Q34-11): the ONE writer for a task's `blockedBy` list,
 * and the two halves of its release.
 *
 * Three doors write the list (a human on the task page, the controller through
 * `create_task` / `update_task` / a goal link, the operator through its
 * `set_dependencies` tool) and every one of them lands here: the same
 * validation against the store, the same `note`, the same audit row. Live,
 * JC-9's operator had only a decision packet to say "this waits on goal-1"
 * with, and used it as a standing token for five paid turns.
 */

// ------------------------------------------------------------ validation

/** What the list is being written FOR: a task (the usual case), or a goal
 *  link that has no task yet (the goal writer declares its wait, ruling
 *  131(c)); null when nothing on the store carries the list yet (creation
 *  before a key is allocated). */
export type DependencySelf = DependencyRef | null;

const linksRowSchema = z
  .array(
    z
      .object({
        index: z.number().int(),
        taskKey: z.string().nullable().default(null),
        blockedBy: z.array(z.string()).default([]),
      })
      .loose(),
  )
  .catch([]);
type LinkRow = z.infer<typeof linksRowSchema>[number];

interface TaskRow {
  archived: number;
  blocked_by_json: string;
}

function taskRow(db: DatabaseSync, slug: string, key: string): TaskRow | null {
  // SAFETY: `archived` INTEGER NOT NULL and `blocked_by_json` TEXT NOT NULL on
  // `task_projections` (0001 + ruling 131).
  const row = db
    .prepare(`SELECT archived, blocked_by_json FROM task_projections WHERE project_slug = ? AND task_key = ?`)
    .get(slug, key) as TaskRow | undefined;
  return row ?? null;
}

function goalLinks(db: DatabaseSync, slug: string, goalId: string): LinkRow[] | null {
  // SAFETY: `links_json` is TEXT NOT NULL DEFAULT '[]' on `goal_projections`.
  const row = db
    .prepare(`SELECT links_json FROM goal_projections WHERE project_slug = ? AND goal_id = ?`)
    .get(slug, goalId) as { links_json: string } | undefined;
  if (!row) return null;
  return linksRowSchema.parse(JSON.parse(row.links_json));
}

function storedList(row: TaskRow | null): string[] {
  return row ? z.array(z.string()).catch([]).parse(JSON.parse(row.blocked_by_json)) : [];
}

/** The refs a node waits on: a task's stored list, or a goal link's task's
 *  list once created, else the link's DECLARED list. */
function edgesOf(db: DatabaseSync, slug: string, ref: DependencyRef): DependencyRef[] {
  let raw: string[] = [];
  if (ref.kind === "task") {
    raw = storedList(taskRow(db, slug, ref.task));
  } else {
    const link = goalLinks(db, slug, ref.goal)?.find((l) => l.index === ref.link) ?? null;
    if (link?.taskKey) raw = storedList(taskRow(db, slug, link.taskKey));
    else if (link) raw = link.blockedBy;
  }
  return raw.map(parseDependencyRef).filter((r): r is DependencyRef => r !== null);
}

/** Does `ref` denote the same node as `self`? A goal link whose task IS
 *  `self`'s task counts, so `JC-3` waiting on `goal-1 link 2` (which created
 *  JC-3) is a self-wait. */
function sameNode(db: DatabaseSync, slug: string, ref: DependencyRef, self: DependencySelf): boolean {
  if (!self) return false;
  if (formatDependencyRef(ref) === formatDependencyRef(self)) return true;
  if (ref.kind === "goal" && self.kind === "task") {
    const link = goalLinks(db, slug, ref.goal)?.find((l) => l.index === ref.link);
    return link?.taskKey === self.task;
  }
  if (ref.kind === "task" && self.kind === "goal") {
    const link = goalLinks(db, slug, self.goal)?.find((l) => l.index === self.link);
    return link?.taskKey === ref.task;
  }
  return false;
}

/** Depth-first from `start` along stored AND declared edges (ruling 131(b));
 *  the path back to `self`, or null when no cycle would close. */
function cyclePath(db: DatabaseSync, slug: string, start: DependencyRef, self: DependencySelf): string[] | null {
  const seen = new Set<string>();
  const stack: { ref: DependencyRef; path: string[] }[] = [
    { ref: start, path: [formatDependencyRef(start)] },
  ];
  while (stack.length) {
    const { ref, path } = stack.pop()!;
    for (const next of edgesOf(db, slug, ref)) {
      const spelled = formatDependencyRef(next);
      if (sameNode(db, slug, next, self)) return [...path, spelled];
      if (seen.has(spelled)) continue;
      seen.add(spelled);
      stack.push({ ref: next, path: [...path, spelled] });
    }
  }
  return null;
}

/**
 * Validate a list against the store and return it in canonical spellings,
 * de-duplicated, in the order given. A refusal names the reference and the
 * reason: unparseable (quoting the grammar), self, unknown task, archived
 * task, unknown goal or link, or a cycle (walking stored task lists and
 * DECLARED goal-link lists alike, so a mutual sibling-chain wait is refused at
 * write time instead of producing two tasks born held forever).
 */
export function validateDependencyRefs(
  db: DatabaseSync,
  input: { projectSlug: string; self: DependencySelf; entries: readonly string[] },
): string[] {
  const slug = input.projectSlug;
  const out: string[] = [];
  for (const raw of input.entries) {
    const text = raw.trim();
    if (text === "") continue;
    const ref = parseDependencyRef(text);
    if (!ref) {
      throw AppError.validation(`"${text}" is not a task key or a goal link. ${DEPENDENCY_GRAMMAR_HINT}`);
    }
    const spelled = formatDependencyRef(ref);
    if (sameNode(db, slug, ref, input.self)) {
      throw AppError.validation(`${spelled}: a task cannot wait on itself.`);
    }
    if (ref.kind === "task") {
      const row = taskRow(db, slug, ref.task);
      if (!row) throw AppError.validation(`${spelled} is not a task in this project.`);
      if (row.archived) throw AppError.validation(`${spelled} is archived; a task cannot wait on abandoned work.`);
    } else {
      const links = goalLinks(db, slug, ref.goal);
      if (!links) throw AppError.validation(`${ref.goal} is not a goal in this project.`);
      const link = links.find((l) => l.index === ref.link);
      if (!link) throw AppError.validation(`${ref.goal} has no link ${ref.link} (it has ${links.length}).`);
      if (link.taskKey && taskRow(db, slug, link.taskKey)?.archived) {
        throw AppError.validation(`${spelled} (${link.taskKey}) is archived; a task cannot wait on abandoned work.`);
      }
    }
    const cycle = cyclePath(db, slug, ref, input.self);
    if (cycle) {
      const selfName = input.self ? formatDependencyRef(input.self) : "this task";
      throw AppError.validation(
        `Waiting on ${spelled} would close a cycle: ${[selfName, ...cycle].join(" waits on ")}.`,
      );
    }
    if (!out.includes(spelled)) out.push(spelled);
  }
  return out;
}

// ---------------------------------------------------------------- writer

function actorRefOf(db: DatabaseSync, actor: TaskActor, ctx: TaskActionContext) {
  if (ctx.operatorAuthorized) return { kind: "operator" as const };
  return {
    kind: "human" as const,
    userId: actor.userId,
    nameHint: findUserById(db, actor.userId)?.name ?? null,
  };
}

function summaryOrThrow(db: DatabaseSync, slug: string, key: string): TaskSummary {
  const summary = getTaskSummary(db, slug, key);
  if (!summary) throw AppError.internal(`Task ${slug}/${key} vanished after write.`);
  return summary;
}

/** Is anything ELSE owed on this task, so `waiting` must not settle to `none`? */
function somethingPending(parsed: ParsedTaskFile): boolean {
  return (
    parsed.packet !== null ||
    parsed.frontmatter.recommendations.length > 0 ||
    parsed.frontmatter.waiting === "agent"
  );
}

export interface SetTaskDependenciesInput {
  projectSlug: string;
  taskKey: string;
  /** The FULL list; `[]` clears. */
  blockedBy: readonly string[];
}

export interface SetTaskDependenciesResult {
  task: TaskSummary;
  /** False when the validated list equalled the stored one (nothing written). */
  changed: boolean;
  blockedBy: string[];
  added: string[];
  removed: string[];
}

/**
 * Replace a task's `blockedBy` list. Gated on `edit-task-meta` unless the
 * operator is acting (`ctx.operatorAuthorized`); an archived task is refused
 * with its own sentence; an unchanged list short-circuits. A non-empty list
 * settles `waiting: "none"` when nothing else is pending (the task owes nobody
 * anything while it waits, ruling 131(a)); an emptied list clears a recorded
 * `heldAtStage`. When a NON-operator write empties a previously non-empty
 * list, that write IS the release (ruling 131(e)): the release note is the
 * one note that lands, through the same two halves the engine uses.
 */
export async function setTaskDependencies(
  db: DatabaseSync,
  input: SetTaskDependenciesInput,
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<SetTaskDependenciesResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const what = "edit what a task waits on";
  requireProjectMutable(project, what);
  if (!ctx.operatorAuthorized) {
    requireProjectAuthority(db, project, actor, rolesForAction("edit-task-meta"), {
      action: "edit-task-meta",
      what,
    });
  }
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fm = existing.parsed.frontmatter;
  if (fm.archived) {
    throw AppError.validation(
      `${input.taskKey} is archived; restore it before editing what it waits on.`,
    );
  }
  const next = validateDependencyRefs(db, {
    projectSlug: input.projectSlug,
    self: { kind: "task", task: input.taskKey },
    entries: input.blockedBy,
  });
  const previous = [...fm.blockedBy];
  const added = next.filter((r) => !previous.includes(r));
  const removed = previous.filter((r) => !next.includes(r));
  if (JSON.stringify(next) === JSON.stringify(previous)) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: false, blockedBy: next, added, removed };
  }
  const releasing = next.length === 0 && previous.length > 0 && !ctx.operatorAuthorized;
  const by = actorRefOf(db, actor, ctx);
  await updateTaskFile(ref, (parsed) => {
    if (releasing) {
      clearDependencies(parsed);
      return;
    }
    parsed.frontmatter.blockedBy = next;
    if (next.length === 0) {
      parsed.frontmatter.heldAtStage = null;
    } else if (!somethingPending(parsed)) {
      parsed.frontmatter.waiting = "none";
    }
    const clauses: string[] = [];
    if (added.length) clauses.push(`added ${added.join(", ")}`);
    if (removed.length) clauses.push(`removed ${removed.join(", ")}`);
    const event: TaskFileEvent = {
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: by,
      title: "Dependencies updated",
      text:
        next.length > 0
          ? `Waits on ${next.join(", ")} (${clauses.join("; ")}). Held until every entry is done; Viberr releases it then.`
          : `No longer waits on other work (${clauses.join("; ")}).`,
      toAgent: false,
      evidence: null,
    };
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.dependencies.updated",
    actor: ctx.operatorAuthorized ? OPERATOR_AUDIT_ACTOR : { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { blockedBy: next, added, removed },
  });
  if (releasing) {
    await announceRelease(db, ctx, input.projectSlug, input.taskKey, {
      entries: previous,
      clearedBy: actor.label,
    });
  }
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: true, blockedBy: next, added, removed };
}

// --------------------------------------------------------------- release

/**
 * The frontmatter half of a release (ruling 131(e)): the list is cleared, a
 * recorded `heldAtStage` with it, and a STORED `blocked` readiness is lifted
 * to `ready` (the derived floor lifts by itself on reproject; the stored
 * value would otherwise keep the task red). Returns the entries cleared.
 */
export function clearDependencies(parsed: ParsedTaskFile): string[] {
  const fm = parsed.frontmatter;
  const entries = [...fm.blockedBy];
  fm.blockedBy = [];
  fm.heldAtStage = null;
  if (fm.readiness === "blocked") fm.readiness = "ready";
  return entries;
}

export interface AnnounceReleaseInput {
  /** What was waited on (the entries the frontmatter half cleared). */
  entries: readonly string[];
  /** The person who emptied the list by hand, when it was not the engine. */
  clearedBy?: string;
}

/**
 * The announcing half of a release: the release note naming what was waited
 * on, the `task.dependencies.released` audit row, the `dependency`
 * notification to the owner and supervisors, and the operator re-invoked with
 * the `dependencies-released` trigger. Shared by the engine and by a human
 * clearing the list (the same release, the same two halves).
 */
export async function announceRelease(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  input: AnnounceReleaseInput,
): Promise<void> {
  const list = input.entries.join(", ");
  const text = input.clearedBy
    ? `Released: ${input.clearedBy} cleared the wait on ${list}. The task can move again; the base branch may have changed since the hold.`
    : `Released: everything this task waited on is done (${list}). The task can move again; the base branch has changed since the hold, so the work re-reads it before continuing.`;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: { kind: "system", systemId: "dependency-release" },
      title: "Dependencies released",
      text,
      toAgent: true,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
  recordAudit(db, {
    action: "task.dependencies.released",
    actor: SYSTEM_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { entries: [...input.entries], clearedBy: input.clearedBy ?? null },
  });
  notifyTaskWatchers(
    db,
    { projectSlug, taskKey, kind: "dependency", title: `${taskKey} can move again`, text },
    ctx,
  );
  try {
    const { autoInvokeOperator } = await import("./task-actions.server");
    await autoInvokeOperator(db, ctx, projectSlug, taskKey, "dependencies-released");
  } catch (error) {
    logger.warn("dependency release could not re-invoke the operator", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
