/**
 * The packets a task opens on itself when its work stops moving (ruling 13(a)):
 * the stuck-loop packet a react or transition chain ends with, the
 * review-deadlock escalation and its retry, and the withdrawal of a stuck or
 * delivery packet that a later event has superseded.
 */

import { taskClosure } from "./task-closure.server";
import { endSentence } from "~/shared/text/sentence";
import type { DatabaseSync } from "node:sqlite";
import { consecutiveRequestChanges } from "~/schemas/task-file.schema";
import type { OperatorOpenPacketInput, OperatorPacketOptionInput } from "./operator-packets.server";
import {
  agentNamesOf,
  buildReviewDeadlockPacket,
  delivererNameOf,
  reviewDeadlockOf,
  reviewDeadlockTitle,
  type ReviewDeadlock,
} from "./review-deadlock.server";
import {
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  appendPolicyNote,
  loadProjectContext,
  notifyTaskWatchers,
  POLICY_ENGINE_NOTIFY_FROM,
  reprojectTask,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  type ClosedDecision,
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import { logger } from "~/server/logging/logger.server";
import { errorMessage, toError } from "~/shared/errors";
import type { TaskActionContext } from "./task-action-core.server";

/**
 * What a stuck-loop escalation actually did. T13 (pass 31): callers need this
 * because `operatorOpenPacket` NOTIFIES the task's watchers itself — an
 * actionable "Blocked, decision needed: …" row. A caller that also sends its own
 * plain "run failed: …" notification therefore produces two rows about one
 * event, differing only in wording. Only `"opened"` means that packet
 * notification went out; the other two arms leave the caller responsible for
 * telling anyone at all.
 */
type StuckLoopEscalation =
  /** A packet was written and its watcher notification sent. `notifiedUserIds`
   *  lists who that notification actually REACHED (routing prefs applied per
   *  recipient) — a watcher whose prefs dropped the packet row is NOT in it,
   *  and the T13 caller owes them the quality fallback. */
  | { status: "opened"; notifiedUserIds: string[] }
  /** A packet was ALREADY open on this task, so nothing was written and nobody
   *  was notified for THIS event (the earlier packet had its own notification,
   *  which may have been about something else entirely). */
  | { status: "already_open" }
  /** The packet was refused or the write threw; a timeline note was left
   *  instead, and no notification was sent. */
  | { status: "failed" };

/**
 * The general recovery options every stall packet can offer: re-prompt the
 * specialist with a corrected directive (recommended when nothing better is
 * known), or send it back for another attempt. `openStuckLoopPacket` appends
 * the hold. Ruling 119's depth-capped packet keeps them, unrecommended, beside
 * the delivery it recommends.
 */
export const STOCK_STALL_OPTIONS: readonly OperatorPacketOptionInput[] = [
  {
    kind: "redirect",
    title: "Redirect with sharper guidance",
    detail: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
    recommended: true,
  },
  {
    kind: "request_edit",
    title: "Send back for another attempt",
    detail: "Ask the same specialist to try again from its last report.",
  },
];

export async function openStuckLoopPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    agentHandle: string;
    reason: string;
    /** Ruling 156(a) (pass 34): the person's own move, written after the
     *  reason ("Arda can wait until the window reopens (…), or connect a
     *  different Claude account or an API key on Profile → Agent accounts."). */
    remedy?: string;
    /** Ruling 156(a): a classified backend failure supplies its own option set
     *  from `describeRunFailure` (retry on the other backend when the owner has
     *  it, else "send the agent back to continue"; redirect present and NOT
     *  recommended, the agent did nothing wrong). Absent, the stock set
     *  (redirect recommended, request_edit, hold) stands: the other two callers
     *  escalate coordination loops, not failed runs, and their packets must
     *  stay resolvable. The hold option is appended to either set. */
    options?: OperatorPacketOptionInput[];
    /** R20-3 (F20-4): the provider's own redacted sentence, rendered as its own
     *  "Provider said" observation beside the Signal so the human reads the
     *  actual cause on the packet, not only in the timeline. */
    providerText?: string;
    /** Ruling 65: the account-level cause, when this failure is one. Packets
     *  sharing it are resolved together — see `taskPacketSchema.cause`. */
    cause?: string;
    /** Ruling 119: where the work stands (the last report, the head and its
     *  delivery state, the last gate result), written into the body after the
     *  reason. The depth-capped react loop supplies it. */
    standings?: string;
  },
): Promise<StuckLoopEscalation> {
  try {
    const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    // Unreadable task file: nothing was escalated and nothing can be — that is
    // a failure, not an existing packet (T13 reads these apart).
    if (!existing) return { status: "failed" };
    if (existing.parsed.packet) return { status: "already_open" }; // already escalated
    const { operatorOpenPacket } = await import("./operator-packets.server");
    const { resolveOperatorAuthority } = await import("./operator-authority.server");
    const authority = resolveOperatorAuthority(ctx, input.projectSlug, {});
    const hold: OperatorPacketOptionInput = {
      kind: "hold_runtime_debug",
      title: "Hold for runtime debugging",
      detail: "Freeze coordination while the provider-native session is inspected.",
    };
    const options: OperatorPacketOptionInput[] = input.options
      ? [...input.options, hold]
      : [...STOCK_STALL_OPTIONS, hold];
    const observations: NonNullable<OperatorOpenPacketInput["observations"]> = [
      { k: "Agent", v: `@${input.agentHandle}` },
      { k: "Signal", v: input.reason },
    ];
    if (input.providerText) {
      observations.push({ k: "Provider said", v: input.providerText, code: true });
    }
    const open: OperatorOpenPacketInput = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      packetType: "blocked",
      title: `Work stalled: pick a recovery path`,
      body:
        `${input.reason}${input.remedy ? ` ${input.remedy}` : ""}` +
        `${input.standings ? ` ${input.standings}` : ""} ` +
        "Coordination is paused until a human chooses how to proceed.",
      observations,
      options,
      // Ruling 123: a stall is the one premise a later successful run can
      // disprove, so this marker is what `withdrawSupersededStuckPacket` reads.
      // The stock-set fallback below spreads `open`, and keeps it.
      stalled: true,
    };
    // Ruling 65: when the failure belongs to an ACCOUNT rather than this task,
    // the packet carries that, so the N identical siblings one quota or
    // credential failure raises can be answered once.
    if (input.cause) open.cause = input.cause;
    let result = await operatorOpenPacket(db, ctx, open, authority);
    /**
     * Ruling 123: an escalation the server composed for ITSELF must not be
     * abandoned because a guard written to coach a model rejected one option.
     *
     * `operatorOpenPacket`'s authoring guards exist for the operator, which
     * reads the refusal, revises its options and tries again — their messages
     * are written that way ("Offer the OTHER backend, or offer wait_for_window
     * with dueAt set to the reopen instant"). This function has no such loop:
     * it built the options itself from `describeRunFailure`, so a refusal ends
     * with a stalled task and NO packet, which is strictly worse than a packet
     * with one fewer option.
     *
     * So it falls back to the stock set — redirect, send back, hold — whose
     * kinds carry no conditional guard at all, and says on the packet what was
     * dropped and why. Only when the failure supplied its own options: the
     * stock set IS the other callers' set, and retrying it unchanged would be
     * a loop.
     */
    if (result.outcome !== "done" && input.options) {
      logger.info("stuck-loop packet refused its composed options; retrying with the stock set", {
        taskKey: input.taskKey,
        reason: result.message,
      });
      const fallback: OperatorOpenPacketInput = {
        ...open,
        observations: [
          ...observations,
          {
            k: "Tailored options withheld",
            v:
              `Viberr composed options for this failure and refused its own packet: ` +
              `${endSentence(result.message)} The general recovery options are offered instead.`,
          },
        ],
        options: [...STOCK_STALL_OPTIONS, hold],
      };
      result = await operatorOpenPacket(db, ctx, fallback, authority);
    }
    if (result.outcome !== "done") {
      logger.info("stuck-loop packet not opened", {
        taskKey: input.taskKey,
        reason: result.message,
      });
      // C10.4 (pass 25): the task IS in a stuck loop (this function only runs
      // past the already-escalated early-return when it is), but the escalation
      // packet was refused — so without a note the task sits waiting on a human
      // with no card saying why. Leave one.
      await noteStuckLoopEscalationFailed(db, ctx, input.projectSlug, input.taskKey, {
        kind: "refused",
        reason: result.message,
      });
      return { status: "failed" };
    }
    return { status: "opened", notifiedUserIds: result.notifiedUserIds ?? [] };
  } catch (error) {
    logger.warn("stuck-loop packet escalation failed", {
      taskKey: input.taskKey,
      err: toError(error),
    });
    await noteStuckLoopEscalationFailed(db, ctx, input.projectSlug, input.taskKey, {
      kind: "failed",
      reason: errorMessage(error),
    });
    return { status: "failed" };
  }
}

/**
 * C10.4 (pass 25): a visible fallback when a stuck-loop escalation can't open
 * its packet — so a task that has stopped making progress never sits waiting on
 * a human with nothing on the timeline explaining why. Guarded: never throws.
 *
 * Ruling 122 — and it has to say WHY, because that was the whole point.
 *
 * Both callers hold the reason. One has `operatorOpenPacket`'s own refusal
 * message, the other has a thrown `Error`. Both LOG it and neither passed it,
 * so the card C10.4 added to explain a stuck task explained nothing: "the
 * recovery packet could not be opened" is the observation a person has already
 * made by the time they are reading it.
 *
 * It also told them to "resolve it". There is no packet — that is the entire
 * subject of the note — so a person following that sentence goes looking for a
 * card that does not exist. The two arms differ too: a REFUSAL is a governance
 * answer with a remedy in it (an authority, an archived project, a packet
 * already open), and a THROW is a fault. Telling them apart is most of the
 * help.
 *
 * Same shape as ruling 164, one file over: a fixed sentence standing where
 * the system had the specific fact.
 */
async function noteStuckLoopEscalationFailed(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  why: { kind: "refused" | "failed"; reason: string },
): Promise<void> {
  try {
    const reason = why.reason.trim();
    const said = reason
      ? why.kind === "refused"
        ? `Viberr refused it: ${endSentence(reason)}`
        : `Writing it failed: ${endSentence(reason)}`
      : why.kind === "refused"
        ? "Viberr refused it and gave no reason."
        : "Writing it failed and the error carried no message.";
    await appendPolicyNote(db, ctx, projectSlug, taskKey, {
      text:
        "This task's operator turns stopped making progress, and the recovery packet that " +
        `would have asked you how to proceed was not opened. ${said} ` +
        "There is no packet on this task to resolve; it is waiting on a person. " +
        (why.kind === "refused"
          ? "Clear what the refusal names and the next operator turn escalates on its own, " +
            "or run the operator yourself and decide from there."
          : "Run the operator yourself and decide from there; the next turn will try the " +
            "escalation again."),
    });
  } catch {
    // Best-effort: the stuck state is already logged above.
  }
}

/**
 * Withdraw a matching stale STALL packet after successful agent work (owner
 * ruling 2026-07-18).
 *
 * Ruling 123: only a packet `openStuckLoopPacket` raised (`stalled: true`). This
 * used to take any blocked packet without an acceptance option, and on AX-21 at
 * 01:24 it took the one saying "`ax-21` conflicts with `main`". The Surface
 * Developer had been dispatched onto that conflict, found it, changed nothing
 * and ended its run cleanly ("Blocked on the unresolved AX-21/main conflict; no
 * lasting changes were made"). The timeline then called the conflict "moot"
 * because the run "completed successfully", and the question the developer
 * asked about it was held behind a decision that no longer existed. A run
 * finishing disproves a stall and nothing else.
 */
export async function withdrawSupersededStuckPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    delivers: boolean;
    role: string;
    runProfileId: string;
  },
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const packet = existing?.parsed.packet;
    if (!packet?.stalled) return;
    const retryOptions = packet.options.filter(
      (o) => o.kind === "retry_other_backend",
    );
    if (retryOptions.length > 0) {
      const subjectProfileId =
        retryOptions.find((o) => o.profileId)?.profileId ?? null;
      // profileId is the join key when the packet names one (a reviewer retry);
      // an UNSTAMPED option is about the primary specialist — the operator's
      // open_decision_packet option shape carries no profileId at all — so the
      // delivering agent's success is what falsifies it.
      const matches = subjectProfileId
        ? input.runProfileId === subjectProfileId
        : input.delivers;
      if (!matches) return;
    }
    let withdrawn: ClosedDecision | null = null;
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      const p = parsed.packet;
      // Re-check inside the write — the read above raced other writers, and a
      // different packet may stand here now.
      if (!p?.stalled || p.id !== packet.id) return;
      parsed.packet = null;
      // A blocked packet held the readiness gate down with it (same lift as the
      // goal-edit auto-clear above).
      if (parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
      const closedAt = new Date().toISOString();
      parsed.timeline.unshift({
        occurredAt: closedAt,
        type: "transition",
        actor: { kind: "operator" },
        title: null,
        text: `**Packet withdrawn:** "${p.title}" is moot. The ${input.role} agent run completed successfully after it was opened.`,
        toAgent: false,
        evidence: null,
      });
      withdrawn = { packetId: p.id, closedAt };
    });
    if (!withdrawn) return;
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
    followClosedDecision(db, input.projectSlug, input.taskKey, withdrawn);
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    // Ruling 94: the automatic clear. The verdict that just landed was written
    // while this packet stood, so the escalation was skipped; seconds
    // later the same run's success withdraws the packet, and the escalation
    // would be gone with nothing having decided it should be. This path has
    // never fired on a real board — the live misses came through the human
    // resolution — but it is the same defect and gets the same retry.
    await retryReviewDeadlockEscalation(db, ctx, input.projectSlug, input.taskKey);
    recordAudit(db, {
      action: "task.packet.withdrawn_superseded",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { delivers: input.delivers, role: input.role },
    });
  } catch (error) {
    logger.warn("superseded-packet withdrawal failed", {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Withdraw a stale delivery/branch-conflict blocked packet once a PR now stands
 * for the task (F29-7). When server-owned delivery fails on a non-fast-forward
 * push conflict, the operator opens a blocked "Delivery push conflict … no PR
 * opened" decision packet. If a human then resolves the branch out-of-band and
 * re-delivers with the GitHub panel's "Deliver branch & open PR" button, the
 * push+PR succeed — but the packet is HUMAN-owned, so the operator cannot clear
 * it and an operator re-run won't either. The task then sits `blocked` with a
 * packet whose "no PR opened" text flatly contradicts the "PR #N · in review"
 * panel beside it. A successful delivery is exactly what falsifies its premise,
 * so supersede it here (readiness lifts with it), the same shape as the
 * retry-packet supersession after a successful agent run.
 *
 * Scoped by the packet's `discard_branch` or `resolve_remote_collision` option —
 * the structured markers of the branch/delivery-conflict family (discard the
 * local branch, or clear a remote key collision and re-deliver). Both kinds must
 * match: F31-6 refuses `discard_branch` authoring exactly when work stands on
 * the branch, so post-F31-6 conflict packets carry `resolve_remote_collision`
 * instead and keying on `discard_branch` alone would reopen F29-7. A
 * reject-recovery packet ("PR closed without merging") uses `archive_task`
 * instead and is deliberately left alone, as is any `accept_completion` packet.
 * Best-effort; never turns the open PR into an error.
 *
 * F33-3 (pass 33): the `type === "blocked"` requirement binds only the
 * `discard_branch` half. Live (VIB-1) a COLLISION packet survived a by-hand
 * delivery that opened PR #270 on `vib-1` at the first attempt, and its confirm
 * dialog then offered to delete "the stale branch `vib-1` … the unrelated one
 * squatting on this task's branch name" — the task's own live branch, carrying
 * its own commit and its own open PR. A `resolve_remote_collision` option says
 * one thing only: another PR holds this task's branch name. A review PR that
 * just opened ON that branch falsifies exactly that, whatever `type` the
 * operator gave the packet, so the collision kind is moot on its own.
 */
export async function withdrawSupersededDeliveryPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  const isConflictPacket = (p: {
    type: string;
    options: readonly { kind: string }[];
  }): boolean =>
    !p.options.some((o) => o.kind === "accept_completion") &&
    (p.options.some((o) => o.kind === "resolve_remote_collision") ||
      (p.type === "blocked" &&
        p.options.some((o) => o.kind === "discard_branch")));
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    const packet = existing?.parsed.packet;
    if (!packet || !isConflictPacket(packet)) return;
    let withdrawn: ClosedDecision | null = null;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      const p = parsed.packet;
      // Re-check inside the write — the read above raced other writers.
      if (!p || !isConflictPacket(p)) return;
      parsed.packet = null;
      // A blocked packet held the readiness gate down with it.
      if (parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
      const closedAt = new Date().toISOString();
      parsed.timeline.unshift({
        occurredAt: closedAt,
        type: "transition",
        actor: { kind: "operator" },
        title: null,
        text: `**Packet withdrawn:** "${p.title}" is moot. Delivery succeeded and a review pull request now stands for this task.`,
        toAgent: false,
        evidence: null,
      });
      withdrawn = { packetId: p.id, closedAt };
    });
    if (!withdrawn) return;
    markTaskPacketApprovalRead(db, projectSlug, taskKey);
    followClosedDecision(db, projectSlug, taskKey, withdrawn);
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.packet.withdrawn_superseded",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: { reason: "delivery_succeeded" },
    });
  } catch (error) {
    logger.warn("superseded delivery-packet withdrawal failed", {
      taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 94 (F37-57): display names for the escalation card, read from the
 * project file so a handle is a NAME even on a project whose run history was
 * pruned. Empty when the project cannot be read — the card then falls back to
 * the role, which is worse copy but never a crash inside a locked write.
 */
export function deadlockAgentNames(
  ctx: TaskMutationContext,
  projectSlug: string,
): ReadonlyMap<string, string> {
  const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  return file ? agentNamesOf(file.parsed.frontmatter) : new Map();
}

/**
 * Ruling 94 — the deadlock escalation is retried when the packet that blocked
 * it clears.
 *
 * Viberr raises the "N times running" packet from inside the locked write
 * that records the verdict, and skips it when a packet is already open — which
 * it must, since a task holds one packet. What nothing did was come back.
 *
 * The escalation was attempted EXACTLY ONCE, at the instant the objection was
 * written, and any unrelated packet standing at that instant killed it for good.
 * Those packets are usually a quota or credential failure (ruling 156), raised
 * in bursts across several tasks at once and nothing to do with the review.
 *
 * Measured on the shopify-clone board: five tasks reached a second consecutive
 * `request_changes`; **two never got the packet**. SHOP-18's second objection
 * landed at 03:44:44 with a backend-failure packet open (resolved at 04:38:38);
 * the task then ran another eight hours and ended in a force-accept over a
 * wedged Verify gate, with the person writing the routing by hand. SHOP-10
 * reached three rounds the same way.
 *
 * And the operator's own turn instruction told it the opposite: "a task you are
 * reading with such a reviewer and no packet is one where the escalation COULD
 * NOT BE WRITTEN" — a write failure, when in fact it was skipped by design and
 * would never be attempted again.
 *
 * Called after a resolution clears a packet. Best-effort and silent when there
 * is no deadlock: this runs on every packet resolution, and most of them have
 * nothing to do with a review.
 */
export async function retryReviewDeadlockEscalation(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || existing.parsed.packet) return;
    const fm = existing.parsed.frontmatter;
    if (taskClosure(fm, loadProjectContext(ctx, projectSlug).stages).closed) return;
    // Only an engagement that can actually record a verdict can deadlock a
    // review; a stale verdict from a profile nobody has engaged is history.
    const candidates = fm.engagements.filter((e) => e.verdictCapable);
    const deadlocked = candidates.flatMap((e) => {
      const deadlock = reviewDeadlockOf(fm, e.profileId, consecutiveRequestChanges(fm, e.profileId));
      return deadlock ? [{ deadlock, engagement: e }] : [];
    });
    if (deadlocked.length === 0) return;
    const names = deadlockAgentNames(ctx, projectSlug);
    /**
     * The retry is for an escalation that was NEVER MADE — not for one a person
     * has just answered.
     *
     * Without this, resolving the deadlock packet itself re-raises it on the
     * spot: the reviewer is still at N consecutive objections the instant the
     * card closes. That is the loop the owner called out on SHOP-76 — "that
     * shop-76 constantly bringing up ask what else would block on packet" —
     * and ruling 94 is the whole file about not rebuilding it.
     *
     * The packet's own title carries the round count, and raising it writes
     * that title onto the timeline ("**Decision packet:** …"). So a timeline
     * that already names this reviewer at this count has had its escalation;
     * silence there is what makes one owed. A LATER objection raises the count
     * and is a new escalation, which is ruling 94's own rule.
     */
    // Ruling 94: the reviewer AND the count. On the count alone, two reviewers
    // standing at the same count read as one, and the escalation the first was
    // given hid the one the second was owed. The title is the raise's entry
    // title or opens this retry's note, never just somewhere in a text, since
    // one name can end with another ("Security reviewer"). Where the project
    // names nobody, the raise wrote the engagement's role and this retry the
    // profile id.
    const carries = (title: string) =>
      existing.parsed.timeline.some((e) => e.title === title || (e.text ?? "").startsWith(title));
    let found: { deadlock: ReviewDeadlock; profileId: string } | null = null;
    for (const { deadlock, engagement } of deadlocked) {
      const named = names.get(engagement.profileId);
      const calledBy = named ? [named] : [engagement.profileId, engagement.role];
      if (calledBy.some((who) => carries(reviewDeadlockTitle(who, deadlock.rounds)))) continue;
      found = { deadlock, profileId: engagement.profileId };
      break;
    }
    if (!found) return;
    const deadlock = found.deadlock;
    const packet = buildReviewDeadlockPacket({
      taskKey,
      packetId: newId("pkt"),
      deadlock,
      reviewerName: names.get(found.profileId) ?? found.profileId,
      delivererName: delivererNameOf(fm, names),
      heldBy: fm.blockedBy,
    });
    let raised = false;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      // Re-checked inside the lock: the read above is outside it, and the
      // resolution that just ran may have opened one of its own.
      if (parsed.packet) return;
      parsed.packet = packet;
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text:
          `${packet.title}. This escalation was due when that verdict landed and could not be ` +
          "raised then, because another decision was already open on this task. It is raised now " +
          "that the other one is answered.",
        toAgent: false,
        evidence: null,
      });
      raised = true;
    });
    if (!raised) return;
    reprojectTask(db, ctx, projectSlug, taskKey);
    /**
     * Everything ruling 94's own raise does after its lock, because a packet
     * that arrives with nobody told is not an escalation.
     *
     * The first draft of this retry wrote the packet and stopped there: no
     * inbox row, no audit. It would have put a decision on a task and left the
     * person to find it, which is a quieter version of the defect it exists to
     * fix — the escalation reaching nobody. `notifyTaskWatchers` stamps the
     * OPERATOR as the sender on any notice that names none, so the policy
     * engine names itself here exactly as ruling 94 does: this is not the
     * operator's judgement.
     */
    recordAudit(db, {
      action: "task.review.deadlock",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: { profileId: found.profileId, rounds: deadlock.rounds, retried: true },
    });
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "packet",
        ptype: "input",
        title: `Decision needed: ${packet.title}`,
        text: packet.body,
        // Ruling 75: the row opens the packet, where it is decided.
        about: { decision: packet.id },
        from: POLICY_ENGINE_NOTIFY_FROM,
      },
      ctx,
    );
  } catch (error) {
    logger.warn("review-deadlock escalation retry failed", {
      taskKey,
      err: toError(error),
    });
  }
}
