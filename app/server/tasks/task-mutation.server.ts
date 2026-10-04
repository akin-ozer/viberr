import type { DatabaseSync } from "node:sqlite";
import { createActorResolver } from "~/shared/mapping/actor.server";
import { AppError } from "~/server/errors/app-error.server";
import { resolveTaskFilePath, readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import {
  type ClosedDecision,
  type CreateNotificationInput,
  createNotification,
  followClosedDecision,
  markTaskPacketApprovalRead,
  proposalLink,
  taskDecisionLink,
  taskEventLink,
  taskRecommendationsLink,
} from "~/server/projections/notifications.server";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import type {
  FileActorRef,
  ParsedTaskFile,
  Recommendation,
  TaskFileEvent,
} from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { ProjectRole } from "~/shared/rbac";
import type { ProjectGate } from "~/schemas/project-file.schema";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  resolveRequiredReviewers,
  type RequiredReviewerView,
} from "./required-reviewers.server";
import { toError } from "~/shared/errors";

/**
 * The task-mutation SUBSTRATE: the context shape every governed write threads,
 * and the three infrastructure helpers that write-paths call around their own
 * logic (resolve a file ref, re-project after a write, notify the watchers).
 *
 * WHY ITS OWN MODULE — this is a load-bearing cycle break, not tidying.
 * `agent-toolkit.server.ts` needs exactly these three helpers, and importing
 * them from `task-actions.server.ts` closed a real import cycle:
 *
 *     specialist-run → agent-toolkit → task-actions ⇢ (dynamic) specialist-run
 *
 * The `⇢` edge is a deliberate `await import()` that exists ONLY to hide that
 * cycle from the static graph, and hiding it is what made it dangerous: when
 * `resolvePacket`'s `retry_other_backend` arm dynamically imported
 * `specialist-run` while that module was itself still initializing, the import
 * resolved to a HALF-EVALUATED namespace and `startAgentRun` threw
 * `ReferenceError: Cannot access '__vite_ssr_import_30__' before initialization`
 * at its first use of a not-yet-assigned import binding. The retry then failed
 * inside a `catch` that only logged — a human resolved the packet, the packet
 * cleared, and NO agent run started.
 *
 * These three helpers depend only on leaf modules (files/, projections/,
 * errors/, logging/), so hosting them here severs the cycle at its root rather
 * than deferring it. `task-actions.server.ts` re-exports all of them, so the
 * many existing importers are unaffected; modules that would otherwise close
 * the cycle (`agent-toolkit`) import from HERE.
 *
 * Beside them sit the small reads the write paths share — a stage's display
 * name, the post-write summary — on the same leaf-only footing, so any writer
 * (`specialist-run` included) can import them without reopening the cycle.
 */

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
    /** Ruling 489(d): react hops since a person last acted, which a reply
     *  that moved the head does NOT restart (see OPERATOR_REACT_HOP_CEILING).
     *  Optional: absent reads as 0, a chain a person just started. */
    reactHops?: number;
    /** Consecutive operator-authored transition chain depth (see
     *  OPERATOR_TRANSITION_CHAIN_CAP). Optional: only the operator drive sets
     *  it; absent reads as 0. */
    transitionDepth?: number;
    /** Ruling 152(a): the stage this drive's OWN latest transition landed on.
     *  `transitionStage` stamps it when it skips the operator re-trigger for a
     *  live run, so the settle-time stranded backstop judges the stage the
     *  drive left the task at instead of treating the move as "owned by a
     *  re-trigger" that no longer fires. */
    movedToStageId?: string;
    /** Ruling 202: this drive DELIVERED — it entered `performDelivery`, which
     *  pushes the branch and opens or updates the review PR. Progress, exactly
     *  as a transition is, and stamped on ENTRY rather than on the GitHub
     *  answer: the push and the PR call can land after the run row is already
     *  `finished`, and the settle-time backstop runs in that window. Live, it
     *  did: a drive whose single action was `deliver_for_review` was called a
     *  deliberate hold 111ms before its own PR event reached the timeline. */
    delivered?: boolean;
    /**
     * Ruling 228 (F37-47): EVERY action this drive planned was refused, so the
     * drive did nothing at all. Not the same as an operator that decided to
     * wait — it decided to act and was stopped — and the difference is what
     * the settle-time backstop needs to tell them apart.
     */
    planWhollyRefused?: boolean;
    /**
     * Ruling 406 (F39-33): this drive CARRIED OUT at least one planned action
     * (an `outcome: "done"`), whatever effect it had.
     *
     * The settle-time "deliberate hold" verdict used to be reached by
     * enumerating effects, and the list kept turning out to be short: ruling
     * 152(a) added a transition that landed elsewhere, ruling 202 added
     * delivery ("a drive whose single action was `deliver_for_review` was
     * called a deliberate hold"), ruling 228 added the wholly-refused plan.
     * Live on ax-clone AX-18 it happened a fourth time, and this time Viberr
     * was punishing an operator for following Viberr's own instruction: the
     * transition was refused with "Open the conflict packet
     * (update_branch_from_base) ... instead of moving the task", the operator
     * planned exactly that, the refresh succeeded as a no-op because the
     * branch was already current -- and because a base refresh is not a
     * transition, a dispatch, a delivery or a packet, Viberr recorded that the
     * operator "held it twice in a row without advancing, dispatching, or
     * opening a packet", set `heldAtStage` and paused coordination.
     *
     * An operator that ACTED did not hold. That is one fact about the drive
     * rather than a list of the effects Viberr has thought of so far, so it
     * does not need a fifth amendment the next time an action has a new shape.
     */
    carriedOutAction?: boolean;
    /**
     * F39-69: this drive carried out a base refresh (`update_branch_from_base`
     * answered `done`: merged, or already current). A refresh only prepares
     * the branch for a step that follows it. Live on ax-clone AX-5 a Codex
     * operator planned the refresh as step one of a person's three-step
     * directive and stopped. The task sat at Review, "waiting on a human", with
     * nothing to answer, because the settle-time backstop resumes a drive only
     * at an `auto` stage, and Review's way out is a person's.
     */
    refreshed?: boolean;
    /**
     * Ruling 400 (F39-27): the refusal sentences themselves, so the one
     * automatic retry can CARRY them instead of telling the operator to go
     * and read them.
     *
     * Ruling 392 settled this shape for agents — an instruction that delegates
     * reading costs a run — and the plan-refused nudge was committing it a
     * level up, against a reader whose own timeline window clamps entries and
     * whose attention is the thing being spent.
     */
    refusedPlanSteps?: { tool: string; message: string }[];
    /**
     * Ruling 357 (pass 38, F38-11): this drive's own delivery opened the review
     * PR or moved its head under full autonomy — the event that used to queue
     * a `delivered` operator turn behind this very drive's lease. The drive
     * continues on its own turn, so the follow-up is owed only if it stops
     * without acting on the delivery; the lease release reads both stamps.
     */
    deliveredHeadMoved?: boolean;
    /** Ruling 357: a transition or a dispatch this drive made AFTER its
     *  delivery — the drive acted on it, and no follow-up turn is owed. */
    actedAfterDelivery?: boolean;
  };
}

export interface ProjectContext {
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
  /** Ruling 178: the project's declared required reviewers, resolved to the
   *  names the acceptance gate prints. Empty when the project declares none. */
  requiredReviewers: RequiredReviewerView[];
  /** Ruling 482: the gates Viberr runs on every delivered revision; the
   *  acceptance gate refuses until they pass on the revision under review. */
  gates: ProjectGate[];
}

export function loadProjectContext(
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
    requiredReviewers: resolveRequiredReviewers(fm, ctx.dataRoot),
    gates: fm.gates ?? [],
  };
}

export function taskRef(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
) {
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

/** Prepend a policy-engine note to the task's timeline, stamped inside the
 *  file lock, then re-project the task. */
export async function appendPolicyNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  note: { title?: string | null; text: string },
): Promise<void> {
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: { kind: "system", systemId: "policy-engine" },
      title: note.title ?? null,
      text: note.text,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
}

/** The task's projected summary right after a write that re-projected it. A
 *  missing row there is a broken projection, not a user error. */
export function summaryOrThrow(
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

/** A stage's DISPLAY name, for the sentences that name one (a recommendation
 *  label, the canonical re-anchor block); the raw id when the project file is
 *  unreadable. */
export function stageDisplayName(
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
): string {
  const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  return file ? stageName(file.parsed.frontmatter.stages, stageId) : stageId;
}

/** The operator's canonical notification actor. */
export const OPERATOR_NOTIFY_FROM: ActorRender = { kind: "agent", name: "Operator" };

/** The policy engine as a notification sender: the `ActorRender` of the
 *  `system:policy-engine` timeline actor. GitHub divergence alerts (R8-6), the
 *  reconcile poller's notices, scope violations and the review-deadlock
 *  escalation (ruling 237) all send as it. */
export const POLICY_ENGINE_NOTIFY_FROM: ActorRender = { kind: "system", name: "Policy engine" };

/**
 * Ruling 497: the one thing a task notice is about, so its row opens there and
 * not at the top of a page the person then has to search.
 */
export type NoticeSubject =
  /** The timeline event written at this time (its `occurredAt`). */
  | { event: string }
  /** The task's open decision packet (an operator's, or an agent's question),
   *  by its id: ruling 547 moves the row to the event that closes it. */
  | { decision: string | undefined }
  /** The task's pending recommendation cards. */
  | "recommendations"
  /** A knowledge-base proposal, by id (ruling 483). */
  | { proposal: string };

/** Where a row about `about` on this task opens (the links in
 *  `notifications.server.ts`). */
export function noticeHref(projectSlug: string, taskKey: string, about: NoticeSubject): string {
  if (about === "recommendations") return taskRecommendationsLink(projectSlug, taskKey);
  if ("decision" in about) return taskDecisionLink(projectSlug, taskKey, about.decision);
  if ("event" in about) return taskEventLink(projectSlug, taskKey, about.event);
  return proposalLink(projectSlug, about.proposal);
}

export interface TaskWatcherNotice {
  projectSlug: string;
  taskKey: string;
  kind: NotificationKind;
  ptype?: "input" | "blocked" | null;
  title?: string | null;
  text: string;
  /** Ruling 361 (pass 38, F38-15): the actor the timeline names for the same
   *  event — REQUIRED. There is no default: for a year the writer stamped
   *  "Operator" on any notice that named nobody, and 816 notifications on this
   *  instance (every reviewer verdict, every dependency release) told the inbox
   *  the Operator had done what the reviewer or the release engine did. */
  from: ActorRender;
  occurredAt?: string;
  /** Ruling 497: what the notice is about, which is where its row opens.
   *  Omitted or null (the writer found nothing to point at), it opens the task. */
  about?: NoticeSubject | null;
  /** Skip this user (e.g. the human who triggered the event). */
  exceptUserId?: string;
  /** Skip these users — e.g. recipients an earlier notification about the SAME
   *  event already reached (T13's per-recipient dedupe: the packet row and the
   *  quality fallback must never both land in one person's queue, but a watcher
   *  whose prefs dropped the packet row still needs the fallback). */
  exceptUserIds?: readonly string[];
}

/** Ruling 140(b): why the owner seat changed hands, in the words the row uses. */
export type OwnerSeatChange =
  | { kind: "handed_off"; taskKey: string }
  | { kind: "seated_at_creation"; taskKey: string }
  | { kind: "taken_over"; taskKey: string }
  | { kind: "admin_released"; taskKey: string };

/** Ruling 140(b): what became of the one row this notifier tries to write —
 *  recorded on the audit row so a silenced preference and a broken store never
 *  read the same. */
export type OwnerSeatNotified =
  | { userId: string }
  | { skipped: "silenced" }
  | { skipped: "failed" };

/** The row a seat change writes: its heading and its body. */
interface OwnerSeatRow {
  title: string;
  text: string;
}

function ownerSeatText(change: OwnerSeatChange, actorName: string): OwnerSeatRow {
  const seatMeans =
    "The owner is this task's human reviewer and acceptance authority, and every agent run on it uses the owner's own Claude and Codex accounts.";
  switch (change.kind) {
    case "handed_off":
      return {
        title: `${actorName} handed you ${change.taskKey}`,
        text: `You own ${change.taskKey} now. ${seatMeans}`,
      };
    case "seated_at_creation":
      return {
        title: `${actorName} created ${change.taskKey} with you as owner`,
        text: `You own ${change.taskKey} from its first turn. ${seatMeans}`,
      };
    case "taken_over":
      return {
        title: `${actorName} took over ${change.taskKey}`,
        text: `You no longer own ${change.taskKey}: ${actorName} holds the seat, with its review and acceptance authority, and runs on it bill their accounts now.`,
      };
    case "admin_released":
      return {
        title: `${actorName} released you from ${change.taskKey}`,
        text: `You no longer own ${change.taskKey}. The seat is open to any contributor or above; until someone takes it, nobody holds its review and acceptance authority and no agent run on it can be billed.`,
      };
  }
}

/**
 * Ruling 140(b) (pass 34, U34-11): tell the person whose owner seat changed.
 * Under ruling 127 the seat is the credential principal and the acceptance
 * authority, so a seat that changes hands silently is a bill and a duty
 * someone learns about from the first failure packet.
 *
 * Never notifies the ACTOR about their own act (a self-take and a self-release
 * notify nobody), and fails OPEN: a store that refuses the row is logged and
 * reported back as `{ skipped: "failed" }` rather than failing the mutation
 * that already landed. The caller puts the answer on its audit row.
 */
export function notifyOwnerSeatChange(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    recipientUserId: string;
    actor: TaskActor;
    actorName: string;
    change: OwnerSeatChange;
    /** Ruling 497: when the timeline's `assign` event for this change was
     *  written, so the row opens on it. */
    eventAt: string;
  },
): OwnerSeatNotified | null {
  if (input.recipientUserId === input.actor.userId) return null;
  const { title, text } = ownerSeatText(input.change, input.actorName);
  try {
    const id = createNotification(db, {
      userId: input.recipientUserId,
      kind: "ownership",
      title,
      text,
      // Pass 34 review: every other notifier passes `from`, and the
      // notifications stream renders the actor from it — without one the row
      // showed a dash and never named who changed the seat.
      from: createActorResolver(db)({
        kind: "human",
        userId: input.actor.userId,
        nameHint: input.actorName,
      }),
      projectSlug: input.projectSlug,
      taskKey: input.change.taskKey,
      href: noticeHref(input.projectSlug, input.change.taskKey, { event: input.eventAt }),
    });
    // `createNotification` answers null when the reader silenced the category.
    return id ? { userId: input.recipientUserId } : { skipped: "silenced" };
  } catch (error) {
    logger.error("notifyOwnerSeatChange failed", {
      projectSlug: input.projectSlug,
      taskKey: input.change.taskKey,
      recipient: input.recipientUserId,
      err: toError(error),
    });
    return { skipped: "failed" };
  }
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
    // notify nobody of a real event — log it so the blind spot is diagnosable
    // instead of an undiagnosable "no one got the alert".
    //
    // C10.1: this is a DELIBERATE fail-open, not an oversight. The mutation
    // that produced `notice` has already committed by the time this runs, so
    // throwing here would surface a confusing secondary error for an
    // unrelated write and still leave the mutation applied — worse than a
    // silently-empty recipient set. There is no human-facing surface at this
    // layer to report the failure per-notice (the caller only sees the
    // returned array, and most callers don't inspect its length), so this log
    // line naming the project/task/kind and the real error is, today, the
    // ONLY diagnostic trail for "watchers got nothing". If that ever proves
    // insufficient, the fix belongs in the caller (surface `notified.length
    // === 0` against the notice's expected recipients), not here.
    logger.error("notifyTaskWatchers: recipient resolution failed", {
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
      kind: notice.kind,
      err: toError(error),
    });
    return [];
  }
  if (notice.exceptUserId) recipients.delete(notice.exceptUserId);
  for (const userId of notice.exceptUserIds ?? []) recipients.delete(userId);

  const notified: string[] = [];
  for (const userId of recipients) {
    // createNotification consults this recipient's routing prefs and returns
    // null when they've silenced this category — only count real deliveries.
    const notification: CreateNotificationInput = {
      userId,
      kind: notice.kind,
      ptype: notice.ptype ?? null,
      title: notice.title ?? null,
      text: notice.text,
      from: notice.from,
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
    };
    if (notice.about) notification.href = noticeHref(notice.projectSlug, notice.taskKey, notice.about);
    // No caller timestamp ⇒ leave the key off and let the writer stamp `now`.
    if (notice.occurredAt) notification.occurredAt = notice.occurredAt;
    const id = createNotification(db, notification);
    if (id) notified.push(userId);
  }
  return notified;
}

// ------------------------------------------- acceptance offers (ruling 137)

/** Why an acceptance offer was withdrawn — the three events that invalidate
 *  it (pass 34, F34-15). */
export type OfferWithdrawalCause =
  | { kind: "revision"; headSha: string }
  | { kind: "packet"; title: string }
  | { kind: "stage_move"; toStageId: string; toStageName: string };

export interface OfferWithdrawal {
  removed: Recommendation[];
  /** Cards left standing after the withdrawal (a `run_agent` card survives). */
  surviving: number;
  /** The timeline note that was written, when anything was removed. */
  note: TaskFileEvent | null;
}

/**
 * Ruling 137: the terminal (Done-equivalent) stage id of a project, read from
 * its file, for the writers without a loaded project context: the packet
 * writers that withdraw acceptance offers, and the operator's transition
 * routing. Resolved from the workflow graph like every other role lookup
 * (B-WF4); `resolveStageRoles` already does the positional-last fallback.
 * Named apart from task-actions' `terminalStageIdOf(project)`, which takes a
 * loaded `ProjectContext`. Null when the project file is unreadable: the
 * withdrawal then removes `accept_completion` cards alone.
 */
export function terminalStageIdFor(ctx: TaskMutationContext, projectSlug: string): string | null {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return null;
  const fm = project.parsed.frontmatter;
  return resolveStageRoles(fm.stages, fm.workflow).terminalId;
}

/** A locked mutator's withdrawal result, carried out of the closure — a plain
 *  `let` is narrowed to `null` past the callback that assigns it. */
export interface OfferWithdrawalSlot {
  offers: OfferWithdrawal | null;
}

function withdrawalCauseText(cause: OfferWithdrawalCause): string {
  switch (cause.kind) {
    case "revision":
      return `a new revision \`${cause.headSha.slice(0, 7)}\` was delivered, so the offer no longer describes the work under review`;
    case "packet":
      return `a decision packet opened ("${cause.title}"), so the task is waiting on a human decision first`;
    case "stage_move":
      return `the task moved to **${cause.toStageName}**, away from the acceptance boundary`;
  }
}

/**
 * Ruling 137 (pass 34, F34-15): remove the acceptance offers a task carries
 * that no longer hold, INSIDE the task file's own lock (the caller is a
 * `updateTaskFile` mutator). `accept_completion` cards go on every cause; a
 * `transition` card targeting the terminal stage is an acceptance too (F19-3)
 * and goes on the packet and stage causes. `run_agent` and `delivery` cards
 * survive all three: more work is compatible with rework.
 *
 * A withdrawal is never silent: one `note` titled "Recommendation withdrawn"
 * names each card and the cause. The audit row and the bell live in
 * {@link recordRecommendationWithdrawal}, which needs the database and runs
 * after the lock. Lives HERE (the leaf) so the delivery reconcile, the packet
 * writers and the stage move can all call it without closing the
 * `specialist-run → agent-toolkit → task-actions` cycle this module exists to
 * break.
 */
export function withdrawAcceptanceOffers(
  parsed: ParsedTaskFile,
  terminalStageId: string | null,
  cause: OfferWithdrawalCause,
  actor: FileActorRef,
  /** Cards the CALLER drops in the same write for its own reasons (the stage
   *  move's blanket "any pending transition card is stale"). They are removed
   *  here so the note's survivor count is the array the write actually leaves
   *  behind — counting before the caller's own filter overstated it (pass 34
   *  review) — but they are not NAMED: this note is about the acceptance
   *  offers the ruling covers. */
  alsoStale?: (r: Recommendation) => boolean,
): OfferWithdrawal {
  const stale = (r: Recommendation): boolean => {
    if (r.kind === "accept_completion") return true;
    if (cause.kind === "revision") return false;
    return (
      r.kind === "transition" &&
      terminalStageId !== null &&
      r.toStageId === terminalStageId
    );
  };
  const keep = (r: Recommendation): boolean => !stale(r) && !(alsoStale?.(r) ?? false);
  const removed = parsed.frontmatter.recommendations.filter(stale);
  if (removed.length === 0) {
    parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(keep);
    return { removed: [], surviving: parsed.frontmatter.recommendations.length, note: null };
  }
  parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(keep);
  const surviving = parsed.frontmatter.recommendations.length;
  const names = removed.map((r) => `"${r.label}"`).join(", ");
  const note: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "note",
    actor,
    title: "Recommendation withdrawn",
    text:
      `Withdrew ${removed.length === 1 ? "the offer" : "the offers"} ${names}: ${withdrawalCauseText(cause)}.` +
      (surviving > 0
        ? ` ${surviving === 1 ? "1 recommendation still stands" : `${surviving} recommendations still stand`}.`
        : "") +
      " The operator re-recommends acceptance on its next turn if the offer still holds.",
    toAgent: false,
    evidence: null,
  };
  parsed.timeline.unshift(note);
  return { removed, surviving, note };
}

/**
 * The half of a withdrawal that needs the database: one
 * `task.recommendation.withdrawn` audit row per withdrawal event, and the
 * "Waiting on you" bell — `markTaskPacketApprovalRead` marks EVERY unread
 * approval row for the task read, project-wide, and `addRecommendation` raised
 * such a row for a surviving `run_agent` card, so it is called ONLY when no
 * recommendation survives. Call after the locked write that ran
 * {@link withdrawAcceptanceOffers}, and only when it removed something.
 */
export function recordRecommendationWithdrawal(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    withdrawal: OfferWithdrawal;
    cause: OfferWithdrawalCause;
    actor: AuditActor;
  },
): void {
  if (input.withdrawal.removed.length === 0) return;
  recordAudit(db, {
    action: "task.recommendation.withdrawn",
    actor: input.actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      cause: input.cause.kind,
      removed: input.withdrawal.removed.map((r) => ({
        id: r.id,
        kind: r.kind,
        forHeadSha: r.forHeadSha ?? null,
      })),
      surviving: input.withdrawal.surviving,
    },
  });
  if (input.withdrawal.surviving === 0) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);
  }
}

// ------------------------------- acceptance packets (ruling 475, F40-55 (b))

/**
 * Ruling 475 (F40-55 (b)): an open decision packet that offers
 * `accept_completion` stops holding the moment the review PR conflicts with its
 * base, because the acceptance gate refuses the very click it invites. Live on
 * WEB-2 the packet said "the PR is mergeable" for 26 minutes after WEB-4's
 * merge had put it in conflict, and the owner learned so only when Accept was
 * refused. Ruling 162(d) already withdrew the `accept_completion`
 * RECOMMENDATIONS on that flip; the packet offering the same click survived.
 *
 * Runs INSIDE the task file's lock (the caller is an `updateTaskFile` mutator)
 * and writes one person-facing note. {@link recordAcceptancePacketWithdrawal}
 * writes the audit row and clears the bell after the lock. Returns what was
 * withdrawn, or null when no such packet stood.
 */
export function withdrawAcceptancePacket(
  parsed: ParsedTaskFile,
  /** Why the offer no longer holds, as the tail of a sentence. */
  reason: string,
  actor: FileActorRef,
): AcceptancePacketWithdrawal | null {
  const packet = parsed.packet;
  if (!packet || !packet.options.some((o) => o.kind === "accept_completion")) return null;
  parsed.packet = null;
  // A blocked packet held the readiness gate down with it.
  if (parsed.frontmatter.readiness === "blocked") parsed.frontmatter.readiness = "ready";
  const note: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "transition",
    actor,
    title: null,
    text: `**Packet withdrawn:** "${packet.title}" no longer holds: ${reason}.`,
    toAgent: false,
    evidence: null,
  };
  parsed.timeline.unshift(note);
  return { title: packet.title, closed: { packetId: packet.id, closedAt: note.occurredAt } };
}

/** What {@link withdrawAcceptancePacket} withdrew. */
export interface AcceptancePacketWithdrawal {
  title: string;
  /** Ruling 547: the packet, and the note that records its withdrawal. */
  closed: ClosedDecision;
}

/** A locked mutator's {@link withdrawAcceptancePacket} result, carried out of
 *  the closure (the same reason {@link OfferWithdrawalSlot} exists). */
export interface AcceptancePacketWithdrawalSlot {
  /** Null when no such packet stood. */
  withdrawn: AcceptancePacketWithdrawal | null;
}

/** The database half of {@link withdrawAcceptancePacket}: the audit row, the
 *  packet's bell marked read for everyone it reached, and its rows sent to the
 *  note that says why it went (ruling 547). */
export function recordAcceptancePacketWithdrawal(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    withdrawn: AcceptancePacketWithdrawal;
    reason: "pr_conflicting";
    actor: AuditActor;
  },
): void {
  recordAudit(db, {
    action: "task.packet.withdrawn_superseded",
    actor: input.actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { reason: input.reason, title: input.withdrawn.title },
  });
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  followClosedDecision(db, input.projectSlug, input.taskKey, input.withdrawn.closed);
}
