import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  allLinksSettled,
  currentLinkIndex,
  type GoalFrontmatter,
  type GoalLink,
  type ParsedGoalFile,
  goalLinkSchema,
} from "~/schemas/goal-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  resolveProjectAuthority,
  type AuthorityProject,
} from "~/server/auth/project-authority.server";
import { AppError } from "~/server/errors/app-error.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import {
  createGoalFile,
  nextGoalId,
  readGoalFile,
  updateGoalFile,
  withGoalsLock,
} from "~/server/files/goal-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildGoalFile } from "~/server/projections/rebuilder.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { rolesForAction } from "~/shared/rbac";
import {
  createTask,
  loadProjectContext,
  requireAction,
  requireProjectMutable,
  type ProjectContext,
} from "./task-actions.server";
import { validateDependencyRefs } from "./dependencies.server";
import { formatDependencyRef, parseDependencyRef } from "~/shared/dependencies";
import type { CreateTaskInput } from "./task-actions.server";
import type { TaskActor, TaskMutationContext } from "./task-mutation.server";

/**
 * Chained goals (ruling 99): the lifecycle engine.
 *
 * A goal is an ordered chain of tasks inside one project. The controller (or
 * any authorized member, through it) DEFINES the chain; the server ADVANCES
 * it: when a link's task closes to Done, the next link's task is created and
 * that task's own operator picks it up (`createTask`'s existing auto-invoke).
 * The controller sits above operators and never replaces them.
 *
 * AUTHORITY MODEL
 * - Creating a goal requires the asking user's own `create-task` in the
 *   project — a chain is a promise of future task creation, so the promise is
 *   gated where its effect is.
 * - Advancing happens with NOBODY present, so it runs under the goal
 *   CREATOR's recorded identity and RE-PROVES their live `create-task` at
 *   every advance (FR39's precedent: unattended action stays visible,
 *   cancellable, audited). Lost authority pauses the chain (`attention`)
 *   instead of escalating.
 * - Redirecting (pause/resume/skip/retry/edit/cancel) requires the creator
 *   themselves or a member holding `run-agents` (chain steering is agent
 *   steering).
 *
 * IDEMPOTENCY: every mutation is a locked read-modify-write of the goal file
 * with status re-checks inside the lock, and `reconcileGoal` is convergent —
 * hooks and the periodic runner both just say "look at this goal now".
 * There is NO delete anywhere: completed and cancelled chains stay readable.
 */

export const GOAL_MAX_LINKS = 20;

export interface GoalLinkInput {
  title: string;
  goal: string;
  /** Ruling 131(c): what this link's task will wait on (task keys, or other
   *  goals' links); spelling-checked and validated at write time, copied onto
   *  the task when the chain creates it. */
  blockedBy?: string[];
}

export interface CreateGoalInput {
  projectSlug: string;
  title: string;
  description?: string;
  onFailure?: "pause" | "continue";
  links: GoalLinkInput[];
}

export interface GoalActionResult {
  goalId: string;
  status: GoalFrontmatter["status"];
  /** The task key the chain currently rides on, when one exists. */
  activeTaskKey: string | null;
  message: string;
}

function goalRef(ctx: TaskMutationContext, projectSlug: string, goalId: string) {
  return { projectSlug, goalId, dataRoot: ctx.dataRoot };
}

function activeTaskKeyOf(links: readonly GoalLink[]): string | null {
  const index = currentLinkIndex(links);
  if (index === null) return null;
  return links.find((l) => l.index === index)?.taskKey ?? null;
}

/** The chain context block prepended to every link task's goal text, so the
 *  task stands alone AND names the chain it serves. */
function linkGoalText(
  goal: GoalFrontmatter,
  link: GoalLink,
  previous: GoalLink | null,
): string {
  const head =
    `Part of goal ${goal.id} (${goal.title}), link ${link.index} of ${goal.links.length}.` +
    (previous?.taskKey
      ? ` The previous link was carried by ${previous.taskKey} (${previous.status}).`
      : "");
  return `${head}\n\n${link.goal.trim() || link.title}`;
}

// ------------------------------------------------------------------ create

/**
 * Ruling 131(c): validate one link's declared wait. References to THIS
 * chain's own links are checked here (an existing link, never itself, never
 * a later link of the same chain, which the chain order already forbids);
 * everything else goes through the shared validator, whose cycle walk
 * traverses declared goal-link edges as well as created tasks.
 */
function validateLinkWait(
  db: DatabaseSync,
  projectSlug: string,
  goalId: string,
  linkIndex: number,
  links: readonly GoalLink[],
  entries: readonly string[],
): string[] {
  const own: string[] = [];
  const foreign: string[] = [];
  for (const raw of entries) {
    const ref = parseDependencyRef(raw);
    if (ref?.kind === "goal" && ref.goal === goalId) {
      if (ref.link === linkIndex) {
        throw AppError.validation(`${formatDependencyRef(ref)}: a link cannot wait on itself.`);
      }
      if (!links.some((l) => l.index === ref.link)) {
        throw AppError.validation(`${goalId} has no link ${ref.link} (it has ${links.length}).`);
      }
      if (ref.link > linkIndex) {
        throw AppError.validation(
          `${formatDependencyRef(ref)}: a link cannot wait on a LATER link of its own chain (the chain runs in order).`,
        );
      }
      own.push(formatDependencyRef(ref));
      continue;
    }
    foreign.push(raw);
  }
  const validated = validateDependencyRefs(db, {
    projectSlug,
    self: { kind: "goal", goal: goalId, link: linkIndex },
    entries: foreign,
  });
  const out: string[] = [];
  for (const entry of [...own, ...validated]) if (!out.includes(entry)) out.push(entry);
  return out;
}

export async function createGoal(
  db: DatabaseSync,
  input: CreateGoalInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<GoalActionResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // A chain is future task creation — gate it where its effect is.
  requireAction(db, project, actor, "create-task", "define a goal chain");

  const title = input.title.trim();
  if (title.length < 3) {
    throw AppError.validation("Give the goal a title of at least 3 characters.");
  }
  const links = input.links
    .map(
      (l, i): GoalLink => ({
        index: i + 1,
        title: l.title.trim(),
        goal: l.goal.trim(),
        taskKey: null,
        status: "pending",
        note: null,
        blockedBy: l.blockedBy ?? [],
      }),
    )
    .filter((l) => l.title.length > 0);
  if (links.length < 1) {
    throw AppError.validation("A goal chain needs at least one link.");
  }
  if (links.length > GOAL_MAX_LINKS) {
    throw AppError.validation(
      `A goal chain carries at most ${GOAL_MAX_LINKS} links.`,
    );
  }

  // The id is minted from a directory scan and only becomes real when the goal
  // file is written — and link 1's task is created in between. Hold the
  // project's goals lock across all three, or two concurrent creates mint the
  // SAME id, both create a task, and the loser's `createGoalFile` throws with
  // its task already created and dispatched to an operator.
  const { goalId, created } = await withGoalsLock(
    input.projectSlug,
    ctx.dataRoot,
    async () => {
      const id = nextGoalId(input.projectSlug, ctx.dataRoot);
      // Ruling 131(c): every declared wait is validated at DECLARATION time,
      // against the store and against this chain's own links, so a mutual
      // sibling-chain wait is refused here instead of producing two tasks born
      // held forever.
      for (const link of links) {
        link.blockedBy = validateLinkWait(db, input.projectSlug, id, link.index, links, link.blockedBy);
      }
      const now = new Date().toISOString();
      const fm: GoalFrontmatter = {
        id,
        title,
        status: "active",
        createdBy: actor.userId,
        createdByLabel: actor.label,
        onFailure: input.onFailure ?? "pause",
        links,
        createdAt: now,
        updatedAt: now,
      };

      // Link 1's task is created FIRST (under the asking user's own authority —
      // requireAction inside createTask), so a refusal there leaves no orphan
      // goal file behind.
      const first = links[0]!;
      const firstInput: CreateTaskInput = {
        projectSlug: input.projectSlug,
        title: first.title,
        goal: linkGoalText(fm, first, null),
        goalRef: { goalId: id, linkIndex: 1 },
      };
      // Ruling 131(c): link 1's declared wait rides onto its task at birth.
      if (first.blockedBy.length > 0) firstInput.blockedBy = first.blockedBy;
      const task = await createTask(db, firstInput, actor, ctx);
      first.taskKey = task.key;
      first.status = "active";

      await createGoalFile(goalRef(ctx, input.projectSlug, id), {
        frontmatter: fm,
        description: input.description?.trim() ?? "",
      });
      return { goalId: id, created: task };
    },
  );
  rebuildGoalFile(db, input.projectSlug, goalId, { dataRoot: ctx.dataRoot });

  recordAudit(db, {
    action: "goal.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "goal",
    subjectId: goalId,
    projectSlug: input.projectSlug,
    details: { title, links: links.length, firstTask: created.key },
  });
  return {
    goalId,
    status: "active",
    activeTaskKey: created.key,
    message: `Goal ${goalId} created with ${links.length} link${links.length === 1 ? "" : "s"}; link 1 is ${created.key}.`,
  };
}

// ------------------------------------------------------------------ update

export type UpdateGoalOp =
  | { op: "pause" }
  | { op: "resume" }
  | { op: "cancel"; reason?: string }
  | { op: "skip_link"; index: number; reason?: string }
  | { op: "retry_link"; index: number }
  /** `blockedBy` ABSENT leaves the link's list alone; `[]` clears it (the
   *  same absent-vs-empty contract `update_task` keeps, ruling 131(c)). */
  | { op: "edit_link"; index: number; title?: string; goal?: string; blockedBy?: string[] }
  | { op: "add_link"; title: string; goal: string; blockedBy?: string[] }
  | { op: "remove_pending_link"; index: number };

export interface UpdateGoalInput {
  projectSlug: string;
  goalId: string;
  action: UpdateGoalOp;
}

/** Creator-or-steering-tier gate for redirecting a chain. */
function requireGoalAuthority(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  createdBy: string,
  what: string,
): void {
  if (actor.userId === createdBy) {
    // The creator redirects their own chain; membership is still required —
    // and so is a live project. This arm bypasses `requireAction`, the
    // chokepoint that freezes an archived project (R6-3), so it has to say so
    // itself; the `run-agents` arm below gets it from `requireAction` for free.
    requireProjectMutable(project, what);
    const decision = resolveProjectAuthority(db, project, actor, "any-member", {
      action: "any-member",
      what,
    });
    if (decision.allowed) return;
    throw AppError.forbidden(`Only project members can ${what}.`);
  }
  requireAction(db, project, actor, "run-agents", what);
}

export async function updateGoal(
  db: DatabaseSync,
  input: UpdateGoalInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<GoalActionResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readGoalFile(goalRef(ctx, input.projectSlug, input.goalId));
  if (!existing) throw AppError.notFound(`Goal ${input.goalId} not found.`);
  requireGoalAuthority(
    db,
    project,
    actor,
    existing.parsed.frontmatter.createdBy,
    "redirect a goal chain",
  );

  const op = input.action;
  let message = "";
  let retryLinkIndex: number | null = null;
  let advanceAfter = false;

  const parsed = await updateGoalFile(
    goalRef(ctx, input.projectSlug, input.goalId),
    (goal) => {
      const fm = goal.frontmatter;
      const terminal = fm.status === "completed" || fm.status === "cancelled";
      const by = actor.label;
      switch (op.op) {
        case "pause": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          if (fm.status === "paused") {
            message = `Goal ${fm.id} is already paused.`;
            return;
          }
          fm.status = "paused";
          message = `Goal ${fm.id} paused.`;
          return `Paused by ${by}.`;
        }
        case "resume": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          if (fm.status === "active") {
            message = `Goal ${fm.id} is already active.`;
            return;
          }
          fm.status = "active";
          advanceAfter = true;
          message = `Goal ${fm.id} resumed.`;
          return `Resumed by ${by}.`;
        }
        case "cancel": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          fm.status = "cancelled";
          message = `Goal ${fm.id} cancelled. Its record stays readable.`;
          return `Cancelled by ${by}${op.reason ? `: ${op.reason}` : ""}.`;
        }
        case "skip_link": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          const link = fm.links.find((l) => l.index === op.index);
          if (!link) throw AppError.validation(`No link ${op.index}.`);
          if (link.status === "done" || link.status === "skipped") {
            throw AppError.conflict(`Link ${op.index} is already ${link.status}.`);
          }
          if (link.status === "active" && link.taskKey) {
            throw AppError.conflict(
              `Link ${op.index} is being worked by ${link.taskKey}. Archive or finish that task first, or retry the link after it fails.`,
            );
          }
          link.status = "skipped";
          link.note = op.reason?.trim() || link.note;
          if (fm.status === "attention") fm.status = "active";
          advanceAfter = true;
          message = `Link ${op.index} skipped.`;
          return `Link ${op.index} (${link.title}) skipped by ${by}${op.reason ? `: ${op.reason}` : ""}.`;
        }
        case "retry_link": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          const link = fm.links.find((l) => l.index === op.index);
          if (!link) throw AppError.validation(`No link ${op.index}.`);
          if (link.status !== "failed") {
            throw AppError.conflict(
              `Only a failed link can be retried; link ${op.index} is ${link.status}.`,
            );
          }
          retryLinkIndex = op.index;
          if (fm.status === "attention") fm.status = "active";
          message = `Link ${op.index} queued for retry.`;
          return `Link ${op.index} (${link.title}) retried by ${by}.`;
        }
        case "edit_link": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          const link = fm.links.find((l) => l.index === op.index);
          if (!link) throw AppError.validation(`No link ${op.index}.`);
          if (link.status !== "pending" && link.status !== "failed") {
            throw AppError.conflict(
              `Only a pending or failed link can be edited; link ${op.index} is ${link.status}.`,
            );
          }
          if (op.title?.trim()) link.title = op.title.trim();
          if (op.goal?.trim()) link.goal = op.goal.trim();
          // Ruling 131(c): absent leaves the list; `[]` clears it. Validated
          // at declaration time, this chain's other links included.
          if (op.blockedBy !== undefined) {
            link.blockedBy = validateLinkWait(db, input.projectSlug, fm.id, link.index, fm.links, op.blockedBy);
          }
          const waitClause =
            op.blockedBy !== undefined
              ? `; waits on ${link.blockedBy.length ? link.blockedBy.join(", ") : "nothing"}`
              : "";
          message = `Link ${op.index} updated${waitClause}.`;
          return `Link ${op.index} edited by ${by}${waitClause}.`;
        }
        case "add_link": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          if (fm.links.length >= GOAL_MAX_LINKS) {
            throw AppError.validation(
              `A goal chain carries at most ${GOAL_MAX_LINKS} links.`,
            );
          }
          const title = op.title.trim();
          if (!title) throw AppError.validation("Give the link a title.");
          const nextIndex = fm.links.length + 1;
          fm.links.push({
            index: nextIndex,
            title,
            goal: op.goal.trim(),
            taskKey: null,
            status: "pending",
            note: null,
            blockedBy: validateLinkWait(db, input.projectSlug, fm.id, nextIndex, fm.links, op.blockedBy ?? []),
          });
          advanceAfter = true;
          message = `Link ${fm.links.length} added.`;
          return `Link ${fm.links.length} (${title}) added by ${by}.`;
        }
        case "remove_pending_link": {
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          const link = fm.links.find((l) => l.index === op.index);
          if (!link) throw AppError.validation(`No link ${op.index}.`);
          if (link.status !== "pending" || link.taskKey) {
            throw AppError.conflict(
              "Only a pending link with no task can be removed from the chain.",
            );
          }
          fm.links = fm.links
            .filter((l) => l.index !== op.index)
            .map((l, i) => ({ ...l, index: i + 1 }));
          message = `Link removed; the chain now has ${fm.links.length} link${fm.links.length === 1 ? "" : "s"}.`;
          return `Pending link ${op.index} (${link.title}) removed by ${by}.`;
        }
      }
    },
  );
  rebuildGoalFile(db, input.projectSlug, input.goalId, { dataRoot: ctx.dataRoot });
  recordAudit(db, {
    action: "goal.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "goal",
    subjectId: input.goalId,
    projectSlug: input.projectSlug,
    details: { op: op.op, message },
  });

  // A retry creates the fresh link task under the PRESENT caller's authority.
  // The un-park (attention→active) + "retried" history already committed above,
  // so if the task cannot be created (e.g. the caller lost create-task
  // authority) re-park to attention HERE with an honest note — otherwise the
  // chain sits active with a still-failed link until the next 60s reconcile
  // flaps it back, re-notifying and recording a retry that never started. Same
  // shape as reconcileGoal's advance path.
  if (retryLinkIndex !== null) {
    try {
      await startLinkTask(
        db,
        input.projectSlug,
        input.goalId,
        retryLinkIndex,
        actor,
        ctx,
        "retry",
      );
    } catch (error) {
      logger.error("goal link retry task creation failed", {
        goalId: input.goalId,
        linkIndex: retryLinkIndex,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      await updateGoalFile(
        goalRef(ctx, input.projectSlug, input.goalId),
        (goal) => {
          if (goal.frontmatter.status !== "active") return;
          goal.frontmatter.status = "attention";
          return `Retry could not start link ${retryLinkIndex}'s task (${error instanceof Error ? error.message : "unknown error"}); parked for redirect.`;
        },
      );
      const after = readGoalFile(goalRef(ctx, input.projectSlug, input.goalId));
      if (after) {
        notifyCreator(
          db,
          after.parsed.frontmatter,
          input.projectSlug,
          "A link retry could not start its task. Resume or redirect the goal to try again.",
        );
      }
      rebuildGoalFile(db, input.projectSlug, input.goalId, {
        dataRoot: ctx.dataRoot,
      });
    }
  } else if (advanceAfter) {
    await reconcileGoal(db, input.projectSlug, input.goalId, ctx);
  }
  const after = readGoalFile(goalRef(ctx, input.projectSlug, input.goalId));
  const fm = after?.parsed.frontmatter ?? parsed.frontmatter;
  return {
    goalId: input.goalId,
    status: fm.status,
    activeTaskKey: activeTaskKeyOf(fm.links),
    message,
  };
}

// ----------------------------------------------------------------- advance

/** Notify the goal's creator (kind `controller`) — chain progress reaches the
 *  human who defined it even when nobody is watching the board. */
function notifyCreator(
  db: DatabaseSync,
  fm: GoalFrontmatter,
  projectSlug: string,
  text: string,
  taskKey?: string | null,
): void {
  try {
    createNotification(db, {
      userId: fm.createdBy,
      kind: "controller",
      title: `${fm.id} · ${fm.title}`,
      text,
      projectSlug,
      taskKey: taskKey ?? null,
      from: { kind: "agent", name: "Controller" },
    });
  } catch (error) {
    logger.warn("goal creator notification failed", {
      goalId: fm.id,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Re-prove the goal creator's live `create-task` (silent — an unattended
 *  advance probing a lost authority is a pause, not an attempt to exceed). */
function creatorMayCreateTasks(
  db: DatabaseSync,
  project: AuthorityProject,
  fm: GoalFrontmatter,
): boolean {
  return resolveProjectAuthority(
    db,
    project,
    { userId: fm.createdBy, label: fm.createdByLabel || fm.createdBy },
    rolesForAction("create-task"),
    { action: "create-task", what: "advance a goal chain", silentDeny: true },
  ).allowed;
}

/**
 * Create the task for one link (advance target or retry) and mark it active.
 * The actor is whoever's authority the creation runs under.
 *
 * ONE start per link at a time. `createTask` is a long await and the link's
 * `taskKey` — the only durable record that a start happened — cannot be
 * written until it returns, so two reconciles racing (a task hook and the
 * runner tick, say) would both read the link as unstarted and grow TWO tasks
 * for one link, the second overwriting the first's key and orphaning it. The
 * claim is an in-process lock rather than a field in the goal file on purpose:
 * a field would survive a crash mid-create and strand the link forever,
 * whereas a lost lock leaves the link exactly as it was for the next
 * reconcile to start cleanly.
 *
 * `mode` is what the caller believes about the link, re-checked INSIDE the
 * lock: `advance` starts a pending link that has no task, `retry` re-starts a
 * link a human parked as failed. A caller whose belief no longer holds lost
 * the race and returns null.
 */
async function startLinkTask(
  db: DatabaseSync,
  projectSlug: string,
  goalId: string,
  linkIndex: number,
  actor: TaskActor,
  ctx: TaskMutationContext,
  mode: "advance" | "retry",
): Promise<string | null> {
  return withFileLock(`goal-start:${projectSlug}:${goalId}:${linkIndex}`, () =>
    startLinkTaskLocked(db, projectSlug, goalId, linkIndex, actor, ctx, mode),
  );
}

async function startLinkTaskLocked(
  db: DatabaseSync,
  projectSlug: string,
  goalId: string,
  linkIndex: number,
  actor: TaskActor,
  ctx: TaskMutationContext,
  mode: "advance" | "retry",
): Promise<string | null> {
  const ref = goalRef(ctx, projectSlug, goalId);
  const current = readGoalFile(ref);
  if (!current) return null;
  const fm = current.parsed.frontmatter;
  const link = fm.links.find((l) => l.index === linkIndex);
  if (!link) return null;
  // The chain must still be ACTIVE to start a link. The goal-start lock is a
  // DIFFERENT navigator.locks key from the goal-file lock that a concurrent
  // cancel/pause commits under, so check the freshest status here — and again
  // under the file lock at attach time below, to close the createTask window.
  // reconcileGoal early-returns on a cancelled/completed chain forever, so a
  // link started on one strands its task in perpetual limbo.
  if (fm.status !== "active") return null;
  if (mode === "advance" && (link.taskKey !== null || link.status !== "pending")) {
    return null;
  }
  if (mode === "retry" && link.status !== "failed") return null;
  const previous =
    fm.links.filter((l) => l.index < linkIndex).sort((a, b) => b.index - a.index)[0] ??
    null;
  const linkInput: CreateTaskInput = {
    projectSlug,
    title: link.title,
    goal: linkGoalText(fm, link, previous),
    goalRef: { goalId, linkIndex },
  };
  // Ruling 131(c): the link's declared wait is copied onto the task and
  // validated there; a reference that can no longer be satisfied (its task
  // archived since the declaration) refuses the create, and the caller parks
  // the chain in `attention` with the validator's sentence.
  if (link.blockedBy.length > 0) linkInput.blockedBy = link.blockedBy;
  const created = await createTask(db, linkInput, actor, ctx);
  let attached = false;
  await updateGoalFile(ref, (goal) => {
    // Re-check under the goal-FILE lock: a cancel/pause may have committed during
    // the createTask await above. A non-active chain must not gain an active
    // link — it would strand this task on a goal reconcileGoal never revisits.
    if (goal.frontmatter.status !== "active") return;
    const target = goal.frontmatter.links.find((l) => l.index === linkIndex);
    if (!target) return;
    attached = true;
    target.taskKey = created.key;
    target.status = "active";
    target.note = null;
    return `Link ${linkIndex} (${target.title}) started as ${created.key}${target.blockedBy.length > 0 ? `, waiting on ${target.blockedBy.join(", ")}` : ""}.`;
  });
  if (!attached) {
    // The chain went non-active mid-create. The task exists and carries a
    // goalRef (so it still surfaces as this goal's), but no link claims it and
    // the card shows no active link on a dead/parked chain — the honest state.
    logger.warn("goal link start abandoned: chain no longer active", {
      goalId,
      linkIndex,
      taskKey: created.key,
    });
    return null;
  }
  rebuildGoalFile(db, projectSlug, goalId, { dataRoot: ctx.dataRoot });
  notifyCreator(
    db,
    fm,
    projectSlug,
    `Link ${linkIndex} started as ${created.key}.`,
    created.key,
  );
  return created.key;
}

/**
 * THE convergent advance engine. Reads the goal, derives every linked task's
 * real state, records completions/failures, and creates the next link's task
 * when the chain is active and its current link is settled. Hooks and the
 * periodic runner both just call this; every write happens under the goal
 * file's own lock with status re-checks, so concurrent calls converge.
 */
export async function reconcileGoal(
  db: DatabaseSync,
  projectSlug: string,
  goalId: string,
  ctx: TaskMutationContext = {},
): Promise<void> {
  const ref = goalRef(ctx, projectSlug, goalId);
  const snapshot = readGoalFile(ref);
  if (!snapshot) return;
  if (
    snapshot.parsed.frontmatter.status === "completed" ||
    snapshot.parsed.frontmatter.status === "cancelled"
  ) {
    return;
  }

  const project = loadProjectContext(ctx, projectSlug);
  const taskState = (taskKey: string): "done" | "failed" | "open" | "gone" => {
    // The canonical FILE is the truth an advance acts on (a projection can lag).
    const task = readTaskFile({ projectSlug, taskKey, dataRoot: ctx.dataRoot });
    if (!task) return "gone";
    const fm = task.parsed.frontmatter;
    if (fm.archived) return "failed";
    if (isTerminalStage(fm.stage, project.stages)) return "done";
    return "open";
  };

  let completedNow = false;
  let attentionNow: string | null = null;
  let failedLink: { index: number; title: string; taskKey: string } | null = null;
  let startIndex: number | null = null;

  await updateGoalFile(ref, (goal) => {
    const fm = goal.frontmatter;
    if (fm.status === "completed" || fm.status === "cancelled") return;
    const history: string[] = [];
    /** A link this pass moved OUT of `failed` — the one park it may lift. */
    let recoveredLink = false;

    for (const link of fm.links) {
      if (!link.taskKey) continue;
      // `skipped` is a HUMAN's decision about the link itself and never
      // re-derives. `done` is a claim about the task, so it is re-derived
      // below — but only a re-opening undoes it.
      if (link.status === "skipped") continue;
      const state = taskState(link.taskKey);
      if (link.status === "done") {
        if (state === "open") {
          // The completed task was pulled back out of the terminal stage: the
          // link is genuinely no longer done. Archiving or losing a completed
          // task, by contrast, is bookkeeping and leaves the link settled.
          link.status = "active";
          link.note = null;
          history.push(
            `Link ${link.index} (${link.title}) reopened: ${link.taskKey} left the final stage.`,
          );
        }
        continue;
      }
      if (state === "done") {
        link.status = "done";
        history.push(`Link ${link.index} (${link.title}) completed by ${link.taskKey}.`);
      } else if ((state === "failed" || state === "gone") && link.status !== "failed") {
        link.status = "failed";
        link.note =
          state === "gone"
            ? `Task ${link.taskKey} is missing from the store.`
            : `Task ${link.taskKey} was archived.`;
        failedLink = { index: link.index, title: link.title, taskKey: link.taskKey };
        history.push(`Link ${link.index} (${link.title}) failed: ${link.note}`);
      } else if (state === "open" && link.status === "failed") {
        // The failure was undone — the task is back on the board. Deriving the
        // failure but never the recovery would leave the chain parked on live
        // work, and its only exit (retry) would spawn a second task for it.
        link.status = "active";
        link.note = null;
        recoveredLink = true;
        history.push(
          `Link ${link.index} (${link.title}) recovered: ${link.taskKey} is on the board again.`,
        );
      }
    }

    // A failure parks the chain unless the goal rides through failures.
    const anyFailedOpen = fm.links.some((l) => l.status === "failed");
    if (anyFailedOpen && fm.onFailure === "pause" && fm.status === "active") {
      fm.status = "attention";
      attentionNow =
        failedLink !== null
          ? `Link ${failedLink.index} failed. The chain is paused for your decision: retry it, skip it, or cancel the goal.`
          : "A link failed. The chain is paused for your decision.";
      history.push("Chain paused (attention): a link failed.");
    }
    // …and un-parks when THIS pass saw the failure undone. `attention` is the
    // machine's own park (`paused` is a human's and is never lifted here), but
    // it is set for more than a failed link: losing the creator's authority
    // parks a chain too. Lifting on the mere ABSENCE of a failed link would
    // flip those chains attention -> active -> attention on every runner tick,
    // re-notifying the creator each time — so lift only the park whose cause
    // this pass watched disappear.
    if (recoveredLink && !anyFailedOpen && fm.status === "attention") {
      fm.status = "active";
      history.push("Chain resumed: the failed link is live again.");
    }

    if (allLinksSettled(fm.links) && fm.status !== "attention") {
      fm.status = "completed";
      completedNow = true;
      history.push("Every link is settled. Goal completed.");
    } else if (fm.status === "active") {
      const index = currentLinkIndex(fm.links);
      const link = index === null ? null : fm.links.find((l) => l.index === index);
      // `failed` with onFailure=continue: move past it.
      if (link && link.status === "failed" && fm.onFailure === "continue") {
        link.status = "skipped";
        link.note = `${link.note ?? "Failed."} Chain continues past it (onFailure: continue).`;
        history.push(`Link ${link.index} failed and was skipped (onFailure: continue).`);
        const nextIndex = currentLinkIndex(fm.links);
        if (nextIndex === null) {
          if (fm.links.length > 0) {
            fm.status = "completed";
            completedNow = true;
            history.push("Every link is settled. Goal completed.");
          }
        } else {
          const next = fm.links.find((l) => l.index === nextIndex);
          if (next && !next.taskKey) startIndex = nextIndex;
        }
      } else if (link && !link.taskKey && link.status === "pending") {
        // The chain is ON this link and no task carries it (fresh advance, or
        // a crash between goal write and task creation) — start it.
        startIndex = link.index;
      }
    }

    return history.length ? history.join(" ") : undefined;
  });

  if (attentionNow) {
    const fm = readGoalFile(ref)?.parsed.frontmatter;
    if (fm) notifyCreator(db, fm, projectSlug, attentionNow);
  }
  if (completedNow) {
    const fm = readGoalFile(ref)?.parsed.frontmatter;
    if (fm) notifyCreator(db, fm, projectSlug, "Goal completed: every link is settled.");
    recordAudit(db, {
      action: "goal.completed",
      actor: { userId: null, label: "goal-runner" },
      subjectKind: "goal",
      subjectId: goalId,
      projectSlug,
    });
  }

  if (startIndex !== null) {
    const fm = readGoalFile(ref)?.parsed.frontmatter;
    if (!fm) return;
    // Unattended creation: re-prove the CREATOR's live authority first.
    if (!creatorMayCreateTasks(db, project, fm)) {
      await updateGoalFile(ref, (goal) => {
        if (goal.frontmatter.status !== "active") return;
        goal.frontmatter.status = "attention";
        return `Chain paused (attention): ${fm.createdByLabel || fm.createdBy} no longer holds task creation in this project, so the next link could not start.`;
      });
      notifyCreator(
        db,
        fm,
        projectSlug,
        "The chain could not advance: you no longer hold task creation in this project. Ask a project admin to restore it, then resume the goal.",
      );
      rebuildGoalFile(db, projectSlug, goalId, { dataRoot: ctx.dataRoot });
      return;
    }
    try {
      await startLinkTask(
        db,
        projectSlug,
        goalId,
        startIndex,
        {
          userId: fm.createdBy,
          label: `${fm.createdByLabel || fm.createdBy} · goal chain`,
        },
        ctx,
        "advance",
      );
    } catch (error) {
      logger.error("goal link task creation failed", {
        goalId,
        linkIndex: startIndex,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      await updateGoalFile(ref, (goal) => {
        if (goal.frontmatter.status !== "active") return;
        goal.frontmatter.status = "attention";
        return `Chain paused (attention): creating the next link's task failed (${error instanceof Error ? error.message : "unknown error"}).`;
      });
      const after = readGoalFile(ref)?.parsed.frontmatter;
      if (after) {
        notifyCreator(
          db,
          after,
          projectSlug,
          "The chain could not advance: creating the next link's task failed. Resume the goal to retry.",
        );
      }
    }
  }
  rebuildGoalFile(db, projectSlug, goalId, { dataRoot: ctx.dataRoot });
}

/**
 * Hook: a task changed in a way that can move its chain (reached Done, was
 * archived, restored). Fire-and-forget from the task write paths — the engine
 * converges, so a spurious call is a cheap no-op.
 */
export function maybeReconcileGoalForTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  try {
    const task = readTaskFile({ projectSlug, taskKey, dataRoot: ctx.dataRoot });
    const goalId = task?.parsed.frontmatter.goalRef?.goalId;
    if (!goalId) return;
    void reconcileGoal(db, projectSlug, goalId, ctx).catch((error) => {
      logger.error("goal reconcile failed", {
        projectSlug,
        goalId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  } catch (error) {
    logger.warn("goal reconcile hook failed", {
      projectSlug,
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

const activeGoalRowSchema = z.object({
  project_slug: z.string(),
  goal_id: z.string(),
});

/**
 * Periodic + boot catch-up: reconcile every non-terminal goal, so a link that
 * completed while the process was down (or through a hand edit the hooks never
 * saw) still advances its chain. Cheap: a projection query, then per-goal
 * file reads only for the few live chains.
 */
export async function reconcileAllGoals(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<number> {
  const rows = z.array(activeGoalRowSchema).parse(
    db
      .prepare(
        `SELECT project_slug, goal_id FROM goal_projections
         WHERE status IN ('active', 'attention')`,
      )
      .all(),
  );
  for (const row of rows) {
    try {
      await reconcileGoal(db, row.project_slug, row.goal_id, ctx);
    } catch (error) {
      logger.error("goal reconcile failed", {
        projectSlug: row.project_slug,
        goalId: row.goal_id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return rows.length;
}

// ------------------------------------------------------------------ runner

const GOAL_TICK_MS = 60_000;
const GOAL_RUNNER_KEY = Symbol.for("viberr.goalRunner");

interface GoalRunnerHost {
  [GOAL_RUNNER_KEY]?: { timer: ReturnType<typeof setInterval> };
}

/**
 * One tick of the runner: every live chain reconciled, then (ruling 131(e))
 * every held task whose wait is satisfied released, so a hand edit or a
 * rescan the write hooks never saw still releases within a minute. Exported
 * so the tick's contract is tested without driving the interval singleton.
 */
export async function goalRunnerTick(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ goals: number; released: number }> {
  const goals = await reconcileAllGoals(db, ctx);
  const { releaseDueDependents } = await import("./dependencies.server");
  const released = await releaseDueDependents(db, ctx);
  return { goals, released };
}

/** Boot: catch up once, then reconcile on a non-overlapping interval.
 *  Idempotent; the timer is unref'd so it never blocks exit. */
export function startGoalRunner(db: DatabaseSync): void {
  // SAFETY: registry symbol under a viberr-namespaced name; only this function
  // writes the slot.
  const host = globalThis as GoalRunnerHost;
  if (host[GOAL_RUNNER_KEY]) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void goalRunnerTick(db)
      .catch((error) => {
        logger.error("goal runner tick failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, GOAL_TICK_MS);
  timer.unref();
  host[GOAL_RUNNER_KEY] = { timer };
  tick();
}

// -------------------------------------------------------------------- views

export interface GoalView {
  id: string;
  title: string;
  status: GoalFrontmatter["status"];
  createdBy: string;
  createdByLabel: string;
  onFailure: "pause" | "continue";
  description: string;
  links: GoalLink[];
  currentIndex: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  history: { occurredAt: string; text: string }[];
}

/** Read one goal straight from its canonical file (detail view). */
export function getGoalView(
  projectSlug: string,
  goalId: string,
  ctx: TaskMutationContext = {},
): GoalView | null {
  const read = readGoalFile(goalRef(ctx, projectSlug, goalId));
  if (!read) return null;
  return toGoalView(read.parsed);
}

export function toGoalView(parsed: ParsedGoalFile): GoalView {
  const fm = parsed.frontmatter;
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    createdBy: fm.createdBy,
    createdByLabel: fm.createdByLabel,
    onFailure: fm.onFailure,
    description: parsed.description,
    links: fm.links,
    currentIndex: currentLinkIndex(fm.links),
    createdAt: fm.createdAt,
    updatedAt: fm.updatedAt,
    history: parsed.timeline,
  };
}

const goalProjectionRowSchema = z.object({
  goal_id: z.string(),
  title: z.string(),
  status: z.enum(["active", "paused", "attention", "completed", "cancelled"]),
  created_by: z.string(),
  created_by_label: z.string(),
  on_failure: z.enum(["pause", "continue"]),
  links_json: z.string(),
  description: z.string(),
  current_index: z.number().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

/** List a project's goals from the projection (board panel read model). */
export function listGoals(db: DatabaseSync, projectSlug: string): GoalView[] {
  const rows = db
    .prepare(
      `SELECT goal_id, title, status, created_by, created_by_label, on_failure,
              links_json, description, current_index, created_at, updated_at
       FROM goal_projections WHERE project_slug = ?
       ORDER BY created_at DESC`,
    )
    .all(projectSlug);
  return rows.flatMap((raw) => {
    const parsed = goalProjectionRowSchema.safeParse(raw);
    if (!parsed.success) return [];
    const r = parsed.data;
    let links: GoalLink[] = [];
    try {
      const decoded: unknown = JSON.parse(r.links_json);
      if (Array.isArray(decoded)) {
        // Pass 34 review: PARSED, not asserted. A row written before ruling 131
        // has no per-link `blockedBy` key, and the Controller page reads
        // `l.blockedBy.length` off exactly these rows — the assertion promised a
        // field an existing store does not carry. The schema's own default
        // fills it, so an old row reads `blockedBy: []` instead of crashing the
        // render, whatever the derivation-version rebuild has or has not done.
        links = z.array(goalLinkSchema).catch([]).parse(decoded);
      }
    } catch {
      links = [];
    }
    return [
      {
        id: r.goal_id,
        title: r.title,
        status: r.status,
        createdBy: r.created_by,
        createdByLabel: r.created_by_label,
        onFailure: r.on_failure,
        description: r.description,
        links,
        currentIndex: r.current_index,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        history: [],
      },
    ];
  });
}
