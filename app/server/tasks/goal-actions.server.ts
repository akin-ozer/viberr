import type { DatabaseSync } from "node:sqlite";
import type { CardStatusKind } from "~/features/board/card-status";
import { actorProseName } from "./user-display-name.server";
import {
  deadDependencies,
  dependenciesSatisfied,
  parseBlockedByColumn,
  resolveDependencies,
} from "~/server/projections/dependencies.server";
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
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildGoalFile } from "~/server/projections/rebuilder.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { rolesForAction } from "~/shared/rbac";
import {
  createTask,
  loadProjectContext,
  reprojectTask,
  requireAction,
  requireProjectMutable,
  type ProjectContext,
} from "./task-actions.server";
import { releaseTask, setTaskDependencies, validateDependencyRefs } from "./dependencies.server";
import { formatDependencyRef, parseDependencyRef, type DependencyRender } from "~/shared/dependencies";
import type { CreateTaskInput } from "./task-actions.server";
import type { TaskActor, TaskMutationContext } from "./task-mutation.server";
import { countLabel } from "~/shared/text/plural";
import { toError } from "~/shared/errors";

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

const GOAL_MAX_LINKS = 20;

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
  /** Ruling 476(h): the controller conversation the chain is planned in,
   *  recorded on the goal so the project's Controller page links back to it. */
  conversationId?: string | null;
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
  /** Ruling 192: the body to carry forward instead of the link's frozen copy —
   *  a retry's own task text, which is the contract everyone has been working
   *  to. Absent (a first start) leaves the declared text. */
  body?: string,
): string {
  // Ruling 404 (F39-31): this header is FROZEN into the task's goal body at
  // creation and never rewritten, so it may only state facts that cannot move.
  // The chain's LENGTH moves -- the controller added links 6-8 to goal-4 on
  // 2026-09-22 and three already-created tasks went on claiming "of 5", with
  // AX-21 telling its own agent it was the last link of the chain while three
  // more followed. A previous link's STATUS moves the same way. Both are gone:
  // the goal id, the title, this link's own index and which task carried the
  // previous link are settled the moment the task exists. The live chain is
  // `goalChain` on the operator's snapshot (ruling 402), which is read fresh.
  const head =
    `Part of goal ${goal.id} (${goal.title}), link ${link.index}.` +
    (previous?.taskKey ? ` The previous link was carried by ${previous.taskKey}.` : "");
  return `${head}\n\n${(body ?? "").trim() || link.goal.trim() || link.title}`;
}

/** The chain header `linkGoalText` prepends, so a task's goal can be carried
 *  into a NEW task without stacking a second one (the count, and which task
 *  carried the previous link, have both moved on). */
const CHAIN_HEADER_RE = /^Part of goal [^\n]*\n\n/;

function stripChainHeader(goal: string): string {
  return goal.replace(CHAIN_HEADER_RE, "").trim();
}

// ------------------------------------------------------------------ create

/**
 * Ruling 398: can this link start, must it wait, or is its wait dead?
 *
 * A wait on a link of this SAME goal is answered from the frontmatter being
 * written, never from the projection. The projection is rebuilt after this
 * pass, so a sibling this very pass marked `done` or `skipped` still reads
 * `failed` there — which silently stranded the link behind it.
 */
function linkWaitState(
  db: DatabaseSync,
  projectSlug: string,
  fm: GoalFrontmatter,
  link: GoalLink,
): "ready" | "open" | "dead" {
  if (link.blockedBy.length === 0) return "ready";
  const foreign: string[] = [];
  let open = false;
  let dead = false;
  for (const raw of link.blockedBy) {
    const ref = parseDependencyRef(raw);
    if (ref?.kind === "goal" && ref.goal === fm.id) {
      const sibling = fm.links.find((l) => l.index === ref.link);
      if (!sibling) dead = true;
      // `skipped` settles a wait exactly as `done` does: onFailure=continue
      // means the chain moves past that link, and a dependent that stayed held
      // on it would never move at all.
      else if (sibling.status === "failed") dead = true;
      else if (sibling.status !== "done" && sibling.status !== "skipped") open = true;
      continue;
    }
    foreign.push(raw);
  }
  if (foreign.length > 0) {
    const resolved = resolveDependencies(db, projectSlug, foreign);
    if (deadDependencies(resolved).length > 0) dead = true;
    else if (!dependenciesSatisfied(resolved)) open = true;
  }
  return dead ? "dead" : open ? "open" : "ready";
}

/** Ruling 398: `link 3` — a wait on a sibling link of the goal being written,
 *  the only spelling available before the goal has an id. */
const RELATIVE_LINK_RE = /^link\s+(\d+)$/i;

/**
 * Ruling 131(c): validate one link's declared wait. References to THIS
 * chain's own links are checked here (an existing link, never itself; a
 * later link is fine since ruling 398(c), and a cycle among them is
 * `refuseLinkCycles`' question); everything else goes through the shared
 * validator, whose cycle walk traverses declared goal-link edges as well as
 * created tasks.
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
    // Ruling 398: `link 2` means link 2 of THIS goal.
    //
    // The id is minted while the goal is being written, so at creation time an
    // author has no way to name their own chain — and now that a link starts
    // as soon as its declared wait allows, naming a sibling is how a SEQUENCE
    // is written down at all. Without this spelling a sequential goal would
    // take a create plus one `update_goal` per link, after reading back an id
    // the author never chose.
    //
    // Expanded here and stored in the canonical absolute spelling, so the file
    // keeps exactly the two spellings `app/shared/dependencies.ts` documents.
    const relative = RELATIVE_LINK_RE.exec(raw.trim());
    const ref = parseDependencyRef(
      relative ? `${goalId} link ${Number(relative[1])}` : raw,
    );
    if (ref?.kind === "goal" && ref.goal === goalId) {
      if (ref.link === linkIndex) {
        throw AppError.validation(`${formatDependencyRef(ref)}: a link cannot wait on itself.`);
      }
      if (!links.some((l) => l.index === ref.link)) {
        throw AppError.validation(`${goalId} has no link ${ref.link} (it has ${links.length}).`);
      }
      // Ruling 398(c): a forward wait is ordinary now.
      //
      // The refusal that stood here — "a link cannot wait on a LATER link of
      // its own chain (the chain runs in order)" — was right while position
      // WAS the order: a later link's task did not exist yet, so waiting on it
      // deadlocked. Ruling 398 took that meaning away and this guard outlived
      // it, which the ax-clone controller hit the same afternoon: it wanted the
      // failure-semantics audit held behind the link that ADDS the routes it
      // audits, four positions later in the same goal, and had no way to say
      // so. What actually has to be refused is a CYCLE, and `refuseLinkCycles`
      // below refuses it over the whole graph rather than by position.
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

/**
 * Ruling 398(c): refuse a cycle among a goal's own links.
 *
 * Position stopped being the order, so "later" is no longer a safe proxy for
 * "would deadlock". This is the real question, asked over the whole graph: a
 * link that waits, directly or through its siblings, on itself can never start,
 * and neither can anything behind it. Cross-goal and cross-task cycles are
 * `validateDependencyRefs`' job (`cyclePath`); this covers the one graph that
 * is being written and does not exist in the store yet.
 */
function refuseLinkCycles(goalId: string, links: readonly GoalLink[]): void {
  const edges = new Map<number, number[]>();
  for (const link of links) {
    const out: number[] = [];
    for (const raw of link.blockedBy) {
      const ref = parseDependencyRef(raw);
      if (ref?.kind === "goal" && ref.goal === goalId) out.push(ref.link);
    }
    edges.set(link.index, out);
  }
  const state = new Map<number, "open" | "closed">();
  const stack: number[] = [];
  const walk = (index: number): void => {
    const seen = state.get(index);
    if (seen === "closed") return;
    if (seen === "open") {
      const at = stack.indexOf(index);
      const loop = [...stack.slice(at), index]
        .map((i) => `link ${i}`)
        .join(" waits on ");
      throw AppError.validation(
        `${loop}: these links wait on each other, so none of them could ever start.`,
      );
    }
    state.set(index, "open");
    stack.push(index);
    for (const next of edges.get(index) ?? []) walk(next);
    stack.pop();
    state.set(index, "closed");
  };
  for (const link of links) walk(link.index);
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
  // Filter BEFORE numbering. Numbering first and dropping blank-titled rows
  // afterwards left a HOLE in the sequence — [A, "", C] became indexes 1 and 3
  // with a length of 2 — and `add_link` mints `fm.links.length + 1`, so the
  // next link came back as another index 3 and the chain carried two links
  // that every by-index lookup (waits, status, the task binding) could not
  // tell apart.
  const links = input.links
    .filter((l) => l.title.trim().length > 0)
    .map(
      (l, i): GoalLink => ({
        index: i + 1,
        title: l.title.trim(),
        goal: l.goal.trim(),
        taskKey: null,
        status: "pending",
        note: null,
            redeclared: false,
        blockedBy: l.blockedBy ?? [],
      }),
    );
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
  const { goalId } = await withGoalsLock(
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
      refuseLinkCycles(id, links);
      const now = new Date().toISOString();
      const fm: GoalFrontmatter = {
        id,
        title,
        status: "active",
        createdBy: actor.userId,
        createdByLabel: actor.label,
        conversationId: input.conversationId ?? null,
        onFailure: input.onFailure ?? "pause",
        links,
        createdAt: now,
        updatedAt: now,
      };

      // Ruling 398(c): the FILE is written first, and the tasks follow.
      //
      // Link 1's task used to be created before the file, so that a refusal
      // left no orphan goal behind. That ordering became impossible the moment
      // a link could wait on a sibling: `createTask` validates the inherited
      // wait against the store, and `goal-50 link 2` is not in the store until
      // the goal file exists. The orphan it guarded against is covered anyway —
      // `requireAction(create-task)` runs at the top of this function, and a
      // start that fails now parks the goal by name instead of throwing, which
      // is a record rather than a silent gap.
      await createGoalFile(goalRef(ctx, input.projectSlug, id), {
        frontmatter: fm,
        description: input.description?.trim() ?? "",
      });
      return { goalId: id };
    },
  );
  rebuildGoalFile(db, input.projectSlug, goalId, { dataRoot: ctx.dataRoot });
  // Ruling 398: every link that nothing makes wait starts here, link 1
  // included, through the one selector (`startLinkTask`, under the creator's
  // re-proved authority), rather than sitting until the goal runner's next
  // tick: a person who declares three independent links means three tasks
  // now. A start that fails parks the goal in `attention` by name; the file
  // is already written, so nothing here is rolled back.
  await reconcileGoal(db, input.projectSlug, goalId, ctx);
  const startedList =
    readGoalFile(goalRef(ctx, input.projectSlug, goalId))?.parsed.frontmatter.links.filter(
      (l) => l.taskKey,
    ) ?? [];
  const startedLinks = startedList.length;
  const created = startedList[0]?.taskKey ?? null;

  recordAudit(db, {
    action: "goal.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "goal",
    subjectId: goalId,
    projectSlug: input.projectSlug,
    details: { title, links: links.length, firstTask: created ?? "" },
  });
  return {
    goalId,
    status: "active",
    activeTaskKey: created,
    message:
      `Goal ${goalId} created with ${countLabel(links.length, "link")}; ` +
      (startedLinks === 0
        ? "no link started yet — every one of them waits on something."
        : `${startedLinks} started now (${startedList.map((l) => `link ${l.index} is ${l.taskKey}`).join(", ")}).`),
  };
}

// ------------------------------------------------------------------ update

export type UpdateGoalOp =
  /** Ruling 192: rename the CHAIN (and re-describe it). A chain outlives the
   *  sentence it was created with — pass 37's `goal-2` still read "Identity and
   *  Catalog services" hours after catalog moved to its own chain — and until
   *  now the only way to correct that was to cancel the chain and rebuild every
   *  link. Neither field steers any work: the title appears in each link task's
   *  chain header at CREATE time and is never re-read. */
  | { op: "rename"; title?: string; description?: string }
  | { op: "pause" }
  | { op: "resume" }
  | { op: "cancel"; reason?: string }
  | { op: "skip_link"; index: number; reason?: string }
  | { op: "retry_link"; index: number }
  /** `blockedBy` ABSENT leaves the link's list alone; `[]` clears it (the
   *  same absent-vs-empty contract `update_task` keeps, ruling 131(c)). On an
   *  ACTIVE link it is the only editable field and is written on the link's
   *  task, which mirrors it back onto the link (ruling 155). */
  | { op: "edit_link"; index: number; title?: string; goal?: string; blockedBy?: string[] }
  | { op: "add_link"; title: string; goal: string; blockedBy?: string[] }
  | { op: "remove_pending_link"; index: number }
  /** Ruling 243 (F37-72): bind an EXISTING task to a pending link. */
  | { op: "adopt_task"; index: number; taskKey: string };

export interface UpdateGoalInput {
  projectSlug: string;
  goalId: string;
  action: UpdateGoalOp;
}

/** Ruling 155: an active link's `blockedBy` edit, carried out of the goal-file
 *  lock to the task's writer. */
interface ForwardedLinkWait {
  linkIndex: number;
  taskKey: string;
  blockedBy: string[];
}
interface LinkWaitForward {
  wait: ForwardedLinkWait | null;
  /** Ruling 243: the task an `adopt_task` bound, written back after the goal
   *  file commits so the two records point at each other or neither does. */
  adopted: { taskKey: string; goalId: string; linkIndex: number } | null;
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

/**
 * Pass 34 review (ruling 131 + the chain editor): who currently WAITS on a
 * link of this goal at or after `fromIndex` — the references a removal would
 * silently re-point, because a goal-link dependency is stored by index.
 * Both sides are checked: this goal's own later links (`goalLinkSchema
 * .blockedBy`) and every task in the project whose `blockedBy` names one.
 */
function referencesToLinksFrom(
  db: DatabaseSync,
  projectSlug: string,
  fm: GoalFrontmatter,
  fromIndex: number,
): string[] {
  const holders: string[] = [];
  const affected = (entries: readonly string[]) =>
    entries.some((raw) => {
      const ref = parseDependencyRef(raw);
      return ref?.kind === "goal" && ref.goal === fm.id && ref.link >= fromIndex;
    });
  for (const l of fm.links) {
    if (l.index !== fromIndex && affected(l.blockedBy)) holders.push(`link ${l.index}`);
  }
  // Ruling 131(c) makes a wait on ANOTHER goal's link first-class, and that
  // declaration lives in the sibling GOAL file. Once a sibling link's task
  // exists the task query below catches it — but links are created LAZILY, so
  // a still-pending sibling link has no task yet and was invisible here: the
  // removal renumbered underneath it and silently re-pointed the wait at a
  // different link. Same projection the task half already trusts.
  for (const other of listGoals(db, projectSlug)) {
    if (other.id === fm.id) continue;
    for (const l of other.links) {
      if (affected(l.blockedBy ?? [])) holders.push(`${other.id} link ${l.index}`);
    }
  }
  // SAFETY: both columns are NOT NULL on `task_projections` (`blocked_by_json`
  // carries a '[]' default), so every row answers these two strings.
  const rows = db
    .prepare(
      `SELECT task_key, blocked_by_json FROM task_projections
        WHERE project_slug = ? AND blocked_by_json LIKE ?`,
    )
    .all(projectSlug, `%${fm.id}%`) as { task_key: string; blocked_by_json: string }[];
  for (const row of rows) {
    if (affected(parseBlockedByColumn(row.blocked_by_json))) holders.push(row.task_key);
  }
  return holders;
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
  /** Ruling 411: the pending link an `edit_link` unblocked, if any. */
  let startedIndex: number | null = null;
  // Ruling 155: an active link's wait lives on its task. The goal-file lock
  // below is not re-entrant, and the task writer mirrors the list back onto
  // this very file, so the forward runs AFTER the lock is released.
  const forward: LinkWaitForward = { wait: null, adopted: null };

  const parsed = await updateGoalFile(
    goalRef(ctx, input.projectSlug, input.goalId),
    (goal) => {
      const fm = goal.frontmatter;
      const terminal = fm.status === "completed" || fm.status === "cancelled";
      // U39-18: the chain's history is read by people, so it names them.
      const by = actorProseName(db, actor);
      switch (op.op) {
        case "rename": {
          // Ruling 267 (pass 37, F37-97): the ONE op a settled chain still
          // takes. Every other op here changes what the chain will DO, and a
          // completed or cancelled chain will do nothing — so the terminal
          // guard is right for all of them. `rename` changes only what the
          // chain is CALLED, and a chain is named before the work is
          // understood: live, `goal-2` stayed "Identity and Catalog services"
          // after catalog moved to goal-6, and `goal-4` stayed "Storefront and
          // Admin surfaces" after admin moved to goal-7. Both completed, so
          // both are permanently wrong on a record people read to learn what
          // was built, with no door anywhere to fix them. Refusing an edit that
          // changes no state and loses no history buys nothing and costs the
          // truth of the record; the rename lands in the chain's history like
          // any other, so nothing is rewritten silently.
          const title = op.title?.trim();
          const description = op.description?.trim();
          if (title === undefined && description === undefined) {
            throw AppError.validation("rename needs a title or a description.");
          }
          if (title !== undefined && title.length === 0) {
            throw AppError.validation("A goal title cannot be empty.");
          }
          const parts: string[] = [];
          // Tracked here, not re-derived after the write: comparing `fm.title`
          // to `title` afterwards is true both when the name moved AND when the
          // caller resent the name it already had, so a description-only edit
          // claimed link tasks were keeping "the old name".
          let titleMoved = false;
          if (title !== undefined && title !== fm.title) {
            parts.push(`renamed from "${fm.title}" to "${title}"`);
            fm.title = title;
            titleMoved = true;
          }
          if (description !== undefined && description !== goal.description) {
            parts.push("description rewritten");
            goal.description = description;
          }
          if (parts.length === 0) {
            message = `Goal ${fm.id} is unchanged.`;
            return;
          }
          message = `Goal ${fm.id} ${parts.join(" and ")}.`;
          // Every link task already carries the OLD title in its chain header,
          // written at create time. Say so rather than implying a rename
          // reaches back into work that has already started — and say it only
          // when the NAME moved, because a description edit reaches nothing.
          return (
            `Goal ${parts.join(" and ")} by ${by}.` +
            (titleMoved
              ? terminal
                ? " Every link task keeps the old name in its chain header; this chain is settled, so nothing new will carry the new one."
                : " Link tasks created before now keep the old name in their chain header."
              : "")
          );
        }
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
          if (link.status === "active" && link.taskKey) {
            // Ruling 155 (F35-3): the task carries the wait; its title and
            // goal are settled the moment work started. `blockedBy` alone is
            // forwarded to the task's one writer, which mirrors it back here.
            if (op.title?.trim() || op.goal?.trim() || op.blockedBy === undefined) {
              throw AppError.conflict(
                `Only a pending or failed link's title or goal can be edited; link ${op.index} is active. ` +
                  `Its wait follows ${link.taskKey}: pass blockedBy here or edit it on the task.`,
              );
            }
            // The task writer re-validates the list, but `validateDependencyRefs`
            // does not carry the CHAIN-ORDER rule: a pending later link of this
            // same chain declares no edges, so no cycle closes and the wait is
            // accepted, leaving link 1 held by link 2 and link 2 held by the
            // chain order. Run the goal's own rules here first, so the active
            // arm refuses exactly what every other arm refuses.
            forward.wait = {
              linkIndex: op.index,
              taskKey: link.taskKey,
              blockedBy: validateLinkWait(
                db,
                input.projectSlug,
                fm.id,
                link.index,
                fm.links,
                op.blockedBy,
              ),
            };
            // Ruling 398(c): the whole graph, after the edit lands on it. This
            // arm writes the new wait to the TASK, so `fm.links` still holds
            // the old one: check the graph the edit makes, not the one it
            // replaces.
            const wait = forward.wait.blockedBy;
            refuseLinkCycles(
              fm.id,
              fm.links.map((l) => (l.index === link.index ? { ...l, blockedBy: wait } : l)),
            );
            return;
          }
          if (link.status !== "pending" && link.status !== "failed") {
            throw AppError.conflict(
              `Only a pending or failed link can be edited; link ${op.index} is ${link.status}.`,
            );
          }
          // Ruling 192(b): an edit to a FAILED link is a deliberate
          // re-declaration of the work, and it must outrank the text the retry
          // would otherwise carry from the task that failed. Only the failed
          // arm sets it — a pending link has no task to carry from.
          if (link.status === "failed" && (op.title?.trim() || op.goal?.trim())) {
            link.redeclared = true;
          }
          if (op.title?.trim()) link.title = op.title.trim();
          if (op.goal?.trim()) link.goal = op.goal.trim();
          // Ruling 131(c): absent leaves the list; `[]` clears it. Validated
          // at declaration time, this chain's other links included.
          if (op.blockedBy !== undefined) {
            link.blockedBy = validateLinkWait(db, input.projectSlug, fm.id, link.index, fm.links, op.blockedBy);
            refuseLinkCycles(fm.id, fm.links);
            // Ruling 411 (F39-38): editing a pending link's wait is the most
            // direct way there is to make that link STARTABLE, and it was the
            // one op that did not advance the chain afterwards -- `resume`,
            // `skip_link` and `add_link` all do. So the link sat until the
            // periodic tick, `update_goal` returned with `activeTaskKey` still
            // naming the link before it, and a caller that read the goal back
            // saw a startable link with no task. Live on ax-clone the
            // controller cleared goal-4 link 2's wait, read the goal TWICE,
            // saw link 2 taskless both times, created AX-25 to carry it -- and
            // the tick had already minted AX-24 four seconds earlier. Two
            // tasks for one link, one of them an orphan with an agent
            // dispatched on it. `reconcileGoal` is convergent, so asking it
            // here costs nothing when the wait still stands.
            advanceAfter = true;
            // Ruling 411: remember WHICH link this edit could have started, so
            // the reply can name its task instead of the chain's current one.
            if (link.blockedBy.length === 0) startedIndex = link.index;
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
          // Highest index + 1, not length + 1: a chain that ever acquired a
          // hole (see createGoal above) would otherwise re-mint an index that
          // is already in use.
          const nextIndex =
            fm.links.reduce((max, l) => Math.max(max, l.index), 0) + 1;
          fm.links.push({
            index: nextIndex,
            title,
            goal: op.goal.trim(),
            taskKey: null,
            status: "pending",
            note: null,
            redeclared: false,
            blockedBy: validateLinkWait(db, input.projectSlug, fm.id, nextIndex, fm.links, op.blockedBy ?? []),
          });
          refuseLinkCycles(fm.id, fm.links);
          advanceAfter = true;
          message = `Link ${fm.links.length} added.`;
          return `Link ${fm.links.length} (${title}) added by ${by}.`;
        }
        case "adopt_task": {
          // Ruling 243 (F37-72): a chain normally MAKES its link's task when it
          // advances, and nothing could point a link at a task that already
          // exists. So a person who asked the controller to build out the work
          // for pending links got real tasks the chain did not know about, and
          // the chain would later create its own duplicates. The only escape was
          // `remove_pending_link`, which destroys the link's authored text —
          // live on this pass those texts carried the orders service's port, its
          // whole migration schema and a crash-resumption assertion, and they
          // had to be hand-copied into the new tasks before the links could go.
          if (terminal) throw AppError.conflict(`Goal ${fm.id} is ${fm.status}.`);
          const link = fm.links.find((l) => l.index === op.index);
          if (!link) throw AppError.validation(`No link ${op.index}.`);
          if (link.status !== "pending" || link.taskKey) {
            throw AppError.conflict(
              `Link ${op.index} already has a task (${link.taskKey ?? link.status}). ` +
                "Only a pending link with no task can adopt one.",
            );
          }
          const adoptee = readTaskFile({
            projectSlug: input.projectSlug,
            taskKey: op.taskKey,
            dataRoot: ctx.dataRoot,
          });
          if (!adoptee) {
            throw AppError.validation(`${op.taskKey} is not a task in this project.`);
          }
          if (adoptee.parsed.frontmatter.archived) {
            throw AppError.conflict(
              `${op.taskKey} is archived; restore it before a chain can carry it.`,
            );
          }
          // A task carries at most ONE link. Two chains pointing at one task
          // would each advance on its completion and each claim it as theirs,
          // and the task's own `goalRef` can only name one of them.
          const held = adoptee.parsed.frontmatter.goalRef;
          if (held) {
            throw AppError.conflict(
              `${op.taskKey} is already carried by ${held.goalId} link ${held.linkIndex}. ` +
                "A task belongs to one chain.",
            );
          }
          link.taskKey = op.taskKey;
          link.status = "active";
          link.note = null;
          link.redeclared = false;
          // Ruling 155 runs the other way here than on an advance: the task
          // already exists and OWNS its wait, so the link mirrors what the task
          // says rather than overwriting it with the link's declared list.
          link.blockedBy = [...adoptee.parsed.frontmatter.blockedBy];
          forward.adopted = {
            taskKey: op.taskKey,
            goalId: fm.id,
            linkIndex: op.index,
          };
          message = `Link ${op.index} is now carried by ${op.taskKey}.`;
          return `Link ${op.index} (${link.title}) adopted existing task ${op.taskKey}, by ${by}.`;
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
          // Pass 34 review: a goal-link dependency is stored BY INDEX
          // (`goal-1 link 3`), and this removal renumbers every later link. A
          // reference that pointed at one of them would silently denote a
          // DIFFERENT piece of work, or nothing at all — a task held forever,
          // or released when the wrong link completes. Refuse instead, naming
          // what refers to it; the references are re-spelled by hand and the
          // removal retried.
          const holders = referencesToLinksFrom(db, input.projectSlug, fm, op.index);
          if (holders.length > 0) {
            throw AppError.conflict(
              `Link ${op.index} cannot be removed: removing it renumbers the links after it, and ` +
                `${holders.join(", ")} ${holders.length === 1 ? "waits" : "wait"} on a link at or after ${op.index}. ` +
                `Re-point or clear those waits first, then remove the link.`,
            );
          }
          fm.links = fm.links
            .filter((l) => l.index !== op.index)
            .map((l, i) => ({ ...l, index: i + 1 }));
          message = `Link removed; the chain now has ${countLabel(fm.links.length, "link")}.`;
          return `Pending link ${op.index} (${link.title}) removed by ${by}.`;
        }
      }
    },
  );
  if (forward.wait) {
    // The task writer's own gate and validation apply (ruling 131(b)); an
    // unchanged list still re-mirrors, so a stale link record heals here too.
    const wait = await setTaskDependencies(
      db,
      { projectSlug: input.projectSlug, taskKey: forward.wait.taskKey, blockedBy: forward.wait.blockedBy },
      actor,
      ctx,
    );
    const list = wait.blockedBy.length > 0 ? wait.blockedBy.join(", ") : "nothing";
    message = `Link ${forward.wait.linkIndex} waits on ${list}, through ${forward.wait.taskKey}${wait.changed ? "" : " (unchanged)"}.`;
  }
  if (forward.adopted) {
    // The task's own back-reference, written AFTER the link commits: the link
    // is the record a person reads on the chain, and a task claiming a link
    // that does not claim it back is the worse of the two half-states.
    const adopted = forward.adopted;
    await updateTaskFile(
      { projectSlug: input.projectSlug, taskKey: adopted.taskKey, dataRoot: ctx.dataRoot },
      (parsed) => {
        parsed.frontmatter.goalRef = { goalId: adopted.goalId, linkIndex: adopted.linkIndex };
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: { kind: "system", systemId: "policy-engine" },
          title: "Adopted into a goal chain",
          text:
            `This task now carries **${adopted.goalId} link ${adopted.linkIndex}**. The chain ` +
            "advances when it completes, and no separate task is created for that link.",
          toAgent: false,
          evidence: null,
        });
      },
    );
    reprojectTask(db, ctx, input.projectSlug, adopted.taskKey);
  }
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
    // Ruling 194, corrected: a FAILED link keeps its task key — `reconcileGoal`
    // sets `status = "failed"` and names that task in the note — so the first
    // draft's `link.taskKey !== null` guard returned before doing anything, on
    // every path, and the test that "proved" it built a null-taskKey failed
    // link the product cannot produce. The real question is whether the retry
    // REPLACED the task, so the answer is the key it had before.
    const priorTaskKey =
      readGoalFile(goalRef(ctx, input.projectSlug, input.goalId))
        ?.parsed.frontmatter.links.find((l) => l.index === retryLinkIndex)?.taskKey ?? null;
    try {
      const started = await startLinkTask(
        db,
        input.projectSlug,
        input.goalId,
        retryLinkIndex,
        actor,
        ctx,
        "retry",
      );
      if (started === null) {
        // Ruling 194 (F37-16): `startLinkTask` declines silently when the
        // chain is no longer active — and a reconcile fired by the very
        // archive that failed this link lands exactly there, because it is
        // fire-and-forget. The timeline already carries "Link N retried by X";
        // without this the record claims a retry that started nothing, no task
        // exists, and nobody is told. The THROW arm below has said so since it
        // was written; the decline had no arm at all.
        await updateGoalFile(goalRef(ctx, input.projectSlug, input.goalId), (goal) => {
          const link = goal.frontmatter.links.find((l) => l.index === retryLinkIndex);
          // Unchanged key ⇒ nothing replaced it ⇒ the retry really started
          // nothing. A key that moved means a task exists and this arm is not
          // its business.
          if (!link || link.taskKey !== priorTaskKey) return;
          if (goal.frontmatter.status === "active") goal.frontmatter.status = "attention";
          link.note = "The retry did not start: the chain was redirected while it ran.";
          return (
            `Retry of link ${retryLinkIndex} did NOT start a task — the chain stopped being ` +
            `active while the retry ran. The link is still failed; retry it again.`
          );
        });
        const declined = readGoalFile(goalRef(ctx, input.projectSlug, input.goalId));
        if (declined) {
          notifyCreator(
            db,
            declined.parsed.frontmatter,
            input.projectSlug,
            "A link retry did not start its task. Retry the link again.",
          );
        }
        rebuildGoalFile(db, input.projectSlug, input.goalId, { dataRoot: ctx.dataRoot });
      }
    } catch (error) {
      logger.error("goal link retry task creation failed", {
        goalId: input.goalId,
        linkIndex: retryLinkIndex,
        err: toError(error),
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
  // Ruling 411: say which task the edit STARTED. `activeTaskKey` names the
  // link the chain currently rides on, which since ruling 398's fan-out is
  // usually a DIFFERENT link -- so a caller that unblocked link 2 and read
  // this reply was told about link 1 and learned nothing about its own edit.
  // Live, that caller created a second task for a link Viberr had just filled.
  const startedKey =
    startedIndex !== null
      ? (fm.links.find((l) => l.index === startedIndex)?.taskKey ?? null)
      : null;
  return {
    goalId: input.goalId,
    status: fm.status,
    activeTaskKey: activeTaskKeyOf(fm.links),
    message: startedKey ? `${message} Link ${startedIndex} started as ${startedKey}.` : message,
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
      err: toError(error),
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
  // Ruling 192: a RETRY re-materialises the work from the task that just
  // failed, not from the link's frozen copy. An active link's title and goal
  // are settled in the goal file (ruling 155) while the TASK's are not — a
  // decision packet, an operator edit or a person can rewrite them — so on a
  // board where those diverge the old behaviour handed the retry a contract
  // everyone had moved past, silently, with nothing in the timeline saying a
  // correction had been dropped. Live pass 37 the two copies of SHOP-2's
  // contract disagreed about which task owns `packages/contracts`.
  //
  // Ruling 192(b): unless the link was RE-DECLARED. `edit_link` explicitly
  // accepts a failed link — "edit a pending or failed link" is in the tool's
  // own description — and ruling 192's first draft carried the task's text over
  // that edit without a word, so "edit the failed link, then retry it" silently
  // did nothing. An explicit re-declaration is the later, deliberate
  // instruction and outranks the text the failed task happened to end with.
  const priorTask =
    mode === "retry" && link.taskKey && !link.redeclared
      ? readTaskFile({ projectSlug, taskKey: link.taskKey, dataRoot: ctx.dataRoot })
      : null;
  const carried = priorTask ? stripChainHeader(priorTask.parsed.goal) : "";
  const linkInput: CreateTaskInput = {
    projectSlug,
    title: priorTask ? priorTask.parsed.frontmatter.title : link.title,
    goal: linkGoalText(fm, link, previous, carried),
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
    // Ruling 192(b): the re-declaration has been consumed by this start.
    target.redeclared = false;
    // Ruling 192: say so when the retry carried the failed task's own text
    // rather than the link's — a silent substitution either way is the defect.
    const carriedNote =
      priorTask && carried && carried !== link.goal.trim()
        ? `, carrying ${priorTask.parsed.frontmatter.key}'s own text rather than the link's original`
        : link.redeclared
          ? ", from the link's re-declared text rather than the failed task's"
          : "";
    return `Link ${linkIndex} (${target.title}) started as ${created.key}${target.blockedBy.length > 0 ? `, waiting on ${target.blockedBy.join(", ")}` : ""}${carriedNote}.`;
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
  // Ruling 358 (pass 38, F38-12): a link minted by the completion of the very
  // link it waits on is born held on finished work. The completion's own
  // release sweep listed the held tasks before this one existed, so the task
  // sat until the minute tick: 11 of the 15 born-held links on this instance
  // waited 16–77 s, the `create` drive refused meanwhile ("waits on other
  // work (goal-2 link 2)" — the task whose acceptance had just minted it).
  // Ask the engine once, now that the link carries its task; it is convergent,
  // so an unsatisfied or lagging read leaves the tick to do what it always did.
  if (linkInput.blockedBy) {
    await releaseTask(db, ctx, projectSlug, created.key, { atBirth: true }).catch((error) => {
      logger.warn("release check after the link's mint failed — the tick will retry", {
        goalId,
        linkIndex,
        taskKey: created.key,
        err: toError(error),
      });
    });
  }
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
  /**
   * Ruling 398: the links to start on this pass. A LIST, not a single index.
   *
   * A chain used to create link N+1's task only when link N settled, so a goal
   * could put exactly one task on the board however its links were declared:
   * concurrency equalled the number of active GOALS, and `blockedBy` on a
   * pending link changed nothing, because the task it would hold did not exist
   * to be held. Its own docstring ("born held") describes the behaviour this
   * restores.
   */
  const startIndexes: number[] = [];

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
      // `failed` with onFailure=continue: skip past every failed link, so a
      // pass that fans out is not stopped by one of them.
      if (fm.onFailure === "continue") {
        for (const link of fm.links) {
          if (link.status !== "failed") continue;
          link.status = "skipped";
          link.note = `${link.note ?? "Failed."} Chain continues past it (onFailure: continue).`;
          history.push(`Link ${link.index} failed and was skipped (onFailure: continue).`);
        }
        if (allLinksSettled(fm.links) && fm.links.length > 0) {
          fm.status = "completed";
          completedNow = true;
          history.push("Every link is settled. Goal completed.");
        }
      }
      if (fm.status === "active") {
        // Ruling 398: every pending link with no task yet whose DECLARED wait
        // is already satisfied. A genuine chain still runs in order, because
        // each of its links waits on the last; independent links start
        // together. The shape of the work decides the concurrency, rather than
        // the shape of the scheduler.
        //
        // Satisfaction is evaluated HERE rather than by creating every task at
        // once and letting `blockedBy` hold them. Creating them early would
        // cost two things that have nothing to do with concurrency: a later
        // link would stop being editable (`update_goal` edits a PENDING link,
        // and every link would be active from the first pass), and a wait that
        // is only valid once the work it names exists would park the chain the
        // moment the goal was written.
        for (const link of fm.links) {
          if (link.status !== "pending" || link.taskKey) continue;
          const wait = linkWaitState(db, projectSlug, fm, link);
          if (wait === "dead") {
            // Ruling 131(e)'s rule, kept: a wait that can NEVER complete parks
            // the chain for a person instead of leaving the link pending
            // forever with nothing anywhere saying why. Under the old
            // one-at-a-time advance this happened by accident — the start was
            // attempted and `validateDependencyRefs` threw — and fanning out
            // would have made it silent, because a link whose wait is dead is
            // simply never selected.
            if (fm.status === "active") {
              fm.status = "attention";
              attentionNow =
                `Link ${link.index} (${link.title}) waits on work that can never complete. ` +
                "The chain is paused for your decision: edit the wait, skip the link, or cancel the goal.";
              history.push(
                `Chain paused (attention): link ${link.index}'s wait can never complete.`,
              );
            }
            continue;
          }
          if (wait === "open") continue;
          startIndexes.push(link.index);
        }
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

  if (startIndexes.length > 0) {
    // Ruling 398: the projection before the starts, not only after them.
    // `createTask` validates the new task's inherited wait THROUGH the
    // projection, so a sibling this very pass marked `skipped` still read as
    // archived there and the start was refused in the name of a link the chain
    // had just decided to move past.
    rebuildGoalFile(db, projectSlug, goalId, { dataRoot: ctx.dataRoot });
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
    // Ruling 398: one link's failure must not swallow its siblings. Each start
    // is its own attempt; the FIRST that fails parks the goal and the rest are
    // left for the next pass, which is the same convergent behaviour a single
    // start had — a parked goal starts nothing until a human resumes it.
    for (const linkIndex of startIndexes) {
      try {
        await startLinkTask(
          db,
          projectSlug,
          goalId,
          linkIndex,
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
          linkIndex,
          err: toError(error),
        });
        await updateGoalFile(ref, (goal) => {
          if (goal.frontmatter.status !== "active") return;
          goal.frontmatter.status = "attention";
          return `Chain paused (attention): creating link ${linkIndex}'s task failed (${error instanceof Error ? error.message : "unknown error"}).`;
        });
        const after = readGoalFile(ref)?.parsed.frontmatter;
        if (after) {
          notifyCreator(
            db,
            after,
            projectSlug,
            `The chain could not advance: creating link ${linkIndex}'s task failed. Resume the goal to retry.`,
          );
        }
        break;
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
        err: toError(error),
      });
    });
  } catch (error) {
    logger.warn("goal reconcile hook failed", {
      projectSlug,
      taskKey,
      err: toError(error),
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
async function reconcileAllGoals(
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
        err: toError(error),
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
          err: toError(error),
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

/**
 * Ruling 192: a link as READ, which is not always a link as stored. Ruling 155
 * settles an active link's `title` and `goal` in the goal file while the task's
 * are still editable, so the stored copy can be a contract the work has moved
 * past — live, `goal-2` link 1 said SHOP-2 owns `packages/contracts` while
 * SHOP-2's own goal said it must not touch it. The stored text stays (it is
 * what the chain declared, and the history means it); `liveGoal` is the task's
 * current goal, present only when it has actually moved. Only the goal: a
 * task's TITLE is immutable — nothing in the product writes one after create,
 * `update_task` says so in as many words — so a `title` half here would be a
 * field that can never be set.
 */
export type GoalLinkView = GoalLink & {
  /** Ruling 359: the declared wait with each entry's live state, so the
   *  Controller page reads a done entry as done (ruling 356's sentence).
   *  Filled by `listGoals`, which has the projection; absent on the
   *  file-only detail read. */
  waits?: DependencyRender[];
  /**
   * Ruling 335: what the CHAIN DECLARED, present only when the task has moved
   * past it. `goal` above always carries the truth.
   *
   * Ruling 192 had these the other way round — `goal` kept the frozen
   * declaration and `liveGoal` appeared beside it when they differed — and the
   * controller measured what that costs: on one goal, FOUR of seven links'
   * `goal` fields were superseded, and it said so in its own words: *"the safe
   * field carries the qualifier and the unsafe one has the plain name —
   * `link.goal` is the trap, `link.liveGoal` is the truth, and that is
   * backwards. I only ever noticed because `liveGoal` happened to sit adjacent
   * in the payload; nothing in the reply says the two differ."*
   *
   * Live and load-bearing at the time it was found: goal-5's link 7 is SHOP-82,
   * the release candidate, actively building. Its declared goal instructs a
   * builder to generate a CHANGELOG "from conventional commits" — which that
   * task's own design pass proved impossible, 0 of 583 commits being
   * conventional-shaped — and to own `scripts/seed/demo.ts`, proven unreachable.
   * The task's real goal, corrected by the owner, says the opposite.
   *
   * Ruling 192's substance stands and is why the declaration is still here: the
   * stored text is what the chain declared and the history means it. What
   * changes is which name a reader reaches for first. A retry was never at risk
   * — ruling 192's own `body` argument already rebuilds from the task's current
   * text — so this is entirely about the read.
   */
  declaredGoal?: string;
  /**
   * Ruling 476(g) (F40-56): the word and colour the board's card gives this
   * link's task (`cardStatus`, features/board/card-status.ts), so a chain link
   * whose task waits on a person says "waiting on you" where the chain said
   * "active" in the agent-working colour. Filled by the project Controller
   * page for a link that has a task on the board; absent elsewhere.
   */
  taskStatus?: LinkTaskStatus;
};

/** Ruling 476(g): the board card's status for a link's task, as the rail draws it. */
export interface LinkTaskStatus {
  kind: CardStatusKind;
  label: string;
  /** `scheduled` only: when the task picks itself back up (ruling 225). */
  resumesAt: string | null;
}

export interface GoalView {
  id: string;
  title: string;
  status: GoalFrontmatter["status"];
  createdBy: string;
  createdByLabel: string;
  /** Ruling 476(h): the controller conversation the chain was planned in.
   *  Read from the goal's file (the detail read and the Controller page);
   *  the projection does not carry it, so `listGoals` leaves it absent. */
  conversationId?: string | null;
  onFailure: "pause" | "continue";
  description: string;
  links: GoalLinkView[];
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
  const view = toGoalView(read.parsed);
  // Ruling 192: the DETAIL read is the one a planner acts on, so it carries the
  // live contract beside the declared one. `listGoals` (the board card) shows
  // titles and waits only and reads the projection, so it is left alone.
  view.links = view.links.map((link) => {
    if (!link.taskKey) return link;
    const task = readTaskFile({
      projectSlug,
      taskKey: link.taskKey,
      dataRoot: ctx.dataRoot,
    });
    if (!task) return link;
    const goal = stripChainHeader(task.parsed.goal);
    // Compare against what the task was BUILT from, not against `link.goal`
    // alone: `linkGoalText` falls back to the title when a link declares no
    // goal, so a title-only link read as permanently drifted and the drift
    // field announced a change that never happened.
    const declared = link.goal.trim() || link.title;
    if (goal === declared) return link;
    // Ruling 335: the plain name carries the truth; the declaration keeps a
    // name that says what it is.
    return { ...link, goal, declaredGoal: link.goal };
  });
  return view;
}

function toGoalView(parsed: ParsedGoalFile): GoalView {
  const fm = parsed.frontmatter;
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    createdBy: fm.createdBy,
    createdByLabel: fm.createdByLabel,
    conversationId: fm.conversationId,
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

/** What the Controller page reads from a chain's own file (below). */
export interface GoalFileFacts {
  history: GoalView["history"];
  conversationId: string | null;
}

/**
 * Ruling 419(h): a chain's history, newest first, straight from its canonical
 * file. The projection carries no history (`listGoals` returns it empty), and
 * the controller page is the surface the task page sends a person to "where the
 * whole chain is read" — which showed neither why a chain paused nor the reason
 * a person gave when they cancelled it. Ruling 476(h): the same read carries
 * the conversation the chain was planned in, which the projection does not
 * hold either. Empty and null when the file is gone.
 */
export function readGoalFileFacts(
  projectSlug: string,
  goalId: string,
  ctx: TaskMutationContext = {},
): GoalFileFacts {
  const parsed = readGoalFile(goalRef(ctx, projectSlug, goalId))?.parsed;
  return {
    history: parsed?.timeline ?? [],
    conversationId: parsed?.frontmatter.conversationId ?? null,
  };
}

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
        // Ruling 359: the states ride along with the declaration.
        links: links.map((link) => ({
          ...link,
          waits: resolveDependencies(db, projectSlug, link.blockedBy),
        })),
        currentIndex: r.current_index,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        history: [],
      },
    ];
  });
}
