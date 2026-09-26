import type { ActorRender } from "~/shared/mapping/actor.server";
import { systemIdToName } from "~/server/files/actor-ref.server";
import type { DatabaseSync } from "node:sqlite";
import { actorProseName } from "./user-display-name.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import {
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { findUserById } from "~/server/auth/user-store.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import type { QueuedQuestion } from "~/schemas/task-file.schema";
import { readGoalFile, updateGoalFile } from "~/server/files/goal-writer.server";
import { rebuildGoalFile } from "~/server/projections/rebuilder.server";
import {
  requireProjectAuthority,
  requireProjectMutable,
} from "~/server/auth/project-authority.server";
import { rolesForAction } from "~/shared/rbac";
import { logger } from "~/server/logging/logger.server";
import type { ParsedTaskFile, TaskFileEvent } from "~/schemas/task-file.schema";
import type { GoalLink } from "~/schemas/goal-file.schema";
import type { TaskSummary } from "~/shared/mapping/task.server";
import {
  DEPENDENCY_GRAMMAR_HINT,
  formatDependencyRef,
  parseDependencyRef,
  type DependencyRef,
  type DependencyReleasePayload,
} from "~/shared/dependencies";
import {
  deadDependencies,
  dependenciesSatisfied,
  listHeldTasks,
  resolveDependencies,
} from "~/server/projections/dependencies.server";
import {
  loadProjectContext,
  notifyTaskWatchers,
  reprojectTask,
  summaryOrThrow,
  taskRef,
  type TaskActor,
} from "./task-mutation.server";
// Type-only: the action context carries the injectable `runOperator` seam the
// release hands the re-invoke to; no runtime edge back into task-actions.
import type { TaskActionContext } from "./task-actions.server";
import { errorMessage, toError } from "~/shared/errors";

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
      // Ruling 398(b): a link the chain has SETTLED — `done`, or `skipped` by
      // an onFailure=continue ride-through — is a valid thing to wait on
      // however its task ended. The refusal below is about a live link whose
      // work was abandoned; reading the task alone refused a wait on a link
      // that had already completed, and refused the ride-through's own next
      // link in the name of the failure it was riding past.
      const settled = link.status === "done" || link.status === "skipped";
      if (!settled && link.taskKey && taskRow(db, slug, link.taskKey)?.archived) {
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
  // F39-63 (pass 39): a wait on a task that is already done holds nothing. It
  // was written anyway ("Held until every entry is done"), the engine released
  // it on its next sweep, and the release note told the task "the base branch
  // has changed since the hold" when nothing had merged. Live on ax-clone AX-29
  // the operator re-applied a finished directive's first step this way, and
  // the release it paid for sent the next drive to refresh a current branch
  // instead of re-running the review it owed. Only an ADDED entry is judged:
  // one already on the list that finished since is the engine's to release.
  // A settled goal link stays a valid wait (ruling 398(b)).
  const alreadyDone = resolveDependencies(db, input.projectSlug, added).filter(
    (e) => e.state === "done" && e.goalId === null,
  );
  if (alreadyDone.length > 0) {
    const one = alreadyDone.length === 1;
    throw AppError.validation(
      `${alreadyDone.map((e) => e.label).join(", ")} ${one ? "is" : "are"} already done, so waiting on ` +
        `${one ? "it" : "them"} holds nothing. Leave ${one ? "it" : "them"} off the list.`,
    );
  }
  if (JSON.stringify(next) === JSON.stringify(previous)) {
    // Ruling 155: the record the link carries is brought back in step even
    // when the task's own list did not move (a stale link heals on the next
    // write instead of waiting for a different one).
    await mirrorLinkWait(db, ctx, input.projectSlug, input.taskKey, fm.goalRef, next, changedByOf(db, actor, ctx));
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
  // Ruling 155: a link's task owns the wait; the goal file follows it.
  await mirrorLinkWait(db, ctx, input.projectSlug, input.taskKey, fm.goalRef, next, changedByOf(db, actor, ctx));
  if (releasing) {
    await announceRelease(db, ctx, input.projectSlug, input.taskKey, {
      entries: previous,
      clearedBy: actorProseName(db, actor),
    });
  } else if (previous.length > 0 && next.length === 0) {
    // Ruling 241, corrected by self-review: the drain belongs wherever the HOLD
    // GOES AWAY, not only where a release is ANNOUNCED. `releasing` excludes
    // `ctx.operatorAuthorized` on purpose — `announceRelease` re-invokes the
    // operator, and doing that from inside the operator's own turn would loop —
    // so an operator correcting a wait with `set_dependencies` (the door ruling
    // 240 names as the remedy for a wrong hold) took the last branch and left
    // the question stranded forever, under a wait panel still promising it
    // would be put when the wait cleared, on a task with nothing left to clear.
    // That is F37-68's own shape inside F37-68's own fix.
    await drainQueuedQuestions(db, ctx, input.projectSlug, input.taskKey);
  }
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: true, blockedBy: next, added, removed };
}

// ---------------------------------------------------------------- mirror

/** The chain position a task carries (`task.md` `goalRef`), when it is a
 *  link's task. */
export interface LinkWaitRef {
  goalId: string;
  linkIndex: number;
}

/**
 * Ruling 155 (pass 35, F35-3; amends 131(c)): once a goal link has started a
 * task, the task's `blockedBy` IS the wait, and the goal file's
 * `links[].blockedBy` mirrors it on every change, whoever made it (a person,
 * the controller, the operator, or the engine's release). Live, KNC-3 was
 * released by a controller `update_task {blockedBy: []}` and the Goals panel
 * kept printing "waits on goal-2 link 6" off the goal file while the task
 * ran; a retried link would have been born held on a wait a human had
 * already removed. Two records of one fact, one of them stale.
 *
 * Convergent and quiet: nothing is written unless the task is a link's task,
 * the link is `active` and carried BY this task, and the two lists differ.
 * Returns true when the goal file changed. A goal file that cannot be read or
 * parsed does not fail the task write that already landed; it is logged and
 * the next write mirrors again.
 */
export async function mirrorLinkWait(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  goalRef: LinkWaitRef | null,
  blockedBy: readonly string[],
  by: string,
): Promise<boolean> {
  if (!goalRef) return false;
  const ref = { projectSlug, goalId: goalRef.goalId, dataRoot: ctx.dataRoot };
  const wanted = JSON.stringify(blockedBy);
  const carries = (link: GoalLink | undefined): link is GoalLink =>
    link !== undefined && link.status === "active" && link.taskKey === taskKey;
  const current = readGoalFile(ref)?.parsed.frontmatter.links.find((l) => l.index === goalRef.linkIndex);
  if (!carries(current) || JSON.stringify(current.blockedBy) === wanted) return false;
  try {
    let mirrored = false;
    await updateGoalFile(ref, (goal) => {
      // Re-checked under the goal file's own lock: a retry or a completion may
      // have moved the link between the read above and this write.
      const link = goal.frontmatter.links.find((l) => l.index === goalRef.linkIndex);
      if (!carries(link) || JSON.stringify(link.blockedBy) === wanted) return;
      link.blockedBy = [...blockedBy];
      mirrored = true;
      const list = blockedBy.length > 0 ? blockedBy.join(", ") : "nothing";
      return `Link ${link.index} (${link.title}) now waits on ${list}: ${taskKey}'s list was changed by ${by}.`;
    });
    if (!mirrored) return false;
    rebuildGoalFile(db, projectSlug, goalRef.goalId, { dataRoot: ctx.dataRoot });
    return true;
  } catch (error) {
    logger.error("goal link wait could not mirror the task's list", {
      projectSlug,
      taskKey,
      goalId: goalRef.goalId,
      linkIndex: goalRef.linkIndex,
      err: toError(error),
    });
    return false;
  }
}

/** Who a task-list change is attributed to on the goal timeline. */
function changedByOf(db: DatabaseSync, actor: TaskActor, ctx: TaskActionContext): string {
  return ctx.operatorAuthorized ? "the operator" : actorProseName(db, actor);
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
  /**
   * F39-65: every entry was done before the task existed. Ruling 358 releases
   * a chain link the moment it is minted by the completion it waits on, and
   * the note then said "the base branch has changed since the hold" about a
   * hold that never was, and told a task with no delivered work to re-read the
   * base. Live on ax-clone AX-35, 0.7 s after "Created after the work it waits
   * on was done".
   */
  atBirth?: boolean;
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
    : input.atBirth
      ? `Released: everything this task waits on was done before it was created (${list}), so nothing held it.`
      : `Released: everything this task waited on is done (${list}). The task can move again; the base branch has changed since the hold, so the work re-reads it before continuing.`;
  const at = new Date().toISOString();
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: at,
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
    details: {
      entries: [...input.entries],
      clearedBy: input.clearedBy ?? null,
      atBirth: input.atBirth === true,
    },
  });
  // F39-65: a task born free cannot "move again", and its people were told a
  // moment ago that it started.
  if (!input.atBirth) notifyTaskWatchers(
    db,
    {
      projectSlug,
      taskKey,
      kind: "dependency",
      title: `${taskKey} can move again`,
      text,
      about: { event: at },
      // Ruling 361: the engine, by the name its timeline note carries.
      from: DEPENDENCY_RELEASE_FROM,
    },
    ctx,
  );
  // Ruling 241 (F37-68): drain the questions the hold refused, BEFORE the
  // operator is re-invoked. A person decided that the reviewer answers before
  // anyone reworks anything; re-invoking the operator first would let it
  // dispatch the rework that decision exists to stop, in the window between the
  // release and the question. Same ordering ruling 203 uses on a completion,
  // and for the same reason: the person's instruction goes first.
  await drainQueuedQuestions(db, ctx, projectSlug, taskKey);
  try {
    const { autoInvokeOperator } = await import("./task-actions.server");
    const dependencyRelease: DependencyReleasePayload = {
      entries: [...input.entries],
      clearedBy: input.clearedBy ?? null,
    };
    if (input.atBirth) dependencyRelease.atBirth = true;
    await autoInvokeOperator(db, ctx, projectSlug, taskKey, "dependencies-released", {
      dependencyRelease,
    });
  } catch (error) {
    logger.warn("dependency release could not re-invoke the operator", {
      taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 241: put the questions a dependency hold refused, now that it is gone.
 *
 * Each entry is REMOVED from the task before its run starts, whatever the run
 * then does. A question that stayed queued through a failed start would be put
 * again on the next release, and a reviewer asked the same question twice is
 * the loop ruling 237 exists to break. A start that fails says so on the
 * timeline instead, which is the same honesty the resolution's own arm keeps.
 */
export async function drainQueuedQuestions(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): Promise<number> {
  const queued = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter
    .queuedQuestions;
  if (!queued || queued.length === 0) return 0;
  const taken: QueuedQuestion[] = [];
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    // Re-read under the lock: a concurrent release or a person clearing the
    // task must not let one question be put twice.
    taken.push(...parsed.frontmatter.queuedQuestions);
    parsed.frontmatter.queuedQuestions = [];
  });
  if (taken.length === 0) return 0;
  // Dynamic, like every other reach into task-actions from this module: the two
  // import each other and a static edge here closes the cycle.
  const { OPERATOR_TASK_ACTOR } = await import("./task-actions.server");
  const { REVIEW_DEADLOCK_QUESTION } = await import("./review-deadlock.server");
  const startAgentRun =
    ctx.deps?.startAgentRun ?? (await import("./specialist-run.server")).startAgentRun;
  const opCtx: TaskActionContext = { ...ctx, operatorAuthorized: true };
  for (const question of taken) {
    try {
      const run: Parameters<typeof startAgentRun>[1] = {
        projectSlug,
        taskKey,
        profileId: question.profileId,
        directive: question.directive,
        directiveFrom: question.decidedByLabel,
      };
      // Ruling 316: this is ruling 241's DEFERRED half of the same dispatch
      // `task-actions` makes when the task is not held, and ruling 313 patched
      // only the immediate one — so a deadlock question put after a hold
      // cleared kept the verdict channel the immediate one had lost. A queued
      // question is the same question; it withholds the same way.
      if (question.directive === REVIEW_DEADLOCK_QUESTION) run.withholdVerdict = true;
      await startAgentRun(db, run, OPERATOR_TASK_ACTOR, opCtx);
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("queued reviewer question could not be put after the release", {
        taskKey,
        profileId: question.profileId,
        err: toError(error),
      });
      await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
        parsed.frontmatter.waiting = "human";
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: { kind: "system", systemId: "dependency-release" },
          title: "Queued question not put",
          text:
            `${taskKey} was released, but the question ${question.decidedByLabel} decided to put ` +
            `to the reviewer could not be started: ${message} Nothing was asked and nothing is ` +
            "running. The decision stands on the record above; ask the reviewer again when the " +
            "run can start.",
          toAgent: false,
          evidence: null,
        });
      });
    }
  }
  reprojectTask(db, ctx, projectSlug, taskKey);
  return taken.length;
}

// ---------------------------------------------------------------- engine

/** The goal timeline's name for the release engine (ruling 155). */
const RELEASE_BY = "Viberr (release)";

/** Ruling 361: the inbox names the engine exactly as the task timeline does
 *  (`systemId: "dependency-release"` → "Dependency release"). */
const DEPENDENCY_RELEASE_FROM: ActorRender = {
  kind: "system",
  name: systemIdToName("dependency-release"),
};

/**
 * Release ONE task when every entry it waits on is done (ruling 131(e)).
 * Idempotent and convergent: an empty list has nothing to release, an
 * unsatisfied list is left alone, and a satisfied one goes through the same
 * two halves a person's clear does. Returns true when a release happened.
 */
export async function releaseTask(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  /** F39-65: the caller has just minted this task; a release now means its
   *  waits were all done before it existed. */
  opts: { atBirth?: boolean } = {},
): Promise<boolean> {
  const ref = taskRef(ctx, projectSlug, taskKey);
  const existing = readTaskFile(ref);
  if (!existing) return false;
  const fm = existing.parsed.frontmatter;
  if (fm.archived || fm.blockedBy.length === 0) return false;
  // Pass 34 review: a task that already reached the terminal stage is not
  // waiting for anything — announcing "it can move again" there is false, and
  // the operator hand-off it triggers is an unwatched paid turn on a closed
  // task. Clear the list quietly instead, so the board stops rendering a wait
  // that ended with the task.
  const project = loadProjectContext(ctx, projectSlug);
  if (isTerminalStage(fm.stage, project.stages)) {
    await updateTaskFile(ref, (parsed) => {
      clearDependencies(parsed);
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    await mirrorLinkWait(db, ctx, projectSlug, taskKey, fm.goalRef, [], RELEASE_BY);
    return false;
  }
  const entries = resolveDependencies(db, projectSlug, fm.blockedBy);
  if (!dependenciesSatisfied(entries)) return false;
  // Pass 34 review: the satisfaction check above ran OUT of the lock. Re-read
  // the list inside it and leave the file alone when it moved — otherwise a
  // wait added between the two reads is dropped and announced as released.
  const judged = JSON.stringify(fm.blockedBy);
  let cleared: string[] = [];
  await updateTaskFile(ref, (parsed) => {
    if (JSON.stringify(parsed.frontmatter.blockedBy) !== judged) return;
    cleared = clearDependencies(parsed);
  });
  if (cleared.length === 0) return false; // a concurrent write got there first
  // Ruling 155: the engine's release is a change to the list like any other;
  // the goal file follows it, so a retried link is born free.
  await mirrorLinkWait(db, ctx, projectSlug, taskKey, fm.goalRef, [], RELEASE_BY);
  const release: AnnounceReleaseInput = { entries: cleared };
  if (opts.atBirth) release.atBirth = true;
  await announceRelease(db, ctx, projectSlug, taskKey, release);
  return true;
}

/**
 * Sweep a project's held tasks and release every one whose list is satisfied.
 * Called from the same task-write hooks that advance goal chains (a
 * transition, an archive or restore, an acceptance) and from the goal
 * runner's minute tick, so a hand edit or a rescan still releases within a
 * minute. Cheap: one projection read, then file work only for the few held.
 */
export async function releaseDependents(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
): Promise<string[]> {
  // Pass 34 review: the sweep also notices a wait that can NEVER complete,
  // whatever killed it. The archive hook was the only caller that ever looked,
  // so a cancelled goal, a removed link or a lost task left its dependent held
  // and silent. Idempotent by note text, like the archive path.
  await noteDeadDependency(db, ctx, projectSlug, null).catch((error) => {
    logger.error("dead-dependency sweep failed", {
      projectSlug,
      err: toError(error),
    });
  });
  const released: string[] = [];
  for (const held of listHeldTasks(db, projectSlug)) {
    try {
      if (await releaseTask(db, ctx, projectSlug, held.taskKey)) released.push(held.taskKey);
    } catch (error) {
      logger.error("dependency release failed", {
        projectSlug,
        taskKey: held.taskKey,
        err: toError(error),
      });
    }
  }
  return released;
}

/** Every live project, for the runner's tick. */
export async function releaseDueDependents(db: DatabaseSync, ctx: TaskActionContext = {}): Promise<number> {
  // SAFETY: `slug` TEXT PRIMARY KEY and `archived` INTEGER NOT NULL on `projects`.
  const rows = db.prepare(`SELECT slug FROM projects WHERE archived = 0`).all() as { slug: string }[];
  let count = 0;
  for (const row of rows) count += (await releaseDependents(db, ctx, row.slug)).length;
  return count;
}

/** Fire-and-forget hook beside `maybeReconcileGoalForTask`: a task changed in
 *  a way that can satisfy someone's wait (reached Done, was archived or
 *  restored, was accepted). The engine converges, so a spurious call is a
 *  cheap no-op. */
export function maybeReleaseDependents(db: DatabaseSync, ctx: TaskActionContext, projectSlug: string): void {
  void releaseDependents(db, ctx, projectSlug).catch((error) => {
    logger.error("dependency release sweep failed", {
      projectSlug,
      err: toError(error),
    });
  });
}

const DEAD_NOTE_TITLE = "Waiting on work that cannot complete";

/**
 * A dependency that can never complete (its task was archived) does not
 * release the dependent (ruling 131(e)): it is noted ONCE on the dependent's
 * timeline, the owner and supervisors are told once, and the task is left
 * `waiting: human`, because a person owes the list an edit. The derived
 * `blocked` readiness stays, and the entry renders as "archived" until they
 * make it. Idempotent: a dependent whose newest note already says so is
 * skipped.
 */
export async function noteDeadDependency(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  /** The archived task this call is about, or null for the convergent sweep:
   *  ANY entry that can never complete, whatever killed it (pass 34 review —
   *  a cancelled goal, a removed link or a lost task left the dependent held
   *  in silence, because only the archive hook ever looked). */
  archivedKey: string | null,
): Promise<string[]> {
  const noted: string[] = [];
  for (const held of listHeldTasks(db, projectSlug)) {
    const entries = resolveDependencies(db, projectSlug, held.blockedBy);
    // `archivedKey` decides whether THIS door acts, not what the note says.
    // Filtering the list itself made the two doors spell the same state
    // differently — the archive hook wrote "VIB-5 can never complete" and the
    // convergent sweep wrote "VIB-5, VIB-9 can never complete" — so the
    // idempotence check below (an exact text match, by design: see the comment
    // on `text`) never matched and the sweep re-stated facts the hook had
    // already recorded, as a fresh note AND a fresh notification.
    const dead = deadDependencies(entries);
    if (dead.length === 0) continue;
    if (archivedKey !== null && !dead.some((e) => e.taskKey === archivedKey)) {
      continue;
    }
    const ref = taskRef(ctx, projectSlug, held.taskKey);
    const existing = readTaskFile(ref);
    if (!existing || existing.parsed.frontmatter.archived) continue;
    const spelled = dead.map((e) => e.label).join(", ");
    // ONE spelling, whichever door noticed it: the archive hook and the
    // convergent sweep must produce the same sentence, or the idempotence
    // check below sees a different text and writes the same fact twice
    // (caught while wiring the sweep, pass 34 review). What KILLED the entry
    // is on the entry itself, rendered as its state.
    const text = `${spelled} can never complete. This task stays held; edit what it waits on (remove the entry or point it elsewhere) to release it.`;
    const newestNote = existing.parsed.timeline.find((e) => e.type === "note" && e.title === DEAD_NOTE_TITLE);
    if (newestNote?.text === text) continue;
    const at = new Date().toISOString();
    await updateTaskFile(ref, (parsed) => {
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: at,
        type: "note",
        actor: { kind: "system", systemId: "dependency-release" },
        title: DEAD_NOTE_TITLE,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, projectSlug, held.taskKey);
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey: held.taskKey,
        kind: "dependency",
        title: `${held.taskKey} waits on archived work`,
        text,
        about: { event: at },
        from: DEPENDENCY_RELEASE_FROM,
      },
      ctx,
    );
    noted.push(held.taskKey);
  }
  return noted;
}
