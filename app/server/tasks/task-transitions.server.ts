/**
 * Moving a task between stages (ruling 654): `transitionStage`, the one
 * governed move, whoever makes it, with its boundary, verdict and chain-cap
 * rules, which hands a move into the terminal stage to acceptance; and
 * `reorderTask`, a board card's new rank, moving stages through
 * `transitionStage` when it crosses one.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  archivedTaskMoveBlockedReason,
  deliveredAsFiles,
  deriveValidation,
  type Recommendation,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import { requireProjectMutable } from "~/server/auth/project-authority.server";
import { maybeReleaseDependents } from "./dependencies.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import {
  type AuditEventInput,
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
} from "~/server/audit/audit-recorder.server";
import { noChangeApplies } from "./no-change-completion.server";
import { AppError } from "~/server/errors/app-error.server";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import {
  loadProjectContext,
  type OfferWithdrawalCause,
  type OfferWithdrawalSlot,
  recordRecommendationWithdrawal,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
  withdrawAcceptanceOffers,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { maybeNoteEpicComplete } from "./epic-actions.server";
import { markTaskPacketApprovalRead } from "~/server/projections/notifications.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import {
  autoInvokeOperator,
  humanActorRef,
  nextTransitionChainDepth,
  OPERATOR_TRANSITION_CHAIN_CAP,
  projectRepoFor,
  requireAcceptCompletion,
  requireAction,
  requireAnyMember,
  reviewStageIdOf,
  stageName,
  type TaskActionContext,
  terminalStageIdOf,
  verdictStageOf,
} from "./task-action-core.server";
import { openStuckLoopPacket } from "./task-escalations.server";
import { acceptCompletion } from "./task-acceptance.server";
import { surfaceDeliveryEvent } from "./task-delivery.server";

/** Markdown blockquote, one `>` per line and no trailing space on a blank one
 *  (ruling 381 quotes a person's move reason on the transition entry). */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** Apply a declared workflow transition with its configured authority boundary. */
export async function transitionStage(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    toStageId: string;
    /** Manual board-management move from the stage dropdown: allows moving to
     *  ANY stage (not just a declared workflow boundary — the governed graph is
     *  linear, so a boundary-only dropdown would offer nothing). Reserved for
     *  admin|maintainer (the transition authority). Governed flows (packets,
     *  recommendations, operator) never set this and keep boundary-only rules. */
    manual?: boolean;
    /** Operator rework routing (R7-4): a BACKWARD move to an earlier stage on a
     *  task whose latest review is `failing`, so the operator can send a
     *  rejected task back to the developer without a human. Only honored under
     *  operator authority; validated below (must be backward + validation
     *  failing). Off-graph like `manual`, but operator-scoped and rework-gated. */
    rework?: boolean;
    /** R15-3 (owner ruling 2026-07-28): set ONLY by `applyRecommendation` after
     *  its decision-authority gate passed — the task OWNER applying an operator
     *  TRANSITION recommendation on their own task IS the authorization, so the
     *  manual/approval RBAC tier is not re-demanded from them. Never set by a
     *  route; forging it from a request would bypass the board-management tier. */
    recommendationAuthorized?: boolean;
    /**
     * Ruling 381 (F39-8): WHY a person moved it. A manual stage move is one of
     * the strongest signals a human sends — not ready, do this first, I
     * disagree with the verdict — and it used to be mute: the event read
     * "moved AX-9 from Review to Verify" and nothing else, while the
     * operator's own playbook told it to "read why (their note, decision, or
     * steer) and act on it". Live in pass 39 a send-back carried a specific
     * instruction, the field did not exist, and the operator inferred the work
     * from an older decision and dispatched the wrong thing.
     *
     * REQUIRED on a manual BACKWARD move (the one that always means
     * something), optional going forward. Rides the transition event's own
     * sentence, which is where the operator already looks.
     */
    reason?: string;
    /** Ruling 88 (F21-2): the acceptance disclosure the human acknowledged.
     *  Only consulted when this move lands on the TERMINAL stage — the server
     *  reads that as accepting the completion (see below) — and threaded
     *  straight through to `acceptCompletion`, whose docs own the three-state
     *  contract (echo / explicit `null` / omitted). */
    ack?: AcceptanceDisclosure | null;
  },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fromStageId = existing.parsed.frontmatter.stage;

  if (fromStageId === input.toStageId) {
    // Idempotent: already there — but an idempotent SUCCESS is still a success
    // and has to be earned (F32-10, pass 32; RBAC probe D1). This short-circuit
    // used to sit above every guard, so a VIEWER posting `to=<current stage>`
    // got HTTP 200, `ok: true` and a "Moved …" toast, no `project.authority
    // .denied` row, and the archived-project freeze never ran. The operator's
    // authority is gated upstream by its capability policy, exactly as on the
    // real move below; every human door pays the same gate a real move would.
    if (!ctx.operatorAuthorized) {
      if (input.recommendationAuthorized) {
        requireProjectMutable(project, "change the task stage");
      } else {
        requireProjectMutable(project, "change the task stage");
        requireAction(db, project, actor, "approve-transition", "change the task stage");
      }
    }
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  // Guard: the target must be a real stage of this project (manual moves skip
  // the boundary graph, so validate the destination explicitly).
  if (!project.stages.some((s) => s.id === input.toStageId)) {
    throw AppError.validation(
      `Unknown stage ${input.toStageId} for this project.`,
    );
  }

  // F19-8: an archived task is out of the flow, and every stage move is a claim
  // that it is back in one. Acceptance has refused archived tasks since R14-3,
  // but nothing refused the move itself — so a card the board called abandoned
  // could still be dragged between columns, and a drop on the terminal stage
  // only met the refusal AFTER the move had been animated. Refuse it here, for
  // every actor: a human drag, the keyboard menu, the operator, and the API.
  const archivedMove = archivedTaskMoveBlockedReason(
    existing.parsed.frontmatter,
    input.taskKey,
  );
  // 409, not 400: the same status the acceptance refusal has used since R14-3.
  // A refusal because of the task's STATE is a conflict, not a malformed request.
  if (archivedMove) throw AppError.conflict(archivedMove);

  const boundary = project.workflow.find(
    (w) => w.from === fromStageId && w.to === input.toStageId,
  );
  // Operator rework routing (R7-4): a backward move on a `failing` task is a
  // legitimate off-graph transition (the governed graph is forward-only). Vet it
  // here so it can't be abused for a forward jump or on a healthy task.
  const fromIndex = project.stages.findIndex((s) => s.id === fromStageId);
  const toIndex = project.stages.findIndex((s) => s.id === input.toStageId);
  // Ruling 163 (pass 35, F35-13): a revision that CHANGED after a verdict is
  // rework by definition, and the one backward move it licenses is into the
  // review stage, where the re-verdict can be given. `failing` keeps the whole
  // backward license (R7-4). Same predicate `operatorTransitionStage` reads.
  const backward = toIndex >= 0 && toIndex < fromIndex;
  const changedReworkTarget =
    input.rework === true &&
    ctx.operatorAuthorized === true &&
    backward &&
    existing.parsed.frontmatter.validation === "changed"
      ? await verdictStageOf(ctx, input.projectSlug, project, existing.parsed.frontmatter)
      : null;
  const isReworkMove =
    input.rework === true &&
    ctx.operatorAuthorized === true &&
    backward &&
    (existing.parsed.frontmatter.validation === "failing" ||
      (changedReworkTarget !== null && input.toStageId === changedReworkTarget));
  const movingBack = input.manual === true && backward && !ctx.operatorAuthorized;
  if (!boundary && !input.manual && !isReworkMove) {
    // F19-39: this string is RENDERED to a human (an `AppError` message becomes
    // the toast / route error), so the copy ban applies to it exactly as it
    // applies to a JSX string — see `app/features/copy-ban.test.ts`, which now
    // scans user-facing `AppError` messages under `app/server/**` too.
    //
    // Ruling 412 (F39-39): and it says WHY, when the answer is in this scope.
    // A BACKWARD move is refused for one of two reasons this function has
    // already computed — `validation` licenses no rework at all, or it
    // licenses exactly one target and this is not it — and the bare sentence
    // named neither. Live on ax-clone AX-18 the operator planned Review to
    // Verify to rework against a reviewer's complete blocker list, got "No
    // allowed transition from Review to Verify.", and the THROW aborted the
    // rest of its plan: "Coordination stopped". The task sat on a human. The
    // way forward existed and nothing said so: ruling 133 lets the engaged
    // deliverer run at EVERY stage, so the rework never needed the move.
    // Ruling 429(b): the `changed` arm read `changedReworkTarget`, which is only
    // computed for a move flagged as rework, so an unflagged move off a task
    // whose revision HAD changed was told "this task has neither" (AX-20, 00:47).
    const changedTarget =
      backward && existing.parsed.frontmatter.validation === "changed"
        ? (changedReworkTarget ??
          (await verdictStageOf(ctx, input.projectSlug, project, existing.parsed.frontmatter)))
        : null;
    // `verdictStageFor` answers null when the re-verdict can be given where the
    // task already stands, which is the AX-20 case exactly.
    const why = backward
      ? existing.parsed.frontmatter.validation === "changed"
        ? changedTarget
          ? ` The revision changed after the last verdict, so the only backward move is into ${stageName(project, changedTarget)} for a re-verdict.`
          : ` The revision changed after the last verdict, and its re-verdict is given at ${stageName(project, fromStageId)}, where the task already stands.`
        : existing.parsed.frontmatter.validation === "failing"
          ? ""
          : " A backward move is rework, and rework needs a failing verdict or a revision that changed after one; this task has neither."
      : "";
    const wayOut = backward
      ? " The engaged deliverer runs at every stage (ruling 133), so dispatch it here instead of moving the task."
      : "";
    throw AppError.validation(
      `No allowed transition from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.${why}${wayOut}`,
    );
  }

  const firstStageId = project.stages[0]?.id;
  const lastStageId = project.stages[project.stages.length - 1]?.id;

  // A HUMAN manually moving a task INTO the final stage IS accepting completion
  // — route it through the full acceptance contract (real merge attempt,
  // `completion` event, validation → healthy, packet/recs cleared) rather than a
  // bare `transition` that would leave a Done task with an unmerged PR and no
  // completion record. RBAC (admin|maintainer) is re-checked inside.
  if (
    !ctx.operatorAuthorized &&
    input.toStageId === lastStageId &&
    lastStageId !== undefined
  ) {
    const acceptance: Parameters<typeof acceptCompletion>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
    };
    // Ruling 88: the stage-move ceremony's echo (F19-37's `stage-move` mode)
    // rides along. The KEY is set only when this caller is a
    // disclosure-bearing door — see `acceptCompletion` for why the absence of
    // the key and an explicit `null` mean different things.
    if ("ack" in input) acceptance.ack = input.ack ?? null;
    await acceptCompletion(db, acceptance, actor, ctx);
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  if (ctx.operatorAuthorized) {
    // Operator authority is gated upstream by its capability policy; skip the
    // human RBAC. The final stage stays off this path — the operator reaches
    // Done only through the controlled accept-completion route (full autonomy),
    // never a bare stage move.
    if (input.toStageId === lastStageId) {
      throw AppError.forbidden(
        "The operator reaches Done only by accepting completion, not a bare transition.",
      );
    }
    // Ruling 151 (pass 35, F35-2): the boundary always wins. Whatever the
    // operator's `stage-transitions` grant says, a declared `approval` or
    // `human` boundary is a human's to cross; the operator may recommend it
    // (`operatorTransitionStage` files the card) and an applied card arrives
    // here with `recommendationAuthorized`, never with operator authority. ONE
    // home for every operator-authorized caller, so a `task.transition` row
    // with `by: operator` and `boundary: approval` can never be written again.
    if (
      !input.recommendationAuthorized &&
      !isReworkMove &&
      boundary &&
      boundary.boundary !== "auto"
    ) {
      throw AppError.forbidden(
        `The ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)} boundary is approved by a human on this board: the operator may recommend it, not cross it.`,
      );
    }
  } else if (input.manual) {
    // Manual stage override (board/task dropdown) — a maintainer-level action,
    // regardless of the boundary crossed (forward, backward, or off-graph).
    // R15-3: an owner-applied operator recommendation carries its own authority
    // (the Apply click) — the archived-project freeze still applies.
    if (input.recommendationAuthorized) {
      requireProjectMutable(project, "change the task stage");
    } else {
      requireAction(db, project, actor, "approve-transition", "change the task stage");
    }
    // Ruling 381 (F39-8): a manual move BACKWARD says why, or it does not
    // happen. AFTER the authority gate on purpose — someone who may not move
    // the task at all is refused for that, not told to write a reason they
    // could never use. No exemption: the operator's rework route never reaches
    // this arm (it carries operator authority and its verdict), and an applied
    // recommendation arrives with the card's own words as the reason. A forward
    // move is ordinary progress and asks nothing.
    if (movingBack && !(input.reason ?? "").trim()) {
      throw AppError.validation(
        `Moving ${input.taskKey} back from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)} needs a reason: the operator reads it to decide what to do next, and without one it has to guess. Say what should change before this comes back.`,
      );
    }
  } else if (boundary!.boundary === "auto") {
    // An auto boundary crossed by a human (the UI always sends manual:true, but
    // a server-side caller that omits `manual` — e.g. applyRecommendation on a
    // declared edge — lands here) — the loosest gate: any member. The
    // archived-project freeze (R6-3) is NOT free on this arm the way it is on
    // the requireAction arms, so assert it here at the chokepoint: without it an
    // auto-boundary move writes stage into a read-only archived project.
    requireProjectMutable(project, "move this task");
    requireAnyMember(db, project, actor, "move this task");
  } else if (boundary!.boundary === "approval") {
    if (input.recommendationAuthorized) {
      // R15-3: same owner-applied recommendation authority for a declared
      // approval boundary.
      requireProjectMutable(project, "approve stage transitions");
    } else {
      requireAction(db, project, actor, "approve-transition", "approve stage transitions");
    }
  } else {
    // human boundary (review→done locked in V1): acceptance authority, with the
    // task-owner exception (R6-2) — the owner may accept its own completion.
    requireAcceptCompletion(
      db,
      project,
      actor,
      existing.parsed.frontmatter.ownerUserId,
      "accept completion into Done",
    );
  }

  // One normalization for the blockquote and the audit row. Horizontal runs
  // collapse; LINE breaks survive, because a person writing two sentences about
  // what has to change before the task comes back meant the break, and the
  // quote below carries it. Three-or-more blank lines fold to one.
  const movedReason = (input.reason ?? "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "transition",
    actor: ctx.operatorAuthorized ? { kind: "operator" } : humanActorRef(db, actor),
    title: null,
    text:
      (ctx.operatorAuthorized
        ? `**Transition:** operator moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`
        : `**Transition:** moved ${input.taskKey} from ${stageName(project, fromStageId)} to ${stageName(project, input.toStageId)}.`) +
      // Ruling 381: on the event itself, not in a separate note, so the
      // operator reads the move and the reason as one fact — and quoted, the
      // way a packet decision quotes the resolver's words. Appending it as a
      // bare clause ran the person's own sentence on after a full stop
      // ("…to In Progress. the retry path is still unhandled"), which reads
      // as a typo rather than as an instruction. Ruling 519: the operator's
      // own move quotes its reason the same way, because the move into Review
      // it now makes by itself used to reach a person as a card that carried
      // that reason.
      (movedReason ? `\n\n${quoteLines(movedReason)}` : ""),
    toAgent: false,
    evidence: null,
  };

  // U3 (NFR16) — the idempotency check above is the FAST path, not the
  // decision. It reads the file OUTSIDE the lock, so two submits of the same
  // move (a double-clicked dropdown, a retried in-flight POST, the operator
  // racing a human) both saw `impl` and both wrote: two "**Transition:**"
  // entries in the canonical task.md and two `task.transition` audit rows for
  // ONE human act — against NFR16 by name and against NFR18's "reconstruct who
  // initiated a consequential action". Nothing in SQLite backstops it (there is
  // no unique constraint on transitions).
  //
  // So the check re-runs INSIDE the file lock — the shape `recordDeliveredNextStep`
  // has used all along (see its docblock: "the suppression re-runs INSIDE the
  // file lock, so a retry … can never leave two cards"). `moved` carries the
  // in-lock verdict back out so the event, the audit row, the notification
  // read and the operator re-trigger all follow the ONE write that happened.
  // Ruling 137: a move AWAY from the acceptance boundary (the review stage the
  // workflow graph names, the same source `isAtAcceptanceBoundary` reads)
  // withdraws the standing acceptance offers on the record. A move INTO the
  // terminal stage is the acceptance itself and consumes every card.
  const boundaryStageId = reviewStageIdOf(project);
  const moveCause: OfferWithdrawalCause | null =
    boundaryStageId !== null &&
    fromStageId === boundaryStageId &&
    input.toStageId !== terminalStageIdOf(project)
      ? {
          kind: "stage_move",
          toStageId: input.toStageId,
          toStageName: stageName(project, input.toStageId),
        }
      : null;
  const moveWithdrawal: OfferWithdrawalSlot = { offers: null };
  let moved = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    const current = parsed.frontmatter.stage;
    // Already there: the racing submit won. Write nothing — same outcome, one
    // event, one audit row.
    if (current === input.toStageId) return;
    // Moved somewhere ELSE while this move was in flight: every guard above
    // (the boundary lookup, the rework vetting, the RBAC tier) was evaluated
    // against `fromStageId`, and the timeline entry already says "from
    // <fromStageId>". Writing it now would record a transition that never
    // happened, so refuse rather than land a sentence that is not true.
    if (current !== fromStageId) {
      throw AppError.conflict(
        `${input.taskKey} moved to ${stageName(project, current)} while this change was being ` +
          `applied. It is no longer at ${stageName(project, fromStageId)}. Refresh the task and try again.`,
      );
    }
    moved = true;
    parsed.frontmatter.stage = input.toStageId;
    // Durable previous-stage fact (dynamic-dispatch rework 2026-08-29): the
    // operator's agent choice weighs where the task CAME from — a task back in
    // the work stage from Review is rework, not a fresh build — and before this
    // field the fact evaporated with the one-hop transition trigger.
    parsed.frontmatter.previousStageId = fromStageId;
    // V18: any real move re-litigates a recorded deliberate hold — and a stale
    // marker for a DIFFERENT stage must not ambush the task if it ever returns
    // to the held stage later.
    parsed.frontmatter.heldAtStage = null;
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
    // Leaving the first (triage) stage means the task was accepted into the
    // workflow, so the triage-time `input_required` gate is cleared — otherwise
    // a task with agents actively working would keep showing "input required"
    // on the board forever. `blocked` / `inconsistency_risk_detected` are real
    // states set elsewhere and must survive a transition, so only clear the
    // triage default.
    if (
      fromStageId === firstStageId &&
      input.toStageId !== firstStageId &&
      parsed.frontmatter.readiness === "input_required"
    ) {
      parsed.frontmatter.readiness = "ready";
    }
    // F10-15/F10-32: validation is now DERIVED from the current work revision +
    // per-reviewer verdicts, so review entry no longer laundates it. A bare
    // re-entry can NOT clear a standing `failing` — that only happens when a NEW
    // work revision is delivered (which makes prior verdicts stale). Just
    // recompute the derived cache so the board pill is fresh on entry.
    if (input.toStageId === reviewStageIdOf(project)) {
      parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
    }
    // A stage move makes any pending transition recommendation stale — drop it
    // so a Done task never shows a "move to <stage>" card. It is handed to the
    // withdrawal as the caller's own filter, so ONE write removes both sets and
    // the note counts the survivors it really leaves (pass 34 review: counting
    // before this filter overstated them).
    const staleTransition = (r: Recommendation) => r.kind === "transition";
    // Ruling 387 (F39-14): the MOVE goes on first, and the withdrawal note it
    // causes lands above it. `event` was built before the lock; the note is
    // stamped inside `withdrawAcceptanceOffers`, so it is always the newer of
    // the two. Unshifting the move last put the OLDER event on top, which is
    // how viberr's own `timeline_not_strictly_newest_first` diagnostic came to
    // fire on AX-9 over a one-millisecond pair — and it read backwards besides,
    // showing a consequence below its cause in a newest-first list.
    parsed.timeline.unshift(event);
    if (moveCause) {
      moveWithdrawal.offers = withdrawAcceptanceOffers(
        parsed,
        terminalStageIdOf(project),
        moveCause,
        event.actor,
        staleTransition,
      );
    } else {
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter((r) => !staleTransition(r));
    }
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // U3: the racing submit already wrote this exact move. Everything below is a
  // consequence of THE write — the audit row, the approval-notification read,
  // the operator hand-off, the no-PR review notice — so a second pass through
  // them would duplicate precisely what the in-lock check just prevented.
  if (!moved) return summaryOrThrow(db, input.projectSlug, input.taskKey);

  const transitionDetails: NonNullable<AuditEventInput["details"]> = {
    from: fromStageId,
    to: input.toStageId,
    boundary: boundary?.boundary ?? "manual",
  };
  if (input.manual) transitionDetails.manual = true;
  if (movedReason) transitionDetails.reason = movedReason;
  if (ctx.operatorAuthorized) transitionDetails.by = "operator";
  recordAudit(db, {
    action: "task.transition",
    actor: ctx.operatorAuthorized
      ? OPERATOR_AUDIT_ACTOR
      : { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: transitionDetails,
  });
  if (moveCause && moveWithdrawal.offers) {
    recordRecommendationWithdrawal(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      withdrawal: moveWithdrawal.offers,
      cause: moveCause,
      actor: ctx.operatorAuthorized
        ? OPERATOR_AUDIT_ACTOR
        : { userId: actor.userId, label: actor.label },
    });
  }

  // Approving a requested transition resolves its approval notifications.
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);

  // A stage transition is a coordination trigger: ANY move of a task onto a new
  // (non-Done) stage hands off to the operator so it picks the task up AT THAT
  // STAGE and does the stage-right thing (ADR-002 — one operator per active
  // task). This includes the operator's OWN transitions: a single operator run
  // may advance only one auto boundary (e.g. Triage → Ready) and stop, which
  // used to strand the task at a pre-work stage with `waiting: human` and no
  // packet (P11-70). `runOperator` holds a single-flight process lease per task
  // and QUEUES a trigger that arrives mid-run (newest wins), firing it when the
  // current drive ends; the chain normally terminates once the operator reaches
  // a stage where it deploys a specialist and waits (a specialist run is not a
  // transition) or opens a packet. That termination is model behavior, not
  // structure — so consecutive OPERATOR-authored transitions also thread a
  // depth (`transitionDepth`, the reactDepth idiom) and a hard cap turns a
  // runaway transition loop into a stuck-loop packet instead of unbounded LLM
  // spend. Any human or agent-reply trigger restarts the chain at 0.
  // Fire-and-forget — it never blocks or fails the transition, and it is a
  // no-op when no operator is deployed.
  if (input.toStageId !== lastStageId) {
    const chainDepth = nextTransitionChainDepth(ctx);
    if (chainDepth >= OPERATOR_TRANSITION_CHAIN_CAP) {
      logger.warn(
        "operator transition chain hit its depth cap; pausing auto-coordination",
        { taskKey: input.taskKey, toStageId: input.toStageId, depth: chainDepth },
      );
      // Same escalation the react loop uses at ITS cap: a blocked packet a
      // human resolves (best-effort — no-ops if one is already open). The
      // resolution itself is the human action that restarts coordination.
      await openStuckLoopPacket(db, { ...ctx, operatorAuthorized: true }, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        agentHandle: "operator",
        reason:
          `The operator made ${OPERATOR_TRANSITION_CHAIN_CAP} consecutive stage ` +
          `transitions with no agent run or human action in between, which is a coordination loop.`,
      });
    } else if (ctx.operatorRun) {
      // Ruling 152(a) (pass 35, G35-5): this move was made by a LIVE operator
      // run (`opCtx` carries the run onto the ctx), whose turn continues on
      // its own: the tool reply names the next boundary and the prompt says to
      // walk consecutive `auto` boundaries in one turn. Queuing a fresh
      // operator turn here paid ~$0.30 per stage for nothing but the next
      // transition (KNC-1: eight operator runs for a one-file ADR). A chain the
      // model abandons is the stranded-stage backstop's job. Human and system
      // moves still re-trigger below. The stamp lets the settle-time backstop
      // judge the stage this drive left the task at (`maybeResumeStrandedOperator`).
      ctx.operatorRun.movedToStageId = input.toStageId;
      // Ruling 357: a move after this drive's own delivery is the drive acting
      // on it; the lease release then owes no `delivered` follow-up.
      if (ctx.operatorRun.deliveredHeadMoved) ctx.operatorRun.actedAfterDelivery = true;
    } else {
      const byHuman = ctx.operatorAuthorized
        ? null
        : (humanActorRef(db, actor).nameHint ?? actor.label);
      const transition = {
        fromName: stageName(project, fromStageId),
        toName: stageName(project, input.toStageId),
        // Operator-authored moves need no explanation; a HUMAN's move tells
        // the operator who to honor — or to ask — by name (NEW-4 tags).
        byHuman,
      };
      void (async () => {
        // Owner decision Q35-15 (pass 35, the FOLD): a person's move onto the
        // acceptance boundary (an applied "Move the task to Merge" card, a
        // board drop) files the acceptance recommendation NOW, under the
        // deployed operator's own policy, instead of paying an operator turn
        // whose only work was that card. When the card was filed the turn is
        // not needed; when the gates refuse it (no verdict yet), the operator
        // is re-invoked as before and reads the refusal in its snapshot. An
        // operator-authorized move without a live run (a direct call) folds in
        // `operatorTransitionStage` itself, never here.
        if (!ctx.operatorAuthorized) {
          try {
            const { foldAcceptanceRecommendation } = await import("./operator-moves.server");
            const { resolveOperatorAuthority } = await import("./operator-authority.server");
            const authority = resolveOperatorAuthority(ctx, input.projectSlug);
            const folded = await foldAcceptanceRecommendation(
              db,
              ctx,
              { projectSlug: input.projectSlug, taskKey: input.taskKey },
              authority,
            );
            if (folded?.recommended) return;
          } catch (error) {
            logger.warn("acceptance fold after a transition failed; re-invoking the operator", {
              taskKey: input.taskKey,
              err: toError(error),
            });
          }
        }
        await autoInvokeOperator(
          db,
          ctx,
          input.projectSlug,
          input.taskKey,
          "transition",
          { transitionDepth: chainDepth, transition },
        );
      })();
    }
  }

  // Ruling 503: a move into the terminal stage can be the last open task of
  // its epic. Fire-and-forget — a task in no epic costs one file read.
  maybeNoteEpicComplete(db, ctx, input.projectSlug, input.taskKey);
  // Ruling 131(e): a move into (or out of) the terminal stage can satisfy a
  // dependent's wait. Same fire-and-forget posture; the engine converges.
  maybeReleaseDependents(db, ctx, input.projectSlug);

  // R15-2 (owner ruling 2026-07-28): delivery (push + review PR) is an OPERATOR
  // decision, never a stage side-effect — the transitionStage auto-delivery hook
  // is deleted. Safety net (a): entering the structural review-ROLE stage with
  // no live PR is announced with a typed `github` event so the gap is NEVER
  // silent (F15-17: a literal "Review" stage that delivered nothing said
  // nothing). The operator's `deliver_for_review` tool, an applied `delivery`
  // recommendation, or the task page's manual "Deliver branch & open PR" button
  // performs the actual delivery.
  const reviewStageId = reviewStageIdOf(project);
  if (reviewStageId && input.toStageId === reviewStageId) {
    const moved = existing.parsed.frontmatter;
    const pr = moved.pr;
    const livePr = pr && pr.state !== "closed" && pr.state !== "merged";
    // Ruling 546: a task delivered as the files its deliverer saved on it
    // (rulings 388, 531) has nothing a pull request would carry, and the note
    // told the person the operator was deciding a push and a PR for it.
    // Ruling 576: nor does a task a reviewer verified has nothing to deliver
    // (R19-8); live on AWSC-11 the note followed that verification by 30s.
    // Ruling 667: nor does any task of a project with no repository.
    if (
      !livePr &&
      !deliveredAsFiles(moved) &&
      !noChangeApplies(moved) &&
      projectRepoFor(ctx, input.projectSlug) !== null
    ) {
      void surfaceDeliveryEvent(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        "Review reached with no PR yet",
        `${input.taskKey} entered ${stageName(project, input.toStageId)} with no live review pull request. ` +
          `The operator decides delivery (push + review PR); a maintainer or the task owner can also ` +
          `deliver from the task page's GitHub panel.`,
      );
    }
  }

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/** Reorder one card by midpoint rank, using the governed transition path if it moves stages. */
export async function reorderTask(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    toStageId: string;
    /** Insert immediately before this task; null/absent → append to the end. */
    beforeKey?: string | null;
    /** Ruling 88 (F21-2): the acceptance disclosure the human acknowledged.
     *  A drop (or a keyboard move) onto the FINAL column is an acceptance — the
     *  board's own ceremony has fronted it since ruling 53/R18-7 — so the echo
     *  rides through to `transitionStage`, which consults it on the terminal
     *  branch only. A same-stage rank write never reaches a transition at all,
     *  and an ordinary column move is ack-free. Three states, documented on
     *  `assertAcceptanceDisclosure`. */
    ack?: AcceptanceDisclosure | null;
    /** Ruling 381 (F39-8): why a person dragged it BACK; forwarded verbatim to
     *  the manual transition, which requires one for a backward move. */
    reason?: string;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{
  task: TaskSummary;
  movedStage: boolean;
  toName: string;
  acceptedIntoDone: boolean;
}> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "reorder-board", "reorder the board");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // F19-38: refused for the WHOLE reorder, not only the cross-stage half. An
  // archived card is off the board's default view entirely, so there is no
  // honest rank for it either — and the guard must not depend on
  // `transitionStage` being reached, which a same-stage rank write never does.
  // F19-8: same refusal as the keyboard menu, so the pointer drag route can't
  // slip an archived card past a guard the menu enforces.
  const archivedDrag = archivedTaskMoveBlockedReason(
    existing.parsed.frontmatter,
    input.taskKey,
  );
  if (archivedDrag) throw AppError.conflict(archivedDrag);
  if (!project.stages.some((s) => s.id === input.toStageId)) {
    throw AppError.validation(`Unknown stage ${input.toStageId} for this project.`);
  }

  const movedStage = existing.parsed.frontmatter.stage !== input.toStageId;
  // A stage change goes through the governed manual transition (comment +
  // operator hand-off + reproject); the rank is set afterwards.
  if (movedStage) {
    const move: Parameters<typeof transitionStage>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      toStageId: input.toStageId,
      manual: true,
    };
    // Ruling 88: see the `ack` field above — the key is set only when the caller
    // is a disclosure-bearing door, so an in-process reorder stays omitted.
    if ("ack" in input) move.ack = input.ack ?? null;
    // Ruling 381: a backward DRAG is the same act as the stage menu's move, so
    // it answers the same question rather than being refused with nowhere to
    // type the answer.
    if (input.reason) move.reason = input.reason;
    await transitionStage(db, move, actor, ctx);
  }

  // Midpoint of the requested gap in the target column's CURRENT order.
  const { listProjectTasks, effectiveBoardRank, compareBoardOrder, taskKeyNumber, BOARD_RANK_BASE } =
    await import("~/server/projections/board-query.server");
  const inStage = listProjectTasks(db, input.projectSlug)
    .filter((t) => t.stage === input.toStageId && t.key !== input.taskKey)
    .sort(compareBoardOrder);
  const beforeKey = input.beforeKey ?? null;
  const idx = beforeKey == null ? -1 : inStage.findIndex((t) => t.key === beforeKey);

  let newRank: number;
  if (inStage.length === 0) {
    newRank = taskKeyNumber(input.taskKey) * BOARD_RANK_BASE;
  } else if (idx < 0) {
    // append to the end (beforeKey null or no longer present)
    newRank = effectiveBoardRank(inStage[inStage.length - 1]!) + BOARD_RANK_BASE;
  } else if (idx === 0) {
    newRank = effectiveBoardRank(inStage[0]!) - BOARD_RANK_BASE;
  } else {
    newRank =
      (effectiveBoardRank(inStage[idx - 1]!) + effectiveBoardRank(inStage[idx]!)) / 2;
  }

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.boardRank = newRank;
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  const toName = stageName(project, input.toStageId);
  // Dragging INTO the terminal stage runs the full acceptance contract (merge
  // attempt + completion event) via the H4 redirect — surface that honestly so
  // the toast isn't a bare "Moved" for what is actually an acceptance + merge.
  const acceptedIntoDone =
    movedStage && isTerminalStage(input.toStageId, project.stages);
  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    movedStage,
    toName,
    acceptedIntoDone,
  };
}
