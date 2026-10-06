/**
 * Resolving a decision packet (ruling 654): `resolvePacket` carries out the
 * option a person or the operator chose (an acceptance, a stage move, a
 * delivery, an archive, a new task, an answer to the agent that asked), and
 * fans one decision out to the sibling packets it answers. Also here: the
 * answer to a packet a person already decided (ruling 602), the process-only
 * option kinds, and a packet owner's request for a maintainer's decision.
 */

import { holdRefusalFor } from "~/server/projections/dependencies.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { escapeRegExp } from "~/shared/text/regexp";
import { endSentence } from "~/shared/text/sentence";
import type {
  CollisionServerOutcome,
  DeliveryServerOutcome,
  ResolvedPacketOption,
} from "~/shared/packet-server-outcome";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  deriveValidation,
  DIVERGED_BRANCH_REMEDY,
  PACKET_NOTE_MAX,
  type PacketOption,
  reviewSubjectAuthor,
  type TaskFileEvent,
  type TaskFrontmatter,
  type TaskPacket,
  unpushedRevisionOf,
} from "~/schemas/task-file.schema";
import { roleCan } from "~/shared/rbac";
import { isRepositoryAskCause } from "~/shared/repository-ask";
import { REVIEW_DEADLOCK_QUESTION } from "./review-deadlock.server";
import type { FanOutOutcome } from "./packet-fanout.server";
import { setTaskDependencies } from "./dependencies.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AGENT_QUESTION_PACKET_KIND } from "./agent-outcome.server";
import {
  acceptanceNoChangeCheck,
  assertVerifiedNoChangeStillApplies,
  noChangeCompletionEvent,
  standingKbCorrections,
} from "./no-change-completion.server";
import { newId } from "~/shared/ids/new-id.server";
import { AppError } from "~/server/errors/app-error.server";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import {
  appendPolicyNote,
  loadProjectContext,
  notifyTaskWatchers,
  OPERATOR_NOTIFY_FROM,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
  type TaskWatcherNotice,
} from "./task-mutation.server";
import {
  appendTimelineEvent,
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readEpicFile } from "~/server/files/epic-writer.server";
import {
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import type { GithubActionContext } from "~/server/github/github-reconciler.server";
import { moveStageTarget } from "~/shared/workflow/packet-options";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { initialsOf } from "~/ui/initials";
import { logger } from "~/server/logging/logger.server";
import { userDisplayName } from "./user-display-name.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  autoInvokeOperator,
  avatarTone,
  humanActorRef,
  OPERATOR_TASK_ACTOR,
  ownerException,
  requireAcceptCompletion,
  requireAction,
  stageName,
  type TaskActionContext,
  terminalStageIdOf,
  verdictStageOf,
} from "./task-action-core.server";
import { retryReviewDeadlockEscalation } from "./task-escalations.server";
import { createTask, type CreateTaskInput } from "./task-edits.server";
import { setTaskArchived } from "./task-archive.server";
import {
  type AcceptanceMergeOutcome,
  acceptancePrHeadCheck,
  acceptanceRefusalReason,
  assertAcceptanceDisclosure,
  assertVerifiedHeadStillApplies,
  attemptAcceptanceMerge,
  cleanUpEmptyTaskBranch,
  type EmptyBranchDisposition,
  emptyBranchDisposition,
  emptyBranchNote,
  forceAcceptCompletion,
  forceIrreducibleRefusal,
  mergePendingCause,
  refuseUnverifiedHead,
  revisionDriftNote,
} from "./task-acceptance.server";
import { manualDeliverForReview, recordDeliveredNextStep } from "./task-delivery.server";
import { transitionStage } from "./task-transitions.server";
import { answerAskingAgent, answerNamesAnotherActor } from "./task-comments.server";

/**
 * Ruling 322 — does this `create_task` option also make the DECIDING task wait
 * on what it creates?
 *
 * Ruling 269 built the option and wrote, in the resolver and again in the note
 * it leaves, that *"`<KEY>` is unchanged; the new task carries the work"* — with
 * a comment beside it calling the mutation "a deliberate NO-OP… this option
 * says something about work that is NOT this task". Both were true when they
 * were written.
 *
 * Ruling 287 then added `newTask.blocks`, the reverse edge: the EXISTING tasks
 * that must wait on the new one. Nothing excludes the deciding task from that
 * list, and it is the most natural entry on it — a task is usually created
 * because the work in front of you cannot proceed without it. When it is
 * there, the resolution writes the new key into this task's own `blockedBy`
 * seconds after telling the person this task was untouched, and the board flips
 * it to blocked.
 *
 * Neither sentence was updated. This is the reader that keeps them honest.
 */
function createTaskHoldsDecider(
  spec: PacketOption["newTask"] | undefined,
  taskKey: string,
): boolean {
  const key = taskKey.trim().toUpperCase();
  return (spec?.blocks ?? []).some((b) => b.trim().toUpperCase() === key);
}

/**
 * Ruling 329: EXPORTED, because it is the line between a sentence a person
 * reads once on a card and a sentence that becomes permanent contract.
 *
 * `resolvePacket` appends `${option.t}: ${option.d}` to the task's goal for
 * every option kind NOT in here (and not ending the task). A server-authored
 * option on the wrong side of that line writes its own UI copy into the record,
 * which is how an instruction to type in a textarea ended up in three tasks'
 * goals, addressed to agents that have no textarea. The guard test reads this
 * set to know which authored options it must hold to that bar.
 */
export const PROCESS_ONLY_OPTION_KINDS: ReadonlySet<string> = new Set([
  // Ruling 672: both decide the BOARD, and the board keeps them (a repository
  // in project.md, a ruling in its knowledge base). Neither is this task's
  // contract, and their words are card copy ("Type it as owner/name").
  "connect_repository",
  "keep_without_repository",
  "request_edit",
  "hold_runtime_debug",
  "redirect",
  "retry_other_backend",
  "archive_task",
  "discard_branch",
  "resolve_remote_collision",
  "move_stage",
  // Ruling 200(h): "the label promises an UNBLOCK, so this records one … 'I
  // fixed the credential, carry on' is the recovery the human means". That is
  // what happens NEXT, not what the work IS — the same reason `redirect` and
  // `hold_runtime_debug` are here, and it was missed when the list was first
  // written.
  "block_on_policy",
  // F37-60: both of these POSTDATE ruling 189, so neither was ever added, and
  // the defect the ruling exists to stop came straight back through them.
  // Ruling 224's own words are "the decision IS the wait" and ruling 230's are
  // "hold this until those land" — pure recovery, deciding what happens NEXT
  // rather than what the work IS. Live on SHOP-18: its goal carried FIVE
  // decision blocks, three of them "pick a recovery path → Wait for the window
  // and pick the task back up automatically", which is the same sentence
  // ruling 189 quotes from SHOP-7 as the thing that must not be there.
  "wait_for_window",
  "block_on_dependencies",
  // Ruling 237: "ask the reviewer what else it would block on" decides who
  // runs next, and the answer that comes back is the reviewer's, not the
  // person's. Nothing about the deliverable changed.
  "question_reviewer",
  // Ruling 269: the decision is about work that is NOT this task — it names
  // a gap and puts it on the board somewhere else. Amending THIS contract
  // with it would bind every future run here to a paragraph about another
  // task's job, which is exactly the accumulation ruling 189 exists to stop.
  // The two timeline lines name the new key; that is the join.
  "create_task",
  // Ruling 489: "deliver the committed head" decides what happens next to
  // work that already exists; it changes nothing about what the work is.
  "deliver_for_review",
]);

/** Identify a packet across an awaited resolution so replacements cannot be cleared. */
export function packetIdentity(p: TaskPacket): string {
  if (p.id) return `id:${p.id}`;
  return `fp:${JSON.stringify({
    kind: p.kind,
    title: p.title,
    from: p.from,
    awaiting: p.awaiting ?? null,
    options: p.options.map((o) => ({
      kind: o.kind,
      t: o.t,
      profileId: o.profileId ?? null,
      backend: o.backend ?? null,
    })),
  })}`;
}

/** Ruling 189: the sentence that makes a person's decision part of the
 *  task's contract. O39-b finds an earlier copy of the same decision by it. */
const CONTRACT_CLAUSE = "This decision is part of the task's contract from here on.";

/** Every decision block the contract holds: the question it answered and the
 *  answer, as `resolvePacket` writes them. */
const CONTRACT_DECISION_RE = new RegExp(
  String.raw`answered “([^”]*)”:\*\*\n\n([\s\S]*?)\n\n` + escapeRegExp(CONTRACT_CLAUSE),
  "g",
);

/**
 * O39-b: does the contract already hold this decision, to this question?
 *
 * The answer alone is not the decision. An agent's options are often a bare
 * "Yes", so a second question answered "Yes" is a different decision, and
 * matching on the answer dropped it from the contract. The question is
 * compared with its numbers blanked, because the one that asks again round
 * after round (the review deadlock, "… has requested changes 3 times
 * running") only changes its count.
 */
function contractHoldsDecision(goal: string, question: string, answer: string): boolean {
  const asked = (title: string) => title.replace(/\d+/g, "#");
  // Ruling 571: an answer joins the option's title and detail with a colon.
  // Goals written before it joined them with a dash, so a dash reads as that
  // separator on both sides and a decision stored the old way still counts.
  const said = (text: string) => text.replace(/ — /g, ": ");
  const wanted = asked(question);
  for (const block of goal.matchAll(CONTRACT_DECISION_RE)) {
    if (said(block[2] ?? "") === said(answer) && asked(block[1] ?? "") === wanted) return true;
  }
  return false;
}

/** Resolve the active packet by stable option kind and mark its notifications read. */
export async function resolvePacket(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    optionIndex: number;
    /** P11-71: optional free-text the human types when resolving — recorded on
     *  the decision event so an option that asks for input ("specify the
     *  expected behavior", "which target") actually has a channel to carry it. */
    note?: string;
    /** Owner request 2026-08-20 (questionnaire packets): the human's OWN answer
     *  instead of a canned option. Non-empty ⇒ `optionIndex` is ignored and the
     *  resolution runs the default arm as a synthetic `custom` option — the
     *  un-gated kind operators already author — with this text as the note the
     *  asker and the operator receive. */
    custom?: string;
    /** Ruling 88 (F21-2): the acceptance disclosure the human acknowledged.
     *  Consulted ONLY by the `accept_completion` arm below — the one option kind
     *  that writes Done and merges a pull request; every other kind resolves a
     *  decision and carries no acceptance to disclose. Three states, documented
     *  on `assertAcceptanceDisclosure`: an echo to verify, an explicit `null`
     *  from a door whose request carried none (refused), or omitted by an
     *  in-process caller. The packet-identity pin this function already keeps is
     *  NOT a substitute: it proves the decision is the one that was opened, not
     *  that the human saw what merges. */
    ack?: AcceptanceDisclosure | null;
    /** Ruling 319: INTERNAL. Set when this resolution is itself the fan-out of
     *  a decision a person made on another task, naming that task. It stops the
     *  fan-out below recursing — a sibling answers for itself and for nobody
     *  else — and no door sets it; only the loop at the end of this function. */
    fanOutOrigin?: string;
  },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<{ task: TaskSummary; option: PacketOption }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const packet = existing.parsed.packet;
  if (!packet) {
    throw AppError.conflict("This packet was already resolved.");
  }
  /**
   * Ruling 315: the note REFUSES like its neighbour instead of being cut.
   *
   * `project.task.tsx` used to slice it to 2,000 characters in the route,
   * before this function ever saw it — no `maxLength` on the textarea, no
   * counter, no marker on the record and no error, and nothing anywhere holds
   * the discarded tail. Ruling 292 allowed a cut on a VERDICT because "the full
   * text is never lost — the agent's own report is on the same timeline,
   * untruncated". A person's typed note has no second copy, so the same cut is
   * actual loss.
   *
   * Live on SHOP-76: a 4,454-character decision was stored at exactly 2,000,
   * ending mid-word, and a rework round ran on the operator's reconstruction of
   * the sentence viberr had deleted. The card had promised the opposite —
   * "anything you type below is recorded on the task's contract and every later
   * run reads it".
   *
   * The limit is the same 4,000 the directive field beside it already refuses
   * at, because two fields on one card differing by a factor of two, and by
   * refuse-versus-truncate, is the thing that made this survivable to write.
   */
  const noteText = input.note ?? "";
  if (noteText.length > PACKET_NOTE_MAX) {
    throw AppError.validation(
      `That note is too long: ${PACKET_NOTE_MAX.toLocaleString("en-US")} characters max, ` +
        `and you wrote ${noteText.length.toLocaleString("en-US")}. ` +
        "Nothing was recorded. Shorten it and confirm again, or put the long version " +
        "in a comment on the task and refer to it here.",
    );
  }
  const customDirective = input.custom?.trim() ?? "";
  if (customDirective.length > PACKET_NOTE_MAX) {
    throw AppError.validation(
      "Custom directive is too long: 4,000 characters max.",
    );
  }
  // A custom answer resolves as a synthetic option of the un-gated `custom`
  // kind: same default arm, same send-back-to-asker routing, same operator
  // requeue — the directive itself travels as the decision note below.
  let option: PacketOption;
  if (customDirective) {
    option = {
      kind: "custom",
      t: "Answered with a custom directive",
      d: "",
      rec: false,
      ev: "**Decision:** answered with a custom directive. Operator re-engages with it.",
    };
  } else {
    const picked = packet.options[input.optionIndex];
    if (!picked) throw AppError.validation("Unknown packet option.");
    // Ruling 478(e) (F40-31): a choice the asking agent marked as needing the
    // person's typed answer is not an answer without it. The card refuses
    // first; this is the same refusal for any other door.
    if (picked.reply && noteText.trim() === "") {
      throw AppError.validation(
        `"${picked.t}" needs your answer: write it in the box under the options and ` +
          "confirm again. Nothing was recorded.",
      );
    }
    option = picked;
  }
  // R20-1 (F20-5): a packet that has already recorded a decision accepts no
  // second one. `edit_goal` is the only kind that KEEPS its packet open (it
  // clears when the edited goal lands); the `awaiting` stamp is what makes it
  // un-re-confirmable. Every other kind now sets `clearPacket`, so a second
  // confirm on them hits the "already resolved" 409 below — this covers the one
  // kind that legitimately stays open.
  if (packet.awaiting) {
    throw AppError.conflict(
      `This decision was already made on ${input.taskKey}. The packet is waiting for the edited goal. ` +
        `Save the goal to clear it.`,
    );
  }
  // F10-09: snapshot the packet's identity BEFORE any await/lock. The
  // accept_completion path awaits a remote merge, widening the window in which a
  // replacement packet could be opened; the locked update below re-checks this
  // identity so a stale resolution can't stamp/clear a different packet.
  const resolvedPacketIdentity = packetIdentity(packet);

  // Packet-resolution authority (owner ruling Q2 2026-07-11, WIDENED by R14-2
  // 2026-07-25): a decision packet is addressed to the task OWNER, so the owner
  // (whatever their project role) OR an admin|maintainer may resolve it — a
  // contributor who took ownership is no longer told "decision needed" and then
  // handed a 403. `accept_completion` routes through requireAcceptCompletion
  // below, which carries the same owner exception (R6-2).
  // `ownerException` additionally requires CURRENT contributor+ membership
  // (adversarial-review #8) — a user removed from the project who still holds a
  // stale ownerUserId must not resolve packets.
  const isOwner =
    !ctx.operatorAuthorized &&
    ownerException(project, actor, existing.parsed.frontmatter.ownerUserId);
  if (option.kind === "accept_completion") {
    // Acceptance is guarded below by requireAcceptCompletion (the owner exception,
    // R6-2) — do NOT gate it here on resolve-packet, which would block a
    // contributor-owner before the owner check runs.
  } else if (isOwner) {
    // owner is allowed — skip the maintainer gate (the owner must still be able
    // to own the task, i.e. contributor+; a demoted viewer-owner is caught above)
  } else {
    requireAction(db, project, actor, "resolve-packet", "resolve decision packets");
  }

  const now = new Date().toISOString();
  const human = humanActorRef(db, actor);
  const key = input.taskKey;

  let event: TaskFileEvent;
  let mutate: (fm: TaskFrontmatter, timeline: readonly TaskFileEvent[]) => void;
  let clearPacket = false;
  /** U3 (NFR16): the terminal stage THIS resolution would write, set only by the
   *  `accept_completion` arm — the shared write below re-reads the stage under
   *  the lock and skips itself when the task is already there. */
  let acceptsInto: string | null = null;
  /** Ruling 241: THIS resolution queued the reviewer's question instead of
   *  dispatching it, because the task is held. A flag rather than a read of the
   *  written file: "did I queue" and "does a queue entry exist" are different
   *  questions, and the second one answers yes for an entry somebody else left
   *  behind — which would silently skip the dispatch this decision promised. */
  let queuedTheQuestion = false;
  /** OBS-11: the empty branch this resolution closes over. Decided by the
   *  `accept_completion` arm from the PRE-acceptance frontmatter, but acted on
   *  only after the write lands, so the decision has to outlive that arm's
   *  block scope. Every other arm leaves it `none`. */
  let branchDisposition: EmptyBranchDisposition = { kind: "none" };
  /** Ruling 672: the connection a person answered `connect_repository` with,
   *  ON THIS TASK: what hands the answered tasks back to their operators once
   *  the fan-out has run, and (when this answer attached the repository)
   *  starts the controller on the board. Null on every other kind, and on a
   *  task the answer only reached. */
  let repositoryConnection: { repo: string; attached: boolean } | null = null;

  switch (option.kind) {
    case "accept_completion": {
      // Human-only Review → Done boundary (always-human invariant), with the
      // task-owner exception (R6-2).
      requireAcceptCompletion(
        db,
        project,
        actor,
        existing.parsed.frontmatter.ownerUserId,
        "accept completion into Done",
      );
      // Ruling 88 (F21-2): this option is an acceptance — it writes Done and
      // merges the pull request — so it is held to the ceremony exactly like the
      // Accept button. Checked AFTER the authority gate (a caller who may not
      // accept hears about their role, not their dialog) and BEFORE the merge,
      // so a missing or stale acknowledgment is never discovered on the far side
      // of an irreversible GitHub write. Re-compared under the lock below.
      assertAcceptanceDisclosure(
        existing.parsed.frontmatter,
        input.ack,
        input.taskKey,
        "full",
      );
      // The SAME acceptance gates the direct `acceptCompletion` path applies —
      // required reviewers on the current revision (F10-15), the closed-PR
      // rejection (P13-D-4), the conflicting PR and the workflow-graph position
      // (P14-LV-02). This inlined accept has historically shipped with a subset
      // of them; one shared helper is the fix. `blockedPacket: false` because
      // the open packet IS what this call resolves — it can't also be the reason
      // to refuse the resolution.
      // F28-L1: run the live no-change probe BEFORE the sync gate so a verified-
      // empty completion (the R20-2 auto-detect) isn't refused "no review pull
      // request" here — the same reorder the direct human accept path carries.
      const noChange = await acceptanceNoChangeCheck(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
      );
      {
        const refusal = acceptanceRefusalReason(
          project,
          existing.parsed.frontmatter,
          input.taskKey,
          {
            blockedPacket: false,
            noChange,
            subjectAuthor: reviewSubjectAuthor(existing.parsed.frontmatter, existing.parsed.timeline),
          },
        );
        if (refusal) throw AppError.conflict(refusal);
      }
      const doneStageId =
        terminalStageIdOf(project) ??
        project.stages[project.stages.length - 1]?.id ??
        "done";
      acceptsInto = doneStageId;
      // R15-1 gate 2 (F15-15): the packet path is a Done writer like the other
      // two, so the PR head must contain the delivered revision HERE as well —
      // otherwise the operator's own acceptance packet becomes the one door
      // through which a stale-head PR merges with a green review attached.
      const headCheck = await acceptancePrHeadCheck(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
      );
      if (headCheck.refusal) {
        await refuseUnverifiedHead(db, ctx, input.projectSlug, input.taskKey, headCheck);
      }
      // R19-8: the packet path is a writer to Done like the other two, so the
      // no-change basis is re-proved live HERE as well — otherwise the
      // operator's own acceptance packet becomes the one door a stale
      // `noChanges` flag closes a now-non-empty branch through. No `force` on
      // this path. The probe was hoisted above the gate (F28-L1); reuse it.
      if (noChange.refusal) throw AppError.conflict(noChange.refusal);
      // F15-13: a PR already merged out of band needs no merge attempt, and the
      // completion event must not claim the merge as this human's act.
      const alreadyMerged = existing.parsed.frontmatter.pr?.state === "merged";
      // Attempt the REAL merge (FR31) and only claim "merged" when it truly
      // happened; a merge GitHub refuses (conflict, moved head) refuses the
      // acceptance itself, and an unreachable merge records "accepted" (merge
      // pending) with its real cause — never a false merge (D3 / NFR15).
      //
      // P14-GV-05: the merge is an EXTERNAL, irreversible side effect, and the
      // only identity re-check used to run AFTER it (inside the write lock) — so
      // a packet replaced while this resolution was in flight left the PR merged
      // on GitHub and the resolution 409'd: a real merge committed under a stale
      // decision, self-healed only by the poller's "merged but not Done" nudge.
      // Re-check inside `beforeMerge`, the last point before the side effect —
      // and re-check the FULL acceptance gate there too (B-WF1): a revision or
      // verdict that changed during the await must refuse, exactly as the
      // direct path does.
      const merge: AcceptanceMergeOutcome = alreadyMerged
        ? { kind: "merged" }
        : await attemptAcceptanceMerge(
            db,
            ctx,
            input.projectSlug,
            input.taskKey,
            actor,
            () => {
              const fresh = readTaskFile(
                taskRef(ctx, input.projectSlug, input.taskKey),
              );
              if (
                !fresh?.parsed.packet ||
                packetIdentity(fresh.parsed.packet) !== resolvedPacketIdentity
              ) {
                throw AppError.conflict(
                  "This decision was replaced by a newer one. Refresh the task and choose again.",
                );
              }
              const refusal = fresh
                ? acceptanceRefusalReason(
                    project,
                    fresh.parsed.frontmatter,
                    input.taskKey,
                    // F28-L1: the same verified-empty result the outer gate saw.
                    {
                      blockedPacket: false,
                      noChange,
                      subjectAuthor: reviewSubjectAuthor(fresh.parsed.frontmatter, fresh.parsed.timeline),
                    },
                  )
                : null;
              if (refusal) throw AppError.conflict(refusal);
            },
          );
      if (merge.kind === "unmergeable") throw AppError.conflict(merge.reason);
      const reallyMerged = merge.kind === "merged";
      const hasPr = !!existing.parsed.frontmatter.pr;
      // R17-1: name any reviewed-revision drift on the completion record.
  /**
   * Ruling 318: computed AFTER the merge, because the merge is what moves the
   * branch. `existing` was read before `attemptAcceptanceMerge`, which runs
   * `refreshBranchForAcceptance` → `recordBranchRefresh`: it brings the branch
   * up to date with the base, pushes that merge commit, re-measures the drift
   * and REWRITES the file. So on every task whose ceremony refreshed the base,
   * the permanent Done record either named a head that was never merged or
   * omitted the refresh the acceptance itself created.
   *
   * Live on SHOP-81, three consecutive entries: the github note says "base
   * refreshed · 2 merge commits · 9 base commits", the branch-deletion note
   * says the head was `75786d012de9`, and the completion record — the permanent
   * one — names the pre-refresh head instead.
   *
   * R17-1's whole purpose is that the permanent record names the commits that
   * shipped outside the reviewed revision, and the acceptance is the thing that
   * ships them.
   */
      const driftNote = revisionDriftNote(
        readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter ??
          existing.parsed.frontmatter,
      );
      /**
       * Ruling 327: stamped when it is WRITTEN, not when the ceremony began.
       *
       * `now` is captured at the top of `resolvePacket`, 114 lines and one
       * GitHub round-trip above this — and `attemptAcceptanceMerge` can refresh
       * the base, push, merge and reconcile before it returns. So the permanent
       * Done record was dated BEFORE the merge it describes.
       *
       * Live on SHOP-77: the completion reads 05:33:35.903Z, the merge it
       * announces is 05:33:43.377Z and the branch deletion 05:33:44.631Z. The
       * timeline is newest-first, so the file puts the completion at the top
       * while its own timestamp is the oldest of the three — whichever a reader
       * trusts, the other is wrong. And its text is ruling 318's drift note,
       * correctly measured after the refresh, describing a state that did not
       * exist at the instant the record claims.
       *
       * The direct acceptance path (`acceptCompletion`) already stamps at write
       * time; this is the packet door catching up, so one ceremony does not date
       * itself two ways depending on which control a person used. The rest of
       * this switch keeps `now`: every other arm writes before any remote call.
       */
      const acceptedAt = new Date().toISOString();
      // R19-8: the ONE shared no-change completion event, same as the other two
      // writers to Done.
      event = noChange.applies
        ? noChangeCompletionEvent({
            taskKey: input.taskKey,
            actor: human,
            occurredAt: acceptedAt,
            by: "human",
            verification: noChange.verification,
            autoDetected: noChange.autoDetected,
            kbCorrections: standingKbCorrections(db, input.projectSlug, input.taskKey),
          })
        : {
            occurredAt: acceptedAt,
            type: "completion",
            actor: human,
            title: "Completion accepted",
            text:
              (!hasPr
                ? `Human acceptance recorded. Task transitioned to **${stageName(project, doneStageId)}** (no linked pull request).`
                : alreadyMerged
                  ? `Human acceptance recorded. Task transitioned to **${stageName(project, doneStageId)}**; the review PR had already been merged on GitHub.`
                  : reallyMerged
                    ? `Human acceptance recorded. Task transitioned to **${stageName(project, doneStageId)}** and the review PR was merged.`
                    : `Human acceptance recorded. Task transitioned to **${stageName(project, doneStageId)}**; the review PR is **accepted, merge pending** (${mergePendingCause(merge)}).`) +
              driftNote,
            toAgent: false,
            evidence: null,
          };
      // OBS-11 / OBS-13: a packet is a writer to Done like the Accept button,
      // so the empty branch is disposed of here too. Without it the same
      // branch's fate depended on which door the human used, and a branch the
      // acceptance itself proved carries nothing sat on GitHub forever with no
      // timeline sentence saying so. Decided from the PRE-acceptance
      // frontmatter so the completion event can state the branch's fate; the
      // deletion runs after the write, below.
      branchDisposition = emptyBranchDisposition(
        db,
        existing.parsed.frontmatter,
        noChange,
        input.projectSlug,
      );
      // The branch sentence rides on the no-change event only: the merge path's
      // copy is about a pull request, and a task WITH a PR never reaches a
      // `branch_empty` verification (the same rule acceptCompletion follows).
      if (noChange.applies) {
        event.text += emptyBranchNote(branchDisposition, input.taskKey);
      }
      mutate = (fm, timeline) => {
        // In-lock re-check (B-WF1): the generic resolution write below holds the
        // file lock — this is the last word before Done is recorded. A2: the
        // head verification above is bound to one (PR, revision) pair, so the
        // pair itself is re-asserted here too.
        assertVerifiedHeadStillApplies(fm, headCheck, input.taskKey);
        assertVerifiedNoChangeStillApplies(fm, noChange, input.taskKey);
        // Ruling 88: the disclosure is re-compared against the state actually
        // being closed, on the same terms `applyAcceptanceWrite` re-compares it
        // for the other Done writers. Scope `in-lock` skips the PR fact, which
        // the merge above may already have moved.
        assertAcceptanceDisclosure(fm, input.ack, input.taskKey, "in-lock");
        const refusal = acceptanceRefusalReason(project, fm, input.taskKey, {
          blockedPacket: false,
          noChange,
          subjectAuthor: reviewSubjectAuthor(fm, timeline),
        });
        if (refusal) throw AppError.conflict(refusal);
        // R20-2 (F20-6): a server-proved no-change acceptance repairs the flag so
        // the durable record matches the outcome. Set before deriveValidation.
        if (noChange.applies && noChange.autoDetected) fm.noChanges = true;
        // Ruling 98: EVERY stage write records where the task came from. This
        // arm writes the terminal stage itself rather than going through
        // `applyAcceptanceWrite`, which owns the field — without this the Done
        // task's `previousStageId` still names the stage before review, and the
        // next operator turn is told it arrived from there.
        if (fm.stage !== doneStageId) fm.previousStageId = fm.stage;
        fm.stage = doneStageId;
        fm.readiness = "ready";
        fm.waiting = "none";
        // P14-LV-02: derived, never synthesized — see acceptCompletion.
        fm.validation = deriveValidation(fm);
        // Acceptance consumes ALL standing recommendations (see
        // applyAcceptanceWrite — same rule, same reason).
        fm.recommendations = [];
        // Never downgrade an already-merged PR to "accepted" (F15-13).
        if (fm.pr) {
          const next =
            fm.pr.state === "merged" || reallyMerged ? "merged" : "accepted";
          fm.pr = { ...fm.pr, state: next };
        }
      };
      clearPacket = true;
      break;
    }
    case "block_on_policy": {
      // R20-1 (F20-5): the label promises an UNBLOCK, so this records one. It
      // used to record "hold on policy … stays blocked", leave the packet open,
      // and re-accept the same confirm forever. On a FAILURE packet the run
      // died and no coordination happened, so "I fixed the credential, carry on"
      // is the recovery the human means — which is why it re-queues below.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        // Ruling 130(c) (pass 34, F34-12): without a pre-authored `ev` the
        // record restates the option's OWN words. It used to assert "policy /
        // credential updated" for every option of this kind, and an operator
        // reading that record on JC-6 told the specialist a GitHub-scope block
        // had been lifted when nothing had.
        text:
          option.ev ??
          `**Decision:** ${option.t}. ${key} is unblocked and the operator ` +
            `re-runs to re-check. If it is still blocked, a new decision packet is opened.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.readiness = "ready";
        fm.waiting = "agent";
        // B-WF2 stands: `validation` has ONE writer (deriveValidation) — a
        // policy decision never touches review health.
      };
      clearPacket = true;
      break;
    }
    case "hold_runtime_debug": {
      // R20-1 (F20-5): still a hold — no run starts — but it now RESOLVES the
      // packet (it used to keep it open and re-accept the same confirm). The
      // task stays blocked and waiting on a human so the board's "Blocked or
      // waiting" filter still lists it (ruling 36 / R16-2) now that the packet
      // no longer holds that position.
      event = {
        occurredAt: now,
        type: "blocked",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** hold for runtime debug. ${key} stays blocked while the provider-native ` +
            `session is inspected. Coordination is paused and no operator run was started. ` +
            // Ruling 207(i): `run-agents` is admin/maintainer only (shared/rbac),
            // so a CONTRIBUTOR who owns the task — who may resolve this packet
            // through the owner exception — never sees that control, and the
            // @operator door is gated on the same role. Naming the control
            // without naming who holds it left an owner looking for a button
            // that is not rendered for them, on a task now blocked with the
            // packet cleared.
            `**Run operator** on the task page restarts it; that control belongs to a ` +
            `maintainer or an admin, so ask one if you do not see it.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.readiness = "blocked";
        fm.waiting = "human";
      };
      clearPacket = true;
      break;
    }
    case "edit_goal": {
      // The human chose to refine the goal themselves. The packet's ask is
      // only fulfilled when the edit LANDS, so the packet stays open (stamped)
      // and updateTaskGoal clears it the moment the new goal is saved — no
      // operator round-trip needed. The UI reads this option kind and opens
      // the goal editor.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Waiting for the edited goal; the packet clears as soon as it lands.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "human";
      };
      break;
    }
    case "retry_other_backend": {
      // Ruling 354 (pass 38, F38-8): ruling 241's rule at this arm too. The
      // retry is an agent dispatch, which ruling 186 refuses on a held task;
      // reading the hold only in the start below meant the decision was
      // written, the packet cleared, and THEN "The retry could not start" —
      // the person's choice bought nothing and there was no packet to choose
      // again from. The hold is read HERE, before the resolution write, and
      // the packet stays open until the wait clears or is edited.
      {
        const heldFor = existing.parsed.frontmatter.blockedBy;
        if (heldFor.length > 0) {
          throw AppError.conflict(
            `${holdRefusalFor(db, input.projectSlug, input.taskKey, heldFor, "retrying it on another backend")} The packet stays open; choose again once the wait clears.`,
          );
        }
      }
      // Backend-failure recovery (D4): the run restarts below on the option's
      // target backend; startSpecialistRun/startReviewerRun set the engagement's
      // `pinnedBackend` (F27-B1) so the switch STICKS — every later prompt on this
      // task follows the pin over the live profile until another retry re-pins it.
      const targetLabel = BACKEND_LABEL[option.backend ?? "claude"];
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Re-running on ${targetLabel} with a fresh context.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "agent";
        fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    case "question_reviewer": {
      // Ruling 237 (F37-57): the decision is that the REVIEWER answers before
      // anyone reworks anything. The run starts below; `waiting: agent` is
      // honest about who the task is on, and the stage does not move — the
      // reviewer is being asked a question about the revision where it stands,
      // not sent to judge a new one.
      //
      // Ruling 241 (F37-68): unless a dependency hold refuses it. Ruling 186
      // refuses every agent dispatch on a held task, and live on SHOP-5 this
      // arm wrote the decision, cleared the packet and then discovered the
      // refusal — leaving the contract saying "no rework until the reviewer has
      // answered" about a reviewer nobody would ever ask. The hold is read
      // HERE, before the resolution write, for the reason `force_accept`'s own
      // arm states: "a refusal discovered after it would leave the decision
      // recorded with no acceptance behind it."
      //
      // The owner's call was to queue rather than refuse, so the decision still
      // stands and the question rides on the task until the wait clears.
      const heldFor = existing.parsed.frontmatter.blockedBy;
      const queueing = heldFor.length > 0 && !!option.profileId;
      queuedTheQuestion = queueing;
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          (queueing
            ? `**Decision:** ${option.t}. ${holdRefusalFor(db, input.projectSlug, input.taskKey, heldFor, "asking it now")} ` +
              "The question is queued with the task and put the moment the wait clears. " +
              "No rework until the reviewer has answered."
            : `**Decision:** ${option.t}. No rework until the reviewer has answered.`),
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        // A queued question is not an agent working: `waiting` stays with the
        // hold's own answer rather than claiming a run nobody started (F37-33).
        fm.waiting = queueing ? "human" : "agent";
        fm.readiness = "ready";
        if (queueing && option.profileId) {
          fm.queuedQuestions.push({
            id: newId("qq"),
            profileId: option.profileId,
            directive: REVIEW_DEADLOCK_QUESTION,
            decidedBy: actor.userId,
            decidedByLabel: actor.label,
            decidedAt: now,
            heldBy: [...heldFor],
          });
        }
      };
      clearPacket = true;
      break;
    }
    case "archive_task": {
      // R14-3 authority, re-checked inside the case exactly like
      // accept_completion re-checks its own gate: packet resolution admits the
      // task's OWNER (R14-2), but archiving is the board-management tier — the
      // same `approve-transition` the Archive button requires. A
      // contributor-owner picking this option gets the honest 403 instead of a
      // silent widening of R14-3. The archive itself (and the optional branch
      // deletion) runs AFTER the resolution write below.
      requireAction(
        db,
        project,
        actor,
        "approve-transition",
        option.deleteBranch
          ? "archive this task and delete its branch"
          : "archive this task",
      );
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "none";
      };
      clearPacket = true;
      break;
    }
    case "discard_branch": {
      // R20-2 (F20-6): discard the task's LOCAL, never-pushed workspace branch.
      // It destroys commits, so it takes the same `approve-transition` tier the
      // archive-with-branch-deletion path requires. The actual git work (and the
      // `fm.branch` clear) happens AFTER the resolution write, below — the
      // resolution itself only records the decision and clears the packet.
      requireAction(
        db,
        project,
        actor,
        "approve-transition",
        "discard this task's branch",
      );
      // F33-2 (pass 33): the decision event states the DECISION, never its
      // effect. The discard runs after this write and can refuse (`on_remote`,
      // `no_workspace`, a git failure), and its own note carries the outcome —
      // so a sentence asserting "the branch is discarded" here put a claim on
      // the canonical timeline one millisecond above the note that contradicts
      // it. `option.ev` still overrides, as it does on every other kind.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      // The frontmatter edit happens after the git work (below); the resolution
      // write only clears the packet and records the decision.
      mutate = () => {};
      clearPacket = true;
      break;
    }
    case "resolve_remote_collision": {
      // F31-6: the branch-collision remedy. Deletes a REMOTE ref (and closes
      // the recorded unowned PR), so it takes the same `approve-transition`
      // tier as the sibling destructive options; the GitHub work and the
      // re-delivery run AFTER the resolution write, below.
      requireAction(
        db,
        project,
        actor,
        "approve-transition",
        "resolve this task's branch collision",
      );
      // Ruling 354 (pass 38, F38-8): the ceremony ends in a re-delivery, which
      // ruling 240 refuses on a held task — after the PR was closed and the
      // remote branch deleted. Read the hold before any of it, so a held task
      // keeps both its packet and its remote branch until the wait clears.
      {
        const heldFor = existing.parsed.frontmatter.blockedBy;
        if (heldFor.length > 0) {
          throw AppError.conflict(
            `${holdRefusalFor(db, input.projectSlug, input.taskKey, heldFor, "clearing its branch collision and re-delivering it")} The packet stays open; choose again once the wait clears.`,
          );
        }
      }
      // F33-2 (pass 33): the decision event states the DECISION, never its
      // effect. This text was written unconditionally and BEFORE any GitHub
      // work — so when the remedy refused (the delete-first ordering's whole
      // point), the canonical timeline held the refusal note ("The branch
      // collision was **not** cleared … Nothing was re-delivered.") directly
      // above an event asserting the branch WAS removed and the work re-
      // delivered, one millisecond apart. The outcome note is the only writer
      // of the outcome; `option.ev` still overrides.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      mutate = () => {};
      clearPacket = true;
      break;
    }
    case "deliver_for_review": {
      // Ruling 489 (pass 40, F40-68): the delivery runs AFTER the resolution
      // write, below, through the task page's own delivery door. Its authority
      // (`run-agents`, or the task's owner) and ruling 240's hold are read
      // here, before the packet is spent, so a refusal leaves the decision
      // open rather than answered with nothing done.
      if (!isOwner) {
        requireAction(db, project, actor, "run-agents", "deliver the branch & open the review PR");
      }
      {
        const heldFor = existing.parsed.frontmatter.blockedBy;
        if (heldFor.length > 0) {
          throw AppError.conflict(
            `${holdRefusalFor(db, input.projectSlug, input.taskKey, heldFor, "delivering it for review")} The packet stays open; choose again once the wait clears.`,
          );
        }
      }
      // F33-2: the decision event states the decision; the delivery's own
      // events and the outcome carry what happened.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      mutate = () => {};
      clearPacket = true;
      break;
    }
    case "force_accept": {
      // Ruling 164 (pass 35, F35-14): an option's title is a promise the
      // resolution keeps. KNC-3's "Force-accept as admin without a fresh
      // verdict" was a `custom` option: the resolution recorded the decision,
      // re-ran the operator, whose `accept_completion` returned a no-op behind
      // the verdict gate, and the operator had to ask the owner to press the
      // button by hand. This kind performs the override itself, through
      // `forceAcceptCompletion` — the same function the task page's Force
      // accept button calls, so the same disclosure ceremony, the same
      // irreducible gate and the same audited bypass record.
      //
      // The authority is that button's own: `force-accept-completion` is
      // admin-only, so a maintainer (or a contributor-owner the packet
      // admitted) hears the button's own refusal sentence rather than a
      // packet-shaped one.
      requireAction(
        db,
        project,
        actor,
        "force-accept-completion",
        "force-accept past the review gate",
      );
      // Both refusals the force path can still make are run HERE, before the
      // resolution write: that write clears the packet, and a refusal
      // discovered after it would leave the decision recorded with no
      // acceptance behind it. `forceAcceptCompletion` re-checks them on its own
      // terms below (it is a public door in its own right).
      const irreducible = forceIrreducibleRefusal(
        existing.parsed.frontmatter,
        input.taskKey,
      );
      if (irreducible) throw AppError.conflict(irreducible);
      assertAcceptanceDisclosure(
        existing.parsed.frontmatter,
        input.ack,
        input.taskKey,
        "full",
      );
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        // F33-2: the decision, never its effect — the acceptance below writes
        // its own completion event and `task.acceptance.forced` audit row.
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      mutate = () => {};
      clearPacket = true;
      break;
    }
    case "move_stage": {
      // Ruling 164 (pass 35, F35-14): the option names a stage and the
      // resolution moves the task there, through `transitionStage` with
      // `manual: true` — the stage picker's own path, so the same
      // `approve-transition` tier, the same off-graph licence a person's move
      // carries, and the same transition event and `task.transition` audit row.
      // KNC-16's "Move KNC-16 back to Review" was a `redirect`: it recorded the
      // decision and moved nothing.
      requireAction(
        db,
        project,
        actor,
        "approve-transition",
        "change the task stage",
      );
      const moveTarget = moveStageTarget(option, project.stages, input.taskKey);
      if (!moveTarget.ok) throw AppError.conflict(moveTarget.refusal);
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        // F33-2 again: the move runs after this write and can refuse, and its
        // own transition event (or the refusal note) carries the outcome.
        text: option.ev ?? `**Decision:** ${option.t}.`,
        toAgent: false,
        evidence: null,
      };
      // The block the packet held down goes with it, exactly as every sibling
      // arm does (`block_on_policy`, the send-back default, the collision
      // ceremony's `liftBlock`, the operator's withdrawal). `transitionStage`
      // deliberately lets a stored `blocked` survive a move, so leaving it
      // here left the board showing a blocked task with no packet on it and
      // nothing a person could do about it — which is the shape KNC-16 opened
      // this kind for.
      mutate = (fm) => {
        if (fm.readiness === "blocked") fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    case "create_task": {
      // Ruling 269 (F37-101): the decision IS the new task. Everything the
      // resolution needs is on the option; the creation itself runs AFTER this
      // write, through `createTask` — the same door the board and both
      // toolkits use, so the key allocation, the goal-header shape, the
      // dependency validation and the auto-invoke are the ones every other
      // caller gets (ruling 164: an option performs the real action through
      // the real door).
      const spec = option.newTask;
      if (!spec || spec.title.trim() === "" || spec.goal.trim() === "") {
        throw AppError.conflict(
          `"${option.t}" carries no task to create, so confirming it would create nothing. ` +
            `Ask the operator to offer the option again with the task's title and goal.`,
        );
      }
      event = {
        occurredAt: now,
        type: "note",
        actor: human,
        title: null,
        // Ruling 322: the second sentence used to say `${key} is unchanged`
        // unconditionally, and `newTask.blocks` may name this very task.
        text:
          option.ev ??
          `**Decision:** ${option.t}. A new task is being created for it: "${spec.title}". ` +
            (createTaskHoldsDecider(spec, key)
              ? `${key} will wait on it, and is released when it is done.`
              : `${key} is unchanged; the new task carries the work.`),
        toAgent: false,
        evidence: null,
      };
      // A deliberate NO-OP mutation HERE. Every sibling flips a field — the
      // `waiting` stamp, a stage, a disposition — and flipping one would be
      // this write claiming a reach it does not have.
      //
      // Ruling 322: that is not the same as "this task is unchanged". When
      // `newTask.blocks` names this task (ruling 287's reverse edge), the
      // resolution below writes the new key into its `blockedBy` through
      // `setTaskDependencies` — the task's own editor — which is where a wait
      // belongs. What this arm must not do is pretend the wait is not coming;
      // the sentence above says which of the two happened.
      mutate = () => {};
      clearPacket = true;
      break;
    }
    case "block_on_dependencies": {
      // Ruling 230 (F37-50): the decision IS the wait. `blockedBy` is ruling
      // 131's mechanism and it is already good — the board renders it, the
      // schedule runner refuses on it, and the dependency release re-triggers
      // the operator when the last entry finishes. It simply could not be
      // reached from a packet, so an operator wanting a hold picked
      // `block_on_policy`, whose resolution UNBLOCKS, and the record read
      // "SHOP-11 is unblocked" under an option titled "Hold SHOP-11 while…".
      //
      // The list is written AFTER this write, through `setTaskDependencies` —
      // the same door the operator's own tool and the task page use, so the
      // canonicalisation and the "Dependencies updated"
      // note are the ones every other caller gets (ruling 164: an option
      // performs the real action through the real door).
      const entries = (option.blockedBy ?? []).filter((e) => e.trim() !== "");
      if (entries.length === 0) {
        throw AppError.conflict(
          `"${option.t}" names nothing to wait on, so there is no hold to record. ` +
            `Ask the operator to offer the option again with the tasks this one waits on.`,
        );
      }
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. ${key} waits on ${entries.join(", ")}; nothing runs on it ` +
            `until every entry is done, and Viberr releases it then.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        // Deliberately `human`, not `none`: the dependency write below is what
        // earns `none` (it settles the flag itself once nothing is pending). If
        // it fails, the task is left visibly on a person rather than silently
        // idle with no hold and no owner.
        fm.waiting = "human";
      };
      clearPacket = true;
      break;
    }
    case "wait_for_window": {
      // Ruling 224 (F37-44): the decision IS the wait. The packet closes and
      // the task settles on a human, because nothing is running and nothing
      // should look like it is; the schedule written after this write is what
      // brings the agent back. Authored only on a quota refusal whose reset
      // instant the provider gave us.
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          option.ev ??
          `**Decision:** ${option.t}. Nothing runs until the window reopens; the scheduled run brings the agent back.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        // Not `waiting: agent`: no agent is coming for the next few hours, and
        // a board that claims one is the F37-33 lie by another road.
        fm.waiting = "human";
        if (fm.readiness === "blocked") fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    case "accept_unverified_head": {
      // Ruling 226 (F37-43): the deliberate way past a head GitHub would not
      // compare. It is NOT force-accept and must not borrow its door — that one
      // bypasses the VERDICT gate and cannot touch this one. This waives a
      // single containment check, for a single (PR, delivered revision, live
      // head) triple, and the authority it asks for is the acceptance it is
      // about to make possible.
      requireAction(
        db,
        project,
        actor,
        "accept-completion",
        "accept a completion whose PR head could not be checked",
      );
      // Re-read live before granting anything. The refusal this packet answers
      // is a transient-shaped failure, and the honest outcome when it has
      // cleared is to grant NO waiver and say the check ran — a waiver written
      // on a check that would now pass is a permission nobody needed.
      const recheck = await acceptancePrHeadCheck(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
      );
      if (!recheck.refusal) {
        event = {
          occurredAt: now,
          type: "transition",
          actor: human,
          title: null,
          text:
            `**Decision:** ${option.t}. On re-reading, GitHub answered the comparison this ` +
            `time, so no override was recorded and ${key} can be accepted normally.`,
          toAgent: false,
          evidence: null,
        };
        mutate = (fm) => {
          fm.waiting = "human";
          if (fm.readiness === "blocked") fm.readiness = "ready";
        };
        clearPacket = true;
        break;
      }
      // Still refusing, but without the three facts there is nothing to pin a
      // waiver to, and an unpinned one would be a standing permission to merge
      // whatever that branch later carries.
      if (
        !recheck.liveHeadSha ||
        recheck.prNumber === null ||
        !recheck.revisionHeadSha
      ) {
        throw AppError.conflict(
          `${key}'s pull request or delivered revision is no longer readable, so there is ` +
            `nothing to record this override against. Refresh the task and try again.`,
        );
      }
      const waivedHead = recheck.liveHeadSha;
      const waivedRevision = recheck.revisionHeadSha;
      const waivedPr = recheck.prNumber;
      const waiverUserId = actor.userId ?? null;
      if (!waiverUserId) {
        throw AppError.conflict(
          `Only a signed-in person can accept ${key} without the containment check.`,
        );
      }
      const waiverLabel = userDisplayName(db, waiverUserId) ?? "";
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        // The record states the CONSEQUENCE, not the check. A9's note named
        // the check that did not run, which reads as a formality; what this
        // decision actually admits is that unreviewed code may land.
        text:
          `**Decision:** ${option.t}. PR #${waivedPr} may be merged at head ` +
          `\`${waivedHead.slice(0, 7)}\` without confirming it contains the reviewed ` +
          `revision \`${waivedRevision.slice(0, 7)}\`. Code no reviewer approved may reach ` +
          `the base branch. The override applies to this head only: if the branch moves, ` +
          `the check is required again.`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.headCheckWaiver = {
          prNumber: waivedPr,
          revisionHeadSha: waivedRevision,
          liveHeadSha: waivedHead,
          at: now,
          byUserId: waiverUserId,
          byLabel: waiverLabel,
        };
        fm.waiting = "human";
        if (fm.readiness === "blocked") fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    case "connect_repository": {
      // Ruling 672: the decision IS the connection. The repository the person
      // typed is attached HERE, before the write that clears the packet,
      // through the Change door (ruling 669): GitHub confirms it or the door
      // refuses in its own words, and a refusal leaves the question open with
      // nothing recorded. Attaching is the board's policy, so it asks for the
      // tier that door asks for. On a task the answer reached from another
      // one (ruling 319's fan-out) nothing is attached twice.
      requireAction(db, project, actor, "edit-policy", "connect a repository to this board");
      const { connectRepositoryFromPacket } = await import("./repository-ask.server");
      const connected = await connectRepositoryFromPacket(
        db,
        ctx,
        {
          projectSlug: input.projectSlug,
          typed: noteText,
          answeredElsewhere: input.fanOutOrigin !== undefined,
        },
        actor,
      );
      if (input.fanOutOrigin === undefined) {
        repositoryConnection = { repo: connected.repo, attached: connected.attached };
      }
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text: `**Decision:** ${option.t}. ${connected.sentence}`,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "agent";
        fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    case "keep_without_repository": {
      // Ruling 672: the decision is written into the project's rulings
      // knowledge base before the packet clears, because that document is
      // what stops the question being asked again: a decision recorded here
      // and not there would be asked on the next task. It is the board's
      // policy too, so the same tier.
      requireAction(
        db,
        project,
        actor,
        "edit-policy",
        "decide that this board keeps no repository",
      );
      const { keepWithoutRepositoryFromPacket } = await import("./repository-ask.server");
      const ruling = await keepWithoutRepositoryFromPacket(
        db,
        ctx,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          byName: human.nameHint,
          at: now,
          answeredElsewhere: input.fanOutOrigin !== undefined,
        },
        actor,
      );
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          `**Decision:** ${option.t}. It is in the project's rulings (\`${ruling.kb}/${ruling.doc}\`): ` +
          "tasks on this board come back as files, and the operator does not ask again.",
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "agent";
        fm.readiness = "ready";
      };
      clearPacket = true;
      break;
    }
    default: {
      // request_edit | redirect | custom — send back to the agent side.
      // Ruling 163 (pass 35, F35-13 (b)): a redirect the branch-conflict
      // packet marked `rework` RETURNS a task standing at or past the review
      // stage to that stage in this same write, so the resolved revision gets
      // its verdict where the reviewers are eligible. KNC-20 sat at Merge
      // after its conflict rework with no reviewer able to run there; a human's
      // off-graph stage move was the only way out and nothing named it.
      const returnStage =
        option.kind === "redirect" && option.rework === true
          ? await verdictStageOf(ctx, input.projectSlug, project, existing.parsed.frontmatter)
          : null;
      const returnNote =
        returnStage !== null
          ? ` ${key} returns to ${stageName(project, returnStage)} so the resolved revision gets its verdict there.`
          : "";
      event = {
        occurredAt: now,
        type: "transition",
        actor: human,
        title: null,
        text:
          (option.ev ??
            // Ruling 562: an agent's question is answered back to that agent
            // when it can run, and to the operator when it cannot; the events
            // that follow say which. Its record names the decision only.
            (packet.kind === AGENT_QUESTION_PACKET_KIND && packet.askedBy?.trim()
              ? `**Decision:** ${option.t}.`
              : `**Decision:** ${option.t}. Operator re-engages the specialist with a summon note.`)) +
          returnNote,
        toAgent: false,
        evidence: null,
      };
      mutate = (fm) => {
        fm.waiting = "agent";
        fm.readiness = "ready";
        if (returnStage !== null && fm.stage !== returnStage) {
          fm.previousStageId = fm.stage;
          fm.stage = returnStage;
        }
      };
      if (returnStage !== null) {
        recordAudit(db, {
          action: "task.transition",
          actor: { userId: actor.userId, label: actor.label },
          subjectKind: "task",
          subjectId: input.taskKey,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          details: {
            from: existing.parsed.frontmatter.stage,
            to: returnStage,
            boundary: "rework",
            via: "packet_redirect",
          },
        });
      }
      clearPacket = true;
      break;
    }
  }

  // Ruling 189 (pass 37, F37-10): the sentence a person's decision adds to the
  // task's goal, or null when this resolution is not an answer that binds
  // future work.
  //
  // Skipped for a resolution that ENDS the task (an acceptance, an archive):
  // there is no future run to bind, and a closed task's goal should read as it
  // did when the work was done. Skipped for the operator's own withdrawal,
  // which is not a person's answer. Everything else — a chosen option, a custom
  // directive — is an instruction the next run must see, and the last clause
  // says which way the contradiction it may create resolves.
  //
  // Only an answer that binds future WORK belongs in the contract. A recovery
  // choice — "try again", "redirect", "retry on the other backend", "hold while
  // I debug", "clear the stale remote branch" — decides what happens NEXT, not
  // what the work IS, and appending those accumulates process noise in the text
  // every future run re-anchors on. Live on SHOP-7 the goal collected two
  // blocks: the provider decision (contract) and "Work stalled: pick a recovery
  // path → Redirect with sharper guidance" (not).
  //
  // Ruling 284 (owner's call, 2026-09-15) draws the second line by CHANNEL:
  // choosing a structured option is a decision and amends the contract; typing
  // free text is conversation and does not. The old rule was the opposite — a
  // typed directive "always binds, whatever packet it was typed on, because a
  // person wrote it" — and it made the kind of the answer unknowable, because
  // one text box takes both a scope decision and a word to the operator about
  // its own tooling. Live the same hour it was written: SHOP-27's packet was
  // answered with a directive that was mostly "call read_board before you offer
  // a create_task option", and that sentence is now welded into the goal of the
  // orders service, where every future run on it re-anchors on a note about
  // another actor's tools. Nothing is lost by leaving it out: the directive is
  // written verbatim to the timeline, and it reaches the operator in its own
  // `note` field on the re-queue, which is the channel it was actually for.
  // Ruling 189 / 284: the list is module-scope and exported now (ruling 329).

  // Ruling 189 excludes "a resolution that ENDS the task", and `acceptsInto`
  // catches only ONE of the two doors that do: `force_accept` closes the task
  // through `forceAcceptCompletion` and never assigns it (ruling 200(h)). A
  // contract amendment on a task being closed in the same breath binds no
  // future run's work, which is the whole test the exclusion applies.
  const endsTheTask = acceptsInto !== null || option.kind === "force_accept";
  const goalAnswer: string | null =
    endsTheTask ||
    !clearPacket ||
    customDirective !== "" ||
    PROCESS_ONLY_OPTION_KINDS.has(option.kind)
      ? null
      : [option.t, option.d].filter((part) => part.trim()).join(": ");
  const goalAmendment: string | null =
    goalAnswer === null
      ? null
      : `---\n\n` +
        `**Decision: ${now.slice(0, 10)}, ${human.nameHint} answered “${packet.title}”:**\n\n` +
        `${goalAnswer}\n\n` +
        `${CONTRACT_CLAUSE} Where anything ` +
        `above contradicts it, the decision wins: it was made by the person the ` +
        `question was put to, and it is not an agent overstepping.`;

  // U3 (NFR16): set when the acceptance arm found the task already terminal
  // under the lock — the write, and the audit row that belongs to it, are the
  // racing acceptance's, not this call's.
  let alreadyAccepted = false;
  const decisionWritten = updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // U3 (NFR16) — the acceptance arm's already-Done check, where it is a
    // decision rather than a guess. `acceptCompletion` re-runs it inside the
    // write lock (`applyAcceptanceWrite`) precisely because its own outside-lock
    // read is stale by the time the merge returns; this arm writes Done through
    // its own mutate and never had that second look, so a task another
    // acceptance closed during the merge await was met with a 409 about the
    // packet — a refusal for an outcome that HAD happened. Skip the write whole
    // instead: the racing acceptance already recorded the completion, the merge
    // and the audit. Every other option kind keeps the conflicts below (they
    // resolve a decision rather than assert a state that may already hold).
    if (acceptsInto !== null && parsed.frontmatter.stage === acceptsInto) {
      alreadyAccepted = true;
      return;
    }
    if (!parsed.packet) {
      // Raced with a concurrent resolve inside the lock window.
      throw AppError.conflict("This packet was already resolved.");
    }
    // F10-09: the packet in the file must be the SAME one we read and validated
    // the option against. A replacement (opened during our await) has a
    // different identity — reject rather than apply the stale choice to it.
    if (packetIdentity(parsed.packet) !== resolvedPacketIdentity) {
      throw AppError.conflict(
        "This decision was replaced by a newer one. Refresh the task and choose again.",
      );
    }
    mutate(parsed.frontmatter, parsed.timeline);
    // Ruling 189 (pass 37, F37-10): a person's decision joins the task's
    // CONTRACT, not just its timeline.
    //
    // Live on SHOP-7: the goal said "the agent must not select a provider …
    // ask Arda to choose". Arda chose. The agent recorded the choice, the
    // required reviewer re-anchored on the canonical file — as its prompt tells
    // it to — found the deliverable contradicting the goal, and requested
    // changes; the operator then told the agent to "remove every claim that
    // mock-only was selected", and a second packet asked Arda the same question
    // again. Answer → act → rejected against the stale goal → reverted → asked
    // again, with no exit inside the mechanism.
    //
    // The timeline is where the decision LIVED and the goal is what every fresh
    // run READS, so the goal won. Appending it here, in the same locked write
    // that clears the packet, needs no model judgement and cannot be forgotten
    // by a turn that fails or is interrupted.
    // O39-b: a decision the contract already holds, to the same question,
    // is not written again. Live on ax-clone AX-22 a review deadlock asked
    // round after round, and every "Let the rework continue" answer appended
    // the same block: four copies in the text every fresh run re-anchors on.
    // Each answer is still on the timeline, and ruling 415 carries every one
    // to the operator.
    if (
      goalAmendment &&
      goalAnswer !== null &&
      !contractHoldsDecision(parsed.goal, packet.title, goalAnswer)
    ) {
      parsed.goal = `${parsed.goal.trimEnd()}\n\n${goalAmendment}`;
    }
    if (clearPacket) parsed.packet = null;
    // Ruling 160 (pass 35, F35-11): a PERSON answering a packet while the
    // task's pull request stands closed without merging is the answer to that
    // closure, whichever option they chose (rework, archive, a redirect): the
    // next delivery may open a fresh PR for the branch. The operator's own
    // withdrawal of a packet (`resolve_decision_packet`) is not a person's
    // answer and stamps nothing.
    // The answer is recorded even when no closure record exists yet: the gate
    // that refuses delivery keys on `state: "closed"`, and `closed` also reaches
    // the file from the workspace reconcile, which records no closure. Without
    // this the person's answer would have nothing to stamp and the refusal
    // would outlive every decision they can make.
    const closedPr = parsed.frontmatter.pr;
    const closure = closedPr?.state === "closed" ? (closedPr.closure ?? null) : null;
    if (
      closedPr?.state === "closed" &&
      (closure === null || closure.answered === null) &&
      !ctx.operatorAuthorized
    ) {
      const answered = { at: new Date().toISOString(), byUserId: actor.userId };
      if (closure) closure.answered = answered;
      else closedPr.closure = { at: answered.at, by: null, answered };
    }
    // V18: a resolved decision is a human re-litigating the task's direction —
    // a recorded deliberate hold no longer speaks for them.
    parsed.frontmatter.heldAtStage = null;
    // edit_goal keeps the packet but marks the decision made — updateTaskGoal
    // clears it when the edited goal lands.
    if (option.kind === "edit_goal" && parsed.packet) {
      parsed.packet.awaiting = "goal_edit";
      // Ruling 138: the packet records WHICH option was chosen, so a reload
      // renders it decided and rebuilds the same goal draft.
      parsed.packet.decided = {
        optionIndex: input.optionIndex,
        at: new Date().toISOString(),
        byUserId: actor.userId,
      };
    }
    // P11-71: carry the human's free-text into the recorded decision so an
    // option that asked for input isn't resolved with an unstated reading — the
    // operator (and reviewers reading the timeline) see exactly what was said.
    // A custom answer IS that free-text: the directive rides the same channel.
    const note = customDirective || input.note?.trim();
    const eventWithNote = note
      ? { ...event, text: `${event.text}\n\n> ${note.replace(/\n/g, "\n> ")}` }
      : event;
    parsed.timeline.unshift(eventWithNote);
  });
  try {
    await decisionWritten;
  } catch (error) {
    // Ruling 672: a `connect_repository` answer attaches before this write,
    // and GitHub is asked in between. When the packet was answered or
    // replaced meanwhile, the write refuses for a change that happened: the
    // connection is settled as one made outside any task, and the refusal
    // says the repository is connected.
    if (repositoryConnection?.attached) {
      const { connectionOutlivedItsDecision } = await import("./repository-ask.server");
      throw await connectionOutlivedItsDecision(
        db,
        ctx,
        { projectSlug: input.projectSlug, taskKey: input.taskKey, repo: repositoryConnection.repo },
        actor,
        toError(error),
      );
    }
    throw error;
  }
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  // U3: one act, one row. A no-op write made no decision to record.
  if (!alreadyAccepted) {
    recordAudit(db, {
      action: "task.packet.resolved",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        optionKind: option.kind,
        optionTitle: option.t,
        packetKind: packet.kind,
      },
    });
  }

  // Ruling 164 + ruling 152(c) (pass 35, cluster review): the two options that
  // say the spent window is over — the specialist's "The window has reset …,
  // or the Codex account changed: send @dev back to continue" and the
  // operator's "The usage window has reset …, or I switched the Codex account:
  // re-run" — are the person's statement that the instance's exhaustion record
  // is stale. Nothing else retires that record: it is cleared only by a run
  // that COMPLETES on the backend, and the dispatch hold stops any run from
  // starting until the recorded instant passes, so the option resolved, the
  // operator was re-queued, its dispatch was held again and the stated remedy
  // was overridden by the record it contradicts. That matters most when the
  // record is wrong: a reset time the provider gave as a bare clock reading is
  // resolved to the next occurrence, so an observation past that time parks the
  // account until tomorrow. The option names the backend it asserts about
  // (`run-failure-remedy.server.ts`); no other kind carries one but
  // `retry_other_backend`, which names the OTHER backend and is handled above.
  if (
    (option.kind === "request_edit" || option.kind === "block_on_policy") &&
    option.backend
  ) {
    const { clearBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    clearBackendQuotaExhaustion(db, option.backend);
  }

  // R20-1 (F20-5): every settled decision consumes the packet approval. Holds
  // no longer keep their packet open, so the ONLY kind that leaves it open is
  // `edit_goal` (awaiting the edited goal) — and that is a made decision too, so
  // the approval is read in every case. (Was gated on `!clearPacket`, which now
  // reduces to exactly this set.)
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  // Ruling 547: a packet this answer cleared leaves the page, so its rows open
  // the decision's own entry. An `edit_goal` answer keeps its packet, decided,
  // until the goal lands; a write the racing acceptance owned cleared nothing.
  if (clearPacket && !alreadyAccepted) {
    followClosedDecision(db, input.projectSlug, input.taskKey, {
      packetId: packet.id,
      closedAt: event.occurredAt,
    });
  }

  // R20-1 (F20-5): EVERY settled decision hands the task back to the operator,
  // not just the three send-back kinds. The exceptions are the options that end
  // the task's coordination or start their own run.
  const NO_REQUEUE: string[] = [
    "accept_completion", // the task is Done
    "archive_task", // the task left the board
    "edit_goal", // the packet is still open, awaiting the goal
    "hold_runtime_debug", // the human explicitly asked for no run (§1.2)
    // Ruling 230: the decision is that nothing runs until the dependencies
    // clear. Re-invoking the operator would only pay a drive to rediscover the
    // wait it was just told about — JC-9's five runs, and the same reason
    // ruling 131(d) refuses the held triggers at the door.
    "block_on_dependencies",
    "retry_other_backend", // starts a specialist run above; its completion re-invokes
    "discard_branch", // cleanup only, no coordination change
    "resolve_remote_collision", // the re-delivery's own machinery owns the follow-up
    "deliver_for_review", // ruling 489: the same, with one hand-off after the delivery
    // Ruling 164 (pass 35, F35-14): the task is Done (the acceptance below),
    // and the move re-invokes the operator at the stage it lands on
    // (`transitionStage`), so a second hand-off here would pay for a duplicate
    // turn on the stage the first one is already reading.
    "force_accept",
    "move_stage",
    // Ruling 224 (F37-44): the decision IS that nothing runs until the window
    // reopens, and the schedule written above is what brings the operator
    // back. Re-invoking it here spends a run against the very quota the human
    // just chose to wait out, gets refused, and opens a NEW packet asking the
    // same question — so answering the packet re-created it, in a loop. Live
    // on SHOP-18 at 00:05:50, seven seconds after the decision was recorded.
    "wait_for_window",
    // Ruling 237 (F37-57): starts the reviewer's run below, exactly like
    // `retry_other_backend`; its completion re-invokes the operator with the
    // answer in hand. Re-invoking here would put the operator on the task
    // while the question it is supposed to wait for is still unanswered, which
    // is the behaviour this packet exists to interrupt.
    "question_reviewer",
    // Ruling 672: the answer alone does not make the board able to deliver.
    // `carryOnAfterConnection` starts each answered task's operator, after
    // the fan-out, at the moment it can do something with the repository.
    "connect_repository",
  ];
  const requeue = !NO_REQUEUE.includes(option.kind);
  if (requeue) {
    const decisionNote = customDirective || input.note?.trim();
    const resolvedOption = decisionNote
      ? { kind: option.kind, title: option.t, note: decisionNote }
      : { kind: option.kind, title: option.t };
    // R15-14: when an AGENT raised this question (request_edit / redirect /
    // custom on an "Agent question" packet), the answer belongs to that agent,
    // not to a courier. Route it to the asker first, through the same machinery
    // an @mention reply uses (resume the provider session, re-apply confinement,
    // re-anchor on task.md). The operator still runs afterwards to coordinate;
    // it just stops being the only way the answer travels.
    const sentBackToAgent =
      option.kind === "request_edit" ||
      option.kind === "redirect" ||
      option.kind === "custom";
    let answeredAsker = false;
    if (sentBackToAgent) {
      const askedBy =
        packet.kind === AGENT_QUESTION_PACKET_KIND
          ? (packet.askedBy?.trim() ?? "")
          : "";
      if (askedBy) {
        // Ruling 447 (O39-a): an answer that names another actor goes to the
        // operator, which routes it; only an answer for the asker goes back.
        const { listDeployedSpecialists } = await import("./specialist-roster.server");
        const { agentMentionHandle } = await import("./agent-reply.server");
        const deployed = listDeployedSpecialists(
          input.projectSlug,
          ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {},
        ).map((a: { id: string; name: string }) => ({
          id: a.id,
          name: a.name,
          handle: agentMentionHandle({ profileId: a.id, name: a.name }),
        }));
        // The person's words: the option they chose and anything they typed.
        // Never the option's description, which the ASKER wrote, and which
        // narrates what happens next ("the operator then moves it to
        // Verify") as often as it names who should act.
        const routedTo = answerNamesAnotherActor(
          [option.t, decisionNote ?? ""].join("\n"),
          askedBy,
          deployed,
        );
        if (routedTo) {
          const askerName = deployed.find((a) => a.id === askedBy)?.name ?? askedBy;
          await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), {
            occurredAt: new Date().toISOString(),
            type: "note",
            actor: { kind: "system", systemId: "policy-engine" },
            title: null,
            text:
              `The answer names ${routedTo}, so it went to the operator to route, ` +
              `not back to ${askerName}, who asked.`,
            toAgent: false,
            evidence: null,
          });
          reprojectTask(db, ctx, input.projectSlug, input.taskKey);
        } else {
          const answer: Parameters<typeof answerAskingAgent>[2] = {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            profileId: askedBy,
            question: packet.title,
            decision: option.t,
          };
          if (decisionNote) answer.note = decisionNote;
          answeredAsker = await answerAskingAgent(db, ctx, answer, actor);
        }
      }
    }
    // No asker (an operator/policy packet), or its session is gone / the profile
    // was undeployed — hand off to the operator with the dedicated
    // `packet-resolved` trigger so the turn instruction names the decision
    // instead of narrating a stage move (the old `transition` lie).
    if (!answeredAsker) {
      void autoInvokeOperator(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        "packet-resolved",
        { resolvedOption },
      );
    }
  }

  // OBS-11: the same cleanup the Accept button runs, on the acceptance door
  // that skipped it. Skipped when the write itself was skipped (U3): a racing
  // acceptance owns the branch as well as the completion record, so running it
  // here too would delete the branch twice for one close. Every non-acceptance
  // arm leaves the disposition `none`, which the helper returns on immediately.
  if (!alreadyAccepted) {
    await cleanUpEmptyTaskBranch(db, ctx, input, branchDisposition, actor);
  }

  // archive_task: the decision IS the archive — run the real R14-3 contract
  // (schedules cancelled, recommendations withdrawn, reversible, audited) and
  // then the optional remote-branch cleanup. The archive gate already ran
  // inside the case above, so this cannot 403 after the packet cleared. Branch
  // deletion is best-effort: an archive whose cleanup failed is still an
  // archive, and every non-success outcome lands on the timeline in plain
  // words (the delete helper writes its own `github` event on success).
  if (option.kind === "archive_task") {
    await setTaskArchived(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, archived: true },
      actor,
      ctx,
    );
    if (option.deleteBranch && actor.userId) {
      const { deleteTaskRemoteBranch } = await import(
        "~/server/github/github-reconciler.server"
      );
      // Ruling 136(c): this door now pays the live re-confirm of a cached open
      // PR, so the transport hook is threaded like every other GitHub call.
      const archiveDeleteCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
      if (ctx.fetchImpl) archiveDeleteCtx.fetchImpl = ctx.fetchImpl;
      const outcome = await deleteTaskRemoteBranch(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        { userId: actor.userId, label: actor.label },
        archiveDeleteCtx,
      );
      const outcomeText =
        outcome.status === "deleted"
          ? null
          : outcome.status === "already_gone"
            ? `Branch \`${outcome.branch}\` was already gone on GitHub: nothing left to delete.`
            : outcome.status === "no_branch"
              ? "The task has no delivery branch, so there is nothing to delete."
              : outcome.status === "refused"
                ? `Branch \`${outcome.branch}\` was **not** deleted: ${outcome.message}`
                : "The branch was **not** deleted: this project has no GitHub repo or credential configured.";
      if (outcomeText) {
        await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
          text: outcomeText,
        });
      }

      // F20-24: `deleteTaskRemoteBranch` removes only the REMOTE ref — the local
      // workspace commit survived, so "discard work" was a lie: "Restore from
      // archive" re-offered an ENABLED "Deliver branch & open PR" that would
      // re-push the abandoned work and open a fresh PR. Discard the local branch
      // too and clear `fm.branch`, so the discarded work exists nowhere and the
      // restored task shows no phantom branch row. Skipped only when the remote
      // deletion was REFUSED (an open PR / the default branch — the work is
      // deliberately KEPT). `discardLocalTaskBranch` keeps ruling 17's own guard:
      // a branch still reachable on the remote is never removed here.
      const localBranch = existing.parsed.frontmatter.branch;
      if (localBranch && outcome.status !== "refused") {
        const defaultBranch =
          readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot })
            ?.parsed.frontmatter.defaultBranch || "main";
        const { discardLocalTaskBranch } = await import(
          "~/server/github/push-workspace.server"
        );
        const discard: Parameters<typeof discardLocalTaskBranch>[0] = {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          branch: localBranch,
          defaultBranch,
          // The ruling-17 "is it on origin?" check needs the project's PAT, or
          // it cannot answer on a private repo.
          db,
        };
        if (ctx.dataRoot) discard.dataRoot = ctx.dataRoot;
        const local = await discardLocalTaskBranch(discard);
        if (local.status === "deleted") {
          // Ruling 161 (pass 35, U35-8): the remote head the delete removed,
          // read live by `deleteTaskRemoteBranch` before its DELETE. KNC-21's
          // audit named the LOCAL head (8c463b7) as what was discarded while
          // the ref it deleted held a foreign commit; both heads are recorded.
          const remoteSha = outcome.status === "deleted" ? outcome.remoteSha : null;
          await updateTaskFile(
            taskRef(ctx, input.projectSlug, input.taskKey),
            (parsed) => {
              if (parsed.frontmatter.branch === local.branch) {
                parsed.frontmatter.branch = null;
              }
              parsed.timeline.unshift({
                occurredAt: new Date().toISOString(),
                type: "note",
                actor: { kind: "system", systemId: "policy-engine" },
                title: null,
                text:
                  `The local workspace branch \`${local.branch}\` (\`${local.sha.slice(0, 12)}\`) ` +
                  `was discarded too, so "discard work" now leaves no commit to re-deliver.` +
                  (remoteSha && remoteSha !== local.sha
                    ? ` Origin's copy stood at \`${remoteSha.slice(0, 12)}\`, a different head, and is gone with it.`
                    : ""),
                toAgent: false,
                evidence: null,
              });
            },
          );
          reprojectTask(db, ctx, input.projectSlug, input.taskKey);
          recordAudit(db, {
            action: "task.branch.discarded",
            actor: { userId: actor.userId, label: actor.label },
            subjectKind: "task",
            subjectId: input.taskKey,
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            details: {
              branch: local.branch,
              localSha: local.sha,
              remoteSha,
              basis: "archive_cleanup",
            },
          });
        }
      }
    }
  }

  // discard_branch (R20-2 / F20-6): the decision IS the branch discard. The
  // operator that authored the option holds no repo-write tool, so its option
  // was inert (F20-6: the human had to `git branch -D` by hand) — the confirm
  // now executes it. Best-effort like the archive cleanup above: a failed
  // discard never un-resolves the packet, and every outcome lands one honest
  // timeline note. `fm.branch` is cleared ONLY when the branch we really deleted
  // is still the one the frontmatter names.
  if (option.kind === "discard_branch") {
    const branch = existing.parsed.frontmatter.branch;
    if (!branch) {
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        text: "This task has no workspace branch, so there is nothing to discard.",
      });
    } else {
      const defaultBranch =
        readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot })
          ?.parsed.frontmatter.defaultBranch || "main";
      const { discardLocalTaskBranch } = await import(
        "~/server/github/push-workspace.server"
      );
      const discard: Parameters<typeof discardLocalTaskBranch>[0] = {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        branch,
        defaultBranch,
        // As above: the remote check needs the project's PAT to answer on a
        // private repo, and refuses rather than guessing when it cannot.
        db,
      };
      if (ctx.dataRoot) discard.dataRoot = ctx.dataRoot;
      const outcome = await discardLocalTaskBranch(discard);
      // Ruling 161 (pass 35, G35-6): the discard RETIRES the revision the
      // agent reported on that branch. The record stays (`kind: discarded`,
      // verdicts kept as history) so no reviewer can pin a verdict to a head
      // that no longer exists, and `validation` re-derives to `none`. A
      // `verified` revision names the base sha, not this branch, and stays.
      const revisionBefore = existing.parsed.frontmatter.workRevision;
      const retires =
        outcome.status === "deleted" &&
        revisionBefore !== null &&
        revisionBefore.kind !== "verified" &&
        revisionBefore.kind !== "discarded" &&
        (revisionBefore.branch === null || revisionBefore.branch === outcome.branch)
          ? revisionBefore
          : null;
      const noteText =
        outcome.status === "deleted"
          ? `Branch \`${outcome.branch}\` (\`${outcome.sha.slice(0, 12)}\`) was deleted from this ` +
            `task's workspace. It existed only there: nothing was pushed to GitHub, so nothing on ` +
            `the remote changed.` +
            (retires
              ? ` Revision \`${retires.id}\` (\`${retires.headSha.slice(0, 7)}\`) is retired with it: ` +
                `its verdicts stay on the record as history, and the task has no revision under review.`
              : "")
          : outcome.status === "not_found"
            ? `Branch \`${outcome.branch}\` was not in this task's workspace, so there was nothing to discard.`
            : outcome.status === "on_remote"
              ? `Branch \`${outcome.branch}\` was **not** discarded: it exists on GitHub, so it is ` +
                `no longer a local-only branch. Use archive with branch deletion to remove a pushed branch.`
              : outcome.status === "no_workspace"
                ? `Branch \`${outcome.branch}\` was **not** discarded: this task has no workspace clone.`
                : `Branch \`${outcome.branch}\` was **not** discarded: ${outcome.reason}`;
      await updateTaskFile(
        taskRef(ctx, input.projectSlug, input.taskKey),
        (parsed) => {
          if (
            outcome.status === "deleted" &&
            parsed.frontmatter.branch === outcome.branch
          ) {
            parsed.frontmatter.branch = null;
          }
          const rev = parsed.frontmatter.workRevision;
          if (retires && rev && rev.id === retires.id) {
            rev.kind = "discarded";
            parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
          }
          parsed.timeline.unshift({
            occurredAt: new Date().toISOString(),
            type: "note",
            actor: { kind: "system", systemId: "policy-engine" },
            title: null,
            text: noteText,
            toAgent: false,
            evidence: null,
          });
        },
      );
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      recordAudit(db, {
        action:
          outcome.status === "deleted"
            ? "task.branch.discarded"
            : "task.branch.discard_refused",
        actor: { userId: actor.userId, label: actor.label },
        subjectKind: "task",
        subjectId: input.taskKey,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        details:
          outcome.status === "deleted"
            ? {
                branch: outcome.branch,
                localSha: outcome.sha,
                // Ruling 161: a local-only discard touched no remote head.
                remoteSha: null,
                basis: "local_only",
                retiredRevisionId: retires?.id ?? null,
              }
            : { branch, status: outcome.status },
      });
    }
  }

  // resolve_remote_collision (F31-6, ruling 136): the decision IS the remedy —
  // delete the stale remote branch, close the recorded unowned PR, re-deliver
  // this task's local work — and the ceremony ends with EXACTLY ONE hand-off.
  // Each step is best-effort AFTER the resolution write (the decision stands
  // even when GitHub misbehaves) and every non-success lands on the timeline
  // in plain words. The kind stays out of the generic `packet-resolved`
  // re-queue above (that hand-off runs before the ceremony and could not carry
  // its outcome): the ceremony fires its own at its end, the ruling-48
  // `delivered` re-queue when the re-delivery fired it, otherwise a
  // `packet-resolved` re-queue whose payload carries the outcome in its OWN
  // field, never inside the human's quoted note.
  // P07-F (pass 32): no `&& actor.userId` guard — `resolveRemoteBranchCollision`
  // refuses a user-less actor itself ("No acting user.") and the refusal lands
  // on the timeline below.
  if (option.kind === "resolve_remote_collision") {
    const { resolveRemoteBranchCollision } = await import(
      "~/server/github/github-reconciler.server"
    );
    const collisionCtx: Parameters<typeof resolveRemoteBranchCollision>[3] = {
      dataRoot: ctx.dataRoot,
    };
    if (ctx.fetchImpl) collisionCtx.fetchImpl = ctx.fetchImpl;
    const collisionRef = { projectSlug: input.projectSlug, taskKey: input.taskKey };
    const collision = await resolveRemoteBranchCollision(
      db,
      collisionRef,
      { userId: actor.userId, label: actor.label },
      collisionCtx,
    );
    const branchName = existing.parsed.frontmatter.branch ?? "";
    let noteText: string | null = null;
    let delivered = false;
    let deliveredPr: number | null = null;
    let liftBlock = false;
    let operatorRequeued = false;
    let serverOutcome: CollisionServerOutcome;
    const outcomeOf = (
      outcome: CollisionServerOutcome["outcome"],
      facts: { prNumber?: number | null; reason?: string },
    ): CollisionServerOutcome => {
      const built: CollisionServerOutcome = { kind: "resolve_remote_collision", outcome };
      if (facts.prNumber !== undefined && facts.prNumber !== null) built.prNumber = facts.prNumber;
      if (facts.reason) built.reason = facts.reason;
      return built;
    };
    // The delivery door the task page uses (maintainer+/owner gate; the
    // approve-transition check above implies it for every resolver).
    const deliverNow = () => manualDeliverForReview(db, collisionRef, actor, ctx);
    if (collision.status === "cleared") {
      // The name is free again — re-deliver through the audited human door.
      const delivery = await deliverNow();
      if (delivery.status === "delivered") {
        delivered = true;
        deliveredPr = delivery.prNumber;
        liftBlock = true;
        operatorRequeued = delivery.operatorRequeued;
        serverOutcome = outcomeOf("cleared_and_delivered", { prNumber: delivery.prNumber });
      } else {
        noteText = `The stale remote branch was cleared, but the re-delivery did not complete: ${delivery.message} Deliver again from the task page when it is resolved.`;
        serverOutcome = outcomeOf("cleared_delivery_failed", { reason: delivery.message });
      }
    } else if (collision.reason === "own_pr_open") {
      // Ruling 136(b): the packet's premise was false — the PR on the branch is
      // this task's OWN review PR, so there is no collision to clear, and what
      // the person asked for is the work reaching that PR. For a remote that
      // is merely behind or absent, perform the delivery that pushes it (the
      // delivery is the authority on the relation: a diverged remote it meets
      // refuses as `push_conflict`, and the block stays). For a remote the file
      // already records as DIVERGED, keep the block and say who resolves the
      // history. A self-referencing collision record is cleared either way.
      const fmNow =
        readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter ?? null;
      const ownPr = collision.prNumber ?? fmNow?.pr?.number ?? null;
      const premise = `No collision to clear: PR #${ownPr} on \`${branchName}\` is ${input.taskKey}'s own review PR.`;
      if (fmNow?.github?.unownedPr != null && fmNow.github.unownedPr === ownPr) {
        await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
          if (parsed.frontmatter.github) {
            parsed.frontmatter.github.unownedPr = null;
            // Ruling 161: a self-referencing collision record named no foreign head.
            delete parsed.frontmatter.github.foreignHead;
          }
        });
      }
      const record = fmNow
        ? unpushedRevisionOf(fmNow.pr, activeWorkRevision(fmNow.workRevision)?.headSha ?? null)
        : null;
      if (record?.relation === "diverged") {
        const head = record.prHeadSha ? `\`${record.prHeadSha.slice(0, 7)}\`` : "its head";
        // Ruling 321: "a person resolves the branch history" names no act. The
        // one that works is the one the owner had to write into the project's
        // KB by hand after SHOP-11 — merge, never rewrite, once a pull request
        // tracks the branch.
        noteText = `${premise} Its remote copy (${head}) holds commits this workspace does not, so the delivered revision \`${record.revisionSha.slice(0, 7)}\` cannot be pushed as it stands. ${DIVERGED_BRANCH_REMEDY} Archiving the task is the other way out; the block stays until one of them happens.`;
        serverOutcome = outcomeOf("own_pr_diverged", {
          prNumber: ownPr,
          reason: "the remote branch holds commits this workspace does not",
        });
      } else {
        const delivery = await deliverNow();
        if (delivery.status === "delivered") {
          delivered = true;
          deliveredPr = delivery.prNumber;
          liftBlock = true;
          operatorRequeued = delivery.operatorRequeued;
          const sha = delivery.headSha ? ` \`${delivery.headSha.slice(0, 7)}\`` : "";
          const current = delivery.pushStatus === "up_to_date";
          noteText = current
            ? `${premise} It already carries the delivered revision${sha}; nothing needed pushing, and the block is lifted.`
            : `${premise} The delivered revision${sha} was pushed to it, and the block is lifted.`;
          serverOutcome = outcomeOf(current ? "own_pr_current" : "own_pr_pushed", {
            prNumber: delivery.prNumber,
          });
        } else {
          noteText = `${premise} The delivery that would push the delivered revision to it did not complete: ${delivery.message} The block stays.`;
          serverOutcome = outcomeOf("own_pr_delivery_failed", {
            prNumber: ownPr,
            reason: delivery.message,
          });
        }
      }
    } else {
      noteText = `The branch collision was **not** cleared: ${collision.message} Nothing was re-delivered.`;
      serverOutcome = outcomeOf("refused", { reason: collision.message });
    }
    if (noteText !== null || liftBlock) {
      await updateTaskFile(
        taskRef(ctx, input.projectSlug, input.taskKey),
        (parsed) => {
          // The push-conflict packet held `readiness: blocked` down with it, and
          // nothing in the delivery path writes readiness (the F29-7 withdrawal
          // can't either — the resolution write already cleared the packet). A
          // delivery that reached the PR falsifies the block, so lift it here;
          // on the refused/failed arms the block is still real and stays.
          // `waiting` stays "human": the resolver is present, and acceptance is
          // verdict-gated regardless.
          if (liftBlock && parsed.frontmatter.readiness === "blocked") {
            parsed.frontmatter.readiness = "ready";
          }
          if (noteText !== null) {
            parsed.timeline.unshift({
              occurredAt: new Date().toISOString(),
              type: "note",
              actor: { kind: "system", systemId: "policy-engine" },
              title: null,
              text: noteText,
              toAgent: false,
              evidence: null,
            });
          }
        },
      );
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    }
    // One audit row per ceremony, with its typed outcome.
    recordAudit(db, {
      action: "github.collision.resolved",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        outcome: serverOutcome.outcome,
        reason: serverOutcome.reason ?? null,
        prNumber: serverOutcome.prNumber ?? null,
        delivered,
        blockLifted: liftBlock,
      },
    });
    if (delivered && deliveredPr !== null) {
      // F32-7 (pass 32): `manualDeliverForReview` is the human's door, and
      // `performDelivery` records no next step for a human who just clicked
      // Deliver (R18-2/R19-4) — but the person here confirmed a packet
      // ceremony, not a delivery. Under FULL autonomy the delivery re-queues
      // the operator itself (ruling 134(b)); the SUPERVISED half gets the
      // server-attributed "Move to <review>" card, where the board lets it
      // apply (`recordDeliveredNextStep` re-checks everything under the lock).
      const { resolveOperatorAuthority } = await import("./operator-authority.server");
      if (resolveOperatorAuthority(ctx, input.projectSlug).autonomy !== "full") {
        await recordDeliveredNextStep(db, ctx, input.projectSlug, input.taskKey, deliveredPr);
      }
    } else {
      // F33-4 (pass 33): the refusing arm runs no re-delivery, so the same
      // "Move to <review>" card is recorded over the PR the task already
      // carries, when one is open. No PR means no honest card: the refusal
      // note names the remedy instead.
      const openPr =
        readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter.pr ??
        null;
      const prNumber =
        openPr && (openPr.state === "review" || openPr.state === "accepted")
          ? openPr.number
          : null;
      if (prNumber !== null) {
        await recordDeliveredNextStep(db, ctx, input.projectSlug, input.taskKey, prNumber);
      }
    }
    // Ruling 136(a): EXACTLY ONE hand-off. The `delivered` re-queue, when the
    // re-delivery fired it, already carries the outcome as a moved head;
    // otherwise the operator is handed the decision with Viberr's own record
    // of what the ceremony did, in its own field.
    if (!operatorRequeued) {
      const decisionNote = customDirective || input.note?.trim();
      const handoff: ResolvedPacketOption = { kind: option.kind, title: option.t, serverOutcome };
      if (decisionNote) handoff.note = decisionNote;
      void autoInvokeOperator(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        "packet-resolved",
        { resolvedOption: handoff },
      );
    }
  }

  // Ruling 489 (pass 40, F40-68): the decision IS the delivery. It runs the
  // task page's own door (`manualDeliverForReview` → `performDelivery`, the
  // core behind the operator's `deliver_for_review` tool), so the push, the PR,
  // the audit row and every refusal's timeline event are the ones a delivery
  // always writes. Then exactly one hand-off, as the collision ceremony above:
  // a full-autonomy delivery that moved the head re-queues the operator itself;
  // otherwise the operator is handed the decision with Viberr's record of it,
  // and a supervised task also gets the delivery's "Move to <review>" card.
  if (option.kind === "deliver_for_review") {
    const delivery = await manualDeliverForReview(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      actor,
      ctx,
    );
    const serverOutcome: DeliveryServerOutcome =
      delivery.status === "delivered"
        ? {
            kind: "deliver_for_review",
            outcome: delivery.pushStatus === "up_to_date" && !delivery.moved ? "current" : "delivered",
            prNumber: delivery.prNumber,
          }
        : { kind: "deliver_for_review", outcome: "failed", reason: delivery.message };
    if (delivery.status === "delivered") {
      if (delivery.headSha) serverOutcome.headSha = delivery.headSha;
      // The stall packet held readiness at `blocked`; a delivery that reached
      // the pull request falsifies the stall, so lift it (the collision
      // ceremony's rule). A failed delivery keeps it, beside its own event.
      await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
        if (parsed.frontmatter.readiness === "blocked") parsed.frontmatter.readiness = "ready";
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      const { resolveOperatorAuthority } = await import("./operator-authority.server");
      if (resolveOperatorAuthority(ctx, input.projectSlug).autonomy !== "full") {
        await recordDeliveredNextStep(db, ctx, input.projectSlug, input.taskKey, delivery.prNumber);
      }
    }
    if (!(delivery.status === "delivered" && delivery.operatorRequeued)) {
      const decisionNote = customDirective || input.note?.trim();
      const handoff: ResolvedPacketOption = { kind: option.kind, title: option.t, serverOutcome };
      if (decisionNote) handoff.note = decisionNote;
      void autoInvokeOperator(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        "packet-resolved",
        { resolvedOption: handoff },
      );
    }
  }

  // force_accept (ruling 164, pass 35, F35-14): the decision IS the override.
  // It runs AFTER the resolution write, on the same footing as the archive and
  // the discard above: the packet is answered on the record first (so the
  // acceptance withdraws nothing and its "the decision was never answered" note
  // never fires on a decision that was), and then the admin override runs
  // through the task page's own function. Every refusal it can make was already
  // made inside the case arm, above the write; a race that refuses here surfaces
  // as the acceptance's own conflict, with the decision recorded and the Force
  // accept button still standing.
  if (option.kind === "force_accept") {
    const forced: Parameters<typeof forceAcceptCompletion>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
    };
    if ("ack" in input) forced.ack = input.ack ?? null;
    await forceAcceptCompletion(db, forced, actor, ctx);
  }

  // block_on_dependencies (ruling 230, pass 37, F37-50): write the hold the
  // decision promised, through the same door every other dependency edit uses.
  // Best-effort like its siblings: a refused write never un-resolves a decision
  // a human already made, and its outcome lands on the timeline in plain words.
  if (option.kind === "block_on_dependencies") {
    const entries = (option.blockedBy ?? []).filter((e) => e.trim() !== "");
    try {
      const { setTaskDependencies } = await import("./dependencies.server");
      await setTaskDependencies(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          blockedBy: entries,
        },
        actor,
        ctx,
      );
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("block_on_dependencies resolution could not record the hold", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        text:
          `${input.taskKey} was **not** recorded as waiting on ${entries.join(", ")}: ${message} ` +
          `The decision stands and nothing was started, but nothing releases this task either; ` +
          `set what it waits on from the task page.`,
      });
    }
  }

  // create_task (ruling 269, pass 37, F37-101): make the task the decision
  // promised, through the door every other creator uses, under the RESOLVING
  // person's own authority (`createTask` runs its own `create-task` gate on
  // `actor`). Best-effort like its siblings: a refused create never
  // un-resolves a decision a human already made, and its outcome lands on the
  // timeline in plain words — which on this option matters more than most,
  // because the whole promise was that a task would exist.
  if (option.kind === "create_task" && option.newTask) {
    const spec = option.newTask;
    try {
      const createInput: CreateTaskInput = {
        projectSlug: input.projectSlug,
        title: spec.title,
        goal: spec.goal,
      };
      if (spec.blockedBy?.length) createInput.blockedBy = [...spec.blockedBy];
      if (spec.labels?.length) createInput.labels = [...spec.labels];
      // Ruling 503: work split out of a task belongs to the same body of work,
      // so the new task joins the deciding task's epic.
      const deciderEpic = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed
        .frontmatter.epic;
      if (deciderEpic && readEpicFile({ projectSlug: input.projectSlug, epicId: deciderEpic, dataRoot: ctx.dataRoot })) {
        createInput.epic = deciderEpic;
      }
      const made = await createTask(db, createInput, actor, ctx);
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        title: "Task created from a decision",
        // Ruling 322: same correction as the decision event's own sentence.
        // The wait itself is written by the `blocks` loop below, through the
        // task's own dependency editor; this note is what a person reads.
        text:
          `**${made.key}** (${spec.title}) was created by this decision. ` +
          (createTaskHoldsDecider(spec, input.taskKey)
            ? `${input.taskKey} now waits on it and is released when it is done.`
            : `It carries the work; ${input.taskKey} is unchanged.`),
      });
      // Ruling 287 (F37-122): connect it in the direction the work runs. A task
      // is usually created to UNBLOCK something, so the dependency points from
      // the EXISTING work to the new task — and that is the one direction
      // ruling 269 could not express, because `newTask.blockedBy` only says
      // what the new task waits on.
      //
      // Live on SHOP-28: the person's decision routed three frozen contract
      // shapes to a narrow amendment task, the operator created it, and then
      // had to write "add the new amendment key to SHOP-41's waits… only you
      // can add it; I can only set SHOP-28's own" into the packet's own prose.
      // The ordering was settled, recorded, and delivered as a chore in a
      // human's head — nothing on SHOP-41 said an edit was owed, so a forgotten
      // one would have set SHOP-41 building against contracts that did not
      // exist, which is the divergence the amendment task existed to prevent.
      //
      // Best-effort per key, like the create above: one refusal must not undo
      // a decision a person made or the task it already produced, and each
      // outcome lands on the timeline in plain words. The write goes through
      // `setTaskDependencies`, so the cycle check, the archived-task refusal,
      // the board projection and the release engine are the ones every other
      // caller gets.
      for (const blocked of spec.blocks ?? []) {
        const other = blocked.trim();
        if (!other) continue;
        try {
          const target = readTaskFile(taskRef(ctx, input.projectSlug, other));
          if (!target) throw AppError.notFound(`Task ${other} not found.`);
          const already = target.parsed.frontmatter.blockedBy.includes(made.key);
          if (!already) {
            await setTaskDependencies(
              db,
              {
                projectSlug: input.projectSlug,
                taskKey: other,
                blockedBy: [...target.parsed.frontmatter.blockedBy, made.key],
              },
              actor,
              ctx,
            );
          }
          // The provenance note lands on the task whose wait GREW. A wait that
          // appears with no reason on a task nobody was looking at reads as
          // Viberr deciding something on its own.
          //
          // Ruling 322: except when that task is the one being decided on —
          // the note directly above already told this reader, in this task's
          // own voice, that it now waits on what the decision created. A
          // second card saying it again in the third person is noise on the
          // one timeline where the fact is least surprising.
          if (other.trim().toUpperCase() === input.taskKey.trim().toUpperCase()) {
            reprojectTask(db, ctx, input.projectSlug, other);
            continue;
          }
          await appendPolicyNote(db, ctx, input.projectSlug, other, {
            title: already ? "Already waiting on that task" : "Now waits on a new task",
            text: already
              ? `A decision on **${input.taskKey}** created **${made.key}** (${spec.title}) ` +
                `to unblock this task, which already waited on it. Nothing changed here.`
              : `A decision on **${input.taskKey}** created **${made.key}** (${spec.title}) ` +
                `to unblock this task. This task now waits on it and is released when it is done.`,
          });
        } catch (error) {
          const why = errorMessage(error);
          logger.warn("create_task resolution could not record the reverse wait", {
            taskKey: input.taskKey,
            blocked: other,
            err: toError(error),
          });
          await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
            text:
              `**${made.key}** was created, but **${other}** was NOT set to wait on it: ${why} ` +
              `Add the wait on ${other}'s own page, or ${other} may start work the new task ` +
              `was created to come first.`,
          });
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("create_task resolution could not create the task", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        text:
          `The task "${spec.title}" was **not** created: ${message} The decision stands and ` +
          `${input.taskKey} is unchanged, but the work it named has no task; create it from ` +
          `the board, or ask the operator to offer the decision again.`,
      });
    }
  }

  // wait_for_window (ruling 224, pass 37, F37-44): write the schedule the
  // decision promised. Best-effort like every sibling ceremony — a refused
  // schedule never un-resolves the packet, and its outcome lands on the
  // timeline in plain words instead of as a thrown error over a decision that
  // already stands. A minute past the provider's own instant, because a window
  // that reopens "at 02:27" is not open at 02:27:00.
  if (option.kind === "wait_for_window" && option.dueAt) {
    const dueMs = Date.parse(option.dueAt);
    const runAt = new Date(
      Math.max(Number.isFinite(dueMs) ? dueMs : Date.now(), Date.now()) + 60_000,
    ).toISOString();
    try {
      const { scheduleTaskAction } = await import("./schedule.server");
      // The OPERATOR, never the agent directly: a gap of hours is exactly when
      // the board may have moved — a dependency landed, a reviewer changed, the
      // work was superseded — and re-dispatching the same agent blind would
      // resume a decision nobody re-made. Every other timed resume viberr has
      // (the dependency release, the restart recoveries) re-invokes the
      // operator for the same reason.
      await scheduleTaskAction(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          dueAt: runAt,
          action: "run-operator",
          prompt:
            `The usage window that stopped this task has reopened. Pick it back up from where it ` +
            `stopped; nothing about the task or the guidance changed while it waited, but re-read ` +
            `the board before you dispatch: hours passed.`,
        },
        actor,
        ctx,
      );
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("wait_for_window resolution could not schedule the resume", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        text:
          `${input.taskKey} was **not** scheduled to resume when the window reopens: ${message} ` +
          `Nothing is waiting on this task automatically; run it yourself when the window is back.`,
      });
    }
  }

  // move_stage (ruling 164, pass 35, F35-14): the decision IS the move, made
  // through `transitionStage` with `manual: true` — the stage picker's path,
  // which re-checks `approve-transition`, writes the transition event and the
  // `task.transition` row, and re-invokes the operator at the stage the task
  // lands on. Best-effort like the sibling ceremonies: a refused move never
  // un-resolves the packet, and its outcome lands on the timeline in plain
  // words rather than as a thrown error over a decision that stands.
  if (option.kind === "move_stage") {
    const target = moveStageTarget(option, project.stages, input.taskKey);
    if (target.ok) {
      // Ruling 381: a backward move says why, and a packet resolution is a
      // door onto it like the stage menu. The person's own words when they
      // gave any, else the option they chose, which is what they agreed to.
      // Without it every move_stage option that goes back was refused after
      // the packet had already cleared.
      const why =
        customDirective ||
        input.note?.trim() ||
        [option.t, option.d].filter((part) => part.trim()).join(": ");
      try {
        await transitionStage(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            toStageId: target.stage.id,
            manual: true,
            reason: why,
          },
          actor,
          ctx,
        );
      } catch (error) {
        const message = errorMessage(error);
        logger.warn("move_stage resolution could not move the task", {
          taskKey: input.taskKey,
          err: toError(error),
        });
        await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
          text: `${input.taskKey} was **not** moved to ${target.stage.name}: ${message}`,
        });
      }
    }
  }

  // question_reviewer (ruling 237, F37-57): actually put the question. Same
  // shape as the retry below and for the same reason — the packet is the human
  // decision, the dispatch is coordination machinery — with one difference that
  // matters: the directive is the WHOLE point of the option, so a start failure
  // means the promise on the card was not kept and has to say so.
  if (
    option.kind === "question_reviewer" &&
    option.profileId &&
    // Ruling 241: a question THIS resolution queued is not dispatched now — the
    // moment the hold goes away puts it instead.
    !queuedTheQuestion
  ) {
    const opCtx: TaskMutationContext = { ...ctx, operatorAuthorized: true };
    try {
      const { startAgentRun } = await import("./specialist-run.server");
      await startAgentRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          // No `delivers` and no posture change: the reviewer is already
          // engaged as a non-delivering reviewer, and this re-runs it exactly
          // as it stands. A question that arrived with delivery rights would
          // invite the reviewer to fix the thing itself.
          profileId: option.profileId,
          directive: REVIEW_DEADLOCK_QUESTION,
          directiveFrom: actor.label,
          // Ruling 313: the directive above says "do NOT return a verdict"
          // because one here binds to the same revision and counts as another
          // objection — the loop this option exists to end. Withhold the channel
          // so the sentence is enforced rather than requested. The engagement
          // keeps its verdict grant: the reviewer is still a required reviewer
          // and acceptance still waits for its approve.
          withholdVerdict: true,
        },
        OPERATOR_TASK_ACTOR,
        opCtx,
      );
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("question_reviewer start failed", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
        // `waiting` goes back to a person: the decision promised a reviewer run
        // and there is none, so a board reading "waiting: agent" would be the
        // F37-33 lie — claiming an agent nobody started.
        parsed.frontmatter.waiting = "human";
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: { kind: "operator" },
          title: null,
          text:
            `The question could not be put to the reviewer: ${message} ` +
            "Nothing was asked and nothing is running.",
          toAgent: false,
          evidence: null,
        });
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    }
  }

  // retry_other_backend: actually start the promised run. Operator-authorized
  // like the redirect path's re-engage (the packet is the human decision; the
  // execution is coordination machinery — an owner-contributor may resolve).
  // A start failure must not un-resolve the packet: record it on the timeline.
  if (option.kind === "retry_other_backend") {
    const target: RealBackend = option.backend === "codex" ? "codex" : "claude";
    const opCtx: TaskMutationContext = { ...ctx, operatorAuthorized: true };
    try {
      const { startAgentRun } = await import("./specialist-run.server");
      const retry: Parameters<typeof startAgentRun>[1] = {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        backendOverride: target,
      };
      // Absent on a primary-specialist retry; a reviewer retry names its profile.
      if (option.profileId) retry.profileId = option.profileId;
      await startAgentRun(db, retry, OPERATOR_TASK_ACTOR, opCtx);
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("retry_other_backend start failed", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: { kind: "operator" },
          title: null,
          text: `The retry could not start: ${message}`,
          toAgent: false,
          evidence: null,
        });
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    }
  }

  // ------------------------------------------------- ruling 319: the fan-out
  //
  // `packet.cause` (ruling 315) names what actually failed when the failure
  // belongs to an ACCOUNT rather than to this task: a quota that runs out, a
  // credential that is revoked, a backend that goes away. It takes out every
  // task that account is paying for at the same instant, and each one raised
  // its own identical packet — same reason, same remedy, same options, N times
  // in one person's queue.
  //
  // Ruling 315 wrote the stamp and stopped there, and the field's own comment
  // went on promising that "packets that share a cause resolve together". They
  // did not. This is that loop.
  //
  // Best-effort, and LOUD about what it missed: every sibling it could not
  // answer is named on this task's timeline with the reason, because the person
  // who just cleared four packets with one click is the one who has to know
  // that the fifth is still open.
  // Ruling 328: an escalation ruling 237 had to skip — because THIS packet was
  // the one already open — is raised now that it is answered. Before the
  // fan-out, so a sibling resolution meets the same state this one leaves.
  if (clearPacket) {
    await retryReviewDeadlockEscalation(db, ctx, input.projectSlug, input.taskKey);
  }

  // Ruling 602: a person's own answer to a quota packet stands for the rest of
  // its window, for the packets later refusals open. A fanned-out or standing
  // answer records nothing: the decision it came from already stands.
  if (input.fanOutOrigin === undefined && packet.cause) {
    try {
      const { recordStandingDecision } = await import("./packet-fanout.server");
      recordStandingDecision(db, { packet, option, actor, fromTaskKey: input.taskKey, nowMs: Date.now() });
    } catch (error) {
      logger.warn("standing decision not recorded", { taskKey: input.taskKey, err: toError(error) });
    }
  }

  const reached = await fanOutByCause(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    cause: packet.cause,
    suppressed: input.fanOutOrigin !== undefined,
    option,
    note: noteText,
  }, actor, ctx);

  // Ruling 672: "If they decide to connect a repo, controller spawns on board
  // level" (owner, 2026-10-06). After the fan-out, so the tasks handed back
  // are every task the answer reached, and once: a task the answer only
  // reached carries no connection of its own. Best-effort: the decision is
  // written, and ruling 330's sweep starts a task nothing moved.
  if (repositoryConnection !== null) {
    try {
      const { carryOnAfterConnection } = await import("./repository-ask.server");
      await carryOnAfterConnection(db, ctx, {
        projectSlug: input.projectSlug,
        repo: repositoryConnection.repo,
        taskKeys: [input.taskKey, ...reached],
        switchFrom: repositoryConnection.attached
          ? { userId: actor.userId, taskKey: input.taskKey }
          : null,
        controllerSwitches: false,
        resolvedOption: { kind: option.kind, title: option.t, note: repositoryConnection.repo },
      });
    } catch (error) {
      logger.warn("the tasks a repository connection answered were not handed back", {
        taskKey: input.taskKey,
        err: toError(error),
      });
    }
  }

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    option,
  };
}

/**
 * Ruling 602: a packet raised after a person already decided this account's
 * window is answered by that decision, through the real `resolvePacket`
 * (authority, events, the schedule a wait writes, notifications), exactly as a
 * ruling 319 sibling is. Best-effort: a miss leaves the packet open, as before.
 */
export async function answerFromStandingDecision(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: { projectSlug: string; taskKey: string },
): Promise<void> {
  try {
    const { siblingOptionIndex, standingArrivalText, standingDecisionFor, standingOption } =
      await import("./packet-fanout.server");
    const packet = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.packet;
    if (!packet || packet.awaiting || packet.decided) return;
    const decision = standingDecisionFor(db, packet, Date.now());
    if (!decision) return;
    const at = siblingOptionIndex(packet, standingOption(decision));
    if (at === null) return;
    await resolvePacket(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        optionIndex: at,
        fanOutOrigin: decision.fromTaskKey,
      },
      { userId: decision.byUserId, label: decision.byLabel },
      ctx,
    );
    await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
      text: standingArrivalText(decision),
    });
  } catch (error) {
    logger.warn("standing decision could not answer the packet", {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 319 — apply a resolution to every packet raised by the SAME cause.
 *
 * Each sibling goes through the real `resolvePacket`, not a cheaper write: a
 * decision that reaches another task has to pass that task's authority check,
 * write that task's decision event, notify that task's watchers and run that
 * task's dispatch arm. Anything less would be a second, quieter resolution path
 * that can disagree with the first.
 *
 * Separated from `resolvePacket` only so the recursion is visible; the guard is
 * `suppressed`, set from `fanOutOrigin` by the sibling call below.
 */
async function fanOutByCause(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    cause: string | undefined;
    suppressed: boolean;
    option: PacketOption;
    note: string;
  },
  actor: TaskActor,
  ctx: TaskActionContext,
): Promise<string[]> {
  if (!input.cause || input.suppressed) return [];
  const {
    FANNED_OUT_OPTION_KINDS,
    siblingPacketsSharingCause,
    siblingOptionIndex,
    fanOutArrivalText,
    fanOutOutcomeText,
  } = await import("./packet-fanout.server");
  const outcomes: FanOutOutcome[] = [];
  // A person's own directive answers the task they wrote it on. Every other
  // non-fannable kind says the same thing for the same reason.
  const fannable = FANNED_OUT_OPTION_KINDS.has(input.option.kind);
  let siblings: ReturnType<typeof siblingPacketsSharingCause>;
  try {
    siblings = siblingPacketsSharingCause(db, input.cause, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
    });
  } catch (error) {
    logger.warn("packet cause fan-out could not be searched", {
      taskKey: input.taskKey,
      err: toError(error),
    });
    return [];
  }

  for (const sibling of siblings) {
    // The projection is an index, not the record. A sibling answered between
    // that read and this write is not a miss and is not reported as one.
    const live = readTaskFile(taskRef(ctx, sibling.projectSlug, sibling.taskKey));
    const livePacket = live?.parsed.packet;
    if (
      !livePacket ||
      livePacket.cause !== input.cause ||
      livePacket.awaiting ||
      livePacket.decided
    ) {
      continue;
    }
    const at = fannable ? siblingOptionIndex(livePacket, input.option) : null;
    if (at === null) {
      outcomes.push({
        taskKey: sibling.taskKey,
        applied: false,
        why: fannable
          ? `its packet does not offer "${input.option.t}".`
          : `"${input.option.t}" answers only the task it was chosen on.`,
      });
      continue;
    }
    try {
      await resolvePacket(
        db,
        {
          projectSlug: sibling.projectSlug,
          taskKey: sibling.taskKey,
          optionIndex: at,
          note: input.note,
          fanOutOrigin: input.taskKey,
        },
        actor,
        ctx,
      );
      await appendPolicyNote(db, ctx, sibling.projectSlug, sibling.taskKey, {
        text: fanOutArrivalText({
          fromTaskKey: input.taskKey,
          byName: actor.label,
          optionTitle: input.option.t,
          cause: input.cause,
        }),
      });
      outcomes.push({ taskKey: sibling.taskKey, applied: true });
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("packet cause fan-out could not answer a sibling", {
        taskKey: sibling.taskKey,
        err: toError(error),
      });
      outcomes.push({ taskKey: sibling.taskKey, applied: false, why: endSentence(message) });
    }
  }

  // Ruling 672: the tasks the answer reached, for whoever carries on from it.
  const applied = outcomes.flatMap((o) => (o.applied ? [o.taskKey] : []));
  const text = fanOutOutcomeText(outcomes, input.cause);
  if (!text) return applied;
  try {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  } catch (error) {
    logger.warn("packet cause fan-out outcome could not be recorded", {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
  return applied;
}

/**
 * F20-18 (N20-7) — route a stranded decision to the people who can decide it.
 *
 * A contributor who OWNS a task can be handed a packet whose every option needs
 * maintainer authority (`archive_task` = approve-transition, `edit_goal` =
 * update-goal — both [A,M]). The owner-exception lets them RESOLVE a packet in
 * principle, but each of those options re-checks a higher tier, so a
 * contributor-owner is stranded: no option they can settle, and no in-app way to
 * clear their own task (the Archive control is maintainer+ too). RBAC reserves
 * those dispositions for maintainer+ on purpose, so widening them to the owner is
 * the wrong direction (it is exactly the recommend→direct-style silent widening
 * a later ruling banned). The owner's real path is to hand the decision UP.
 *
 * This notifies the project's maintainers + admins — the same recipient set
 * every packet notification uses — records the ask on the timeline so an
 * arriving maintainer sees WHY it landed on them, and audits it. It never
 * mutates the packet: the maintainer still resolves it through the ordinary
 * gate. The deny-note that surfaces this control is C-GOV-UI's (a later band);
 * this is the server half it calls.
 */
export async function requestPacketMaintainerDecision(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; note?: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ notified: number; to: "admin" | "maintainer" }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const packet = existing.parsed.packet;
  if (!packet) throw AppError.conflict("This packet was already resolved.");

  // The escalation is meaningful ONLY for a contributor-owner who cannot resolve
  // the packet themselves. A maintainer/admin (owner or not) already holds
  // `resolve-packet` and every disposition tier — routing would notify people
  // who can already act (and, for an owner, notify themselves). Refuse with a
  // pointer instead of sending a pointless alert.
  const role = project.memberRoles.get(actor.userId ?? "");
  // Ruling 672: the repository question's two answers decide the board, so
  // they are a project admin's. A maintainer cannot give one either, and may
  // send it up exactly as a contributor-owner sends up a maintainer's.
  const boardDecision = isRepositoryAskCause(packet.cause);
  const canResolveDirectly = roleCan(role, boardDecision ? "edit-policy" : "resolve-packet");
  const isOwner = ownerException(
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
  );
  if (canResolveDirectly) {
    throw AppError.validation(
      boardDecision
        ? "You can answer this decision yourself; there is no need to send it to a project admin."
        : "You can resolve this decision yourself; there is no need to route it to a maintainer.",
    );
  }
  if (!isOwner) {
    // Not the owner and not resolve-capable: no standing to route another's
    // task. The standard gate throws the honest 403.
    requireAction(db, project, actor, "resolve-packet", "resolve decision packets");
  }

  const ownerLabel = actor.label || "The task owner";
  const trimmedNote = input.note?.trim();
  const noteText =
    (boardDecision
      ? `${ownerLabel} cannot answer "${packet.title}" on ${input.taskKey}: both answers decide ` +
        `the board, which is a project admin's, so they asked a project admin to make the call.`
      : `${ownerLabel} owns ${input.taskKey} but every option on this decision ` +
        `("${packet.title}") needs maintainer authority, so they asked a maintainer ` +
        `or admin to make the call.`) +
    (trimmedNote ? `\n\n> ${trimmedNote.replace(/\n/g, "\n> ")}` : "");
  const occurredAt = new Date().toISOString();

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift({
        occurredAt,
        type: "note",
        actor: humanActorRef(db, actor),
        title: null,
        text: noteText,
        toAgent: false,
        evidence: null,
      });
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  // Notification `from` is an ActorRender (a render shape), not the FileActorRef
  // the timeline event carries — build the human render when we have a user id.
  const fromName = actor.userId ? userDisplayName(db, actor.userId) : ownerLabel;
  const notice: TaskWatcherNotice = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    kind: "packet",
    ptype: packet.type === "blocked" ? "blocked" : "input",
    title: boardDecision
      ? `Decision needs a project admin: ${packet.title}`
      : `Decision needs a maintainer: ${packet.title}`,
    text: noteText,
    occurredAt,
    // Ruling 497: the row opens the packet the maintainer is asked to decide.
    about: { decision: packet.id },
    // Ruling 361: the person who asked, or the operator when it did.
    from: actor.userId
      ? {
          kind: "human",
          userId: actor.userId,
          name: fromName,
          initials: initialsOf(fromName),
          tone: avatarTone(db, actor.userId),
        }
      : OPERATOR_NOTIFY_FROM,
  };
  if (actor.userId) {
    // Don't notify the owner about their own ask.
    notice.exceptUserId = actor.userId;
  }
  const notified = notifyTaskWatchers(db, notice, ctx);

  recordAudit(db, {
    action: "task.packet.escalated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { packetKind: packet.kind, notified: notified.length },
  });

  return { notified: notified.length, to: boardDecision ? "admin" : "maintainer" };
}
