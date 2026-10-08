/**
 * What every task action shares (ruling 654): the action context and its test
 * seams, the authority guards (`requireAction`, `requireAcceptCompletion`,
 * `requireDecisionAuthority` and the owner exception behind them), the stage
 * and actor helpers, the operator's react and transition caps, and
 * `autoInvokeOperator`, which wakes the operator after a write. The action
 * families beside it import from here and from each other downward; nothing
 * here imports a family. Task mutations write the canonical file before
 * projections, audit and notifications.
 */

import { endSentence } from "~/shared/text/sentence";
import { countLabel } from "~/shared/text/plural";
import type { ResolvedPacketOption } from "~/shared/packet-server-outcome";
import type { RelayPayload } from "./task-relay.server";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Engagement, TaskFileEvent } from "~/schemas/task-file.schema";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { type RbacAction, roleCan, rolesForAction } from "~/shared/rbac";
import {
  requireProjectAuthority,
  requireProjectMutable,
} from "~/server/auth/project-authority.server";
import type { operatorDispatchAgent } from "./operator-dispatch.server";
import type { DependencyReleasePayload } from "~/shared/dependencies";
import {
  resolveStageRoles,
  stageName as resolveStageName,
  type StageRoles,
} from "~/shared/workflow/stage-roles";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  appendPolicyNote,
  type ProjectContext,
  reprojectTask,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { appendTimelineEvent, updateTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { runOperator, RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { runControllerTurn } from "~/server/controller/controller-run.server";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { startAgentRun } from "./specialist-run.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import type { mergeTaskPr } from "~/server/github/github-reconciler.server";
import type { updateWorkspaceBranchFromBase } from "~/server/github/update-branch.server";
import {
  type EngageStage,
  type EngageTaskState,
  engageStagesFor,
  hasDeliveringAgent,
} from "~/shared/workflow/engage-stages";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { logger } from "~/server/logging/logger.server";
import { userDisplayName } from "./user-display-name.server";
import { errorMessage, toError } from "~/shared/errors";

/** Hard cap on the operator's react re-invocation chain (runaway backstop). */
export const OPERATOR_REACT_DEPTH_CAP = 4;

/**
 * Ruling 489(d): the ceiling on react hops since a person last acted, which
 * nothing but a person (or an approve, ruling 362) restarts.
 *
 * The depth cap above counts hops that got nowhere, so a reply that moved the
 * task's head resets it (ruling 489(a)). That leaves a chain whose every hop
 * commits a new head with no bound at all: the operator re-dispatching a
 * developer that commits each time, with no reviewer to object, would run and
 * bill forever. This one counts EVERY hop, progress or not, and stops the
 * chain with the stuck-loop packet at three times the depth cap.
 */
export const OPERATOR_REACT_HOP_CEILING = 3 * OPERATOR_REACT_DEPTH_CAP;

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

/** Placeholder TaskActor the operator toolkit threads through the shared
 *  mutations; its user id is never read once `operatorAuthorized` is set (the
 *  RBAC check is skipped and audit uses {@link OPERATOR_AUDIT_ACTOR}). */
export const OPERATOR_TASK_ACTOR: TaskActor = {
  userId: "operator",
  label: "operator",
};

/**
 * Injectable impls for the delivery/acceptance collaborators this module
 * reaches through dynamic imports — the ctx-borne analogue of the `fetchImpl`
 * hook the github contexts already take (tests only). An absent field resolves
 * to the real module at the call site, exactly as before.
 */
export interface TaskActionDeps {
  pushWorkspaceBranch?: typeof pushWorkspaceBranch;
  openTaskPr?: typeof openTaskPr;
  mergeTaskPr?: typeof mergeTaskPr;
  runOperator?: typeof runOperator;
  /** Ruling 162 / G35-5(d): the acceptance-time base refresh (the workspace
   *  merge the operator's `update_branch_from_base` performs), injectable so a
   *  test can assert the ceremony's call sequence: one refresh, one merge. */
  updateBranchFromBase?: typeof updateWorkspaceBranchFromBase;
  /** Ruling 241: the dispatch the dependency release drains a queued reviewer
   *  question through. Injected for the same reason `runOperator` is — the
   *  drain's contract is WHAT it sends and in what order, and both are
   *  unobservable through a real run. */
  startAgentRun?: typeof startAgentRun;
  /** Ruling 475: the dispatch the operator's conflict handoff starts the
   *  delivering agent through. Injected for the same reason: the handoff's
   *  contract is WHOM it sends and with WHAT directive, and a real run would
   *  prepare a workspace from GitHub. */
  dispatchAgent?: typeof operatorDispatchAgent;
  /** Ruling 672: the controller turn a connected repository starts on the
   *  board. Injected for the same reason `runOperator` is: its contract is
   *  WHO is asked WHAT, and a real turn starts a model on a person's account. */
  runControllerTurn?: typeof runControllerTurn;
}

/** The mutation ctx plus the test seams: the impls above, and the mock
 *  transport threaded into every GitHub read this module (or a helper it
 *  calls, e.g. `probeNothingToDeliver`) performs. Production callers pass a
 *  plain {@link TaskMutationContext}; both fields default to the real thing. */
export type TaskActionContext = TaskMutationContext & {
  deps?: TaskActionDeps;
  fetchImpl?: typeof fetch;
};

export function stageName(project: ProjectContext, stageId: string): string {
  return resolveStageName(project.stages, stageId);
}

/** The four structural stage roles, resolved once from the workflow graph. */
export function stageRolesOf(project: ProjectContext): StageRoles {
  return resolveStageRoles(project.stages, project.workflow);
}

/** The review stage id — the one with a governed edge into the final stage. */
export function reviewStageIdOf(project: ProjectContext): string | null {
  return stageRolesOf(project).reviewId;
}

/**
 * Ruling 163: the stage a task whose revision changed after a verdict returns
 * to (`verdictStageFor`, read against the deployed profiles' declared
 * eligibility), or null when a verdict can be given where it stands.
 */
export async function verdictStageOf(
  ctx: TaskMutationContext,
  projectSlug: string,
  project: ProjectContext,
  fm: { stage: string; engagements: Engagement[] },
): Promise<string | null> {
  const { listDeployedSpecialists } = await import("./specialist-roster.server");
  const specialistCtx: TaskMutationContext = {};
  if (ctx.dataRoot) specialistCtx.dataRoot = ctx.dataRoot;
  return verdictStageFor(project, fm, listDeployedSpecialists(projectSlug, specialistCtx));
}

/**
 * Ruling 702: the earlier stages a task with no delivering agent may go back
 * to so that one can be engaged (`engageStagesFor`, read against the deployed
 * profiles and the project's required reviewers), and whether the task has a
 * delivering agent that can run at all.
 */
export async function engageStagesOf(
  ctx: TaskMutationContext,
  projectSlug: string,
  project: ProjectContext,
  fm: EngageTaskState,
): Promise<{ stages: EngageStage[]; deliverer: boolean }> {
  const { listDeployedSpecialists } = await import("./specialist-roster.server");
  const specialistCtx: TaskMutationContext = {};
  if (ctx.dataRoot) specialistCtx.dataRoot = ctx.dataRoot;
  const deployed = listDeployedSpecialists(projectSlug, specialistCtx);
  return {
    stages: engageStagesFor(project, fm, deployed, project.requiredReviewers),
    deliverer: hasDeliveringAgent(fm, deployed),
  };
}

/** The terminal (Done-equivalent) stage id. */
export function terminalStageIdOf(project: ProjectContext): string | null {
  return stageRolesOf(project).terminalId;
}

/** The loosest membership gate: ANY live member (idempotent/no-op paths).
 *  Routes through the single authority resolution, so an org admin passes as
 *  the audited D2 override. */
export function requireAnyMember(
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
export function ownerException(
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
export function requireAcceptCompletion(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  ownerUserId: string | null | undefined,
  what: string,
): void {
  // The freeze comes FIRST. The owner exception is about role — a contributor
  // owner decides about their own task — and it short-circuits past
  // `requireAction`, the one chokepoint that enforces R6-3. Owning a task on
  // an archived board is not a licence to close it: acceptance attempts a real
  // merge on a project the product calls read-only.
  requireProjectMutable(project, what);
  if (ownerException(project, actor, ownerUserId)) return;
  requireAction(db, project, actor, "accept-completion", what);
}

/**
 * R14-2 (owner ruling 2026-07-25) — a task's human OWNER governs the decisions
 * ON THEIR OWN TASK, whatever their project role.
 *
 * The pass-12 exception was narrow (packets + acceptance), so a contributor
 * owner whose task carried an operator recommendation was counted "waiting on
 * you" by `decisionsRequiring` and then 403'd by both `applyRecommendation` and
 * `dismissRecommendation` — a dead-end inbox entry (P14-GV-01/GV-07). The owner
 * now clears the same outer gate as a maintainer; the INNER mutation each
 * recommendation drives keeps its own cap (an owner applying "assign a
 * specialist" still needs run-agents), so widening this never widens what the
 * owner can make the machinery do — only what they can decide about their task.
 */
export function requireDecisionAuthority(
  db: DatabaseSync,
  project: ProjectContext,
  actor: TaskActor,
  ownerUserId: string | null | undefined,
  what: string,
): void {
  // Same reason as `requireAcceptCompletion`: the owner short-circuit skips
  // `requireAction` and with it the archive freeze, and resolving a packet
  // starts an operator run on a board that is supposed to be read-only.
  requireProjectMutable(project, what);
  if (ownerException(project, actor, ownerUserId)) return;
  requireAction(db, project, actor, "resolve-packet", what);
}

/** `.get()` hands back an undeclared row, so each reader decodes the one column
 *  it selected and falls back when the user (or the column) is not there. */

const avatarToneRowSchema = z.object({ avatar_tone: z.string() });

/** The user's avatar tint for a notification's `from` render; "" when the user
 *  is gone or never picked one. */
export function avatarTone(db: DatabaseSync, userId: string): string {
  const row = avatarToneRowSchema.safeParse(
    db.prepare(`SELECT avatar_tone FROM users WHERE id = ?`).get(userId),
  );
  return row.success ? row.data.avatar_tone : "";
}

export function humanActorRef(db: DatabaseSync, actor: TaskActor) {
  return {
    kind: "human" as const,
    userId: actor.userId,
    nameHint: userDisplayName(db, actor.userId),
  };
}

/**
 * The `assign` timeline event every ownership change writes — `setOwner`'s
 * take/hand-off, and (ruling 127) creation seating the creator.
 *
 * ONE builder because the owner seat is now load-bearing beyond bookkeeping:
 * every agent run on the task bills the owner's accounts, so "who owns this and
 * since when" has to read the same way in the timeline whichever door the seat
 * changed through. A second inline event shape would drift the moment one of
 * them gained a field.
 */
export function ownerAssignEvent(
  db: DatabaseSync,
  actor: TaskActor,
  text: string,
  /**
   * Ruling 255 (pass 37, F37-84): the instant to stamp, when the caller is
   * writing SEVERAL events for one act and the clock would otherwise put them
   * in an order the arrangement contradicts. Creation passes its own `now`;
   * every other caller keeps reading the clock here.
   */
  occurredAt: string = new Date().toISOString(),
): TaskFileEvent {
  return {
    occurredAt,
    type: "assign",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

/** A size as the attachment notes write it: whole KB, never 0. */
export function attachmentKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Ruling 140(a): the ONE rule for who may hold the owner seat, shared by a
 * hand-off through `setOwner` and a named owner at creation, so the pinned
 * sentence never forks. The ACTOR-side guard of `setOwner` (who may hand off)
 * does not apply at creation: the creator is the implicit first owner.
 */
export function requireOwnable(project: ProjectContext, targetUserId: string): void {
  const targetRole = project.memberRoles.get(targetUserId);
  if (!targetRole || !roleCan(targetRole, "own-task")) {
    throw AppError.forbidden(
      "Ownership can only be handed to a project member who can own tasks (contributor or above).",
    );
  }
}

/** What a trigger carries into the run beside its name: ONE trailing options
 *  object (ruling 131 folded the growing positional tail). */
export interface AutoInvokeOptions {
  /** Transition-chain depth to thread into the run (transition + delivered triggers —
   *  see OPERATOR_TRANSITION_CHAIN_CAP). Omitted → the run starts a fresh chain. */
  transitionDepth?: number;
  /** Owner ruling 2026-07-26 — the transition trigger carries WHAT moved and
   *  WHO moved it, so the operator picks the task up knowing from → to. A
   *  human-authored move whose intent isn't visible on the timeline is
   *  something the operator ASKS about instead of guessing. */
  transition?: { fromName: string; toName: string; byHuman: string | null };
  /** R20-1 (F20-5): packet-resolved trigger — the option the human chose (kind,
   *  title, optional note), so the turn instruction states the decision. */
  resolvedOption?: ResolvedPacketOption;
  /** Ruling 131(e): dependencies-released trigger — what was waited on. */
  dependencyRelease?: DependencyReleasePayload;
  /** Ruling 488: relayed trigger — the task it came from, who sent it and
   *  the text, so the turn instruction carries what arrived. */
  relay?: RelayPayload;
}

/**
 * Ruling 330: the record that a task had stopped.
 *
 * Written BEFORE the operator is invoked and unconditionally, because it has to
 * survive an operator that refuses, is not deployed, or throws — the whole
 * point of the sweep is that this state used to leave no trace at all. It is
 * also the sweep's idempotence key: while this note is the newest event, the
 * sweep has already spoken and stays quiet.
 */
export async function noteStranded(
  db: DatabaseSync,
  ctx: TaskActionContext,
  task: { projectSlug: string; taskKey: string; waiting: string | null; quietForMs: number },
): Promise<void> {
  const { STRANDED_NOTE_TITLE, strandedNoteText } = await import("./stranded-sweep.server");
  await appendPolicyNote(db, ctx, task.projectSlug, task.taskKey, {
    title: STRANDED_NOTE_TITLE,
    text: strandedNoteText(task),
  });
}

/**
 * Ruling 333 — "No changes were delivered" was a literal, over runs that had
 * been working for up to two and a half hours.
 *
 * Every classified provider refusal appended it, and so did every unclassified
 * failure except the two cut-off kinds. Nothing was consulted before the
 * assertion. `max_turns` and `max_budget` were exempted precisely BECAUSE a cut
 * run can leave work in the tree — the canary comment on that exemption says so
 * outright — and a provider refusal on turn 48 is the same cut-off and was not
 * exempt.
 *
 * Measured on the shopify-clone board: the clause was written 34 times across
 * 27 tasks. 28 of them followed the run's own start by more than two minutes,
 * the longest by 145 minutes. FOUR were written onto the very event that
 * attaches the files that run produced — SHOP-16, SHOP-18, SHOP-2 and SHOP-41 —
 * because `runAttachments` is stamped onto the same event eleven lines below,
 * under a comment reading "Files the run saved before it died still get their
 * producer named".
 *
 * The cost is not cosmetic, because the sentence is fed forward:
 * `canonicalTaskAnchor` puts recent timeline events into the NEXT run's prompt,
 * and 124 run logs under the data root contain the phrase. Live on SHOP-28 the
 * owner had to hand-write the correction eighteen minutes later: *"Your previous
 * run did not fail on the work — it ran 48 turns … That file is on disk and
 * uncommitted. … Do not regenerate work that is already in the tree."*
 *
 * The delivery half of the old sentence was true and is kept: a failed run
 * pushes nothing and opens no PR. What it may no longer claim is that nothing
 * survived.
 */
export function runOutcomeClause(input: {
  /** Turns the run had taken when it stopped; 0 when it never got going. */
  turns: number;
  /** Files it saved into the task's attachments before it stopped. */
  attachments: number;
}): string {
  if (input.turns <= 0 && input.attachments <= 0) return " No changes were delivered.";
  const turnPart = input.turns > 0 ? countLabel(input.turns, "turn") : "";
  const filePart =
    input.attachments > 0
      ? `${countLabel(input.attachments, "file")} saved to this task`
      : "";
  const did = [turnPart, filePart].filter(Boolean).join(" and ");
  return (
    ` Nothing was delivered to a pull request, but the run had ${did} behind it when it ` +
    `stopped; read the workspace before starting anything over, because work that is already ` +
    `in the tree is easy to regenerate and hard to notice.`
  );
}

/**
 * Ruling 334: a transport reason flattened to fit inside a prose sentence.
 *
 * The same shape as `push-workspace.server.ts`'s `oneLine`, kept local rather
 * than exported across the module boundary: a `fetch` failure's message is one
 * line already in the common case, and the cap exists so a stack-shaped one
 * cannot shred the sentence it is quoted inside.
 */
export function oneLineDetail(excerpt: string): string {
  const flat = excerpt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/** Best-effort operator handoff; dynamically imported to avoid a module cycle.
 *  Exported for the GitHub reconciler (P14 follow-up): an out-of-band PR state
 *  change (`pr-diverged`) is a coordination event like any other, so the
 *  reconciler wakes the operator through the same seam instead of leaving the
 *  divergence as prose only a human ever acts on. */
export async function autoInvokeOperator(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  trigger:
    | "create"
    | "transition"
    | "goal-updated"
    | "pr-diverged"
    | "delivered"
    | "packet-resolved"
    | "dependencies-released"
    // Ruling 235: a refused acceptance whose cause is an unpushed reviewed
    // revision. Only the operator may push it, so the refusal is handed here.
    | "head-unpushed"
    // Ruling 330: the periodic sweep found a task nothing was going to move —
    // no packet, no recommendation, no queued question, no schedule, no run and
    // no hold. The operator is invoked to decide what happens next, which is
    // what a person ends up doing by hand.
    | "stranded"
    // Ruling 332: a person pressed Accept and the acceptance-time refresh found
    // the branch in conflict. Only the operator can run the workspace merge
    // that resolves it, so the refusal is handed here rather than left as a
    // sentence telling a person to do git they have no checkout for.
    | "pr-conflicting"
    // Ruling 482: the project's gates failed on the revision under review.
    // Only the operator dispatches the rework, so the result is handed here.
    | "gates-failed"
    // Ruling 488: work on another task of this project relayed text here.
    // The operator reads it the way it reads a person's @operator comment.
    | "relayed",
  options: AutoInvokeOptions = {},
): Promise<void> {
  const { transitionDepth, transition, resolvedOption, dependencyRelease, relay } = options;
  try {
    const { resolveOperatorAuthority } = await import("./operator-authority.server");
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    if (!authority.deployed) return; // no operator in this project — nothing to run
    const runOperator =
      ctx.deps?.runOperator ??
      (await import("~/server/runtimes/operator-run.server")).runOperator;
    const runInput: RunOperatorInput = {
      projectSlug,
      taskKey,
      trigger,
      dataRoot: ctx.dataRoot,
    };
    if (transitionDepth !== undefined) runInput.transitionDepth = transitionDepth;
    if (transition) {
      runInput.transitionFromName = transition.fromName;
      runInput.transitionToName = transition.toName;
      runInput.transitionByHuman = transition.byHuman;
    }
    if (resolvedOption) runInput.resolvedOption = resolvedOption;
    if (dependencyRelease) runInput.dependencyRelease = dependencyRelease;
    if (relay) runInput.relay = relay;
    await runOperator(db, runInput);
  } catch (error) {
    logger.error("auto operator invocation failed", {
      taskKey,
      trigger,
      err: toError(error),
    });
    // C1 (pass 23): every caller is fire-and-forget, so a THROW here (before a
    // run row exists) left coordination silently stopped — the human created a
    // task or resolved a packet and nothing woke the operator, with no timeline
    // note and no waiting-state change. A runOperator REFUSAL is not a throw (it
    // returns `{refused}` and is handled at the call site), so only a genuine
    // error reaches this catch — record it so the human knows to run the operator
    // manually. Best-effort: this recovery must never throw out of a fire-and-
    // forget handoff.
    try {
      await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: { kind: "system", systemId: "operator" },
          title: null,
          // Ruling 331: the reason, and no claim about what happens next.
          //
          // This said "(an internal error)" over an `error` the line above was
          // already logging, and then asserted "Coordination is paused for this
          // task" — live on SHOP-38 the operator was re-invoked automatically
          // eleven seconds later, so the one durable sentence on the timeline
          // was the only thing still saying the task was stopped. What this
          // knows is that ONE invocation failed; it does not know that nothing
          // else will run, and ruling 330's sweep now guarantees something will
          // look again.
          text:
            `The operator could not be started automatically: ` +
            `${endSentence(error instanceof AppError ? error.userMessage : errorMessage(error))} ` +
            `That was one attempt on a \`${trigger}\` trigger, not a decision to stop: anything ` +
            `that happens on this task invokes the operator again, and Viberr sweeps for tasks ` +
            `nothing is moving. Run the operator yourself if you would rather not wait.`,
          toAgent: false,
          evidence: null,
        });
      });
      reprojectTask(db, ctx, projectSlug, taskKey);
    } catch (noteError) {
      logger.error("auto operator failure note could not be written", {
        taskKey,
        trigger,
        err: toError(noteError),
      });
    }
  }
}

export function projectRepoFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): string | null {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  return file?.parsed.frontmatter.repo ?? null;
}

/**
 * Ruling 177 (pass 36, F36-5): a task that closes ends its live runs. Called
 * after the closing write (acceptance, force-accept) so the runs are stopped
 * on a task that IS closed; the interrupt itself is the run-service's, audited
 * under the system actor with the cause and the person. Writes ONE policy note
 * naming every run it stopped and one audit row for the task; nothing when no
 * run was live. Best-effort: a failure here never masks the acceptance.
 */
export async function interruptLiveRunsOnClosure(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
  closure: { cause: "accept" | "force-accept" | "archive" },
): Promise<string[]> {
  try {
    const { interruptRunOnClosure } = await import("~/server/runtimes/run-service.server");
    const { listRunsForTaskRows } = await import("~/server/runtimes/run-store.server");
    const live = listRunsForTaskRows(db, projectSlug, taskKey).filter(
      (r) => (r.state === "running" || r.state === "queued") && r.kind !== "controller",
    );
    const stopped: { id: string; label: string }[] = [];
    for (const run of live) {
      const outcome = interruptRunOnClosure(
        db,
        { projectSlug, taskKey, runId: run.id },
        { cause: closure.cause, byUserId: actor.userId },
      );
      if (outcome === "interrupted") {
        stopped.push({ id: run.id, label: run.agent_name ?? run.role });
      }
    }
    if (stopped.length === 0) return [];
    const verb =
      closure.cause === "archive"
        ? "archived"
        : closure.cause === "force-accept"
          ? "force-accepted"
          : "accepted";
    const list = stopped.map((r) => `\`${r.id}\` (${r.label})`).join(", ");
    await appendTimelineEvent(taskRef(ctx, projectSlug, taskKey), {
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: { kind: "system", systemId: "policy-engine" },
      title: "Interrupted by acceptance",
      text:
        `**Closed task:** ${stopped.length === 1 ? "the run" : `${stopped.length} runs`} ${list} ` +
        `${stopped.length === 1 ? "was" : "were"} still live when ${taskKey} was ${verb}; ` +
        `${stopped.length === 1 ? "it was" : "they were"} interrupted so a closed task spends nothing more, ` +
        `and no completion of ${stopped.length === 1 ? "it" : "them"} will re-invoke the operator here.`,
      toAgent: false,
      evidence: null,
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.acceptance.interrupted_runs",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: { cause: closure.cause, runIds: stopped.map((r) => r.id) },
    });
    return stopped.map((r) => r.id);
  } catch (error) {
    logger.warn("closure interrupt failed", {
      taskKey,
      err: toError(error),
    });
    return [];
  }
}
