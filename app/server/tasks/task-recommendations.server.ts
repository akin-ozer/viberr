/**
 * A person deciding an operator recommendation (ruling 13(a)):
 * `applyRecommendation` carries it out (a stage move, a delivery or an
 * acceptance) and `dismissRecommendation` declines it.
 */

import type { DatabaseSync } from "node:sqlite";
import { type RbacAction, roleCan } from "~/shared/rbac";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { DECISION_LEAD, RECOMMENDATION_DECLINED_TITLE } from "~/shared/timeline-leads";
import {
  loadProjectContext,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { markTaskPacketApprovalRead } from "~/server/projections/notifications.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { userDisplayName } from "./user-display-name.server";
import {
  humanActorRef,
  OPERATOR_TASK_ACTOR,
  ownerException,
  requireDecisionAuthority,
  type TaskActionContext,
} from "./task-action-core.server";
import { acceptCompletion } from "./task-acceptance.server";
import { type DeliveryOutcome, performDelivery } from "./task-delivery.server";
import { transitionStage } from "./task-transitions.server";

/** What applying a card hands back to the route. */
export interface AppliedRecommendation {
  task: TaskSummary;
  label: string;
  /** Ruling 229: set when the card was a `delivery`, so the route's toast
   *  can say what moved. */
  delivery?: DeliveryOutcome;
}

export async function applyRecommendation(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    recId: string;
    /** Ruling 97 (F21-2): the acceptance disclosure the human acknowledged.
     *  Consulted ONLY when the card being applied REACHES acceptance — an
     *  `accept_completion` card, or a `transition` card whose target is the
     *  terminal stage (F19-3: one Apply click merged an unreviewed head into
     *  main, whatever the card's `kind` said). Every other card assigns, runs or
     *  moves within the flow and carries no acceptance to disclose, so it is
     *  applied ack-free. Three states, documented on
     *  `assertAcceptanceDisclosure`. The recommendation id is NOT a substitute:
     *  it identifies the card, not what the human was shown merging. */
    ack?: AcceptanceDisclosure | null;
  },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<AppliedRecommendation> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Applying an operator recommendation resolves a pending governance decision
  // (symmetric with dismissRecommendation/resolvePacket): maintainer+ OR the
  // task's own human owner (R14-2). The inner governed mutations still enforce
  // their own finer-grained caps — an owner applying "assign a specialist" is
  // still stopped by run-agents.
  //
  // F20 (no existence probe): the task read has to come FIRST now, because the
  // owner is a fact of the task file. Authorization still precedes every
  // response that reveals anything — an unauthorized caller gets the same 403
  // whether or not the task/recommendation exists, because the guard below
  // throws before the notFound/conflict lines.
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  requireDecisionAuthority(
    db,
    project,
    actor,
    existing?.parsed.frontmatter.ownerUserId,
    "apply recommendations",
  );
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const rec = existing.parsed.frontmatter.recommendations.find(
    (r) => r.id === input.recId,
  );
  // F18-7: a missing id means the card is GONE — resolved, dismissed, or
  // superseded by a newer operator run — not specifically "already resolved"
  // (which mis-describes an unknown/stale id). Hedge to what is actually known.
  if (!rec)
    throw AppError.conflict(
      "That recommendation is no longer available. It may have been resolved, dismissed, or replaced by a newer one. Refresh to see the current recommendations.",
    );

  // R15-3 (owner ruling 2026-07-28): the task OWNER may apply ANY operator
  // recommendation on their own task — the Apply click IS the authorization
  // (FR37 spirit). Live-proven dead end (F15-12): a contributor-owner was shown
  // Apply on a transition card and then 403'd by the inner approve-transition /
  // run-agents tier. When the owner lacks the inner tier, the execution runs as
  // coordination machinery under operator authority — the same seam
  // `resolvePacket`'s retry_other_backend uses ("the packet is the human
  // decision; the execution is coordination machinery").
  const actorRole = project.memberRoles.get(actor.userId) ?? null;
  const ownerApplied = ownerException(
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
  );
  const asCoordination = (needed: RbacAction) =>
    ownerApplied && !roleCan(actorRole, needed);
  const runActor = asCoordination("run-agents") ? OPERATOR_TASK_ACTOR : actor;
  const runCtx: TaskMutationContext = asCoordination("run-agents")
    ? { ...ctx, operatorAuthorized: true }
    : ctx;

  // Execute the recommended action through the governed mutation (RBAC inside).
  let delivery: DeliveryOutcome | undefined;
  if (rec.kind === "run_agent" && rec.profileId) {
    // The operator recommended dispatching an agent (it can't under `recommend`
    // autonomy) — applying it runs exactly what the manual run-agent control
    // would: engage-if-needed with capability-derived posture, the operator's
    // recommended prompt as the directive, and the dispatch-completion contract
    // reporting back to the applying human + the operator.
    const { startAgentRun } = await import("./specialist-run.server");
    const dispatch: Parameters<typeof startAgentRun>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: rec.profileId,
      // Display name, not `actor.label` (the email) — the run's report tags
      // the applying human, and only a display name notifies (R21-9).
      triggeredByName: userDisplayName(db, actor.userId),
      triggeredByUserId: actor.userId,
    };
    if (rec.prompt?.trim()) dispatch.directive = rec.prompt.trim();
    // Hunt 2026-08-29: the operator's explicit posture hint rides the card so
    // Apply installs exactly what was recommended — re-deriving here could
    // flip a "supporting" recommendation into a delivery hand-off.
    if (rec.delivers !== undefined) dispatch.delivers = rec.delivers;
    // Ruling 93: a recommended completeness question is stamped on Apply too.
    if (rec.completeness) dispatch.completeness = true;
    // Ruling 124: and a run recommended not to judge runs without a verdict.
    if (rec.noVerdict) dispatch.withholdVerdict = true;
    await startAgentRun(db, dispatch, runActor, runCtx);
  } else if (rec.kind === "transition" && rec.toStageId) {
    // Owner ruling 2026-07-26: the operator may recommend a move OFF the
    // declared graph (live case: Review → In Progress to re-engage the
    // deliverer after a rejected PR), and the human clicking Apply IS the
    // authorization — the same decision a manual stage-menu move expresses.
    // A declared boundary keeps its boundary semantics; an undeclared edge
    // applies as a manual move. R15-3 widens the pass-14 stance: the task
    // OWNER's Apply click authorizes the recommended move too
    // (`recommendationAuthorized` relaxes only the manual/approval RBAC tier,
    // only on this recommendation path — never a bare stage-menu move).
    const declaredEdge = project.workflow.some(
      (w) =>
        w.from === existing.parsed.frontmatter.stage && w.to === rec.toStageId,
    );
    const move: Parameters<typeof transitionStage>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      toStageId: rec.toStageId,
    };
    if (!declaredEdge) move.manual = true;
    if (asCoordination("approve-transition")) move.recommendationAuthorized = true;
    // Ruling 47: a backward move says why. On this path the card IS the why —
    // the operator wrote it — so its own words ride onto the transition entry
    // instead of the human being asked to retype them into a dialog they never
    // see. `detail` is the operator's reasoning; `label` is the button text and
    // is never empty, so the move can never be refused for a reason the Apply
    // click has no way to supply.
    move.reason = (rec.detail ?? "").trim() || rec.label;
    // Ruling 97: a recommended move onto the TERMINAL stage is an acceptance
    // (`transitionStage` routes it to `acceptCompletion` — the real merge), and
    // that is exactly the F19-3 card whose Apply the ceremony now fronts. The
    // key rides through for every recommended move; `transitionStage` consults
    // it on the terminal branch only, so an ordinary re-stage stays ack-free.
    if ("ack" in input) move.ack = input.ack ?? null;
    await transitionStage(db, move, actor, ctx);
  } else if (rec.kind === "delivery") {
    // R15-2: the operator recommended DELIVERY (push + review PR) — applying it
    // performs the delivery under the human's authorization. A failed delivery
    // keeps the card pending (the refusal names why; events are on the
    // timeline), so the human can fix the cause and apply again.
    const outcome = await performDelivery(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      actor,
    );
    if (outcome.status !== "delivered") {
      throw AppError.conflict(`Delivery did not complete: ${outcome.message}`);
    }
    // Ruling 229: the person who applied the card is told what moved, through
    // the same toast the task page's own control uses.
    delivery = outcome;
  } else if (rec.kind === "accept_completion") {
    // The operator's "accept completion → Done" recommendation. Applying it is
    // the human acceptance of the review→done boundary: same semantics as
    // resolving an acceptance packet (Done, PR merged, completion event) — and,
    // per ruling 97, the same demand for the ceremony's echo.
    const acceptance: Parameters<typeof acceptCompletion>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
    };
    if ("ack" in input) acceptance.ack = input.ack ?? null;
    await acceptCompletion(db, acceptance, actor, ctx);
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

  const applied: AppliedRecommendation = {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    label: rec.label,
  };
  if (delivery) applied.delivery = delivery;
  return applied;
}

/**
 * The audit action a dismissal records. Exported so the snapshot's
 * "already declined" reader (operator-snapshot.server.ts) cannot drift from the
 * writer here.
 */
export const RECOMMENDATION_DISMISSED_AUDIT_ACTION = "task.recommendation.dismissed";

/**
 * Dismiss a pending operator recommendation without acting on it (admin|
 * maintainer, or the task's own owner per R14-2 — symmetric with resolvePacket).
 * Idempotent — a missing id is a no-op.
 */
export async function dismissRecommendation(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; recId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; label: string | null }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  // Dismissing an operator recommendation resolves a pending governance decision
  // (the non-packet equivalent of resolving a packet) — maintainer+ OR the
  // task's own owner (R14-2), symmetric with resolvePacket/applyRecommendation.
  // Dismissal is the reason the decisions inbox can honestly count ANY open
  // decision on an owned task as the owner's: whatever the recommendation is,
  // the owner can always decide it away.
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  requireDecisionAuthority(
    db,
    project,
    actor,
    existing?.parsed.frontmatter.ownerUserId,
    "dismiss recommendations",
  );
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
    // [1] The human's "no" goes on the CANONICAL record, not only into the
    // 90-day audit table. Dismissal used to write nothing here, so task.md read
    // "**Recommendation:** move to Review" (addRecommendation posts that) and
    // then the card silently vanished — the one answer a supervisor gives that
    // left no trace for the next agent, a later reviewer, or anyone reading the
    // task after the audit window closes. INTENT.md justifies that 90-day bound
    // on the premise that task-scoped history survives in task.md; this path was
    // the counter-example.
    //
    // Type `transition` — no new TIMELINE_EVENT_TYPES entry. It is the type
    // resolvePacket already stamps on EVERY human decision that routes a task,
    // including the ones that move no stage (edit_goal, retry_other_backend,
    // archive_task, redirect). A dismissal is the non-packet twin of resolving a
    // packet, so it speaks the same `**Decision:** …` vocabulary and renders in
    // the same "a human decided" row. The `title` distinguishes it, exactly as
    // CONTEXT_CONFLICT_TITLE distinguishes a KB-vs-repo `quality` flag (R19-2).
    //
    // The text names the RECOMMENDATION, not "a recommendation" — and it is
    // self-describing without the title, because the operator's own
    // `recentTimeline` window drops titles.
    //
    // DELIBERATELY NOT BUILT: a free-text human REASON on the dismissal. Whether
    // a supervisor must (or may) say why is a product choice the owner has not
    // made; the trace itself is unambiguous and ships without it.
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "transition",
      actor: humanActorRef(db, actor),
      title: RECOMMENDATION_DECLINED_TITLE,
      text:
        `${DECISION_LEAD} "${rec.label}" was declined. The operator's recommendation was not applied; ` +
        `do not re-propose it unless something material about the task changes.`,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // Resolving the recommendation (either way) clears its "Waiting on you" bell.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  recordAudit(db, {
    action: RECOMMENDATION_DISMISSED_AUDIT_ACTION,
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kind: rec.kind, label: rec.label },
  });

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), label: rec.label };
}
