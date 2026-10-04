/**
 * The operator moving a task forward (ruling 656): delivering it for review,
 * moving it between stages (with ruling 655's answer to a move nobody
 * confirms), and accepting a completion or writing its packet.
 */

import { canonicalDependencyRef } from "~/shared/dependencies";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  type Engagement,
  type TaskPacket,
  unpushedRevisionOf,
} from "~/schemas/task-file.schema";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { transitionStage } from "./task-transitions.server";
import { performDelivery } from "./task-delivery.server";
import {
  acceptanceRefusalFor,
  applyAcceptanceWrite,
  mergeReadinessRefusal,
  revisionDriftNote,
} from "./task-acceptance.server";
import { OPERATOR_TASK_ACTOR } from "./task-action-core.server";
import { OPERATOR_AUDIT_ACTOR, recordAudit } from "~/server/audit/audit-recorder.server";
import {
  stageDisplayName,
  type TaskMutationContext,
  taskRef,
  terminalStageIdFor,
} from "./task-mutation.server";
import {
  acceptanceNoChangeCheck,
  kbCorrectionsOutcome,
  noChangeApplies,
  noChangeCandidate,
  noChangeCompletionEvent,
  standingKbCorrections,
} from "./no-change-completion.server";
import { listDeployedSpecialists } from "./specialist-roster.server";
import { acceptanceOfferBasis, readRequiredReviewers } from "./required-reviewers.server";
import {
  type CompletionPacketInput,
  completionPacketRefusal,
  writeCompletionPacket,
} from "./completion-packet.server";
import {
  deliverGate,
  gate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-authority.server";
import { addRecommendation, opCtx, type RecommendationInput } from "./operator-packets.server";

/** The delivery audit row's details. */
type DeliveryAuditDetails = {
  status: string;
  /** Present only when a review PR actually exists. */
  prNumber?: number;
  /** Ruling 134: the head the delivery left on the PR, and whether the push
   *  (or the PR open) MOVED anything — `delivered` only. */
  headSha?: string | null;
  moved?: boolean;
};

/** The move an operator transition asks `transitionStage` to perform. */
type OperatorTransitionMove = {
  projectSlug: string;
  taskKey: string;
  toStageId: string;
  reason?: string;
  /** R7-4 rework routing — a validated backward move on failing work. */
  rework?: boolean;
};

/**
 * R15-2: DELIVER the task — push the deliverer's branch and open (or reuse) the
 * review PR. Delivery is the operator's decision, gated by `deliver-review-pr`:
 * `direct` performs it via the shared `performDelivery` core and reports the
 * push + PR outcome honestly (including `push_conflict`); `recommend` posts a
 * `delivery` recommendation card a human applies. The server executes the
 * mechanics either way; agents never push or open PRs themselves.
 */
export async function operatorDeliverForReview(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = deliverGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Delivering the branch & opening the review PR is not permitted for the operator here.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  // Ruling 134 (pass 34, F34-11): NO cached-state short-circuit. The old
  // "PR #N is already open for review; there is nothing to deliver" answered
  // before `performDelivery` ran, so every commit an agent made after the first
  // delivery (a reviewer-requested rework, a resolved base conflict, the whole
  // JC-6 scaffold) stayed in the workspace. Delivery is defined by the REMOTE:
  // `pushWorkspaceBranch` reads origin's head and answers `up_to_date` when
  // there is nothing to push, and THAT is the only honest noop.
  const fm = existing.parsed.frontmatter;
  const livePr = fm.pr && fm.pr.state !== "closed" && fm.pr.state !== "merged" ? fm.pr : null;
  if (g === "recommend") {
    // The recommend arm reads the RECORDED fact, never the cache: with an open
    // PR and no unpushed revision on the record there is nothing to propose.
    const activeRevision = activeWorkRevision(fm.workRevision);
    const unpushed = unpushedRevisionOf(fm.pr, activeRevision?.headSha ?? null);
    if (livePr && !unpushed) {
      return {
        outcome: "noop",
        message: `PR #${livePr.number} already carries the delivered revision${activeRevision ? ` \`${activeRevision.headSha.slice(0, 7)}\`` : ""}; there is nothing to deliver.`,
      };
    }
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "delivery",
        label: livePr && unpushed
          ? `Push \`${unpushed.revisionSha.slice(0, 7)}\` to PR #${livePr.number}`
          : "Deliver the branch & open the review PR",
      },
      input.reason ??
        (livePr && unpushed
          ? `The delivered revision \`${unpushed.revisionSha.slice(0, 7)}\` is not on PR #${livePr.number}; delivering pushes it to that PR.`
          : "The work is committed and ready for review; delivering pushes the task branch and opens the review PR."),
    );
    return {
      outcome: "recommended",
      message: livePr && unpushed
        ? `Recommended pushing \`${unpushed.revisionSha.slice(0, 7)}\` to PR #${livePr.number}.`
        : "Recommended delivering the branch & opening the review PR.",
    };
  }
  // F17-1: delivery THROUGH the operator's own tool is operator-authorized by
  // definition — mark the ctx so `performDelivery` attributes the "Opened PR"
  // event to the Operator, not to the sentinel "operator" user id rendered as a
  // human with a bogus "no longer a member" guest pill. (A human manual delivery
  // reaches performDelivery WITHOUT this flag and still renders as that human.)
  const outcome = await performDelivery(
    db,
    { ...ctx, operatorAuthorized: true },
    input.projectSlug,
    input.taskKey,
    OPERATOR_TASK_ACTOR,
  );
  // The PR number exists only on a DELIVERED outcome; a `prNumber` key on a
  // failed delivery would name a pull request that was never opened.
  const details: DeliveryAuditDetails = { status: outcome.status };
  if (outcome.status === "delivered") {
    details.prNumber = outcome.prNumber;
    details.headSha = outcome.headSha;
    details.moved = outcome.moved;
  }
  recordAudit(db, {
    action: "github.delivery.operator",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });
  switch (outcome.status) {
    case "delivered": {
      // Ruling 134(a): the message names what MOVED. A reuse whose push moved
      // the head says so with the sha; a reuse that pushed nothing is the one
      // honest noop, and it reads as one.
      const sha = outcome.headSha ? ` \`${outcome.headSha.slice(0, 7)}\`` : "";
      const message = outcome.created
        ? `Delivered: pushed${sha} and opened review PR #${outcome.prNumber}.`
        : outcome.moved
          ? `Delivered: pushed${sha} to the open review PR #${outcome.prNumber} (its head moved; the reviewers judge the new revision).`
          : outcome.pushStatus === "up_to_date"
            ? `Nothing to push: PR #${outcome.prNumber} already carries${sha || " the workspace head"}.`
            : `Delivered: push skipped (${outcome.pushStatus}), reusing open review PR #${outcome.prNumber}.`;
      // Ruling 494: where the pushed branch now stands against the base, as the
      // compare the push ran says, or that it could not run one.
      return {
        outcome: "done",
        message: outcome.recompare ? `${message} ${outcome.recompare}` : message,
      };
    }
    case "push_conflict":
      return {
        outcome: "noop",
        message:
          `Delivery push CONFLICTED: ${outcome.message}. No PR was opened. This is a ` +
          `branch-history conflict on \`${outcome.branch}\`, not a credential problem. ` +
          `Open a decision packet with a \`resolve_remote_collision\` option (its ` +
          `ceremony closes the squatting PR when one is recorded, deletes the stale ` +
          `remote branch, and re-delivers this task's local work) or an ` +
          `\`archive_task\` option to abandon the task. A \`discard_branch\` option ` +
          `destroys this task's LOCAL commits: the refused push means the revision never ` +
          `left the workspace, so it MAY be offered (ruling 161) when the person's choice is ` +
          `to throw the local work away, never as the way to clear the remote.`,
      };
    case "scope_violation":
      // Ruling 144: the remedy is a human's (grant the scope on GitHub, then
      // Re-check); the violation is already on the task and in the inbox.
      return {
        outcome: "noop",
        message:
          `Delivery was refused for a missing \`${outcome.scope}\` scope: ${outcome.message} ` +
          `A scope violation is open on the task; do not retry until the credential card shows the scope. ` +
          `Do not ask an agent to push.`,
      };
    case "store_layout":
      // Ruling 159: Viberr never publishes its own store layout into the
      // repository; the folder is a person's or the agent's to remove.
      return {
        outcome: "noop",
        message:
          `Delivery was refused: ${outcome.message} ` +
          `Nothing was pushed and no PR was opened. Re-prompt the delivering agent to remove ` +
          `${outcome.files.map((f) => `\`${f}\``).join(", ")} from the branch (the task's real ` +
          `attachments folder is outside the checkout; its prompt names the absolute path), then deliver again.`,
      };
    case "closed_by_human":
      // Ruling 160: a person's close is a decision about the task, answered
      // through the closed-PR recovery packet, never delivered around.
      return {
        outcome: "noop",
        message:
          `Delivery was refused: ${outcome.message} ` +
          `Do not deliver again and do not ask any agent to push or open a PR. ` +
          `The closed-PR recovery packet is the path: when no open packet already covers PR #${outcome.prNumber}, ` +
          `open ONE decision packet (type "input") with a \`custom\` option to rework (a later \`deliver_for_review\` then opens a fresh PR), ` +
          `an \`archive_task\` option, and an \`archive_task\` option with \`deleteBranch: true\`, ` +
          `and say that reopening the PR on GitHub is also a valid answer. Then wait for the person.`,
      };
    case "grant_withheld":
    case "push_failed":
    case "nothing_to_review":
    case "failed":
      return { outcome: "noop", message: `Delivery did not complete: ${outcome.message}` };
  }
}

export async function operatorTransitionStage(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; toStageId: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "stage-transitions");
  if (g === "deny") {
    return { outcome: "denied", message: "Stage transitions are not permitted for the operator here." };
  }
  // An `auto` boundary is ungoverned by the project's own workflow — it declares
  // "no approval needed" — so crossing it is not an exercise of governance
  // authority and does NOT wait on a human, even when the operator's
  // stage-transitions capability is `recommend` (supervised). Otherwise a task
  // strands at a pre-work stage (e.g. Ready→In Progress "when a specialist is
  // assigned") with a recommendation nobody needs to approve. Governed
  // boundaries (`approval`/`human`) still route through the recommend/deny gate.
  // R7-4 rework routing: a BACKWARD move to an earlier stage on a task whose
  // latest review is `failing` sends the rejected work back to the developer.
  // The operator does this directly (no human, no recommendation) so a failed
  // review re-drives itself; transitionStage vets that it is genuinely backward
  // + failing before honoring the off-graph move.
  const isRework = isReworkMove(ctx, input.projectSlug, input.taskKey, input.toStageId);
  const boundary = operatorBoundaryFor(ctx, input.projectSlug, input.taskKey, input.toStageId);
  const terminalId = terminalStageIdFor(ctx, input.projectSlug);
  // F19-26: a transition whose TARGET is the terminal stage is an ACCEPTANCE,
  // whatever the tool it arrived through. A supervised operator calling
  // transition_stage(<terminal>) used to file a plain "Move the task to Done"
  // card whose Apply runs the full acceptance contract — a real, irreversible PR
  // merge — under a label that never says "accept" or "merge". Route it to the
  // acceptance path instead, which files a truthful `accept_completion` card
  // (and refuses out loud when the acceptance gates are not met).
  //
  // R19-6: rerouting also means this path must answer to the ACCEPTANCE
  // capability, not just `stage-transitions` — `stage-transitions: recommend`
  // with `completion-for-acceptance: off` was live-proven to produce a real
  // acceptance card + audit row through exactly this delegation. The gate is
  // the first thing `operatorAcceptCompletion` does, so the refusal is
  // inherited here rather than duplicated (one gate read, one sentence).
  //
  // Ruling 151 (pass 35, F35-2): the reroute now covers BOTH gates. Under
  // `direct` the bare move used to fall through to transitionStage's own
  // refusal ("reaches Done only by accepting completion"); acceptance has its
  // own capability, so the acceptance path answers here too.
  if (terminalId !== null && input.toStageId === terminalId) {
    return operatorAcceptCompletion(
      db,
      ctx,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      authority,
    );
  }
  const name = stageDisplayName(ctx, input.projectSlug, input.toStageId);
  // Ruling 655 (owner, 2026-09-27: "it shouldn't offer the packet as well"): a
  // move nobody confirms is never put to a person. The stage the task already
  // stands at is no move at all, and a card for it would sit beside the move
  // the operator already made. A jump the board does not declare, when every
  // step on the way is `auto`, is the operator's to walk one step at a time; a
  // card would ask a person to approve steps nobody approves. Backward and
  // approval-crossing jumps still route below (owner ruling 2026-07-26).
  {
    const fromStageId = currentStageOf(ctx, input);
    if (fromStageId === input.toStageId) {
      return { outcome: "noop", message: `${input.taskKey} is already at ${name}; there is nothing to move.` };
    }
    const steps = boundary === null && !isRework
      ? automaticStepsTo(ctx, input.projectSlug, fromStageId, input.toStageId)
      : null;
    if (steps) {
      const fromName = stageDisplayName(ctx, input.projectSlug, fromStageId);
      const through = steps.slice(0, -1).map((id) => stageDisplayName(ctx, input.projectSlug, id));
      return {
        outcome: "noop",
        message:
          `${fromName} to ${name} is not one move on this board: the way goes through ` +
          `${through.join(", then ")}, and every step on it is automatic. Move ${input.taskKey} to ` +
          `${through[0]} first; each move's reply names the next.`,
      };
    }
  }
  // Ruling 162 (pass 35, F35-12 (b), owner Q35-17): Merge means mergeable. A
  // move INTO the acceptance stage (the stage with the edge into the terminal
  // one) is refused with the gate's own sentence while the review PR conflicts
  // with the base or lacks the delivered revision, so the task stays at the
  // work stage where the conflict packet is the path. Live (KNC-6, KNC-20) the
  // operator moved both to Merge and recommended acceptance on PRs whose
  // `mergeable: conflicting` was already on the file.
  {
    const mergeEntry = mergeStageEntryRefusal(ctx, input.projectSlug, input.taskKey, input.toStageId);
    // F39-10: `noop` — the PR's mergeability and its delivered revision are
    // task STATE, not a capability the project withheld.
    if (mergeEntry) return { outcome: "noop", message: mergeEntry };
  }
  // Ruling 151 (owner, Q35-1): the boundary the project author declared is the
  // contract every human reads on the Policy page and in project.md, and a
  // grant cannot void it. `direct` crosses `auto` boundaries only; a declared
  // `approval` boundary ALWAYS files a recommendation a human applies, under
  // either autonomy and either grant mode; a declared `human` boundary is
  // refused with a sentence. Live (KNC-1): `stage-transitions: direct` under
  // supervised autonomy moved Review to Merge with `boundary: approval, by:
  // operator` while every surface said a human approves it. Rework moves on a
  // failing task (R7-4) are unchanged.
  if (!isRework && boundary === "human") {
    return {
      outcome: "denied",
      message:
        `Moving ${input.taskKey} to ${name} is a human decision on this board; the operator ` +
        `cannot cross that boundary. A human moves the task or accepts the completion.`,
    };
  }
  if (!isRework && boundary === "approval") {
    const fromName = stageDisplayName(ctx, input.projectSlug, currentStageOf(ctx, input));
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "transition",
        toStageId: input.toStageId,
        label: `Move the task to ${name}`,
      },
      input.reason ?? `The work is ready to advance to ${name}.`,
    );
    return {
      outcome: "recommended",
      message:
        `Recommended moving the task to ${name}; the ${fromName} to ${name} boundary is ` +
        `approved by a human.`,
    };
  }
  if (g === "recommend" && boundary !== "auto" && !isRework) {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "transition",
        toStageId: input.toStageId,
        label: `Move the task to ${name}`,
      },
      input.reason ?? `The work is ready to advance to ${name}.`,
    );
    return { outcome: "recommended", message: `Recommended moving the task to ${name}.` };
  }
  const move: OperatorTransitionMove = { ...input };
  // `rework` is an off-graph escape hatch transitionStage re-validates; it must
  // reach it only on a genuine rework move.
  if (isRework) move.rework = true;
  await transitionStage(db, move, OPERATOR_TASK_ACTOR, opCtx(ctx));
  // Ruling 152(a) (pass 35, G35-5): the reply names the NEXT boundary so one
  // turn can walk consecutive `auto` boundaries instead of paying a fresh
  // operator turn per stage (KNC-1 took eight operator runs for a one-file
  // ADR). When the move lands on the acceptance boundary, the same turn files
  // the acceptance recommendation (owner, Q35-15: the fold), so an approval
  // costs one operator turn, not two.
  const folded = await foldAcceptanceRecommendation(
    db,
    ctx,
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
    authority,
  );
  const next = folded
    ? folded.message
    : nextBoundarySentence(ctx, input.projectSlug, input.toStageId, name, authority);
  return {
    outcome: "done",
    message: `Moved ${input.taskKey} to ${name}.${next ? ` ${next}` : ""}`,
  };
}

/** The task's current stage id (the `from` of the move being judged). */
function currentStageOf(
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
): string {
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  return task?.parsed.frontmatter.stage ?? "";
}

/**
 * Ruling 152(a): what the operator should do about the boundary AFTER the one
 * it just crossed, so a turn continues instead of ending at a stage whose only
 * work is another transition. Empty when the stage has no outbound edge.
 */
function nextBoundarySentence(
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
  fromName: string,
  authority: OperatorAuthority,
): string {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return "";
  const edge = project.parsed.frontmatter.workflow.find((w) => w.from === stageId);
  if (!edge) return "";
  const toName = stageName(project.parsed.frontmatter.stages, edge.to);
  const label = `The next boundary, ${fromName} to ${toName},`;
  if (edge.boundary === "auto") {
    return `${label} is auto: continue in this turn when nothing at ${fromName} needs an agent.`;
  }
  if (edge.boundary === "approval") {
    return `${label} is approved by a human: recommend it when the work is ready.`;
  }
  // A `human` boundary is the acceptance boundary: the fold above already
  // tried the recommendation; reaching here means the recommend branch does
  // not apply (full autonomy with a direct acceptance grant, or acceptance
  // withheld), so the reply names the tool that answers for it.
  return gate(authority, "completion-for-acceptance") === "deny"
    ? `${label} is a human decision: a human accepts the completion.`
    : `${label} is acceptance: call accept_completion when the review is clean.`;
}

/**
 * Owner decision Q35-15 (pass 35, G35-5, the FOLD): when a task lands on the
 * acceptance boundary (the review stage, or any stage with a declared edge into
 * the terminal one), the acceptance recommendation is written NOW, by whoever
 * made the move, instead of by a second paid operator turn whose only work was
 * that card (KNC-30: Review to Merge at 19:21Z, the acceptance card at 19:30Z,
 * two turns). Recommendation ONLY: a full-autonomy operator holding a direct
 * acceptance grant is never folded into an actual acceptance, and a withheld
 * capability files nothing (`completionCapabilityRefusal`). The shared
 * acceptance gate stack inside `operatorAcceptCompletion` decides whether the
 * card can be filed; its refusal sentence comes back as the message so the
 * caller can say why no card exists yet.
 *
 * Returns `null` when the fold does not apply (not at the boundary, direct
 * acceptance, capability withheld, no operator deployed); otherwise whether a
 * card was filed and the sentence to report.
 */
export async function foldAcceptanceRecommendation(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<{ recommended: boolean; message: string } | null> {
  if (!authority.deployed) return null;
  if (completionCapabilityRefusal(authority, input.taskKey)) return null;
  if (authority.autonomy === "full" && gate(authority, "completion-for-acceptance") === "direct") {
    return null;
  }
  const project = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!project || !task) return null;
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const roles = resolveStageRoles(stages, workflow);
  const stage = task.parsed.frontmatter.stage;
  const terminalId = roles.terminalId;
  if (terminalId === null || stage === terminalId) return null;
  const atBoundary =
    stage === roles.reviewId || workflow.some((w) => w.from === stage && w.to === terminalId);
  if (!atBoundary) return null;
  // Ruling 521: the card the fold files is the operator's offer too, so it
  // waits for the completion packet. Refused here, a person's move re-invokes
  // the operator, whose turn writes the packet and then offers.
  const result = await operatorAcceptCompletion(
    db,
    ctx,
    { ...input, requirePacket: true },
    authority,
  );
  if (result.outcome === "recommended") {
    return { recommended: true, message: result.message };
  }
  return {
    recommended: false,
    message: `Acceptance is not recommended yet: ${result.message}`,
  };
}

/** True when moving `taskKey` to `toStageId` is an operator rework move (R7-4):
 *  a BACKWARD step to an earlier stage on a task whose latest review is
 *  `failing`. The operator performs these directly to route a rejected task
 *  back to the developer without a human. */
function isReworkMove(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): boolean {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!task || !project) return false;
  const stages = project.parsed.frontmatter.stages;
  const fromIndex = stages.findIndex((s) => s.id === task.parsed.frontmatter.stage);
  const toIndex = stages.findIndex((s) => s.id === toStageId);
  const backward = toIndex >= 0 && fromIndex >= 0 && toIndex < fromIndex;
  if (!backward) return false;
  const validation = task.parsed.frontmatter.validation;
  if (validation === "failing") return true;
  // Ruling 163 (pass 35, F35-13): a revision that changed after a verdict is
  // rework by definition; the one backward move it licenses is INTO the review
  // stage, where the re-verdict can be given. Same predicate `transitionStage`
  // re-vets, and the same shape `reworkStages` offers.
  if (validation !== "changed") return false;
  const target = verdictStageFor(
    { stages, workflow: project.parsed.frontmatter.workflow },
    task.parsed.frontmatter,
    listDeployedSpecialists(projectSlug, ctx),
  );
  return target !== null && toStageId === target;
}

/**
 * Ruling 163 (pass 35, F35-13 (d)): the sentence naming the way back to the
 * review stage for a task standing past it with a changed or failing
 * revision, or null when it does not apply. The operator's move is the first
 * remedy (`transition_stage` to the review stage, a rework move it performs
 * itself); the person's stage picker on the task page is the second, named so
 * the operator can point a human at it when its own move is refused.
 */
function reworkRemedySentence(
  ctx: TaskMutationContext,
  projectSlug: string,
  fm: { stage: string; validation: string; engagements: Engagement[] },
  stages: { id: string; name: string }[],
): string | null {
  if (fm.validation !== "changed" && fm.validation !== "failing") return null;
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return null;
  const target = verdictStageFor(
    { stages, workflow: project.parsed.frontmatter.workflow },
    fm,
    listDeployedSpecialists(projectSlug, ctx),
  );
  if (target === null) return null;
  const review = stageName(stages, target);
  return (
    `The revision changed after the last verdict, so the task belongs back at ${review} ` +
    `where the reviewers are eligible: move it there with transition_stage (a rework move ` +
    `you perform yourself); a person can also move it with the stage picker on the task page.`
  );
}

/**
 * Ruling 162: why the operator may not move `taskKey` INTO the acceptance
 * stage right now, or null. Reads `mergeReadinessRefusal`, the GitHub-fact
 * half of the acceptance gate, so the move and the acceptance refuse with one
 * sentence. Null for any other target stage.
 */
function mergeStageEntryRefusal(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): string | null {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!project || !task) return null;
  const stages = project.parsed.frontmatter.stages;
  const reviewId = resolveStageRoles(stages, project.parsed.frontmatter.workflow).reviewId;
  if (reviewId === null || toStageId !== reviewId) return null;
  const refusal = mergeReadinessRefusal(task.parsed.frontmatter, taskKey);
  if (!refusal) return null;
  const from = stageName(stages, task.parsed.frontmatter.stage);
  const to = stageName(stages, reviewId);
  return (
    `${refusal} ${taskKey} stays at ${from}: ${to} is where acceptance happens, and the gate ` +
    `would refuse it. Call update_branch_from_base, which routes the conflict (ruling 475), or ` +
    `deliver the revision instead of moving the task.`
  );
}

/** The workflow boundary the operator would cross to move a task from its
 *  current stage to `toStageId`, or null when it isn't a declared transition. */
function operatorBoundaryFor(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): "auto" | "approval" | "human" | null {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!task || !project) return null;
  const from = task.parsed.frontmatter.stage;
  const w = project.parsed.frontmatter.workflow.find((b) => b.from === from && b.to === toStageId);
  return w ? w.boundary : null;
}

/** Ruling 655: the stages a move from `fromStageId` passes through to reach
 *  `toStageId` along declared edges, ending with `toStageId`, when every edge
 *  on the way is `auto`; null when an edge on the way is not, or the edges
 *  never reach it (a backward move, a stage off the chain). */
function automaticStepsTo(
  ctx: TaskMutationContext,
  projectSlug: string,
  fromStageId: string,
  toStageId: string,
): string[] | null {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return null;
  const workflow = project.parsed.frontmatter.workflow;
  const steps: string[] = [];
  let at = fromStageId;
  while (at !== toStageId) {
    const edge = workflow.find((w) => w.from === at);
    if (!edge || edge.boundary !== "auto" || edge.to === fromStageId || steps.includes(edge.to)) {
      return null;
    }
    steps.push(edge.to);
    at = edge.to;
  }
  return steps;
}

/**
 * R19-6 (owner ruling 2026-08-06) — `completion-for-acceptance` withheld is a
 * HARD REFUSE: no recommendation card, no audit row, an out-loud refusal.
 *
 * `gate()` collapses both withheld modes to `deny`, and they mean different
 * things, so the refusal names which one it is:
 *
 *  - **`off`** — "withheld entirely (the tool is not even offered)"
 *    (`project-file.schema.ts`). Nothing about acceptance may originate with the
 *    operator: not the act, not the recommendation, not the audit trace of one.
 *  - **`human`** — "reserved for a human to perform". Same refusal, deliberately.
 *    A recommendation card is not a neutral note: applying one IS the acceptance
 *    (ruling 22 — the Apply click is the authorization), so a card would put the
 *    operator back in the acceptance path a `human` grant just removed it from.
 *    The Claude toolkit already withholds the `accept_completion` tool for BOTH
 *    modes and the Codex plan schema drops it for both; this keeps every other
 *    route consistent with that instead of leaving a second door open.
 *  - **no operator deployed** — `gate()` denies everything (A4); the same
 *    refusal, phrased for a project that granted nothing at all.
 *
 * Returns null when acceptance may proceed (`direct` or `recommend`).
 */
function completionCapabilityRefusal(
  authority: OperatorAuthority,
  taskKey: string,
): string | null {
  if (gate(authority, "completion-for-acceptance") !== "deny") return null;
  const mode = authority.deployed
    ? (authority.policy.get("completion-for-acceptance") ?? "off")
    : "off";
  const because =
    mode === "human"
      ? "that capability is reserved for a human here"
      : "that capability is withheld from the operator here";
  return (
    `Accepting completion is not permitted for the operator here: ${because}, ` +
    `so I am not recommending it either. ${taskKey} stays where it is; ` +
    `a maintainer accepts it on the task page.`
  );
}

/**
 * Ruling 492 (review, 2026-09-26): the refusal for an operator acceptance that
 * would bury the follow-up it just offered, or null.
 *
 * The doctrine has the operator raise a post-merge proof's read as a
 * `create_task` option before it puts the task up for acceptance, and an
 * acceptance withdraws the open decision it does not answer (F32-11; the
 * operator's own answers none, ruling 471(b)). The first wording ended "Never
 * hold this task back for that proof", so an operator that opened the option
 * and called `accept_completion` in the same turn withdrew it unanswered and
 * the read task was never created. Under supervised autonomy its acceptance
 * card stood beside the option, and a person who applied the card first lost
 * the read the same way. Only prompt text stood in the way.
 *
 * Refused while the open decision, not yet decided, offers a `create_task`
 * whose new task waits on this one (`newTask.blockedBy` names it, in the
 * canonical spelling the packet schema stores). Every other open decision is
 * withdrawn by the acceptance as before, and a person's own acceptance is
 * never refused here: its dialog names the decision it withdraws.
 */
function followUpOptionRefusal(packet: TaskPacket | null, taskKey: string): string | null {
  if (!packet || packet.awaiting) return null;
  const key = canonicalDependencyRef(taskKey) ?? taskKey;
  const followUp = packet.options.find(
    (o) => o.kind === "create_task" && (o.newTask?.blockedBy ?? []).includes(key),
  )?.newTask;
  if (!followUp) return null;
  return (
    `The open decision "${packet.title}" offers to create "${followUp.title}", which waits ` +
    `on ${taskKey}. Accepting now would withdraw that decision unanswered, so the follow-up ` +
    `would never be created (ruling 492). Wait for a person to answer it; you are re-invoked ` +
    `when they do. Withdraw it with resolve_decision_packet first only if it is moot.`
  );
}

/**
 * Accept completion and move the task to Done. This is the ONE deliberate
 * exception to the human-only-Done invariant: it performs the move ONLY under
 * FULL autonomy (governed additionally by completion-for-acceptance). Under
 * supervised autonomy it never moves to Done — it opens a completion packet a
 * human resolves (the existing acceptance UX).
 */
export async function operatorAcceptCompletion(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    /** Ruling 521: refuse unless the completion packet describes the work on
     *  offer. Implied by a live operator drive; the fold sets it. */
    requirePacket?: boolean;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  // R19-6 — FIRST, before any read, card or audit row. This function's only
  // `gate()` read used to live inside the direct/recommend choice below
  // (`!== "direct"` ⇒ recommend), so a WITHHELD capability fell into the
  // recommend branch and produced exactly what the grant forbids: a real
  // `accept_completion` card plus a `task.operator.recommended_completion`
  // audit row. Live-proven this pass via the F19-26 reroute, which reaches this
  // function under `stage-transitions: recommend` alone.
  {
    const refusal = completionCapabilityRefusal(authority, input.taskKey);
    if (refusal) return { outcome: "denied", message: refusal };
  }
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${input.projectSlug} not found.`);
  const stages = project.parsed.frontmatter.stages;
  // B-WF4: the STRUCTURAL terminal stage (one resolver everywhere, which does
  // the positional-last fallback itself); `"done"` is the last-ditch only for a
  // stage-less board, so this comparison always has a string to test against.
  const doneStageId =
    resolveStageRoles(stages, project.parsed.frontmatter.workflow).terminalId ??
    "done";

  if (file.parsed.frontmatter.stage === doneStageId) {
    // U36-9 (pass 36): the terminal stage by the board's own name.
    return {
      outcome: "noop",
      message: `${input.taskKey} is already ${stageDisplayName(ctx, input.projectSlug, doneStageId)}.`,
    };
  }

  // P14-LV-02/B-WF6: ONE shared gate — `acceptanceRefusalFor` reads the same
  // helper every human writer does (graph position, required reviewers, the
  // R15-1 verdict gate, blocked packet, closed/conflicting PR, archived task).
  // The per-gate copies this function used to stack on top had already drifted
  // in wording and would drift in behavior next. Checked before BOTH branches
  // below, so a supervised operator never posts a card acceptance would refuse
  // and a full-autonomy one never closes a task off-gate.
  // F28-L1: run the live no-change probe BEFORE the shared gate so a verified-
  // empty completion (the R20-2 auto-detect of a task the deliverer never
  // explicitly claimed `noChanges`) isn't refused "no review pull request" here
  // — the same fix the human accept path carries. Cheap for a task WITH a PR
  // (fails noChangeCandidate, no GitHub call). A stale claim on a branch that
  // gained commits still fails closed at the full-autonomy write below.
  const noChange = await acceptanceNoChangeCheck(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
  );
  {
    const refusal = acceptanceRefusalFor(
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      ctx,
      noChange,
    );
    if (refusal) {
      // Ruling 163 (pass 35, F35-13 (d)): a task past the review stage whose
      // revision changed or failed after a verdict names its way out, so the
      // operator never has to discover the gap (KNC-20's packet offered profile
      // surgery and force-accept; the working remedy was the stage move).
      const remedy = reworkRemedySentence(ctx, input.projectSlug, file.parsed.frontmatter, stages);
      return { outcome: "noop", message: remedy ? `${refusal} ${remedy}` : refusal };
    }
  }
  // Ruling 492 (review): checked before BOTH branches, so neither a
  // full-autonomy acceptance nor a card a person could apply first withdraws
  // the follow-up read the operator offered. Read fresh: the no-change probe
  // above may have waited on GitHub.
  const fresh = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  {
    const refusal = followUpOptionRefusal(fresh?.parsed.packet ?? null, input.taskKey);
    if (refusal) return { outcome: "noop", message: refusal };
  }
  // Ruling 521: the operator's offer carries its completion packet. Checked
  // after every acceptance gate, so an offer the gates refuse is refused with
  // their sentence, not with a request for a summary nobody can use yet. A
  // live drive (`ctx.operatorRun`) is the operator's own call, on either
  // backend and through `transition_stage` to the terminal stage too; the fold
  // asks for it outright, since a person's move reaches it with no drive.
  if (fresh && (input.requirePacket === true || ctx.operatorRun !== undefined)) {
    const refusal = completionPacketRefusal(fresh.parsed.frontmatter, input.taskKey);
    if (refusal) return { outcome: "noop", message: refusal };
  }

  // Supervised, or `completion-for-acceptance: recommend` → recommend only: post
  // an actionable "accept completion → Done" recommendation card (symmetric with
  // the other stage-transition cards, so the review→done boundary gets the same
  // clear one-click prompt as an approval boundary's move) — never move to Done ourselves. A
  // maintainer applies it to accept completion into Done.
  //
  // R19-6: this branch is reached ONLY with a granted capability. It used to
  // read "or without the completion capability", which is what let `off`/`human`
  // file a card — the withheld modes now refuse at the top of the function and
  // never arrive here.
  if (authority.autonomy !== "full" || gate(authority, "completion-for-acceptance") !== "direct") {
    const doneName = stageDisplayName(ctx, input.projectSlug, doneStageId);
    // R19-8: a task with nothing to deliver merges nothing, so the card must not
    // promise a merge — the old single sentence told a human that applying it
    // "merges the review PR", for a task that has no PR and never will. The card
    // wording keys on the DURABLE claim (unchanged by F28-L1, which only reorders
    // the acceptance GATE so a verified-empty completion is not refused).
    const isNoChange = noChangeApplies(file.parsed.frontmatter);
    // Ruling 576: what such a task did change, named on the card.
    const corrections = isNoChange ? standingKbCorrections(db, input.projectSlug, input.taskKey) : [];
    const requiredHere = readRequiredReviewers(input.projectSlug, ctx);
    // Ruling 137: the offer binds to the revision it describes, so a later
    // delivery can withdraw it by name and the card can say which one.
    const offer: RecommendationInput = {
      kind: "accept_completion",
      toStageId: doneStageId,
      label: isNoChange
        ? `Complete ${input.taskKey} with no ${corrections.length > 0 ? "repository " : ""}changes and move it to ${doneName}`
        : `Accept completion and move ${input.taskKey} to ${doneName}`,
    };
    const offeredHeadSha =
      activeWorkRevision(file.parsed.frontmatter.workRevision)?.headSha ?? null;
    if (offeredHeadSha) offer.forHeadSha = offeredHeadSha;
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      offer,
      // Ruling 384 (F39-12): the first clause is DERIVED, never asserted. The
      // card used to open "The review is clean and the work meets the goal" on
      // every acceptance offer — live on AX-12 that sentence sat on a task with
      // `verdicts: []`, `validation: none` and no reviewer ever engaged. The
      // second clause keys on whether a PR EXISTS (`noChangeCandidate`), not on
      // the agent's `noChanges` flag, which is the R20-2 lesson: an envelope
      // that forgets the flag must not make the card promise a merge for a task
      // that has no pull request and never will (R19-8, regressed through the
      // flag).
      `${acceptanceOfferBasis(file.parsed.frontmatter, requiredHere)} ` +
        (isNoChange
          ? corrections.length > 0
            ? `Nothing goes to the repository: no branch carries work for ${input.taskKey}. Its outcome is ${kbCorrectionsOutcome(corrections)}. Accepting moves it to ${doneName} as **completed with no repository changes**; nothing is merged, and the branch state is re-checked when you confirm.`
            : `There is nothing to deliver: no branch carries work for ${input.taskKey}. Accepting moves it to ${doneName} as **completed with no changes**; nothing is merged, and the branch state is re-checked when you confirm.`
          : noChangeCandidate(file.parsed.frontmatter)
            ? `Accepting completion moves ${input.taskKey} to ${doneName}. There is no pull request on this task, so nothing is merged.`
            : `Accepting completion moves ${input.taskKey} to ${doneName} and merges the review PR when GitHub is reachable; otherwise it records the PR as accepted (merge pending).`),
    );
    recordAudit(db, {
      action: "task.operator.recommended_completion",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { toStage: doneStageId, forHeadSha: offeredHeadSha },
    });
    return {
      outcome: "recommended",
      message: `Recommended accepting completion: move ${input.taskKey} to ${doneName}.`,
    };
  }

  // FULL autonomy: the operator accepts completion and moves the task to Done.
  // A REAL PR merge is attributed to a human (mergeTaskPr requires a user
  // identity), so the operator cannot merge — it records the PR as "accepted"
  // (merge pending), never a false "merged". A human merges / reconciles later.
  // B-WF6: the Done write itself is the SHARED acceptance core
  // (`applyAcceptanceWrite`) — this inlined mutation historically mirrored the
  // human path gate by gate and shipped with a subset more than once. The core
  // also re-checks the refusal gates inside the write lock (B-WF1).
  const hasPr = !!file.parsed.frontmatter.pr;
  // R19-8: the operator closes a no-change task through the SAME live, fail-
  // closed re-check the humans do — it has no force override, so an unverifiable
  // remote (or a branch that gained commits) is a plain noop with the reason.
  // The probe was hoisted above the gate (F28-L1); reuse it here.
  if (noChange.refusal) return { outcome: "noop", message: noChange.refusal };
  // R17-1 (F17-L12): name any reviewed-revision drift on the completion record.
  const driftNote = revisionDriftNote(file.parsed.frontmatter);
  const { accepted } = await applyAcceptanceWrite(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    doneStageId,
    prState: "accepted",
    noChangeCheck: noChange,
    event: noChange.applies
      ? noChangeCompletionEvent({
          taskKey: input.taskKey,
          actor: { kind: "operator" },
          occurredAt: new Date().toISOString(),
          by: "operator",
          verification: noChange.verification,
          kbCorrections: standingKbCorrections(db, input.projectSlug, input.taskKey),
        })
      : {
          occurredAt: new Date().toISOString(),
          type: "completion",
          actor: { kind: "operator" },
          title: "Completion accepted",
          text:
            // U36-9 (pass 36): the terminal stage by the board's own name.
            (hasPr
              ? `Operator accepted completion under **full-autonomy** policy. ${input.taskKey} moved to ${stageDisplayName(ctx, input.projectSlug, doneStageId)}; the review PR is **accepted, merge pending** (a human merges it).`
              : `Operator accepted completion under **full-autonomy** policy. ${input.taskKey} moved to ${stageDisplayName(ctx, input.projectSlug, doneStageId)}.`) +
            driftNote,
          toAgent: false,
          evidence: null,
        },
  });
  // U3 (NFR16): `accepted: false` means the task was ALREADY Done when the write
  // lock was taken — a human acceptance (or a second operator turn) landed while
  // this one was running its no-change probe. The completion event, the merge
  // and the audit belong to THAT write; the row below would be a second,
  // operator-attributed record of one acceptance, and the "moved to Done"
  // message would credit this turn with a move it did not make. The early
  // already-Done return above reads the file OUTSIDE the lock, so it is a guess;
  // this is the decision. Same shape as `forceAcceptCompletion`, which has
  // followed the write rather than preceding it since U3.
  if (!accepted) {
    return {
      outcome: "noop",
      message: `${input.taskKey} is already ${stageDisplayName(ctx, input.projectSlug, doneStageId)}.`,
    };
  }
  recordAudit(db, {
    action: "task.operator.accepted_completion",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { autonomy: "full", toStage: doneStageId },
  });
  return {
    outcome: "done",
    message: `Accepted completion: ${input.taskKey} moved to ${stageDisplayName(ctx, input.projectSlug, doneStageId)}.`,
  };
}

/**
 * Ruling 521: write the completion packet, the operator's summary of the
 * finished work for the person who accepts it (`completion-packet.server.ts`).
 * It rides the acceptance grant, since it exists only to go with an
 * acceptance offer: an operator that may not offer acceptance has nothing to
 * write one for.
 */
export async function operatorWriteCompletionPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: CompletionPacketInput,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const refusal = completionCapabilityRefusal(authority, input.taskKey);
  if (refusal) return { outcome: "denied", message: refusal };
  const result = await writeCompletionPacket(db, ctx, input);
  return { outcome: result.written ? "done" : "noop", message: result.message };
}
