/**
 * What an agent run's end does to its task (ruling 13(a)): `recordAgentCompletion`
 * writes the run's report, verdict and reply, and `applyAgentCompletionEffects`
 * carries out what follows (the operator's react, the stuck-loop packet, a
 * deferred @mention, the waiting flags). Also here: the holds a run or a person
 * lifts, and `operatorPromptAgent`, the operator's message to an agent. Two
 * calls reach upward and load their module when they run, as ruling 13
 * does: a deferred @mention goes out through `commentToAgent`, and a packet a
 * person already decided is answered through packet resolution.
 */

import { isBrowserWorkingArtifact } from "~/server/files/task-attachments.server";
import { closureClaim, taskClosure } from "./task-closure.server";
import { formatUsd, runDidNotCompleteLead } from "~/shared/run-failure";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { endSentence } from "~/shared/text/sentence";
import { countLabel } from "~/shared/text/plural";
import { VERDICT_NOTE_TITLE, verdictNoteText } from "~/shared/verdict-note";
import { QUESTION_LEAD } from "~/shared/timeline-leads";
import { isRelayComment } from "./task-relay.server";
// Ruling 119: where a react chain's work stands, read from the server's record.
import {
  deliverHeadOption,
  filesDeliveredSince,
  headMovedSince,
  stuckLoopStandings,
} from "./react-progress.server";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  consecutiveRequestChanges,
  currentVerdicts,
  deliveringEngagement,
  deriveValidation,
  type Engagement,
  type EvidenceRow,
  normalizeEvidenceRows,
  type ParsedTaskFile,
  requiredReviewers,
  reviewSubjectAuthor,
  reviewSubjectId,
  type ReviewVerdict,
  sanitizeEventAttachmentNames,
  type TaskFileEvent,
  type TaskFrontmatter,
  VERDICT_REPORT_TITLE,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import type { OperatorAutonomy } from "./operator-authority.server";
import {
  buildReviewDeadlockPacket,
  delivererNameOf,
  type ReviewDeadlockEscalation,
  reviewDeadlockOf,
} from "./review-deadlock.server";
import { describeRunFailure, type DescribeRunFailureInput } from "./run-failure-remedy.server";
import { joinDependencyEntries } from "~/shared/dependencies";
import {
  isTerminalStage,
  resolveStageRoles,
  stageName as resolveStageName,
} from "~/shared/workflow/stage-roles";
import {
  type AuditActor,
  type AuditEventInput,
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { agentRoleDisplay, encodeActorRef } from "~/server/files/actor-ref.server";
import {
  type AgentOutcomeQuestion,
  askedEntryText,
  buildAgentQuestionPacket,
} from "./agent-outcome.server";
import {
  kbCorrectionsOutcome,
  type NoChangeVerification,
  probeNothingToDeliver,
  standingKbCorrections,
} from "./no-change-completion.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  appendPolicyNote,
  loadProjectContext,
  notifyTaskWatchers,
  type OfferWithdrawalCause,
  type OfferWithdrawalSlot,
  OPERATOR_NOTIFY_FROM,
  POLICY_ENGINE_NOTIFY_FROM,
  type ProjectContext,
  recordRecommendationWithdrawal,
  reprojectTask,
  type TaskMutationContext,
  taskRef,
  type TaskWatcherNotice,
  withdrawAcceptanceOffers,
} from "./task-mutation.server";
import {
  appendTimelineEvent,
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  storedNameAmong,
  taskAttachmentsDir,
  taskDir,
} from "~/server/files/file-store-root.server";
import {
  agentNamesByProfile,
  getRun,
  patchRun,
  reviewSubjectAtDispatch,
} from "~/server/runtimes/run-store.server";
import { deliveredRoundSince } from "~/server/runtimes/provider-refusal.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { StartAgentRunResult } from "./specialist-run.server";
import { PROVIDER_TEXT_CHARS } from "~/server/secrets/git-output-redact.server";
import {
  clearModelMark,
  noteModelAvailabilityFromFailure,
} from "~/server/runtimes/model-availability.server";
import { createActorResolver } from "~/shared/mapping/actor.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import { withheldAgentGrants } from "~/features/agents/capability-catalog";
import {
  mentionedUserIdsOf,
  mentionNotifiesUser,
  notifyMentionedUsers,
  stampNotifiedRecipients,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import { userDisplayName } from "./user-display-name.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  OPERATOR_REACT_DEPTH_CAP,
  OPERATOR_REACT_HOP_CEILING,
  OPERATOR_TASK_ACTOR,
  operatorShouldReactToReply,
  projectRepoFor,
  runOutcomeClause,
  type TaskActionContext,
  terminalStageIdOf,
} from "./task-action-core.server";
import {
  deadlockAgentNames,
  openStuckLoopPacket,
  STOCK_STALL_OPTIONS,
  withdrawSupersededStuckPacket,
} from "./task-escalations.server";
import {
  deliveredFileNames,
  deliverersOwnFileNames,
  filesClaimedBy,
  filesSavedByOtherAgents,
  keepStampedDelivery,
  postAgentReplyComment,
  prepareAgentReplyEvent,
  recordAgentRepliedAudit,
  stampNonCommitDelivery,
  stripCcLine,
  suppressedReplyReason,
} from "./task-replies.server";
import { acceptanceRefusalFor } from "./task-acceptance.server";
import { noteSourcesKeptByRun } from "./task-sources.server";
import {
  deliveryCapturesSettled,
  removeRunPageCaptures,
  requestDeliveryCaptures,
} from "./page-capture.server";
import { recordedPageCaptures } from "~/shared/page-capture";

/**
 * The agent's most-recent reply comment text on a task, or null when it has
 * never replied. `before` excludes comments emitted by the current run.
 */
function latestAgentReplyText(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  backend: RealBackend,
  profileId: string,
  before?: string | null,
): string | null {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) return null;
  const beforeMs = before ? Date.parse(before) : NaN;
  for (const e of file.parsed.timeline) {
    if (
      e.type === "comment" &&
      e.actor.kind === "agent" &&
      e.actor.backend === backend &&
      e.actor.profileId === profileId
    ) {
      // Skip comments from the current run (occurredAt >= run start).
      if (!Number.isNaN(beforeMs) && Date.parse(e.occurredAt) >= beforeMs) {
        continue;
      }
      return e.text;
    }
  }
  return null;
}

/** Open one recovery packet when the bounded operator loop stalls. */
/** Ruling 123: the same function, exported under a test-only name so the
 *  fallback can be driven directly. Production callers use the private one. */

/**
 * Classify a reviewer's reply into a verdict (FR15/FR35). Conservative: returns
 * a verdict only on a clear signal, else null (no validation change). Pure —
 * exported for tests.
 */
export function classifyReviewerVerdict(
  text: string | null,
): "request_changes" | "approve" | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // 1. An EXPLICIT verdict line is the strongest signal and reviewers emit one
  //    ("Verdict: approve", "## Review verdict — PASS"). It wins over incidental
  //    words elsewhere in the prose, so a thorough APPROVE that happens to say
  //    "no tests fail" is not misread as a rejection.
  const verdictApprove = /verdict[\s:—–-]*\**\s*(pass|approv|lgtm|ship it)/.test(t);
  const verdictReject =
    /verdict[\s:—–-]*\**\s*(fail|request|reject|chang|block|no-?go)/.test(t);
  if (verdictReject && !verdictApprove) return "request_changes";
  if (verdictApprove && !verdictReject) return "approve";

  // 2. Strong request-changes PHRASES always count (assertive, not negated).
  if (
    /request(ing)?\s+changes?/.test(t) ||
    /\bchanges? (are )?(required|needed|requested)\b/.test(t) ||
    /\bnothing (was )?implemented\b/.test(t) ||
    /\bno-?op\b/.test(t) ||
    /\bnot (yet )?(implemented|done|complete)\b/.test(t) ||
    /\breject(ed|s|ing)?\b/.test(t)
  ) {
    return "request_changes";
  }

  // 3. Weak negatives ("fail", "failure", "blocker") ONLY count when NOT
  //    locally negated — "no blockers" / "none of the tests fail" / "nothing
  //    fails" / "doesn't fail" are POSITIVE. Scan each occurrence's preceding
  //    context for a negator (a bare `/\bfail\b/` test misclassified clean
  //    approvals — the bug this guard fixes).
  for (const m of t.matchAll(/\b(fail(?:ed|ing|s|ures?)?|blockers?)\b/g)) {
    const pre = t.slice(Math.max(0, m.index - 28), m.index);
    // A negator anywhere in the local lead-in flips it positive. `n't` is a
    // contraction suffix (don't/doesn't/won't) so it needs no leading boundary.
    if (
      !/(?:\b(?:no|not|none|nothing|zero|without|never|any)\b|n't)[^.!?]*$/.test(
        pre,
      )
    ) {
      return "request_changes";
    }
  }

  if (
    /\bapprove(d|s)?\b/.test(t) ||
    /\blgtm\b/.test(t) ||
    /\blooks good to merge\b/.test(t) ||
    /\bready (to|for) (merge|accept)/.test(t) ||
    /\bno (blocking )?issues\b/.test(t)
  ) {
    return "approve";
  }
  return null;
}

/**
 * P13-D-26 — server-derived `evidence:` rows for an outcome event (FR21/FR17:
 * "append outcomes, blockers, and evidence to the task record").
 *
 * REUSES the delivery facts already reconciled onto the task — `github.changed`
 * (PR/branch reconcilers) and `github.commits` + `workRevision`
 * (workspace-delivery) — so nothing is recomputed and no shell-out is added to
 * the completion path. References and counts only; raw output stays in the run
 * logs where the `evidence-separation` guardrail points at it.
 *
 * Pure + exported for tests.
 */
export function deliveredWorkEvidence(fm: {
  branch: string | null;
  github: TaskFrontmatter["github"];
  workRevision: TaskFrontmatter["workRevision"];
}): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const changed = fm.github?.changed ?? null;
  const revision = activeWorkRevision(fm.workRevision);
  const branch = revision?.branch ?? fm.branch;
  // Ruling 16: the size of the change is a reference, neither a pass nor a
  // failure, with its two counts as the result the timeline colours.
  if (changed) {
    rows.push({
      label: `${countLabel(changed.files, "file")} changed${branch ? ` on \`${branch}\`` : ""}`,
      result: `+${changed.add} −${changed.del}`,
      status: "info",
    });
  }
  const commits = fm.github?.commits ?? [];
  if (commits.length > 0) {
    const rev = revision;
    rows.push({
      label:
        `${countLabel(commits.length, "commit")} delivered` +
        (rev?.headSha ? `, revision ${rev.headSha.slice(0, 7)}` : ""),
      result: "",
      status: "info",
    });
  }
  return rows;
}

/** "A", "A and B", "A, B, and C": the reviewers a verdict event names. */
const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Ruling 88: the longest verdict justification stored on a task, and the
 * sentence that ships when it does not fit.
 *
 * 2,000 characters is a generous paragraph and a short essay, which is the
 * right size for the reason a reviewer gives beside its verdict. What was
 * wrong was the silence: a bare `.slice` meant a long justification was stored
 * ending mid-word and read, on the task page, as the whole of what the reviewer
 * said. The full text is never lost - the agent's own report is on the same
 * timeline, untruncated - so the marker's job is to send the reader there.
 */
const VERDICT_REASON_MAX_CHARS = 2_000;

function clipVerdictReason(text: string): string {
  const reason = text.trim();
  if (reason.length <= VERDICT_REASON_MAX_CHARS) return reason;
  return (
    `${reason.slice(0, VERDICT_REASON_MAX_CHARS)}\n\n` +
    `[cut here - the reviewer's justification ran to ` +
    `${reason.length.toLocaleString("en-US")} characters and this is its first ` +
    `${VERDICT_REASON_MAX_CHARS.toLocaleString("en-US")}. Its full report is on this ` +
    `task's timeline, whole.]`
  );
}

/** What {@link recordAgentCompletion} tells its caller. */
interface AgentCompletionRecord {
  escalated: boolean;
  verdictBound: boolean;
  delivered: string | null;
}

/** Atomically record a finished run's reply, verdict, and human question. */
export async function recordAgentCompletion(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  input: {
    actorRef: FileActorRef;
    runId: string;
    /** The prose reply (Claude full text · Codex envelope summary). */
    replyText: string | null;
    verdict: "approve" | "request_changes" | null;
    question: AgentOutcomeQuestion | null;
    /** P13-D-26: evidence REFERENCES for this outcome — the agent's own rows
     *  (report_outcome) plus the derived delivery rows. They land on the
     *  verdict event when there is one, else on the agent's report. */
    evidence?: EvidenceRow[] | null;
    /** Files this run saved into the task's attachments/ dir (browser
     *  captures). Stamped onto the same event that carries the evidence, so
     *  the producing message names its own files. */
    attachments?: string[] | null;
    /** Ruling 87: the run was dispatched to deliver, so its files can be the
     *  delivery. */
    delivers: boolean;
  },
  /** Ruling 94: reports whether this completion RAISED the review-deadlock
   *  packet. The caller needs it to decide whether to hand the task back to the
   *  operator — see the escalation arm in `applyAgentCompletionEffects`.
   *  Ruling 119: and whether the verdict BOUND to a subject, which is what makes
   *  an approval a boundary.
   *  Ruling 86: and the `deliveredAt` stamp of the delivery this completion
   *  stamped and kept, null when it stamped none. Its pages are not asked to
   *  be pictured here: whether the delivery is files or a revision is known
   *  only once the caller's delivery reconcile has run. */
): Promise<AgentCompletionRecord> {
  const { actorRef, runId, replyText, verdict, question } = input;
  const evidence = normalizeEvidenceRows(input.evidence);
  const attachments = sanitizeEventAttachmentNames(input.attachments);
  const prepared = await prepareAgentReplyEvent(
    db,
    ctx,
    projectSlug,
    taskKey,
    runId,
    actorRef,
    replyText,
  );
  // The reply posts as its own comment unless SUPPRESSED — a meaningful-comment
  // guardrail drop, or an F22-12 duplicate of a comment this run already posted.
  const postsReplyEvent = prepared.status === "event" && !prepared.duplicate;
  const suppressedReason = suppressedReplyReason(prepared);
  const hasEvidence = !!(evidence && evidence.length);
  // A reply whose BODY duplicates a mid-run comment does not re-post — but the
  // dispatch-completion cc line (ruling 124 / R20-9) is content that comment
  // never carried, and its guaranteed @tag would otherwise never notify: the
  // reply fan-out below was gated on the reply POSTING, on the false premise
  // that a duplicate's mentions were already delivered. Fan out ONLY the handles
  // this reply ADDS over the comment it repeats (no double-notify) — and do it
  // HERE, before the nothing-to-record early return, which the pure-dedup case
  // (the exact dispatch trigger: repeated body + cc line) hits.
  if (prepared.status === "event" && prepared.duplicatedText !== null) {
    // Ruling 20: and the event records who it reached, so compaction keeps it.
    await stampNotifiedRecipients(
      db,
      taskRef(ctx, projectSlug, taskKey),
      prepared.event,
      notifyMentionedUsers(db, {
        // B-FD8b: pre-trim form, so an added @tag inside a separated fence counts.
        text: prepared.mentionSourceText,
        projectSlug,
        taskKey,
        from: createActorResolver(db, {
          agentNames: agentNamesByProfile(db, projectSlug),
        })(actorRef),
        occurredAt: prepared.event.occurredAt,
        skipUserIds: mentionedUserIdsOf(db, prepared.duplicatedText),
      }),
    );
  }
  // Nothing to record at all. Evidence rows and attachments each count as
  // something: a run whose prose was suppressed but that still produced evidence
  // or saved files gets a producing event below, so neither is lost with the
  // text (the F22-12 duplicate path must not orphan the outcome's evidence).
  if (!verdict && !question && !postsReplyEvent && !attachments && !hasEvidence) {
    // Still stamp the recovery-idempotency audit for a suppressed reply, so boot
    // recovery doesn't reprocess it forever.
    if (suppressedReason) {
      recordAgentRepliedAudit(db, projectSlug, taskKey, runId, suppressedReason);
    }
    return { escalated: false, verdictBound: false, delivered: null };
  }
  const roleDisplay =
    actorRef.kind === "agent" ? agentRoleDisplay(actorRef) : "Agent";
  let questionOpened = false;
  /** Ruling 75: the question packet's id, which its notification names. */
  let questionPacketId: string | undefined;
  // Ruling 99: the envelope's question packet withdraws the standing
  // acceptance offers on the record, inside the same locked write.
  const questionCause: OfferWithdrawalCause | null = question
    ? { kind: "packet", title: question.title.trim() }
    : null;
  const questionTerminalStageId = question
    ? terminalStageIdOf(loadProjectContext(ctx, projectSlug))
    : null;
  const questionWithdrawal: OfferWithdrawalSlot = { offers: null };
  /** Set when the envelope's question could not open a packet (one already is)
   *  — recorded as a timeline note instead of being dropped (P13-RT-06). */
  let questionDeferred: string | null = null;
  /** Ruling 94 (F37-57): the consecutive-objection escalation, written inside
   *  the verdict's own lock and announced after it. A SLOT, the same idiom
   *  `questionWithdrawal` uses below, because a plain `let` assigned only
   *  inside the mutator reads to the compiler as never assigned at all — the
   *  announcement block would type-check as dead code and quietly stop being
   *  checked. */
  const deadlockEscalation: ReviewDeadlockEscalation = { packet: null, deadlock: null };
  /** The project's stages, read once and only when a verdict is being written:
   *  `taskClosure` needs them, and every other verdict-less completion must not
   *  pay a project read for a guard it never reaches. */
  let deadlockStagesCache: ProjectContext["stages"] | null = null;
  const deadlockStages = (): ProjectContext["stages"] => {
    deadlockStagesCache ??= loadProjectContext(ctx, projectSlug).stages;
    return deadlockStagesCache;
  };
  let validation: TaskFrontmatter["validation"] = "healthy";
  // The title/summary are computed from the RESOLVED (derived) validation, not
  // the raw verdict, so the event can never read "Review passed / Validation:
  // failing" (F7-REV3): an approve that lands while another required reviewer is
  // outstanding (or requesting changes) on the current revision is an "Approval
  // noted, rework still needed", NOT a pass.
  let title = "";
  let summary = "";
  /** Ruling 75: when the verdict event was written, so its notice opens on it. */
  let verdictAt: string | null = null;
  // R19-8 (F19-21, live VC-5): a verdict-capable reviewer approving a task that
  // has NOTHING to deliver had nothing to bind to — the verdict was dropped, the
  // event read "there is no delivered revision to bind the verdict to yet", and
  // acceptance dead-ended forever on "No reviewed revision yet". Mint a
  // VERIFICATION revision pinned to the default-branch head so the verdict binds
  // to a real subject and names the base sha it judged; every existing verdict
  // mechanism (requiredReviewers, deriveValidation, staleness) then works
  // unchanged rather than growing a second review model.
  //
  // The preconditions are deliberately narrow. A reviewer approving while a
  // developer is still mid-run must NOT mark the task "no changes" — the branch
  // does not exist YET, which is not the same as never — so nobody may be
  // engaged to deliver and no branch/PR/revision may ever have been linked. The
  // basis is proved by the same live, fail-closed probe acceptance uses.
  let noChangeMint: NoChangeVerification | null = null;
  // Ruling 84: what this run was dispatched to judge. Its verdict binds only
  // to that subject; undefined on a row that does not say (see
  // `reviewSubjectAtDispatch`), which binds to the subject at completion.
  const dispatchedOn = verdict ? reviewSubjectAtDispatch(getRun(db, runId)) : undefined;
  let verdictBound = false;
  /** Ruling 86: the stamp of the delivery this completion stamps and keeps. */
  let delivered: string | null = null;
  /** Ruling 245: the verdict came from the agent that made what it judged. */
  let ownWork = false;
  /** Ruling 83: this objection repeats the reviewer's last one on a delivery
   *  nobody has reworked since, so it sends nothing back a second time. */
  let unfoughtRepeat = false;
  if (verdict === "approve" && actorRef.kind === "agent") {
    const preFile = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed;
    const pre = preFile?.frontmatter;
    if (
      pre &&
      !activeWorkRevision(pre.workRevision) &&
      !pre.pr &&
      pre.branch === null &&
      deliveringEngagement(pre) === null &&
      pre.engagements.some(
        (e) =>
          e.profileId === actorRef.profileId && !e.delivers && e.verdictCapable,
      ) &&
      // Ruling 101: files another agent saved here are work, not "nothing to
      // deliver"; the approval waits for them to be delivered.
      filesSavedByOtherAgents(preFile.timeline, actorRef.profileId).length === 0
    ) {
      const probe = await probeNothingToDeliver(db, ctx, projectSlug, taskKey);
      // `no_repo` verifies but carries no sha, and a revision needs a real head
      // to name — synthesizing one would fabricate a fact. A repo-less project
      // keeps its existing path (no revision, and `acceptanceBlockedReason` only
      // holds it when a required reviewer is engaged).
      if (probe.status === "verified" && probe.verification.baseSha !== null) {
        noChangeMint = probe.verification;
      }
    }
  }
  try {
    let stampBefore: string | null = null;
    const written = await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      stampBefore = parsed.frontmatter.deliveredAt ?? null;
      // Ruling 85: read before this completion adds its own entries.
      const delivered = deliveredFileNames(parsed.frontmatter, parsed.timeline);
      if (verdict) {
        // Ruling 84: a delivery that landed while this run was reviewing is a
        // subject it never read, so its verdict binds to nothing.
        const subjectNow = reviewSubjectId(parsed.frontmatter);
        // A verification revision (R19-8) minted since the dispatch judges the
        // base a run sent to review "nothing delivered" was judging too: a
        // sibling reviewer's approval minted it, and it is not a delivery.
        const mintedSince =
          dispatchedOn === null && activeWorkRevision(parsed.frontmatter.workRevision)?.kind === "verified";
        const moved =
          dispatchedOn !== undefined && subjectNow !== null && dispatchedOn !== subjectNow && !mintedSince;
        // Decided afresh on every pass of this mutator.
        verdictBound = false;
        ownWork = false;
        unfoughtRepeat = false;
        // In-lock re-check: a delivery could have landed during the probe above.
        if (
          noChangeMint &&
          !moved &&
          !activeWorkRevision(parsed.frontmatter.workRevision) &&
          !parsed.frontmatter.pr &&
          parsed.frontmatter.branch === null &&
          deliveringEngagement(parsed.frontmatter) === null &&
          (actorRef.kind !== "agent" || filesSavedByOtherAgents(parsed.timeline, actorRef.profileId).length === 0)
        ) {
          parsed.frontmatter.workRevision = {
            id: newId("rev"),
            headSha: noChangeMint.baseSha!,
            treeSha: null,
            branch: null,
            createdAt: new Date().toISOString(),
            sourceProfileId: null,
            kind: "verified",
          };
          parsed.frontmatter.noChanges = true;
        } else {
          // Nothing was minted — keep the copy below honest about it.
          noChangeMint = null;
        }
        // F10-15: bind the verdict to the CURRENT work revision, last-write-wins
        // per (profileId, revisionId). A NEW revision (delivered head/tree
        // change) makes it stale automatically — no comment/stage-bounce
        // heuristic (F10-32). The derived `validation` cache is then recomputed
        // from the required reviewers' verdicts on the current revision.
        // Ruling 234: a discarded revision is not a subject. A verdict must
        // never pin to a head that no longer exists, so it is recorded as
        // prose (the reply) and binds to nothing.
        //
        // Ruling 84: but a task whose deliverable is a saved FILE does have a
        // subject, and used to fall into that same hole — the verdict was never
        // stored, so `validation` stayed `none`, the rework route ruling 90
        // licenses stayed shut, and the required-reviewer gate (ruling 81)
        // could never be satisfied either. Live on ax-clone AX-12 that was a
        // dead end: a reviewer returned request-changes on the report, and the
        // record said "**Validation:** none" in the same sentence.
        const rev = activeWorkRevision(parsed.frontmatter.workRevision);
        const subjectId = reviewSubjectId(parsed.frontmatter);
        const reviewerProfileId =
          actorRef.kind === "agent" ? actorRef.profileId : null;
        // Ruling 245: a verdict never binds to the reviewer's own work. Handing
        // delivery away does not make the files its deliverer saved someone
        // else's, and a review of them is still a review of its own.
        ownWork =
          reviewerProfileId !== null &&
          reviewerProfileId === reviewSubjectAuthor(parsed.frontmatter, parsed.timeline);
        if (subjectId && reviewerProfileId && !moved && !ownWork) {
          verdictBound = true;
          // Ruling 92: the overwrite keeps the latest verdict and would keep
          // nothing else. A reviewer that returns the SAME result on the SAME
          // revision has reviewed twice, and that is the only signal saying the
          // deliverer could not move — precisely the case where no new revision
          // is ever minted, so a count of distinct revisions stays at 1 forever.
          const prior = parsed.frontmatter.verdicts.find(
            (v) => v.profileId === reviewerProfileId && v.revisionId === subjectId,
          );
          // Ruling 92 (F37-69): a repeat verdict counts as a new ROUND only if
          // a round was actually fought — the DELIVERER RAN between the two.
          //
          // Ruling 92 is right that a deadlock mints no new revision, so the
          // count cannot key on revisions. It is the deliverer's RUN, not its
          // commit, that says a round happened: on SHOP-9 the deliverer ran and
          // reported it had nothing in scope to change, which is a round. What
          // ruling 92 could not see is a repeat objection with no rework behind
          // it at all — and ruling 94's own escalation question provokes
          // exactly that. Live on SHOP-25 the reviewer was asked to name
          // everything it would still block on, answered completely, and
          // attached a `request_changes` to the same untouched revision 8ms
          // later. That took the count from 2 to 3 with nobody having reworked
          // anything, and re-raised the packet on top of the answer a person had
          // just paid for. Ruling 94 forbids that verdict in its prompt, which
          // is the construction ruling 56 refused; this is the part that
          // notices when the model does something else.
          //
          // Ruling 92 (owner, 2026-09-23): a deliverer run the PROVIDER refused
          // fought no round. On ax-clone AX-19 a quota refusal three minutes into
          // the rework counted, and the reviewer's re-verdict on untouched code
          // raised "6 times running". A crash mid-work still counts.
          const deliverer = deliveringEngagement(parsed.frontmatter);
          const reworked =
            !prior ||
            !deliverer ||
            deliveredRoundSince(db, projectSlug, taskKey, deliverer.profileId, prior.at);
          // A repeat of the same result KEEPS the rounds already fought on this
          // revision when no new one was (ruling 92): it used to fall back to
          // 1, so a question run answered on a revision that had already cost
          // two rounds took one of them off the deadlock count.
          const rounds =
            prior?.result === verdict ? (reworked ? prior.rounds + 1 : prior.rounds) : 1;
          // Ruling 92: this objection has no rework behind it (the reviewer
          // read the same untouched revision again), so it is an ANSWER on work
          // that has not moved, and the packet below must not recommend asking
          // for it a second time.
          const noReworkBehind = prior !== undefined && !reworked;
          // Ruling 83: the same objection again with no round fought (the
          // case `rounds` above keeps its count for) is titled apart, so what
          // a task took counts the work as sent back once, not twice.
          unfoughtRepeat =
            verdict === "request_changes" && prior?.result === "request_changes" && !reworked;
          // Ruling 92: every same-result verdict on this revision, fought
          // or not, so a later packet can tell the question was answered here.
          const reviews = prior?.result === verdict ? (prior.reviews ?? prior.rounds) + 1 : 1;
          // Ruling 93 (F39-43): the run that returned this verdict was the one
          // that put the completeness question, so this verdict IS the answer.
          // Keyed by run id and consumed here, so no later verdict inherits it.
          const asked = parsed.frontmatter.engagements.find(
            (e) => e.profileId === reviewerProfileId,
          );
          const answersQuestion =
            asked?.question?.kind === "completeness" && asked.question.runId === runId;
          if (asked?.question && asked.question.runId === runId) asked.question = null;
          const recorded: ReviewVerdict = {
            profileId: reviewerProfileId,
            revisionId: subjectId,
            result: verdict,
            // Ruling 88: a verdict's justification is a STORED record a
            // person reads on the task page, and it was a bare `.slice` -
            // the write-side shape ruling 131 closed for a goal. The cut
            // stays (a verdict reason is a paragraph, not a report), and it
            // now says it was cut and where the whole of it is: the agent's
            // own report, on the same timeline, which is never truncated.
            reason: clipVerdictReason(replyText ?? ""),
            at: new Date().toISOString(),
            rounds,
            reviews,
          };
          // Kept across a same-result overwrite on this revision, as `reviews`
          // is: a later round here must not erase that the question was answered.
          if (answersQuestion || (prior?.result === verdict && prior.answers === "completeness")) {
            recorded.answers = "completeness";
          }
          // Ruling 84: only a commit has a head sha to denormalize.
          if (rev) recorded.headSha = rev.headSha;
          parsed.frontmatter.verdicts = [
            ...parsed.frontmatter.verdicts.filter(
              (v) =>
                !(v.profileId === reviewerProfileId && v.revisionId === subjectId),
            ),
            recorded,
          ];
          // Ruling 94 (F37-57): a SECOND consecutive objection from this same
          // reviewer is a decision for a person, and viberr raises it rather
          // than asking the operator to. Read inside the lock, from the array
          // just written, and acted on after it — a packet write cannot happen
          // inside another file lock.
          // Ruling 52 (F36-5): never a packet on a CLOSED task. A reviewer run
          // that finishes after its task was accepted, force-accepted or
          // archived still records its verdict — evidence is evidence — and
          // ruling 52's own arm below says no coordination follows it. An
          // escalation asking a person to decide something about a shipped task
          // is exactly the packet that ruling refused, and `operatorOpenPacket`
          // refuses it by name; writing the packet here rather than through
          // that door means carrying its guard too.
          if (
            verdict === "request_changes" &&
            !parsed.packet &&
            !taskClosure(parsed.frontmatter, deadlockStages()).closed
          ) {
            const deadlock = reviewDeadlockOf(
              parsed.frontmatter,
              reviewerProfileId,
              consecutiveRequestChanges(parsed.frontmatter, reviewerProfileId),
            );
            if (deadlock) {
              const names = deadlockAgentNames(ctx, projectSlug);
              parsed.packet = buildReviewDeadlockPacket({
                taskKey,
                packetId: newId("pkt"),
                deadlock,
                // The agent's NAME, never `roleDisplay`: the card writes it as
                // an @handle, and ruling 70 is the standing rule that a handle
                // is a name. "@Review & validation" names nobody and matches
                // nothing a person can search for.
                reviewerName: names.get(reviewerProfileId) ?? roleDisplay,
                delivererName: delivererNameOf(parsed.frontmatter, names),
                // Ruling 66: read inside the same locked write that raises the
                // packet, so the card's promise is built from the hold the
                // resolution will meet — not one read a moment earlier.
                heldBy: parsed.frontmatter.blockedBy,
                // Ruling 92: an objection with no rework behind it is the
                // reviewer's answer on unchanged work, not a fresh round.
                noReworkBehind,
                revisionLabel: rev ? rev.headSha.slice(0, 7) : null,
                // Ruling 93: this run put the completeness question.
                askedWithThisReview: answersQuestion,
              });
              parsed.frontmatter.waiting = "human";
              // Ruling 99 says a packet withdraws the standing acceptance
              // offers, and this packet needs no code for it: a
              // `request_changes` always derives `validation: "failing"`, and
              // the filter a few lines below already drops every
              // `accept_completion` and, while failing, every `transition`
              // card. Calling `withdrawAcceptanceOffers` here as its siblings
              // do would withdraw nothing and write a second "the offer was
              // withdrawn" line into the decision log for one disappearance.
              deadlockEscalation.packet = parsed.packet;
              deadlockEscalation.deadlock = deadlock;
              // The NOTE is unshifted further down, after the verdict event,
              // not here. The timeline is newest-first and this note is the
              // consequence of that verdict, so it has to sit above it — but
              // the reply comment carries the timestamp it was PREPARED with,
              // which is older than anything stamped in this write. Unshifting
              // here put a note 5ms newer than the reviewer's comment BELOW it,
              // and viberr's own `timeline.out_of_order` diagnostic caught it
              // on SHOP-24 within the hour.
            }
          }
        }
        validation = deriveValidation(parsed.frontmatter);
        parsed.frontmatter.validation = validation;
        // The summary sits under the title in the timeline AND is the whole of
        // the notification, so restating the title ("Changes requested" ·
        // "… requested changes.") spends the one informative line on nothing.
        // Name the revision the verdict binds to instead — the fact a reader
        // needs next, and the one that makes a stale verdict visible.
        // Ruling 88: a verdict on the files a result came back in binds to
        // them (ruling 84), and the note says so rather than "no delivered
        // revision", which read as a verdict that bound to nothing.
        const onRevision = rev
          ? ` on \`${rev.headSha.slice(0, 12)}\``
          : subjectId
            ? " on the files delivered on this task"
            : "";
        if (moved) {
          // Ruling 84: the verdict is the reviewer's judgment of what it read,
          // recorded in words; the task's review waits for a run on what is
          // delivered now. A question this run was asked is answered all the
          // same (ruling 93), so it does not wait on a later run.
          // Ruling 83: an objection that binds to nothing sends nothing back,
          // and its title says so (as an approval's does), here and in the
          // two arms below.
          title =
            verdict === "request_changes"
              ? VERDICT_NOTE_TITLE.changesNotCounted
              : VERDICT_NOTE_TITLE.noted;
          summary =
            `${roleDisplay} ${verdict === "request_changes" ? "requested changes" : "approved"}, ` +
            `but ${subjectMovedSentence(dispatchedOn ?? null, rev)}, so the verdict does not bind to ` +
            "what is delivered now. Run the review again.";
          const asked = parsed.frontmatter.engagements.find(
            (e) => e.profileId === reviewerProfileId,
          );
          if (asked?.question && asked.question.runId === runId) asked.question = null;
        } else if (ownWork) {
          // Ruling 245: recorded in words, bound to nothing.
          title =
            verdict === "request_changes"
              ? VERDICT_NOTE_TITLE.changesNotCounted
              : VERDICT_NOTE_TITLE.noted;
          summary =
            `${roleDisplay} ${verdict === "request_changes" ? "requested changes" : "approved"}, ` +
            "but it made what is delivered, so its verdict does not count. Have another agent " +
            "deliver the work, or another reviewer judge it.";
        } else if (verdict === "request_changes") {
          title = !verdictBound
            ? VERDICT_NOTE_TITLE.changesNotCounted
            : unfoughtRepeat
              ? VERDICT_NOTE_TITLE.changesOnUnchangedWork
              : VERDICT_NOTE_TITLE.changesRequested;
          // Ruling 245: with nothing delivered, the objection binds to nothing
          // and says so, as an approval with nothing to bind to does below.
          // On AWSC-19 the event read "Validation: none. Estimate Judge
          // requested changes." over a record that held no verdict at all.
          summary = verdictBound
            ? `${roleDisplay} requested changes${onRevision}.`
            : `${roleDisplay} requested changes, but nothing on this task has been delivered for the verdict to bind to, so it does not count.`;
        } else if (!subjectId || !reviewerProfileId) {
          // Approve with nothing to bind to — nothing delivered yet. Record
          // the prose but never claim a pass.
          title = VERDICT_NOTE_TITLE.noted;
          const undelivered = reviewerProfileId
            ? filesSavedByOtherAgents(parsed.timeline, reviewerProfileId)
            : [];
          summary =
            undelivered.length > 0
              ? `${roleDisplay} approved, but nothing on this task has been delivered for the verdict to bind to: ` +
                `${joinDependencyEntries(undelivered.map((u) => `${u.agent} saved ${joinDependencyEntries(u.files.map((f) => `\`${f}\``))}`))} ` +
                "without being handed delivery. Hand delivery to the agent that made the result (`run_agent` with `delivers: true`), " +
                "have it save the final versions, and run the review again."
              : `${roleDisplay} approved, but there is no delivered revision to bind the verdict to yet.`;
        } else if (validation === "healthy") {
          title = VERDICT_NOTE_TITLE.passed;
          // R19-8: when the subject is a VERIFICATION revision, say what was
          // actually judged — there is no "work" to have approved. The two
          // bases are different facts (no branch at all vs. a branch carrying
          // nothing), so the sentence must not state one for the other.
          // Ruling 245: a task that corrected a knowledge base changed
          // something, so the approval says what, and whether the reviewer
          // made it: then it verified the repository, not its own corrections.
          const corrections = noChangeMint ? standingKbCorrections(db, projectSlug, taskKey) : [];
          const ownCorrections =
            corrections.length > 0 && corrections.every((c) => c.filedBy === roleDisplay);
          summary = noChangeMint
            ? `${roleDisplay} approved: ${corrections.length > 0 ? "nothing goes to the repository" : "there is nothing to deliver"}. ` +
              (noChangeMint.basis === "no_branch"
                ? `No \`${noChangeMint.branch}\` branch exists on the remote`
                : `\`${noChangeMint.branch}\` carries no commits ahead of \`${noChangeMint.baseBranch}\``) +
              `, verified against \`${noChangeMint.baseBranch}\` at \`${noChangeMint.baseSha!.slice(0, 12)}\`. ` +
              (corrections.length > 0
                ? `This task's outcome is ${kbCorrectionsOutcome(corrections)}` +
                  (ownCorrections ? ", so this approval is not a review of them" : "") +
                  ". Accepting completes this task with no repository changes."
                : "Accepting completes this task with no changes.")
            : `${roleDisplay} approved the work${onRevision}.`;
        } else {
          // Approved, but not yet cleared. Ruling 81 (F40-58): WHY decides
          // the words. "Rework still needed" is true only when another
          // required reviewer has requested changes (`failing`); while one has
          // simply not reported (`changed`), the same title told the owner's
          // bell that rework was needed on a revision nobody had objected to,
          // minutes before "Review passed" (WEB-1, WEB-2, WEB-4).
          const names = deadlockAgentNames(ctx, projectSlug);
          const current = currentVerdicts(parsed.frontmatter);
          const resultOf = (profileId: string) =>
            current.find((v) => v.profileId === profileId)?.result;
          const nameList = (engagements: readonly Engagement[]) =>
            LIST_AND.format(engagements.map((e) => names.get(e.profileId) ?? e.role));
          const required = requiredReviewers(parsed.frontmatter);
          const objecting = required.filter((e) => resultOf(e.profileId) === "request_changes");
          const pending = required.filter((e) => resultOf(e.profileId) !== "approve");
          if (validation === "failing" && objecting.length > 0) {
            title = `${VERDICT_NOTE_TITLE.noted}, rework still needed`;
            summary =
              `${roleDisplay} approved${onRevision}, but ${nameList(objecting)} ` +
              `requested changes on it, so it is not cleared.`;
          } else if (pending.length > 0) {
            title = `${VERDICT_NOTE_TITLE.noted}, waiting on ${nameList(pending)}`;
            summary =
              `${roleDisplay} approved${onRevision}. ${nameList(pending)} ` +
              `${pending.length === 1 ? "has" : "have"} not reviewed it yet, ` +
              "and acceptance waits for every required reviewer.";
          } else {
            title = VERDICT_NOTE_TITLE.noted;
            summary = `${roleDisplay} approved${onRevision}.`;
          }
        }
        // A not-yet-acceptable state makes a pending accept-completion
        // recommendation stale (the acceptance gate would 409), so drop it: the
        // UI must not show a misleading "Accept completion" card. The operator
        // re-recommends the right next step on its next turn.
        // F36-6 (pass 36): a FAILING verdict also voids any pending
        // "move to <review/acceptance stage>" card — Viberr's own delivery
        // next-step or the operator's — since applying it would carry a
        // rejected revision across the approval boundary.
        if (validation !== "healthy") {
          parsed.frontmatter.recommendations =
            parsed.frontmatter.recommendations.filter(
              (r) =>
                r.kind !== "accept_completion" &&
                !(validation === "failing" && r.kind === "transition"),
            );
        }
      }
      // ATOMIC: the agent's reply comment, its verdict, and its question land
      // in this ONE write. Unshift the reply first, then the verdict, so the
      // verdict reads newest and the agent's reply sits just below it.
      //
      // P13-D-26: exactly ONE of the two carries the evidence rows — the
      // verdict event when there is a verdict (it IS the outcome), otherwise
      // the agent's report. Duplicating them across both would double the
      // record for one outcome. The run's saved files follow the same rule.
      if (postsReplyEvent) {
        let replyEvent = prepared.event;
        if (evidence && !verdict) replyEvent = { ...replyEvent, evidence };
        if (attachments && !verdict) replyEvent = { ...replyEvent, attachments };
        /**
         * Ruling 88: TITLE it, because this comment is the only complete copy
         * of a justification the stored record is a clip of — and the two
         * fields that protect a comment from compaction were just moved OFF it,
         * three lines up, precisely BECAUSE there is a verdict.
         *
         * So the protection was exactly inverted: a deliverer's report carries
         * evidence and is immune, while the verdict report — which ruling 88's
         * own marker calls "on this task's timeline, whole" — was the first
         * thing folded away. Live on SHOP-76 three of four rounds of review
         * reasoning were unrecoverable from canonical `task.md` while every
         * `verdicts[].reason` still pointed at them.
         */
        if (verdict) replyEvent = { ...replyEvent, title: VERDICT_REPORT_TITLE };
        parsed.timeline.unshift(replyEvent);
        // Ruling 85: a run that ends by asking a person has not delivered.
        if (!question) {
          stampNonCommitDelivery(
            parsed.frontmatter,
            actorRef,
            replyEvent.attachments ?? null,
            replyEvent.occurredAt,
            input.delivers,
            delivered,
          );
        }
      } else if (!verdict && (attachments || hasEvidence)) {
        // The prose was suppressed (guardrail-dropped, or an F22-12 duplicate of
        // this run's own mid-run comment), but the run still produced evidence
        // and/or saved files. Record a producing note so the outcome's evidence
        // rows and attributed files are not lost with the text.
        const producing: TaskFileEvent = {
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: actorRef,
          title: null,
          text: attachments
            ? attachments.length === 1
              ? "Saved 1 file to this task's attachments during the run."
              : `Saved ${attachments.length} files to this task's attachments during the run.`
            : "Recorded this run's evidence.",
          toAgent: false,
          evidence: hasEvidence ? evidence : null,
        };
        if (attachments) producing.attachments = attachments;
        parsed.timeline.unshift(producing);
        // Ruling 85: a run that ends by asking a person has not delivered.
        if (!question) {
          stampNonCommitDelivery(
            parsed.frontmatter,
            actorRef,
            attachments,
            producing.occurredAt,
            input.delivers,
            delivered,
          );
        }
      }
      if (verdict) {
        const verdictEvent: TaskFileEvent = {
          occurredAt: new Date().toISOString(),
          type: "quality",
          // D8: the outcome is the AGENT'S judgment — attribute it honestly.
          actor: actorRef,
          title,
          text: verdictNoteText(validation, summary),
          toAgent: false,
          evidence,
        };
        if (attachments) verdictEvent.attachments = attachments;
        parsed.timeline.unshift(verdictEvent);
        verdictAt = verdictEvent.occurredAt;
        // Ruling 94: the escalation note goes ABOVE the verdict that caused
        // it, which means last, and with a stamp that cannot be older than what
        // it sits on.
        if (deadlockEscalation.packet) {
          parsed.timeline.unshift({
            occurredAt: new Date().toISOString(),
            type: "comment",
            actor: { kind: "system", systemId: "policy-engine" },
            title: deadlockEscalation.packet.title,
            text: `**Decision packet:** ${deadlockEscalation.packet.title}. Awaiting a human decision.`,
            toAgent: false,
            evidence: null,
          });
        }
      }
      // Ask-human question from the outcome envelope (Codex transport; the
      // Claude toolkit opens its packet live mid-run). One packet slot per
      // task — never clobber an open decision.
      if (question && !parsed.packet) {
        const asked = buildAgentQuestionPacket(actorRef, question);
        parsed.packet = asked;
        questionPacketId = asked.id;
        parsed.frontmatter.waiting = "human";
        if (questionCause) {
          questionWithdrawal.offers = withdrawAcceptanceOffers(
            parsed,
            questionTerminalStageId,
            questionCause,
            actorRef,
          );
        }
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: actorRef,
          title: null,
          text: askedEntryText(`${QUESTION_LEAD} ${asked.title}`, asked),
          toAgent: false,
          evidence: null,
        });
        questionOpened = true;
      } else if (question) {
        // P13-RT-06 (same site): the envelope carried a question but a decision
        // is already open, so it cannot become a packet. Claude's `ask_human`
        // tool tells the model that mid-run ("[refused] … mention your question
        // there instead") and it folds the question into its report; the Codex
        // envelope had no such channel and the question vanished with no
        // timeline trace at all. Record it so the open decision's reader sees
        // what else the agent needs.
        questionDeferred = question.title.trim();
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: actorRef,
          title: null,
          text:
            `**Question held (a decision is already open):** ${questionDeferred}` +
            (question.body?.trim() ? `\n\n${question.body.trim()}` : "") +
            "\n\nAnswer it alongside the open decision, or re-prompt the agent once that decision is resolved.",
          toAgent: false,
          evidence: null,
        });
      }
    });
    delivered = keepStampedDelivery(ctx, projectSlug, taskKey, stampBefore, written);
    reprojectTask(db, ctx, projectSlug, taskKey);
    // Ruling 94 (F37-57): the packet itself was written inside the verdict's
    // own lock above, so the objection and the escalation it raised can never
    // land apart. What is left is telling people — a decision nobody is
    // notified about waits exactly as long as it takes someone to open the task
    // by chance.
    if (deadlockEscalation.packet && deadlockEscalation.deadlock) {
      recordAudit(db, {
        action: "task.review.deadlock",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: {
          profileId: deadlockEscalation.deadlock.profileId,
          rounds: deadlockEscalation.deadlock.rounds,
        },
      });
      notifyTaskWatchers(
        db,
        {
          projectSlug,
          taskKey,
          kind: "packet",
          ptype: "input",
          title: `Decision needed: ${deadlockEscalation.packet.title}`,
          text: deadlockEscalation.packet.body,
          // Ruling 75: the row opens the packet, where it is decided.
          about: { decision: deadlockEscalation.packet.id },
          // Ruling 94: `notifyTaskWatchers` stamps OPERATOR_NOTIFY_FROM on any
          // notice that names nobody, so leaving this off told the inbox the
          // Operator raised it — contradicting the card, which says
          // `from: policy-engine`, and contradicting the ruling, whose whole
          // point is that this is not the operator's judgement.
          from: POLICY_ENGINE_NOTIFY_FROM,
        },
        ctx,
      );
    }
    // P13-RT-01 (NEW-4, broken on its PRIMARY path): a FINISHED agent's report
    // that tags a human ("@Arda …") must reach their inbox. Only the
    // interrupted/errored path (postAgentReplyComment) and Claude's mid-run
    // post_comment tool fanned out, so the common case — the agent replies,
    // the run completes — notified nobody, on either backend. The reply
    // directive explicitly instructs the agent to tag the commenter, so this
    // was the majority of agent @tags. Same helper/`from` shape as :1169.
    if (postsReplyEvent) {
      // Ruling 20: and the event records who it reached, so compaction keeps it.
      await stampNotifiedRecipients(
        db,
        taskRef(ctx, projectSlug, taskKey),
        prepared.event,
        notifyMentionedUsers(db, {
          // B-FD8b: the PRE-trim reply text — a handle inside a separated
          // evidence fence must still reach the tagged human's inbox.
          text: prepared.mentionSourceText,
          projectSlug,
          taskKey,
          from: createActorResolver(db, {
            agentNames: agentNamesByProfile(db, projectSlug),
          })(actorRef),
          occurredAt: prepared.event.occurredAt,
        }),
      );
    }
    // The deduped-reply case is fanned out earlier (before the nothing-to-record
    // early return), so it is NOT repeated here — see the
    // `prepared.duplicatedText` fan-out near the top of this function.
    // Recovery-idempotency audit for the reply (posted, guardrail-dropped, or
    // deduped as an F22-12 duplicate). Skip only a genuinely empty reply.
    if (prepared.status !== "empty") {
      recordAgentRepliedAudit(
        db,
        projectSlug,
        taskKey,
        runId,
        postsReplyEvent ? null : suppressedReason,
      );
    }
    if (questionOpened) {
      if (questionCause && questionWithdrawal.offers) {
        recordRecommendationWithdrawal(db, {
          projectSlug,
          taskKey,
          withdrawal: questionWithdrawal.offers,
          cause: questionCause,
          actor: { userId: null, label: encodeActorRef(actorRef) },
        });
      }
      recordAudit(db, {
        action: "task.agent.packet_opened",
        // P13-RT-06: the AGENT asked, not the operator. The Claude transport
        // has attributed this correctly since P11-23
        // (agent-toolkit.server.ts); the Codex transport recorded the same
        // action id under OPERATOR_AUDIT_ACTOR, so an actor-filtered audit view
        // credited every Codex agent's question to the operator.
        actor: { userId: null, label: encodeActorRef(actorRef) },
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: {
          runId,
          title: question!.title.trim(),
          actorRef: encodeActorRef(actorRef),
        },
      });
      // F37-64: ruling 74 fixed ONE of the two question doors. Its words are
      // "the notification says WHO is asking … an agent's own question reached
      // the owner's inbox under the Operator's name and avatar, on the one
      // surface whose chip IS the 'who wants something from you' signal" — and
      // it was applied in `agent-toolkit.server.ts`, the CLAUDE `ask_human`
      // tool. This is the CODEX outcome-envelope door, which copies that
      // ruling's title format and never set `from`, so `notifyTaskWatchers`
      // stamped `OPERATOR_NOTIFY_FROM` over it.
      //
      // Live on SHOP-5 at 16:52:12: title "Infrastructure Engineer asks:
      // Gateway route proof", sender `{"kind":"agent","name":"Operator"}`, on a
      // packet whose own `from` reads
      // `agent:codex/infrastructure-engineer (Infrastructure Engineer)`.
      const askNotice: TaskWatcherNotice = {
        projectSlug,
        taskKey,
        // Ruling 74 (F40-48): the same `question` kind the Claude door
        // writes (agent-toolkit.server.ts), with its own pill and toggle.
        kind: "question",
        title: `${roleDisplay} asks: ${question!.title.trim()}`,
        text: question!.body ?? "An engaged agent needs a human decision.",
        // Ruling 75: the row opens the question's card, where it is answered.
        about: { decision: questionPacketId },
        // Ruling 74: the asker by name; the Operator only when the operator asked.
        from:
          actorRef.kind === "agent"
            ? { kind: "agent", backend: actorRef.backend, name: roleDisplay, role: roleDisplay }
            : OPERATOR_NOTIFY_FROM,
      };
      notifyTaskWatchers(db, askNotice, ctx);
    } else if (questionDeferred) {
      logger.info("agent question held: a decision packet is already open", {
        taskKey,
        runId,
        question: questionDeferred,
      });
    }
    if (verdict) {
      recordAudit(db, {
        action: "task.quality.flagged",
        actor: OPERATOR_AUDIT_ACTOR,
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: { verdict, validation, actorRef: encodeActorRef(actorRef) },
      });
      // Ping the owner + supervisors so the quality inbox card appears on real
      // runs (not just seed). Each recipient's `quality` routing pref is honored
      // inside notifyTaskWatchers → createNotification.
      notifyTaskWatchers(
        db,
        {
          projectSlug,
          taskKey,
          kind: "quality",
          title,
          text: summary,
          about: verdictAt ? { event: verdictAt } : null,
          // Ruling 74: the reviewer that judged, not the Operator — 673
          // "Review passed" notifications on this instance named the wrong agent.
          from:
            actorRef.kind === "agent"
              ? {
                  kind: "agent",
                  backend: actorRef.backend,
                  name: agentRoleDisplay(actorRef),
                  role: agentRoleDisplay(actorRef),
                }
              : OPERATOR_NOTIFY_FROM,
        },
        ctx,
      );
    }
  } catch (error) {
    logger.warn("agent completion recording failed", {
      taskKey,
      err: toError(error),
    });
  }
  // Ruling 94: when the write above threw, nothing was escalated and the
  // caller reacts exactly as it always did.
  return { escalated: deadlockEscalation.packet !== null, verdictBound, delivered };
}

/**
 * Ruling 84: what moved under a reviewer while it ran, in its verdict note's
 * words. `from` is the subject it was dispatched on (null when nothing had been
 * delivered), `rev` the task's active revision now (null when the delivery is
 * files).
 */
function subjectMovedSentence(from: string | null, rev: WorkRevision | null): string {
  if (rev) {
    const sha = `\`${rev.headSha.slice(0, 12)}\``;
    return from === null
      ? `it started before ${sha} was delivered`
      : `${sha} was delivered while it was reviewing the revision before it`;
  }
  if (from === null) return "it started before the files on this task were delivered";
  return from.startsWith("files:")
    ? "the files on this task were delivered again while it was reviewing them"
    : "the files on this task were delivered while it was reviewing a revision";
}

/**
 * Ruling 69 (F37-23): deliver the @mention that could not start while this
 * agent was running.
 *
 * The single-flight guard refuses a mention of an agent that already has a live
 * run on the task — correctly; two processes in one checkout is the thing it
 * exists to prevent. What was wrong was what viberr said next: "it will see the
 * comment when it next re-anchors". The anchor carries the last five timeline
 * events, clamped, and only a FRESH run builds one, so the promise held only if
 * that agent happened to run again on that task before five more events landed.
 * Live on SHOP-6 neither held: an owner's correction was eight events back
 * within 75 seconds, and the Platform Architect it named never ran on the task
 * again before it was accepted.
 *
 * Nothing is queued in memory. The comment IS the record, and "undelivered"
 * is derivable from it: a human comment addressed to this agent, posted after
 * this run started, cannot have started a run of its own — the single-flight
 * guard is the only thing that could have refused it.
 *
 * Ruling 69: EVERY such comment goes into ONE directive, not the oldest one
 * into one run. The first draft delivered the oldest and claimed the rest would
 * "ride the next completion"; they cannot. The window is "newer than the run
 * that was busy", so the moment the oldest starts a redelivery run, the others
 * are older than THAT run's start and no later completion can see them again —
 * a two-message burst lost its second message, silently, which is the failure
 * this whole function exists to stop. Merging also matches what the operator
 * lease already does with a person's consecutive comments: one burst is one
 * question, not N governed drives.
 *
 * Returns true when a run started, and the caller then leaves the operator's
 * own react trigger alone: a person's instruction goes first.
 */
export async function deliverDeferredMention(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    /** The completed run's start, the window's lower bound. Null (no recorded
     *  start) means there is no honest window, so nothing is claimed. */
    runStartedAt: string | null;
  },
): Promise<{ started: boolean; pending: number }> {
  const none = { started: false, pending: 0 };
  const startedAt = input.runStartedAt;
  if (!startedAt) return none;
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) return none;
  const { resolveMentionedAgent } = await import("./agent-reply.server");
  const mine: { at: string; text: string; userId: string }[] = [];
  for (const event of file.parsed.timeline
    .filter((e) => e.type === "comment" && e.toAgent && e.actor.kind === "human")
    .filter((e) => e.occurredAt > startedAt)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    if (event.actor.kind !== "human") continue;
    const target = resolveMentionedAgent(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      event.text,
    );
    if (target?.profileId === input.profileId) {
      mine.push({ at: event.occurredAt, text: event.text, userId: event.actor.userId });
    }
  }
  const oldest = mine[0];
  if (!oldest) return none;
  // One author (the ordinary case: one person typing twice) reads as one
  // message. Several authors keep their names inline, because the directive
  // can only tell the agent to tag ONE person back (NEW-4) and the others must
  // at least be visible in what it is answering.
  const authors = new Set(mine.map((m) => m.userId));
  const text =
    mine.length === 1
      ? oldest.text
      : mine
          .map((m) => (authors.size > 1 ? `${userDisplayName(db, m.userId)}: ${m.text}` : m.text))
          .join("\n\n");
  logger.info("delivering the @mention(s) refused while the agent was running", {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    comments: mine.length,
    oldestAt: oldest.at,
  });
  const { commentToAgent } = await import("./task-comments.server");
  const result = await commentToAgent(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      text,
      redelivered: true,
    },
    // The person who has been waiting longest is the one the agent is told to
    // tag back.
    { userId: oldest.userId, label: userDisplayName(db, oldest.userId) },
    ctx,
  );
  // Ruling 69: the caller needs to know a delivery was OWED, not only
  // whether one started — a refused redelivery leaves a written promise on the
  // record and, before this, nothing anywhere contradicted it.
  return { started: result.triggered !== null, pending: mine.length };
}

/**
 * Ruling 69: withdraw, on the record, a delivery promise that cannot be
 * kept. `commentToAgent`'s single-flight refusal writes "Viberr starts it on
 * this comment as soon as that run finishes" onto the timeline; when the
 * completion hop cannot start that run — the task closed underneath it, the
 * stage stopped admitting the profile, a credential went away — the person is
 * owed the correction in the same place they were given the promise.
 */
async function appendUndeliveredMentionNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; agentHandle: string },
  owed: number,
): Promise<void> {
  try {
    await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
      title: "Mention still not delivered",
      text:
        `**Not delivered:** ${owed === 1 ? "a comment" : `${owed} comments`} addressed to ` +
        `@${input.agentHandle} could not be started when its run finished, so the delivery ` +
        `promised when the comment was refused has not happened. ` +
        `${owed === 1 ? "It stays" : "They stay"} on the record; mention the agent again once ` +
        `the task can run one.`,
    });
  } catch (error) {
    logger.warn("undelivered-mention note failed", {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

/** The finished run a completion acts on: what the live callback registers and
 *  boot recovery replays. */
interface AgentCompletionInput {
  projectSlug: string;
  taskKey: string;
  backend: RealBackend;
  /** The engaged profile's stable identity. */
  profileId: string;
  role: string;
  /** The engagement owns the workspace/branch/PR (G1) — gates delivery
   *  reconcile + the single-flight semantics; NEVER a behavior kind. */
  delivers: boolean;
  /** Staging key for a Claude toolkit report_outcome envelope (absent for
   *  Codex/recovered runs — their envelope re-parses from the stored reply). */
  outcomeKey?: string;
  workdir: string | null;
  /** The agent's @mention handle, for the stuck-loop packet copy. */
  agentHandle: string;
  /** C5 (pass 25): this run was started to answer a human's @mention/directive
   *  (`directiveFrom` was set), not as a bare review invocation. A reviewer
   *  answering a conversational @mention produces no verdict BY DESIGN, so the
   *  "reviewer finished without a readable verdict" note must NOT fire for it —
   *  even while the task sits at the review stage. Only a run started FOR review
   *  (Run button / operator review, no human directive quoted) expects a verdict. */
  fromHumanDirective?: boolean;
  /** F-P11 (pass 25): this Codex run was actually given the outcome-envelope
   *  outputSchema (verdict/ask/evidence-capable). When explicitly `false`, its
   *  reply is plain prose and must NOT be re-parsed as an envelope (a plain
   *  developer's reply that happens to be a bare JSON object would otherwise be
   *  silently truncated to its `summary` field). Undefined → unknown (recovery),
   *  which keeps the legacy re-parse so a recovered envelope still resolves. */
  envelopeRequested?: boolean;
  /** Dispatch-completion contract (2026-08-29): display name of the human
   *  whose manual/scheduled dispatch started this run. Presence makes the
   *  final report always tag them + @operator (appended when the model forgot)
   *  and always re-invokes the operator. PERSISTED on the run row (pass 32,
   *  C02-R11) so a run recovered after a restart keeps the contract — it used
   *  to be closure-only and degrade to the react heuristic with no cc line. */
  dispatchedByName?: string;
  /** The dispatcher's user id — what the cc-append verifies notification
   *  against (the mention ladder resolves people, not substrings). */
  dispatchedByUserId?: string;
  /** Present when started inside an operator react loop (continue the chain). */
  operatorRun?: { backend: RealBackend; autonomy: OperatorAutonomy; reactDepth: number; reactHops?: number };
}

/** Register the single completion pipeline: record, reconcile, and continue coordination. */
export async function registerAgentCompletion(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: AgentCompletionInput & {
    runId: string;
    /** Ruling 87 (F37-77): the workspace checkout could not be provisioned, so
     *  this run executed with NO working tree. PERSISTED on the run row for the
     *  same reason as `outcomeKey` — the closure that would otherwise carry it
     *  dies with the process, and a recovered reviewer would have its report
     *  re-classified into a verdict it never gave. */
    noCheckout?: boolean;
  },
): Promise<void> {
  // Persist on the run row what boot recovery must re-find after a restart —
  // the in-process callback below holds these only in a closure that dies
  // with the process: the staging key for the staged report_outcome envelope
  // (AO-1) and the dispatcher of the dispatch-completion contract (C02-R11).
  const persisted: Parameters<typeof patchRun>[2] = {};
  if (input.outcomeKey) persisted.outcomeKey = input.outcomeKey;
  if (input.noCheckout) persisted.noCheckout = 1;
  if (input.dispatchedByName) {
    persisted.dispatchedByName = input.dispatchedByName;
    if (input.dispatchedByUserId) persisted.dispatchedByUserId = input.dispatchedByUserId;
  }
  if (Object.keys(persisted).length > 0) patchRun(db, input.runId, persisted);
  const { registerRunCompletion, noteCompletionEffectsLost } = await import(
    "~/server/runtimes/run-service.server"
  );
  registerRunCompletion(input.runId, (finished) => {
    void applyAgentCompletionEffects(db, ctx, input, {
      id: finished.id,
      state: finished.state,
    }).catch(async (cause: unknown) => {
      logger.error("agent-run completion handler failed", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: toError(cause),
      });
      // C4 (pass-24 fix): THIS rejection is the real failure path. The callback
      // is `void applyAgentCompletionEffects(...).catch(...)`, so it never throws
      // synchronously — the guard in run-service (`fireIfAlreadyTerminal`) wraps a
      // synchronous `cb()` call and can never catch an async rejection here. Surface
      // the lost effects where they actually fail, or the board reads "agent working"
      // until the next restart replays recovery. `noteCompletionEffectsLost` is
      // itself best-effort and never throws.
      await noteCompletionEffectsLost(db, finished, ctx.dataRoot);
    });
  }, db);
}

/**
 * Ruling 78 (pass 35, F35-10): the evidence stamp above claims only files that
 * reached the task's real `attachments/` dir. An agent under an older prompt
 * created `projects/<slug>/tasks/<key>/attachments` INSIDE its repository
 * checkout instead, so its file never reached the task page and a delivery
 * would have carried Viberr's store layout into the repository. Scan the run's
 * workspace candidates for that folder and post one warning line naming it and
 * what it holds, so a person learns why the attachment is missing. Best-effort:
 * a warning that cannot be written never fails the completion.
 */
async function warnStrayAttachmentsFolder(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; workdir: string | null },
  runId: string,
): Promise<void> {
  const { findStrayAttachmentsFolder } = await import(
    "~/server/files/task-attachments.server"
  );
  const wsRoot = path.join(taskDir(input.projectSlug, input.taskKey, ctx.dataRoot), "workspace");
  const repo = projectRepoFor(ctx, input.projectSlug);
  const repoName = repo ? (repo.split("/").pop() ?? repo) : null;
  const candidates = [
    ...(input.workdir ? [input.workdir] : []),
    ...(repoName ? [path.join(wsRoot, repoName)] : []),
    path.join(wsRoot, "repo"),
    wsRoot,
  ];
  const stray = findStrayAttachmentsFolder(candidates, input.projectSlug, input.taskKey);
  if (!stray) return;
  const realDir = taskAttachmentsDir(input.projectSlug, input.taskKey, ctx.dataRoot);
  const held =
    stray.files.length > 0
      ? `It holds ${stray.files.map((f) => `\`${f}\``).join(", ")}; those files were NOT posted on this task.`
      : "It is empty.";
  const text =
    `A folder named \`${stray.rel}\` exists inside the run's repository checkout (\`${stray.dir}\`). ` +
    `That is Viberr's own store layout, not the task's attachments folder, which is \`${realDir}\`. ` +
    `${held} A delivery that carries the folder is refused; remove it from the branch and move the files to the real folder.`;
  logger.warn("stray store-layout attachments folder inside the workspace checkout", {
    taskKey: input.taskKey,
    runId,
    dir: stray.dir,
    files: stray.files,
  });
  try {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "policy",
        actor: { kind: "system", systemId: "delivery" },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  } catch (err) {
    logger.warn("failed to post the stray attachments folder warning", {
      taskKey: input.taskKey,
      runId,
      err: toError(err),
    });
  }
}

/**
 * The completion EFFECTS (reply → reconcile → verdict → react/stuck-packet/
 * waiting-flip) — shared by the live callback above and the boot-recovery
 * reconciler, so a run recovered after a restart behaves byte-for-byte like one
 * whose callback fired in-process.
 */
export async function applyAgentCompletionEffects(
  db: DatabaseSync,
  /** `deps.runOperator` (tests) replaces the react's operator run, as it does
   *  every other operator hand-off. */
  ctx: TaskActionContext,
  input: AgentCompletionInput & {
    /** Ruling 163(d): set by boot recovery, which replays a run's lost effects
     *  possibly days later. The deferred-@mention redelivery is a promise made
     *  by the LIVE refusal and belongs to the live completion; replaying it from
     *  an old run's window would re-deliver a comment a human has since had
     *  answered, starting a duplicate paid run on a stale instruction. */
    replayed?: boolean;
  },
  finished: { id: string; state: string },
): Promise<void> {
  const { fullReplyTextForRun } = await import("./agent-reply.server");
  /** Ruling 94: this completion's own verdict raised the review-deadlock
   *  packet, so the operator react at the end of this function is suppressed —
   *  see the arm that reads it. */
  let raisedDeadlockPacket = false;
  /** Ruling 86: the stamp of the delivery this completion stamped and kept. */
  let stampedDelivery: string | null = null;
  // Ruling 194: the run has ended, so the pictures `capture_page` kept for it
  // go with it. Never awaited and never a reason for the effects to fail.
  void removeRunPageCaptures(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId: finished.id,
  });
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: input.backend,
    profileId: input.profileId,
    roleHint: input.role,
  };
  // The timeline comment stores the FULL reply (2026-07-17 ruling — the old
  // 1,200-char cap made "(truncated — full report in the agent logs)" the only
  // way to read a long report; the timeline UI clamps + expands instead). The
  // operator snapshot caps per-comment text on ITS side, so prompts stay
  // bounded.
  const fullText = fullReplyTextForRun(db, finished.id);
  // The prior reply must predate THIS run so a mid-run post_comment from this
  // same run can't be mistaken for it (corrupting no-progress detection).
  const thisRunRow = getRun(db, finished.id);
  const thisRunStartedAt = thisRunRow?.started_at ?? null;
  // Ruling 69: the redelivery window must open when the single-flight guard
  // STARTED refusing, not when the provider process launched. That guard keys on
  // `state IN ('running','queued')` (commentToAgent), which begins at the row's
  // INSERT — and a run admitted behind a concurrency cap sits queued for minutes
  // with no `started_at` at all. Using the launch instant dropped every comment
  // refused during that wait, silently, under a note promising delivery.
  const deferredWindowFrom = thisRunRow?.created_at ?? thisRunStartedAt;
  // Ruling 82: the sources this run kept leave one entry on the timeline,
  // for a finished, a failed and an interrupted run alike: what a run read is
  // on the task whatever became of the run. Written before the run's files
  // are listed and its reply lands, so the thread reads in the order things
  // happened and the listing below (ruling 77) runs as it did. An entry that
  // cannot be written never fails the completion: the sources stay listed on
  // the page.
  try {
    await noteSourcesKeptByRun(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: finished.id,
      actorRef,
      startedAt: thisRunStartedAt,
    });
  } catch (err) {
    logger.warn("failed to note the sources a run kept", {
      taskKey: input.taskKey,
      runId: finished.id,
      err: toError(err),
    });
  }
  // Files this run saved into the task's attachments/ dir (browser captures):
  // everything written at-or-after the run started. Stamped onto the producing
  // event below so the panel can say who added each file and from which
  // message; without a recorded start there is no honest window, so nothing is
  // claimed.
  const {
    attachmentClaimsInFlight,
    attachmentNamesSince,
    listTaskAttachmentNames,
    pruneBrowserWorkingArtifacts,
    savedFilesText,
  } = await import("~/server/files/task-attachments.server");
  const runAttachmentsRaw = thisRunStartedAt
    ? attachmentNamesSince(
        input.projectSlug,
        input.taskKey,
        thisRunStartedAt,
        ctx.dataRoot,
      )
    : [];
  // Ruling 77: read after the listing and before the timeline below, so a
  // file this run's window holds is either still held by the writer putting
  // it down for someone else, or already claimed on the timeline.
  const heldForOthers = attachmentClaimsInFlight(input.projectSlug, input.taskKey);
  const prevReply = latestAgentReplyText(
    ctx,
    input.projectSlug,
    input.taskKey,
    input.backend,
    input.profileId,
    thisRunStartedAt,
  );
  // 1. Resolve this run's OUTCOME ENVELOPE (G4) + collaboration gates, then
  //    land the reply + verdict + question in ONE atomic write for EVERY
  //    finished run (the reviewer's atomic path is now the universal path —
  //    the two-write split silently lost comments on the docker bind mount).
  //    A non-finished run (interrupt) has no outcome; it still reports its
  //    partial reply below.
  const {
    parseAgentOutcomeJson,
    resolveAgentCollab,
    takeStagedOutcome,
  } = await import("./agent-outcome.server");
  // Gates resolve at COMPLETION time from the live deployment (recovery gets
  // identical behavior); verdict is OFF unless a profile explicitly grants it
  // (F10-14 removed the old "supporting → verdict on" implicit rule).
  //
  // R15-7 (owner ruling, 2026-07-28): a profile that CANNOT be resolved is
  // fully conservative HERE too, not just on the run path. This used to start
  // from `[]`, which `resolveAgentCollab` reads through the catalog defaults as
  // comment/ask/evidence GRANTED — so a ghost profile's finished run could
  // still open a question packet and assert evidence rows in a vanished
  // profile's name, the exact posture the run layer had just withheld.
  let grants: { capabilityId: string; mode: "direct" | "recommend" | "human" | "off" }[] =
    withheldAgentGrants();
  /** Ruling 202: the deployed profile's name, the author a relay names; null
   *  for a vanished profile, whose relays are withheld like its grants. */
  let deployedName: string | null = null;
  if (input.profileId) {
    try {
      const { resolveDeployedSpecialist } = await import("./specialist-roster.server");
      const deployed = resolveDeployedSpecialist(ctx, input.projectSlug, input.profileId);
      grants = deployed.capabilities;
      deployedName = deployed.name;
    } catch {
      // undeployed — everything stays withheld
    }
  }
  const collab = resolveAgentCollab(grants);
  // F10-15 consistency: the REQUIRED-reviewer set (acceptanceBlockedReason /
  // requiredReviewers) is computed from the engagement's engage-time
  // `verdictCapable` snapshot. Verdict RECORDING must use the SAME source, or a
  // required reviewer whose live grant was later removed/undeployed can approve
  // but never record — leaving the task un-acceptable through the normal accept
  // paths (an admin can still `forceAcceptCompletion`, audited — DG-2). Prefer
  // the engagement snapshot; fall back to the live grant only when there is no
  // engagement row (legacy/ad-hoc runs).
  const completionFile =
    readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed ?? null;
  const completionFm = completionFile?.frontmatter ?? null;
  // Ruling 77: a file a PERSON attached while this run was in flight is in
  // the run's mtime window too, and it is theirs: claiming it would name the
  // run as its author and, for a deliverer, move `deliveredAt` onto the
  // person's input. Their note claims the name; the run does not. Ruling 71:
  // the same for a file a relay carried here from another task. A claim by
  // another RUN is not excluded: the deliverer claims its whole window even
  // when a run beside it named one of its files (ruling 85 narrows what a run
  // that does not deliver claims, below).
  // Ruling 76: each such name is taken as the file the folder holds for it.
  // A hold is taken under the name as checked, while an upload that replaces
  // a file stored decomposed keeps that file's own name, so the two can
  // differ in form; a folder holding both forms as two files keeps them apart.
  const carriedHere =
    thisRunStartedAt && completionFile
      ? completionFile.timeline
          .filter(
            (e) => e.occurredAt >= thisRunStartedAt && (e.actor.kind === "human" || isRelayComment(e)),
          )
          .flatMap((e) => e.attachments ?? [])
      : [];
  // Every name the folder was seen to hold: its listing, and the window's own
  // names, which were read a moment earlier and by their own rule.
  const onTask = [
    ...new Set([...listTaskAttachmentNames(input.projectSlug, input.taskKey, ctx.dataRoot), ...runAttachmentsRaw]),
  ];
  // Ruling 86: and a picture the record says Viberr's own render wrote. The
  // window's listing already left out the picture of every page the folder
  // holds; this is the one whose page has since left the task.
  const viberrs = recordedPageCaptures(completionFm?.pageCaptures);
  const someoneElses = new Set(
    [...carriedHere, ...heldForOthers, ...viberrs].map((name) => storedNameAmong(onTask, name)),
  );
  const runSaved = runAttachmentsRaw.filter((name) => !someoneElses.has(name));
  const verdictEngagement =
    input.profileId && completionFm
      ? completionFm.engagements.find((e) => e.profileId === input.profileId)
      : null;
  // Ruling 87: a delivering run's reply is its delivery. A verdict in it is a
  // verdict on its own work, which no review counts, and taking it as one filed
  // the run's files as evidence for it instead of as the delivery. Keyed on how
  // the run was DISPATCHED (`input.delivers`, the same flag the delivery
  // reconcile reads), not on the roster at completion, so a review run whose
  // profile was handed delivery while it worked still records its verdict.
  const verdictAuthorized =
    !input.delivers && (verdictEngagement ? verdictEngagement.verdictCapable === true : collab.verdict);
  // Envelope: a Claude toolkit-staged outcome first; else a Codex
  // outputSchema reply (JSON) parsed from the stored full text.
  let outcome = input.outcomeKey ? takeStagedOutcome(db, input.outcomeKey) : null;
  let replyText = fullText;
  // F-P11 (pass 25): only re-parse a Codex reply as an outcome envelope when this
  // run was ACTUALLY given the envelope outputSchema. A plain Codex developer
  // (no verdict/ask/evidence grant) never gets it, so its prose reply — even one
  // that happens to be a bare `{ "summary": ... }` JSON object — must stay whole
  // rather than being truncated to a field. `undefined` (a recovered run) keeps
  // the legacy re-parse so a genuine recovered envelope still resolves.
  if (
    !outcome &&
    input.backend === "codex" &&
    input.envelopeRequested !== false &&
    fullText
  ) {
    const parsedEnvelope = parseAgentOutcomeJson(fullText);
    if (parsedEnvelope) {
      outcome = parsedEnvelope;
      // The raw JSON must never become the timeline comment.
      replyText = parsedEnvelope.summary ?? null;
    }
  }
  if (!replyText && outcome?.summary) replyText = outcome.summary;
  // Dispatch-completion contract (2026-08-29), mechanical half: the report of a
  // manually/schedule-dispatched run always tags the dispatching human (the tag
  // is what notifies them — NEW-4) and @operator. The prompt asked for both in
  // the model's own words; append only what is missing, BEFORE the reply is
  // stored, so no-progress comparison, the operator's react input and the
  // timeline all see one consistent text (R20-9's guarantee-over-guidance).
  //
  // Hunt 2026-08-29: "already tagged?" is answered by the SAME resolution
  // ladder the fan-out delivers with, keyed on the dispatcher's USER ID — the
  // old first-word substring check was satisfied by "@Arda Other" when the
  // dispatcher was "Arda Kaya" (a tag the ladder rules ambiguous and delivers
  // to nobody), so the guaranteed ping vanished exactly when names collided.
  if (input.dispatchedByName && finished.state === "finished" && replyText) {
    const name = input.dispatchedByName;
    const hasHumanTag = input.dispatchedByUserId
      ? mentionNotifiesUser(db, replyText, input.dispatchedByUserId)
      : replyText.includes(`@${name}`);
    const hasOperatorTag = /@operator\b/i.test(replyText);
    const missing = [
      ...(hasHumanTag ? [] : [`@${name}`]),
      ...(hasOperatorTag ? [] : ["@operator"]),
    ];
    if (missing.length > 0) {
      replyText = `${replyText}\n\ncc ${missing.join(" ")}`;
    }
  }
  // Ruling 78 (owner ask 2026-08-31): the browser MCP writes its own WORKING
  // artifacts — `page-*.yml` aria snapshots, `console-*.log` dumps — into the
  // attachments store, because `--output-dir` IS that store. Tool transport was
  // posted to humans next to the screenshots and drowned the panel. Delete this
  // run's machine-stamped non-visual artifacts UNLESS the exact filename is
  // cited — the persona's "cite the exact filename" contract is how an agent
  // marks a file as for-humans. Screenshots/PDFs and deliberately named files
  // are never pruned. Runs after replyText/outcome are FINAL so every citation
  // source exists, and before every consumer of the list so they all tell the
  // same story. Two scoping guards (ruling-78 review, both CONFIRMED live):
  //  · FINISHED runs only — an error/interrupted browsing run never got to
  //    cite anything, and its console dump is often its only diagnostic;
  //  · no prune while a SIBLING run is live on this task: the mtime window is
  //    task-wide, so a finishing run would delete a still-working sibling's
  //    files before that sibling's citations exist. The sibling prunes its own
  //    window when it completes.
  // SAFETY: the SELECT list is the single aliased aggregate `n`; COUNT(*)
  // over `agent_runs` (0001_baseline) is always a number row.
  const siblingLiveRuns = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_runs
          WHERE project_slug = ? AND task_key = ? AND id != ?
            AND state IN ('queued', 'running')`,
      )
      .get(input.projectSlug, input.taskKey, finished.id) as { n: number }
  ).n;
  // Ruling 85: another specialist run worked on this task while this one did,
  // still live or finished since this run started. The operator saves no file
  // into the attachments store itself (a relay's files are claimed by the
  // relay), so its runs are not counted.
  // SAFETY: the SELECT list is the single aliased aggregate `n`; COUNT(*)
  // over `agent_runs` (0001_baseline) is always a number row.
  const overlappingSpecialists = thisRunStartedAt
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM agent_runs
              WHERE project_slug = ? AND task_key = ? AND id != ? AND kind != 'operator'
                AND (state IN ('queued', 'running') OR finished_at >= ?)`,
          )
          .get(input.projectSlug, input.taskKey, finished.id, thisRunStartedAt) as { n: number }
      ).n
    : 0;
  // What the run said itself: the final reply (for a Codex envelope, ALSO the
  // raw envelope text — replyText is narrowed to its summary), the evidence
  // rows and the ask-human question.
  const ownWords = [
    replyText ?? "",
    fullText ?? "",
    JSON.stringify(outcome?.evidence ?? []),
    outcome?.question?.title ?? "",
    outcome?.question?.body ?? "",
  ].join("\n");
  // The corpus covers every place an agent can cite: its own words, every
  // timeline text since the run started (mid-run comments, human directives),
  // and — ruling 78 — the text of the files this run saved, where a deliverer
  // of files cites its evidence.
  const citationCorpus = [
    ownWords,
    savedFilesText(input.projectSlug, input.taskKey, runSaved, ctx.dataRoot),
    // Ruling 78: an entry cites a file in its evidence rows as well as its
    // text, and an entry that claims a file keeps it. Live on AWSC-32 a
    // researcher's run was still going when the Estimate Judge's verdict
    // cited two browser snapshots in its evidence and claimed twenty; the
    // researcher's completion would have deleted every one of them.
    ...(thisRunStartedAt && completionFile
      ? completionFile.timeline
          .filter((e) => e.occurredAt >= thisRunStartedAt)
          .map((e) => [e.text, JSON.stringify(e.evidence ?? []), ...(e.attachments ?? [])].join("\n"))
      : []),
  ].join("\n");
  const attachmentsPrune =
    finished.state === "finished" && siblingLiveRuns === 0
      ? pruneBrowserWorkingArtifacts(
          input.projectSlug,
          input.taskKey,
          runSaved,
          citationCorpus,
          ctx.dataRoot,
        )
      : finished.state === "finished"
        ? // Ruling 78: beside a live sibling nothing is deleted, and this run
          // claims no working file it did not cite: the sibling decides the
          // rest when it completes, so no entry names a file that later goes.
          { kept: runSaved.filter((name) => !isBrowserWorkingArtifact(name) || citationCorpus.includes(name)), pruned: [] }
        : { kept: [...runSaved], pruned: [] };
  if (finished.state === "finished" && siblingLiveRuns > 0) {
    logger.info("browser working-artifact prune skipped: sibling run live", {
      taskKey: input.taskKey,
      runId: finished.id,
      siblingLiveRuns,
    });
  }
  if (attachmentsPrune.pruned.length > 0) {
    logger.info("pruned uncited browser working artifacts", {
      taskKey: input.taskKey,
      runId: finished.id,
      pruned: attachmentsPrune.pruned,
    });
  }
  // Ruling 85: a run's files are found by mtime in a store every run on the
  // task writes to, so beside another specialist run the window holds that
  // run's files too. A run that does not deliver then claims only the files
  // its own words name, and never one the delivery already holds: under
  // ruling 85 that claim would move the delivery onto this run's entry, and
  // under ruling 245 make the subject this run's own work. Live on AWSC-80 the
  // Estimate Judge, told to save no file, finished nine seconds after the
  // Workflow Researcher saved the task's deliverable, and its comment claimed
  // that file. The deliverer claims its whole window as before: its claim is
  // the delivery.
  const deliveredNow = completionFile
    ? deliveredFileNames(completionFile.frontmatter, completionFile.timeline)
    : new Set<string>();
  // Ruling 81: a maker's own earlier file is in that set now, and its rework
  // beside another specialist run (a review that sent the text and a picture
  // back at once) would claim nothing and move nothing. A file this agent
  // saved before and its own words name is still its: only a name the
  // deliverer's entries claim stays out, which is the case ruling 85 is for.
  const ownEarlier =
    completionFile && input.profileId
      ? filesClaimedBy(completionFile.timeline, new Set([input.profileId]))
      : new Set<string>();
  const deliverersOwn = completionFile
    ? deliverersOwnFileNames(completionFile.frontmatter, completionFile.timeline)
    : new Set<string>();
  const stillItsOwn = (name: string): boolean => ownEarlier.has(name) && !deliverersOwn.has(name);
  const runAttachments =
    finished.state === "finished" && !input.delivers && overlappingSpecialists > 0
      ? attachmentsPrune.kept.filter(
          (name) => ownWords.includes(name) && (!deliveredNow.has(name) || stillItsOwn(name)),
        )
      : attachmentsPrune.kept;
  /** Ruling 119: this completion's RECORDED verdict was `approve` — a boundary
   *  for the react chain's depth count (the arm before the react decision). */
  let approvedThisReply = false;
  if (finished.state === "finished") {
    // Ruling 87 (pass 37, F37-77): a run whose workspace could not be
    // provisioned READ NOTHING, so it judged nothing. Live on SHOP-5 the Code
    // Reviewer reported exactly that — envelope `verdict: null`, summary "No
    // content verdict recorded" — and viberr wrote `request_changes` onto the
    // task anyway, because the prose fallback matched the word "failure" inside
    // VIBERR'S OWN sentence, the one the prompt tells the agent to quote
    // verbatim. That fabricated objection was the second in a row, so the
    // policy engine raised a review-deadlock packet asking a person to choose
    // between interrogating a reviewer that never judged and forcing acceptance
    // past a verdict that did not exist. The operator caught it, said so on the
    // task, and could not withdraw a packet the policy engine had raised.
    const readNothing = thisRunRow?.no_checkout === 1;
    /**
     * Ruling 87: a run told NOT to judge records no verdict, neither from its
     * envelope nor from the prose fallback below.
     *
     * The withholding took the verdict TOOL away on the deadlock question and
     * stopped there, which closed nothing: `verdictAuthorized` reads the
     * ENGAGEMENT snapshot (correctly — a required reviewer whose live grant was
     * removed must still be able to record), so the prose fallback ran anyway
     * and manufactured the verdict the tool had just been taken away to
     * prevent. The Codex envelope is the same hole by another door: its schema
     * is static and requires `verdict`, so a withheld Codex run can fill it, and
     * recorded it binds to the same revision and fights another round
     * (ruling 92), which is the loop the question exists to break.
     *
     * Live on SHOP-68 the reviewer said so in words, and viberr wrote the
     * verdict under its name 70 milliseconds later: "No verdict recorded — the
     * directive said not to... I deliberately skipped `report_outcome` rather
     * than omitting it. (Note: last turn the system appears to have derived a
     * `request_changes` entry from my comment anyway; I can't control that, but
     * nothing new was authored by me.)" The person answered the same deadlock
     * packet three times for one question.
     */
    const verdictSilenced = getRun(db, finished.id)?.verdict_withheld === 1;
    // Verdict: envelope first; a verdict-AUTHORIZED agent with no envelope falls
    // back to the prose classifier (G4). The regex NEVER runs without authority
    // (R1 — a developer's "tests pass" can't flip validation).
    let verdict =
      verdictAuthorized && !readNothing && !verdictSilenced ? (outcome?.verdict ?? null) : null;
    if (verdictAuthorized && verdictSilenced && outcome?.verdict) {
      logger.info("withheld-verdict run emitted a verdict; discarded", {
        taskKey: input.taskKey,
        runId: finished.id,
        verdict: outcome.verdict,
      });
    }
    if (!verdictAuthorized && outcome?.verdict) {
      // B-5 (pass 24): a Codex agent CAN fill the `verdict` field of its outcome
      // envelope even without the `report-validation-verdict` grant — the JSON
      // schema always carries the field, whereas Claude's `report_outcome` omits
      // it when ungranted, so this asymmetry is Codex-only. The verdict is
      // correctly discarded (validation stays gated on the grant), but the drop
      // must not be silent — a maintainer reading the reply's "I approve" prose
      // would otherwise believe a review judgement was recorded.
      logger.info("agent emitted a verdict without the grant; discarded", {
        taskKey: input.taskKey,
        runId: finished.id,
        verdict: outcome.verdict,
      });
    }
    if (readNothing && verdictAuthorized) {
      // Loud, because the review did NOT happen: validation is untouched, and
      // the note below tells the humans on the task so nobody reads a completed
      // review run as a judgement.
      logger.warn("verdict-capable run had NO checkout; no verdict recorded from it", {
        taskKey: input.taskKey,
        runId: finished.id,
        profileId: input.profileId,
        envelopeVerdict: outcome?.verdict ?? null,
      });
    }
    // The fallback is for SILENCE, not for overruling an answer. An agent that
    // filled the envelope and ASKED A QUESTION with the verdict field empty has
    // said which of the two it was doing; running a regex over its prose then
    // converts "here is what I need before I can judge" into a judgement. The
    // no-verdict NOTE below already reads a question as "a legitimate no-verdict
    // outcome" (pass 24, C-4) — the classifier is its sibling and never learned
    // it, which is this pass's most-found defect shape. A run told NOT to judge
    // (`verdictSilenced`, ruling 87) did not fall silent either, so there is
    // nothing here for the fallback to repair.
    if (!verdict && verdictAuthorized && !readNothing && !outcome?.question && !verdictSilenced) {
      verdict = classifyReviewerVerdict(replyText);
      if (verdict) {
        logger.info("agent verdict resolved by prose fallback (no envelope)", {
          taskKey: input.taskKey,
          runId: finished.id,
          verdict,
        });
      } else {
        // F10: a verdict-GRANTED agent finished but neither the structured
        // envelope nor the prose classifier produced a verdict. Behaviour is
        // fail-safe — validation is LEFT UNCHANGED (never silently flipped to
        // `healthy`), so acceptance stays gated on whatever it was — but the
        // reviewer's judgment was effectively lost, so flag the anomaly loudly
        // for monitoring rather than dropping it in silence.
        logger.warn(
          "verdict-granted agent finished with NO determinable verdict; validation left unchanged (not marked healthy)",
          {
            taskKey: input.taskKey,
            runId: finished.id,
            backend: input.backend,
            profileId: input.profileId,
          },
        );
      }
    }
    // P11-26: question authority deliberately uses the LIVE ask grant, not the
    // engage-time snapshot the verdict path uses. The snapshot exists ONLY for
    // verdicts, where a live-grant read would let a removed grant leave a task
    // permanently un-acceptable (a required reviewer that can approve but never
    // record). A question is open-only — it never blocks acceptance — so there
    // is no equivalent hazard, and honoring the current grant (an admin who just
    // revoked ask-human means it now) is the correct behavior. The asymmetry is
    // intentional, not an oversight.
    const question = collab.ask ? (outcome?.question ?? null) : null;
    // P13-D-26: the run's evidence REFERENCES — the agent's own rows first
    // (only when its profile grants attach-evidence-references, same authority
    // check the toolkit made when it declared the field), then the delivery
    // facts already reconciled onto the task. `normalizeEvidenceRows` inside
    // recordAgentCompletion caps and sanitizes the combined list.
    const evidence = [
      ...(collab.evidence ? (outcome?.evidence ?? []) : []),
      ...(completionFm ? deliveredWorkEvidence(completionFm) : []),
    ];
    const recorded = await recordAgentCompletion(db, ctx, input.projectSlug, input.taskKey, {
      actorRef,
      runId: finished.id,
      replyText,
      verdict,
      question,
      evidence,
      attachments: runAttachments,
      delivers: input.delivers,
    });
    if (recorded.escalated) raisedDeadlockPacket = true;
    stampedDelivery = recorded.delivered;
    // Ruling 119: an approval that bound to nothing opened no gate.
    approvedThisReply = verdict === "approve" && recorded.verdictBound;
    await warnStrayAttachmentsFolder(db, ctx, input, finished.id);
    // Ruling 202 (F40-67): the report's relays, posted through the operator's
    // relay door with this agent as the author, after the report itself and
    // before the operator reacts, so its snapshot already reads "Relayed to …".
    if (outcome?.relay?.length) {
      const { postOutcomeRelays } = await import("./task-relay.server");
      const role = agentRoleDisplay(actorRef);
      await postOutcomeRelays(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        author: deployedName
          ? {
              actorRef,
              name: deployedName,
              auditActor: { userId: null, label: encodeActorRef(actorRef) },
              notifyFrom: { kind: "agent", backend: input.backend, name: deployedName, role },
            }
          : null,
        entries: outcome.relay,
      });
    }
    // C5 (pass 23): a verdict-GRANTED reviewer finished but produced NO readable
    // verdict (no envelope, no classifiable prose). Validation is left unchanged
    // — fail-safe, correct — but the human saw a completed review run with no
    // verdict and no note, and had to diff run logs against validation to notice
    // the judgment was lost. Say so, so the review can be re-run or a verdict
    // recorded by hand. Best-effort: a note failure never fails the completion.
    //
    // pass-24 (C-4) narrows the trigger. The pass-23 condition fired on EVERY
    // completion of a verdict-capable reviewer, so a conversational @mention reply
    // ("@Reviewer summarize your concerns") — which produces no verdict by design
    // — got a spurious "acceptance stays gated" warning, even on tasks nowhere near
    // review. Only warn when a verdict was actually EXPECTED: the reviewer asked no
    // question (a question is a legitimate no-verdict outcome), and the task is at
    // the review stage the note is about.
    //
    // pass-25 (C5) closes the residual gap C-4 left open: a conversational
    // @mention that happens WHILE the task sits at the review stage (the normal
    // state during a pending review) still slipped through, because `atReviewStage`
    // was true and the reply carried no verdict/question. Gate on the run's intent
    // too — `fromHumanDirective` is set only when this run answers a human's
    // @mention, never for a bare review invocation — so the note fires only when a
    // verdict was genuinely expected.
    const reviewStageId = ((): string | null => {
      const proj = readProjectFile({
        projectSlug: input.projectSlug,
        dataRoot: ctx.dataRoot,
      })?.parsed.frontmatter;
      return proj ? resolveStageRoles(proj.stages, proj.workflow).reviewId : null;
    })();
    const atReviewStage =
      !!completionFm &&
      !!reviewStageId &&
      completionFm.stage === reviewStageId;
    // Ruling 87: when the run had no working tree the note says THAT, because
    // "re-run the review" is bad advice for a condition a re-run reproduces.
    // It fires even for a run that asked a question: the question reaches a
    // person as a packet, and the task's own record should still say plainly
    // that the review did not happen and why. A run told not to judge
    // (`verdictSilenced`) answered the question it was asked, so it gets no
    // "re-run the review" note unless it had no tree to read.
    const noteText = readNothing
      ? "This review run had no checkout of the repository, so it read nothing and recorded no verdict. Validation is unchanged and acceptance stays gated. The workspace failure is on the server, not on the agent: fix that first, then run the review again."
      : "The reviewer finished without a readable verdict, so validation is unchanged and acceptance stays gated. Re-run the review or record a verdict manually.";
    if (
      verdictAuthorized &&
      !verdict &&
      (!question || readNothing) &&
      (!verdictSilenced || readNothing) &&
      atReviewStage &&
      !input.fromHumanDirective
    ) {
      try {
        await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
          text: noteText,
        });
      } catch (noteError) {
        logger.error("could not write the no-verdict note", {
          taskKey: input.taskKey,
          runId: finished.id,
          err: toError(noteError),
        });
      }
    }
  } else {
    await postAgentReplyComment(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: finished.id,
      actorRef,
      replyText,
      attachments: runAttachments,
    });
  }
  // 1b. A run that ENDED IN ERROR (backend quota/auth/crash) previously left NO
  //     trace on the timeline and never re-invoked the operator — the task just
  //     silently reverted to waiting=human (F8). Surface the failure as a typed
  //     event, escalate a recovery packet so it reaches a human's queue, and stop
  //     (no reconcile/verdict/react on a failed run). Interrupts are a deliberate
  //     human action and are handled elsewhere, so only `error` lands here.
  // Ruling 69: a person's @mention refused by
  // the single-flight guard is delivered when the busy run completes —
  // whatever state it completed in. The call used to sit after the `error`
  // branch's return and after the closed-task branch's return, so a run that
  // ended in error (or a task that closed underneath it) dropped the person's
  // instruction silently, under a note promising the opposite. It runs here
  // instead, and the operator react below is still skipped only when a run
  // actually started.
  let deferredStarted = false;
  let deferredOwed = 0;
  try {
    const outcome = await deliverDeferredMention(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: input.profileId,
      runStartedAt: input.replayed === true ? null : deferredWindowFrom,
    });
    deferredStarted = outcome.started;
    deferredOwed = outcome.pending;
  } catch (error) {
    // A delivery that cannot start must never swallow the completion pipeline.
    // `deferredOwed` stays 0 here, so no withdrawal note follows — deliberate:
    // a THROW means the count is unknown, and every cause ruling 69 names
    // (closure, stage, credential) is a refusal, which returns `triggered:
    // null` with a real count instead of throwing. A throw here is a broken
    // disk or database, and this log line is the honest record of it.
    logger.warn("deferred @mention delivery failed", {
      taskKey: input.taskKey,
      profileId: input.profileId,
      err: toError(error),
    });
  }
  // F37-66: ruling 69's withdrawal, written HERE — beside the attempt it
  // reports on, and above every early return below it.
  //
  // The refusal wrote "Viberr starts it on this comment as soon as that run
  // finishes" onto the canonical record. When that cannot happen — the causes
  // ruling 69 itself names: the task closed underneath it, the stage no
  // longer admits the profile, a credential is gone — the promise has to be
  // withdrawn where it was made. It used to sit below the error branch's
  // return, the closed-task branch's return and ruling 94's, which is the same
  // placement bug ruling 69 had already fixed for the ATTEMPT and for the
  // same two branches: a task archived under a live run took the closed branch,
  // returned, and left the person's promise standing with nothing anywhere
  // contradicting it.
  if (deferredOwed > 0 && !deferredStarted) {
    await appendUndeliveredMentionNote(db, ctx, input, deferredOwed);
  }

  if (finished.state === "error") {
    const { runFailureReason } = await import("./agent-reply.server");
    const failure = runFailureReason(db, finished.id);
    const backendLabel = BACKEND_LABEL[input.backend];
    const roleLabel = "agent";
    // R20-3: 240 (PROVIDER_TEXT_CHARS), not 180 — the provider's own sentence
    // is now split off onto its own line/observation, and the clamp used to cut
    // it off mid-word. This clamps only the human summary sentence.
    const failText = failure?.text
      ? failure.text.length > PROVIDER_TEXT_CHARS
        ? failure.text.slice(0, PROVIDER_TEXT_CHARS - 3) + "…"
        : failure.text
      : "";
    const providerText = failure?.providerText ?? "";
    // Ruling 137 / 156(a): the remedy for a quota or credential refusal
    // belongs to the credential principal, the task owner; the leaf names
    // them, their reset instant and Profile → Agent accounts. An unowned task
    // yields no owner sentence and no retry option.
    const ownerUserId =
      completionFm?.ownerUserId ??
      readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed
        .frontmatter.ownerUserId ??
      null;
    const describeInput: DescribeRunFailureInput = {
      failure,
      backend: input.backend,
      taskKey: input.taskKey,
      ownerUserId,
      role: "specialist",
      agentHandle: input.agentHandle,
      profileId: input.profileId,
    };
    if (ctx.dataRoot) describeInput.dataRoot = ctx.dataRoot;
    // F36-8: the profile's own model, so the `retry_other_backend` option can
    // name what the other backend will run. A profile undeployed since the run
    // started resolves to nothing, and the option names the default alone.
    if (input.profileId) {
      try {
        const { resolveDeployedSpecialist } = await import("./specialist-roster.server");
        describeInput.profileModel = resolveDeployedSpecialist(
          ctx,
          input.projectSlug,
          input.profileId,
        ).model;
      } catch {
        // Not a current deployment — nothing to name.
      }
    }
    const described = describeRunFailure(db, describeInput);
    // Ruling 156(a): a classified refusal is worded ONCE, by the leaf. The
    // other kinds keep their own sentences below; `unavailable` is ruling
    // 137's refusal sentence, already naming the person and the remedy. A
    // provider-side `overloaded` failure is worded by the leaf too: its remedy
    // (retry; nothing to fix) is the same one for operator and specialist.
    // Ruling 158(a): so is a hung run, whose remedy is the same plain retry.
    const classified =
      failure?.kind === "quota" ||
      failure?.kind === "auth" ||
      failure?.kind === "overloaded" ||
      failure?.kind === "idle_timeout" ||
      // Ruling 158(b): the leaf's sentence is the gateway's, naming the call.
      failure?.kind === "tool_loop";
    const reasonText = classified
      ? described.reason
      : failure?.kind === "unavailable"
        ? failText || `${backendLabel} could not run for this task's owner`
        : failure?.kind === "max_turns"
          ? `the ${backendLabel} run hit its turn cap and was CUT OFF mid-work, which is not a task failure (its partial report, if any, is above)`
          // Ruling 159: the leaf words the cap and the spend from the typed
          // record; the cut-off is not a task failure either.
          : failure?.kind === "max_budget"
            ? `the ${backendLabel} run reached the instance's spending cap${
                failure.facts?.spendCapUsd !== undefined ? ` of ${formatUsd(failure.facts.spendCapUsd)}` : ""
              }${
                failure.facts?.spentUsd !== undefined ? ` after spending ${formatUsd(failure.facts.spentUsd)}` : ""
              } and was CUT OFF mid-work, which is not a task failure (its partial report, if any, is above)`
          // P13-D-2: a dead provider transcript is its own class. It used to
          // fall through to the generic branch below, which reads like a
          // runtime error and sent people to check a credential that was
          // fine. Nothing is wrong with the setup and the other backend is
          // not the fix — a fresh run on the SAME backend is.
          : failure?.kind === "session_missing"
            ? `the agent's stored ${backendLabel} session no longer exists, so its history could not be resumed`
            : failText
              ? `${backendLabel} run failed: ${failText}`
              : `the ${backendLabel} run ended in an error`;
    const providerBlock =
      // R20-3 (F20-4): surface the provider's own redacted words as a fenced
      // block in the R19-13 house style, so a human sees "model is not
      // supported when using Codex with a ChatGPT account" instead of only
      // the generic runtime advice above.
      providerText ? `\n\nWhat the provider reported:\n\`\`\`\n${providerText}\n\`\`\`` : "";
    // Ruling 156(a): EVIDENCE, not kind. The two cut-off kinds were exempted
    // because a cut run leaves work behind; a provider refusal on turn 48 is
    // the same cut-off, and the facts that prove it are already in scope.
    const outcomeClause =
      failure?.kind === "max_turns" || failure?.kind === "max_budget"
        ? ""
        : runOutcomeClause({
            turns: thisRunRow?.turns ?? 0,
            attachments: runAttachments.length,
          });
    // Ruling 155: the lead is built by the shared helper the operator's snapshot
    // matches on, so the sentence and its matcher cannot drift apart.
    const lead = runDidNotCompleteLead(input.role, roleLabel);
    const failureText = classified
      ? `${lead}. ${described.reason}${outcomeClause} ${described.remedy}${providerBlock}`
      : `${lead}: ${endSentence(reasonText)}${outcomeClause}${
          failure?.kind === "max_turns"
            ? " Re-prompt the agent to continue from its session, or raise the turn cap (VIBERR_CLAUDE_MAX_TURNS)."
            : failure?.kind === "max_budget"
              ? ` ${described.remedy}`
            : failure?.kind === "session_missing"
              ? " Re-prompt the agent: it will start a fresh run and re-anchor on this task file. Provider transcripts expire, and wiping the data root removes them too."
              // The refusal sentence already says who must do what and where;
              // an unclassified error has no remedy Viberr can vouch for.
              : ""
        }${providerBlock}`;
    // Files the run saved before it died still get their producer named.
    const failureAttachments = sanitizeEventAttachmentNames(runAttachments);
    const failedAt = new Date().toISOString();
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      const failureEvent: TaskFileEvent = {
        occurredAt: failedAt,
        type: "blocked",
        actor: actorRef,
        title: null,
        text: failureText,
        toAgent: false,
        evidence: null,
      };
      if (failureAttachments) failureEvent.attachments = failureAttachments;
      parsed.timeline.unshift(failureEvent);
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    // R20-3 (F20-4): a model the provider REFUSED for this account is marked
    // unavailable from this real run's failure — no synthetic probe (ruling 149).
    // A quota/auth/crash failure never matches MODEL_UNSUPPORTED_RE, so only a
    // genuine "model not supported" verdict marks the row.
    if (providerText) {
      const failedModel = getRun(db, finished.id)?.model ?? null;
      noteModelAvailabilityFromFailure(db, {
        runId: finished.id,
        backend: input.backend,
        model: failedModel,
        providerText,
      });
    }
    // Backend-level failure (quota / auth / no credential): the packet's
    // options come from the leaf (D4 retry-on-the-other-backend first when the
    // task OWNER has it connected, ruling 137; the switch STICKS per F27-B1,
    // owner ruling 2026-08-24, via the retry run's per-engagement
    // `pinnedBackend`; else "send the agent back to continue"; redirect
    // present and not recommended). A hung run takes the leaf's set as well
    // (ruling 158(a)); any other kind keeps the stock set.
    const backendFailure =
      failure?.kind === "quota" ||
      failure?.kind === "auth" ||
      failure?.kind === "unavailable" ||
      failure?.kind === "overloaded";
    /**
     * Ruling 65: a backend failure is an ACCOUNT's failure, not this task's.
     * Quota, auth and a missing credential take out every task running on the
     * same account at the same instant, and each one used to raise its own
     * identical packet. The key is what actually failed — the backend, the kind
     * of failure, and whose account paid for the run (ruling 137's principal) —
     * so two tasks that failed for one reason agree on it with nothing
     * coordinating them.
     *
     * `overloaded` is deliberately NOT grouped: it is the provider being busy
     * for a moment, not a state of the account, and two tasks hitting it are
     * two separate transients that can want different answers.
     */
    const accountCause =
      failure?.kind === "quota" || failure?.kind === "auth" || failure?.kind === "unavailable"
        ? `backend:${input.backend}:${failure.kind}:${getRun(db, finished.id)?.credential_user_id ?? "none"}`
        : null;
    const stuck: Parameters<typeof openStuckLoopPacket>[2] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      agentHandle: input.agentHandle,
      reason: classified
        ? described.reason
        : `The ${input.role} ${roleLabel} run failed: ${endSentence(reasonText)}`,
    };
    if (classified) stuck.remedy = described.remedy;
    // Ruling 158(a): a hung run takes the leaf's options too, which recommend
    // running the same agent again rather than redirecting it.
    if (backendFailure || failure?.kind === "idle_timeout") stuck.options = described.options;
    if (accountCause) stuck.cause = accountCause;
    if (providerText) stuck.providerText = providerText;
    const escalation = await openStuckLoopPacket(
      db,
      { ...ctx, operatorAuthorized: true },
      stuck,
    );
    // Ruling 65: a refusal in a window someone already decided.
    if (accountCause && escalation.status === "opened") {
      const { answerFromStandingDecision } = await import("./packet-resolution.server");
      await answerFromStandingDecision(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
      });
    }
    // T13 (pass 31): ONE notification per failure PER RECIPIENT, not two.
    //
    // `openStuckLoopPacket` → `operatorOpenPacket` already notifies the same
    // watchers with the actionable row ("Blocked, decision needed: Work
    // stalled: pick a recovery path", whose body is this same sentence plus
    // "Coordination is paused until a human chooses how to proceed"). Sending
    // this second `quality` row as well put two near-identical entries in every
    // supervisor's queue for a single failed run, differing only in wording —
    // and the shorter one is the one that cannot be acted on.
    //
    // The dedupe is per recipient, not global: `packet` and `quality` are
    // independent routing categories, so a watcher who silenced packets (but
    // kept quality on) never saw the packet row — a global skip would leave
    // them with NOTHING about the failed run. The escalation reports exactly
    // who the packet row reached; everyone else still gets the quality row
    // (their own prefs may drop that too, which is their stated choice). It is
    // also sent to all watchers when NO packet notification went out: an
    // escalation that was refused or threw ("failed"), or one that found a
    // packet already open ("already_open" — that packet's own notification may
    // have been about something else entirely, and was certainly not about
    // this failure). A failed run must never pass silently.
    const failureNotice: TaskWatcherNotice = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "quality",
      text: classified
        ? `${input.role} run failed. ${described.reason}`
        : `${input.role} run failed: ${endSentence(reasonText)}`,
      // Ruling 75: the row opens the failure's own event, which says why.
      about: { event: failedAt },
      // Ruling 74: the agent whose run failed — the timeline's actor for the
      // same event.
      from: { kind: "agent", backend: input.backend, name: input.role, role: input.role },
    };
    if (escalation.status === "opened") {
      failureNotice.exceptUserIds = escalation.notifiedUserIds;
    }
    notifyTaskWatchers(db, failureNotice, ctx);
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  // 1c. A SUCCESSFUL run withdraws a stale "work stalled" packet about this
  //     same agent (owner ruling 2026-07-18) — done BEFORE the operator reacts
  //     so its snapshot already sees the packet gone instead of asking a human
  //     to dismiss it. Only a stall packet is ever touched (ruling 123).
  if (finished.state === "finished") {
    // R20-3 (F20-4): a model that just RAN to completion is available, whatever
    // a stale unavailability row says. Clearing on a real success IS the
    // re-probe — no separate mechanism (ruling 149).
    const ranModel = getRun(db, finished.id)?.model ?? null;
    if (ranModel) clearModelMark(db, input.backend, ranModel);
    await withdrawSupersededStuckPacket(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      delivers: input.delivers,
      role: input.role,
      runProfileId: input.profileId,
    });
  }
  // 2. Reconcile agent-side delivery (NFR15) — real PRIMARY runs only. A
  //    reviewer (F7-REV1) delivers nothing: it clones the repo to READ the diff,
  //    so its workspace HEAD/branch is incidental. Reconciling delivery off a
  //    reviewer's clone raced the reviewer's just-posted reply comment (its
  //    read-modify-write of task.md could drop it) and could stamp task.md's
  //    branch/pr from the reviewer's checkout. Only the specialist that produced
  //    the change reconciles delivery.
  if (input.delivers && finished.state === "finished") {
    const { reconcileWorkspaceDelivery } = await import(
      "~/server/github/workspace-delivery.server"
    );
    const reconcile: Parameters<typeof reconcileWorkspaceDelivery>[0] = {
      db,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      backend: input.backend,
      profileId: input.profileId,
      role: input.role,
      dataRoot: ctx.dataRoot,
    };
    if (input.workdir) reconcile.workdir = input.workdir;
    await reconcileWorkspaceDelivery(reconcile).catch((error) => {
      // F13: best-effort (must not break completion) but no longer SILENT — a
      // delivery-reconcile failure (git/network) was invisible, so a broken
      // branch/PR link went undiagnosed. Surface it for operators.
      logger.warn("post-run delivery reconcile failed (best-effort)", {
        taskKey: input.taskKey,
        runId: finished.id,
        err: toError(error),
      });
    });
  }
  // 3. (The verdict/question are recorded ATOMICALLY with the reply in step 1
  //    — there is no separate verdict write to race anything.)
  // Ruling 86: the delivery, its kept copy and the reply are written by now,
  // and the reconcile above has minted the work revision if this run
  // committed. So the pictures are asked for here and not where the delivery
  // was stamped: on a board with a repository a first delivery is stamped
  // before its revision exists, and a revision is never pictured. Only the
  // react waits for the pictures, and only so long, so the operator and the
  // reviewers it dispatches start with them there.
  const deliveryCaptures = stampedDelivery
    ? requestDeliveryCaptures(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        stamp: stampedDelivery,
      })
    : null;
  await deliveryCapturesSettled(deliveryCaptures);
  // 4. React: continue an operator chain, or start a fresh one against the
  //    deployed operator. Resolve the effective react context.
  const { resolveOperatorAuthority } = await import("./operator-authority.server");
  let reactAutonomy: OperatorAutonomy;
  let currentDepth: number;
  if (input.operatorRun) {
    reactAutonomy = input.operatorRun.autonomy;
    currentDepth = input.operatorRun.reactDepth;
  } else {
    reactAutonomy = resolveOperatorAuthority(ctx, input.projectSlug, {}).autonomy;
    currentDepth = 0;
  }
  /** Ruling 119: react hops since a person last acted. A run a person
   *  dispatched, or a drive a person's comment or packet answer started,
   *  carries none, so the count starts over there. */
  let chainHops = input.operatorRun?.reactHops ?? 0;
  // Ruling 108 (F37-51): the react chain carries its DEPTH and its autonomy,
  // and no longer carries a BACKEND.
  //
  // It used to pin `input.operatorRun.backend` — the backend of the drive that
  // prompted the agent — and pass it as an override, which beats the live
  // deployment. R22 removed exactly that pin from schedules, on exactly this
  // reasoning: "A schedule fires unattended, so following the profile that is
  // actually deployed then matters MORE than freezing whatever was configured
  // hours earlier." A react is the same shape. The agent it is reacting to may
  // have been running for an hour, and live on pass 37 an owner moved the
  // operator from Codex to `opus[1m]` at 04:19:56 and a react chain started a
  // CODEX operator run at 04:31:44 — twelve minutes later, against a deployment
  // that said `claude`.
  //
  // Safe to drop because the operator re-anchors on `task.md` rather than on a
  // provider transcript (its continuity mode), so a chain that changes backend
  // between turns loses nothing it was relying on. Autonomy stays carried: it
  // is clamped by the deployment's configured ceiling inside the resolver
  // (R19-A), so a chain cannot hold a ceiling the project has since lowered.
  const reactBackend: RealBackend = resolveOperatorAuthority(
    ctx,
    input.projectSlug,
    {},
  ).backend;
  // No-progress detection compares the STORED comment forms (adversarial-
  // review #4): both sides must be the same form or a repeat never matches.
  // Comments now store the FULL reply, so compare `fullText` against
  // `prevReply` (the prior stored comment — also full for new comments; a
  // legacy truncated prevReply simply won't match, which errs toward reacting
  // and is bounded by the depth cap).
  // Compare + hand off the RESOLVED prose reply (a Codex envelope run's
  // fullText is raw JSON — the stored comment and the operator both see the
  // summary, so both sides of the comparison must too).
  // …and through the SAME unconditional transform the stored comment carried:
  // `prevReply` is read back from the stored comment, which rides
  // `withAmbiguityDisclosure`. Comparing the disclosed stored form against the
  // RAW reply meant a verbatim-repeating agent whose report tags an ambiguous
  // name never tripped `noProgress` — the operator kept reacting (a costed
  // operator run + a costed agent run per cycle) until the depth cap, and the
  // packet that finally opened named the wrong reason. (The evidence-separation
  // half of this asymmetry is per-project and pre-dates this; the disclosure is
  // unconditional, so it fires on exactly the repeated text.)
  // The SAME arguments the stored comment was written with, `projectSlug`
  // included (F33-9) — the whole point of this line is that both sides of the
  // comparison carry the identical transform. Omitting the slug here while the
  // writer passes it would reopen the asymmetry described above, just on the
  // non-member half instead of the ambiguous one.
  const replyForCompare = replyText
    ? withAmbiguityDisclosure(db, replyText, input.projectSlug)
    : replyText;
  // Hunt 2026-08-29: the mechanical cc line varies with the DISPATCH SOURCE
  // (present only for dispatched runs, naming that run's dispatcher), so two
  // verbatim-identical agent reports could compare unequal purely because one
  // was dispatched and one was not — a looping agent then bought an extra
  // operator react per source change. Strip the appended line from BOTH sides
  // of the comparison; it is bookkeeping, not progress.
  // Ruling 52 (pass 36, F36-5): a run that finishes after its task CLOSED
  // (accepted, force-accepted or archived while it was live) has its report
  // recorded above — evidence is evidence — but wakes no operator, however it
  // was dispatched: the dispatch-completion contract's forced react is what
  // re-invoked the operator on a shipped HLC-9 and opened a decision packet
  // there. One note says why nothing follows; waiting settles to `none`.
  {
    const closedFile = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const closedProject = closedFile ? loadProjectContext(ctx, input.projectSlug) : null;
    const closure =
      closedFile && closedProject
        ? taskClosure(closedFile.parsed.frontmatter, closedProject.stages)
        : ({ closed: false } as const);
    if (closure.closed && closedProject) {
      const claim = closureClaim(input.taskKey, closure, closedProject.stages);
      await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: "Completed after the task closed",
        text:
          `**Closed task:** the ${input.role} run \`${finished.id}\` finished after ${claim}. ` +
          `Its report is on the record; no coordination follows (the operator is not re-invoked and nothing is dispatched).`,
        toAgent: false,
        evidence: null,
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      logger.info("operator react skipped: the task is closed", {
        taskKey: input.taskKey,
        runId: finished.id,
        why: closure.why,
      });
      await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
      return;
    }
  }
  // Ruling 94: the verdict recorded above raised the deadlock packet, so the
  // task belongs to a person now. The react below is a MACHINE trigger
  // (`agent-reply`), which ruling 115 records as deliberately NOT refused by an
  // open packet: "a packet opened mid-work does NOT stop the machine triggers,
  // so the operator kept coordinating and dispatched a deliverer". That
  // carve-out is right for a packet the operator opened mid-run and can
  // withdraw, and exactly wrong for this one — the next thing the operator does
  // is the re-dispatch the packet exists to interrupt, while the card tells a
  // person coordination is paused. Same shape as the closed-task arm above: the
  // report is on the record, and nothing follows it.
  if (raisedDeadlockPacket) {
    logger.info("operator react skipped: this completion raised the review-deadlock packet", {
      taskKey: input.taskKey,
      runId: finished.id,
    });
    return;
  }
  // Ruling 119 (pass 38, F38-16): an APPROVE is a boundary, so the depth count
  // starts over at it.
  //
  // The cap exists for a chain that goes round without getting anywhere — the
  // operator re-prompting a specialist that keeps coming back with the same
  // objection. A reviewer's approve is the opposite: the gate it guards has
  // opened, and the operator's next move is the step behind it (Review → Verify
  // and the verifier's dispatch, or the acceptance recommendation). Ruling 119
  // recognised one such boundary — the task being ACCEPTABLE — and skipped the
  // packet there, leaving the recommendation to the 15-minute sweep. Live on
  // BNB-16 the code reviewer approved the rework at Review with Verify still
  // ahead, and 0.1 s later the cap opened "Work stalled: pick a recovery path"
  // ("hit its 4-cycle depth cap without reaching a boundary"), whose three
  // options all re-dispatch work that had just passed. Every one of the five
  // such packets on this instance followed an approve (SHOP-5, SHOP-32, SHOP-54
  // twice, BNB-16); the person answered each with "nothing is stalled", and
  // the approved work waited between six minutes and 6.8 hours for that answer.
  //
  // Counting from the approve keeps the cap for the loop it was written for: a
  // rework cycle (request_changes → rework → delivery → review) still counts
  // every hop, and a stage cannot be approved twice — the chain moves on.
  if (approvedThisReply && currentDepth > 0) {
    logger.info("react depth reset: this reply's approve is a boundary, the chain continues", {
      taskKey: input.taskKey,
      runId: finished.id,
      depthBefore: currentDepth,
    });
    currentDepth = 0;
  }
  // Ruling 119: an approve restarts the hop count as well, on 362's own
  // argument: a stage cannot be approved twice, so the restart cannot loop.
  if (approvedThisReply) chainHops = 0;
  // Ruling 119 (pass 40, F40-68): a reply that MOVED the task's head is a
  // boundary too, so the count starts over at it as it does at an approve.
  //
  // Live on WEB-8 the Site Engineer reported its rework done: the new head
  // 178dc22 merged main in, fixed every reviewer finding, and Viberr's gates
  // passed 6/6 on it a second later. The chain had spent its four hops on the
  // ruling-129 conflict hand-off, the owner's rework decision and the rework,
  // so the completion opened "Work stalled: pick a recovery path", whose
  // options all re-dispatched the work that had just finished. Neither
  // boundary this loop knew applied: it was not an approve (362), and the task
  // was not acceptable (258), because the head was not even delivered yet.
  //
  // The signal is the one the server writes: the workspace reconcile above
  // mints a new work revision when the run left a new tree, and a delivery
  // push stamps `pushedAt`, each at the moment it happens, so either landing
  // after this run's row was created is this hop's progress. A reply that
  // leaves the head where it was still counts every hop, so a loop that gets
  // nowhere is still capped.
  if (finished.state === "finished" && currentDepth > 0) {
    const hopStartedAt = thisRunRow?.created_at ?? thisRunStartedAt;
    const afterReply = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const moved = afterReply
      ? headMovedSince(afterReply.parsed.frontmatter.workRevision, hopStartedAt)
      : null;
    // Ruling 119: on a task whose deliverable is files, the delivery stamp is
    // the head, and a stamp this hop wrote is its progress.
    const filesDelivered =
      afterReply && !moved
        ? filesDeliveredSince(afterReply.parsed.frontmatter.deliveredAt, hopStartedAt)
        : null;
    if (moved) {
      logger.info("react depth reset: this reply moved the task's head, a boundary; the chain continues", {
        taskKey: input.taskKey,
        runId: finished.id,
        depthBefore: currentDepth,
        headSha: moved.sha,
        how: moved.how,
      });
      currentDepth = 0;
    } else if (filesDelivered) {
      logger.info("react depth reset: this reply delivered the task's files, a boundary; the chain continues", {
        taskKey: input.taskKey,
        runId: finished.id,
        depthBefore: currentDepth,
        deliveredAt: filesDelivered,
      });
      currentDepth = 0;
    }
  }
  // Ruling 119: the ceiling progress does not reset. The depth reset above
  // unbounded the one loop that commits on every hop — the operator
  // re-dispatching a developer that commits each time, with no reviewer to
  // object — so every hop since a person last acted is counted here, and at
  // OPERATOR_REACT_HOP_CEILING the chain stops with the same packet.
  const hopCeilingReached =
    finished.state === "finished" && chainHops >= OPERATOR_REACT_HOP_CEILING;
  const shouldReact =
    !hopCeilingReached &&
    operatorShouldReactToReply(
      finished.state,
      stripCcLine(replyForCompare),
      stripCcLine(prevReply),
      currentDepth,
    );
  // Ruling 69 (F37-23): a person's @mention that landed while this agent was
  // running was refused by the single-flight guard, and viberr told them the
  // agent would see it. This is where that promise is kept — ahead of the
  // operator's own react trigger below, for the same reason a queued human
  // `@operator` comment drains ahead of the machine trigger (B-OP2): the
  // question exists nowhere else, and coordination can wait one hop. The
  // operator is re-invoked by THAT run's completion, so nothing is skipped,
  // only ordered.
  if (deferredStarted) return;

  // Dispatch-completion contract (2026-08-29): a manually/schedule-dispatched
  // run's completion ALWAYS hands back to the operator — that is the "to let the
  // operator run again" half of the owner's contract, so the react heuristic
  // (new-progress check) is bypassed. The depth cap still binds (a runaway loop
  // is a runaway loop whoever started it), and only THIS hop is forced: runs the
  // reacting operator then dispatches itself carry no dispatchedByName, so the
  // chain reverts to the heuristic one hop later.
  const mustReact =
    !!input.dispatchedByName &&
    finished.state === "finished" &&
    currentDepth < OPERATOR_REACT_DEPTH_CAP &&
    !hopCeilingReached;
  if (!shouldReact && !mustReact) {
    const strippedReply = stripCcLine(replyForCompare);
    const strippedPrev = stripCcLine(prevReply);
    const noProgress =
      !!strippedReply && strippedPrev !== null && strippedPrev === strippedReply;
    const depthCapped =
      !!replyText &&
      !noProgress &&
      finished.state === "finished" &&
      currentDepth >= OPERATOR_REACT_DEPTH_CAP;
    /** Ruling 119: the chain kept making progress and ran out of hops. */
    const hopCapped = !!replyText && !noProgress && !depthCapped && hopCeilingReached;
    if (noProgress) {
      logger.info("operator react skipped: agent made no progress (repeated its reply)", {
        taskKey: input.taskKey,
        runId: finished.id,
      });
    }
    // Ruling 119 (pass 37, F37-89): a chain that stopped because the work is
    // FINISHED did not get stuck, and must not be handed to a person as three
    // ways to redo it.
    //
    // Live on SHOP-32: the Integration Verifier approved `f5470f05` at
    // 05:14:33, both required verdicts sat on the current head, validation read
    // `healthy` — and two seconds later the depth cap opened "Work stalled:
    // pick a recovery path", whose options are redirect the specialist, send it
    // back for another attempt, or hold for runtime debugging. Every one of
    // them re-dispatches work that had passed. The packet then BLOCKED the
    // acceptance it should have been waiting for ("This task has an open
    // blocked decision. Resolve the operator's packet before accepting it"), so
    // the only doors left were to redo finished work or to force-accept past a
    // review gate that had passed — recording a bypass that never happened.
    //
    // The packet's own sentence already claimed the test this adds: "hit its
    // depth cap WITHOUT REACHING A BOUNDARY". Acceptable at the review boundary
    // IS reaching one. Asked here, before any packet exists, so the gate answers
    // about the work rather than about the packet this branch is deciding not to
    // open.
    const acceptableNow =
      (noProgress || depthCapped || hopCapped) &&
      acceptanceRefusalFor(
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        ctx,
      ) === null;
    if (acceptableNow) {
      logger.info("stuck-loop packet skipped: the task is acceptable, so the chain reached a boundary", {
        taskKey: input.taskKey,
        runId: finished.id,
        why: noProgress ? "no_progress" : depthCapped ? "depth_capped" : "hop_ceiling",
      });
    }
    if (hopCapped) {
      logger.info("operator react stopped: the chain reached its hop ceiling since a person last acted", {
        taskKey: input.taskKey,
        runId: finished.id,
        hops: chainHops,
      });
    }
    if ((noProgress || depthCapped || hopCapped) && !acceptableNow) {
      const stuck: Parameters<typeof openStuckLoopPacket>[2] = {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        agentHandle: input.agentHandle,
        reason: noProgress
          ? "The agent repeated its previous report verbatim, with no forward progress."
          : depthCapped
            ? `The coordination loop hit its ${OPERATOR_REACT_DEPTH_CAP}-cycle depth cap without reaching a boundary.`
            : `The chain made progress but ran ${OPERATOR_REACT_HOP_CEILING} hops without a person or a boundary.`,
      };
      // Ruling 119: the capped packet says where the work stands — the report
      // that hit the cap, the head and whether it is delivered, the last gate
      // result — and, over a committed head nobody delivered, recommends the
      // one step left. On WEB-8 its body carried nothing of the report, and
      // delivering 178dc22 for review appeared nowhere on it. The hop ceiling
      // (489(d)) opens the same packet with the same lines.
      if (depthCapped || hopCapped) {
        const standingFile = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
        if (standingFile) {
          const standings = stuckLoopStandings({
            fm: standingFile.parsed.frontmatter,
            gates: loadProjectContext(ctx, input.projectSlug).gates,
            replyText: stripCcLine(replyText),
            agentHandle: input.agentHandle,
          });
          stuck.standings = standings.text;
          if (standings.deliver) {
            stuck.options = [
              deliverHeadOption(standings.deliver),
              ...STOCK_STALL_OPTIONS.map((o) => ({ ...o, recommended: false })),
            ];
          }
        }
      }
      await openStuckLoopPacket(db, { ...ctx, operatorAuthorized: true }, stuck);
    }
    // ALWAYS flip waiting off `agent` when the chain terminates (adversarial-
    // review HIGH #1). markWaitingAgent set it at run start; openStuckLoopPacket
    // only clears it when a packet actually opens — it silently no-ops when the
    // operator lacks generate-packets, a packet is already open, or it throws.
    // Without this fallback the board would read "agent working" forever with no
    // agent running. Idempotent (no-op once a packet flipped waiting to human).
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  // Re-invoke only while an operator is still deployed on the project.
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
    backend: reactBackend,
    autonomy: reactAutonomy,
  });
  if (!authority.deployed) {
    await clearWaitingToHuman(db, ctx, input.projectSlug, input.taskKey);
    return;
  }
  const runOperator =
    ctx.deps?.runOperator ??
    (await import("~/server/runtimes/operator-run.server")).runOperator;
  const reactInput: RunOperatorInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    trigger: "agent-reply",
    reactDepth: currentDepth + 1,
    // Ruling 119: every hop counts toward the ceiling, progress or not.
    reactHops: chainHops + 1,
    backend: reactBackend,
    autonomy: reactAutonomy,
    dataRoot: ctx.dataRoot,
  };
  // Hand the reply DIRECTLY to the react turn. The operator used to depend on
  // the timeline comment for the agent's report — when that comment went
  // missing (stale bind-mount read, guardrail drop), the operator re-prompted
  // the next agent with no findings ("pull up the reviewer's comments…").
  // The run store is the source of truth for the reply; the prompt carries it.
  if (replyText) reactInput.agentReply = replyText;
  await runOperator(db, reactInput);
}

/** Flip a task from `waiting: agent` back to `waiting: human` once no further
 *  agent work follows a completion. No-op when it's already not agent-waiting.
 *  Exported for the operator lease release (settle after the last drive). */
export async function clearWaitingToHuman(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || existing.parsed.frontmatter.waiting !== "agent") return;
    // P13-LV-20: a CLOSED task has no human decision left, but every operator
    // turn settled to `human` anyway — so asking a Done task's operator "is
    // anything still open?" permanently marked it as waiting on a decision, the
    // board counted it, and the review queue (which filters on the review
    // boundary) disagreed. Live-reproduced twice. A terminal-stage task with no
    // open packet and no pending recommendation settles to `none`.
    const fm = existing.parsed.frontmatter;
    const { getProject } = await import("~/server/projections/board-query.server");
    const stages = getProject(db, projectSlug)?.stages ?? [];
    // Ruling 115: a task waiting on other work with nothing else pending
    // owes nobody anything either; "waiting on a human" would put a held task
    // on every human-decision surface with nothing to decide.
    const nothingPending = !existing.parsed.packet && fm.recommendations.length === 0;
    const settled =
      nothingPending && (isTerminalStage(fm.stage, stages) || fm.blockedBy.length > 0)
        ? "none"
        : "human";
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.frontmatter.waiting = settled;
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
  } catch (error) {
    logger.warn("clearWaitingToHuman failed", {
      taskKey,
      err: toError(error),
    });
  }
}

/** Set `waiting: agent` when a provider run is put in flight, so the
 *  board reads "working" (not "waiting on human") while the agent runs. */
export async function markWaitingAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || existing.parsed.frontmatter.waiting === "agent") return;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.frontmatter.waiting = "agent";
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
  } catch (error) {
    logger.warn("markWaitingAgent failed", {
      taskKey,
      err: toError(error),
    });
  }
}

/** Ruling 54 (pass 35, F35-8): who or what started the work that lifts a hold. */
export type HoldLiftCause =
  | {
      kind: "operator-run";
      trigger: "manual" | "scheduled";
      /** The person's display name for a manual run; null for a schedule. */
      byName: string | null;
      /** The person who pressed Run operator, for the audit row; null otherwise. */
      by: AuditActor | null;
    }
  | { kind: "dispatch"; profileId: string; name: string; by: AuditActor | null };

/** The hold shape (ruling 54): a stored `blocked` with no open packet and no
 *  dependency list. An open `blocked` packet keeps the withdrawal paths as the
 *  only lift; a dependency list is ruling 55's own floor. */
function isPacketlessHold(parsed: ParsedTaskFile): boolean {
  return (
    parsed.frontmatter.readiness === "blocked" &&
    parsed.packet === null &&
    parsed.frontmatter.blockedBy.length === 0
  );
}

/**
 * Ruling 54 (pass 35, F35-8): a hold ends when someone starts work.
 *
 * `hold_runtime_debug` (and the refused arm of a collision ceremony) stores
 * `readiness: blocked` with no packet, and nothing paired with that write: a
 * person's Run operator, an `@operator` comment, the controller, a schedule and
 * every dispatch passed the fire-time refusals (which read the packet and the
 * `blockedBy` list, both empty) and left `readiness: blocked` beside
 * `waiting: agent`, so the card read "blocked" and "agent working" on one line
 * (KNC-25). This is the ONE lift: on the hold shape it writes `readiness:
 * ready`, a "Hold lifted" note naming who or what started the work, and
 * `task.hold.lifted`; on any other shape it writes nothing and returns false.
 * The lift is not a claim that the cause is fixed: the operator re-checks and
 * opens a new packet when the block stands (`block_on_policy` doctrine).
 * Best-effort like `markWaitingAgent`: a throw is logged and never blocks the
 * run.
 */
export async function liftHoldForRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  cause: HoldLiftCause,
): Promise<boolean> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing || !isPacketlessHold(existing.parsed)) return false;
    const text =
      cause.kind === "dispatch"
        ? `**Hold lifted:** ${cause.name} was dispatched, so ${taskKey} is no longer held. The run's outcome decides what happens next.`
        : cause.trigger === "scheduled"
          ? `**Hold lifted:** a scheduled operator run started, so ${taskKey} is no longer held. The operator re-checks the task and opens a new decision packet if it is still blocked.`
          : `**Hold lifted:** ${cause.byName ?? "A person"} started an operator run, so ${taskKey} is no longer held. The operator re-checks the task and opens a new decision packet if it is still blocked.`;
    let lifted = false;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      // Re-checked under the lock: a packet opened or a wait written since the
      // read above keeps its own floor.
      if (!isPacketlessHold(parsed)) return;
      parsed.frontmatter.readiness = "ready";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: "Hold lifted",
        text,
        toAgent: false,
        evidence: null,
      });
      lifted = true;
    });
    if (!lifted) return false;
    reprojectTask(db, ctx, projectSlug, taskKey);
    const details: NonNullable<AuditEventInput["details"]> = {
      cause: cause.kind,
      previous: "blocked",
    };
    if (cause.kind === "operator-run") {
      details.trigger = cause.trigger;
      details.byUserId = cause.by?.userId ?? null;
    } else {
      details.profileId = cause.profileId;
    }
    recordAudit(db, {
      action: "task.hold.lifted",
      actor: cause.by ?? OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details,
    });
    return true;
  } catch (error) {
    logger.warn("liftHoldForRun failed", {
      taskKey,
      err: toError(error),
    });
    return false;
  }
}

/**
 * Ruling 120 (F37-36): a person's own operator run re-litigates the DELIBERATE
 * STAGE hold, the way every other human re-litigation already does.
 *
 * `heldAtStage` is the stranded backstop's durable marker (V18): the operator
 * held this stage twice running, so stop paying nudges for it. Its note tells
 * the human "run the operator manually when the hold should end" — and running
 * the operator was the one listed remedy that did not end it. Goal edits,
 * packet resolutions, transitions and acceptance all clear the marker; a person
 * pressing Run operator did not, so the board kept saying "Coordination is
 * paused here" while that person was manually coordinating it, and the drive
 * they paid for got no nudge if it stranded.
 *
 * Deliberately NOT lifted by a schedule or by any machine trigger: V18 exists
 * because an hourly schedule and a stray `@operator` re-armed the nudge forever.
 * The caller's own discriminator is reused unchanged — a `manual` trigger
 * carrying an `actor` is a person and nothing else is.
 */
export async function liftStageHoldForPerson(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  cause: { byName: string | null; by: AuditActor },
): Promise<boolean> {
  try {
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    const held = existing?.parsed.frontmatter.heldAtStage ?? null;
    if (!held) return false;
    const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
    const heldName = project
      ? resolveStageName(project.parsed.frontmatter.stages, held)
      : held;
    let lifted = false;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      // Re-checked under the lock: a transition since the read above already
      // cleared it, and this must not resurrect a note for a hold that is gone.
      if (parsed.frontmatter.heldAtStage !== held) return;
      parsed.frontmatter.heldAtStage = null;
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: "Hold lifted",
        text:
          `**Hold lifted:** ${cause.byName ?? "A person"} started an operator run, so the ` +
          `hold recorded at ${heldName} no longer stands. Coordination resumes here. If the ` +
          `operator holds this stage twice in a row again, Viberr records a new hold.`,
        toAgent: false,
        evidence: null,
      });
      lifted = true;
    });
    if (!lifted) return false;
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.hold.lifted",
      actor: cause.by,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {
        cause: "operator-run",
        previous: "stage-hold",
        stage: held,
        byUserId: cause.by.userId ?? null,
      },
    });
    return true;
  } catch (error) {
    logger.warn("liftStageHoldForPerson failed", {
      taskKey,
      err: toError(error),
    });
    return false;
  }
}

export async function operatorPromptAgent(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    directive: string;
    /** The agent to dispatch; engage-if-needed lives in startAgentRun (the
     *  dynamic-dispatch auto-engage), so the caller no longer pre-splits
     *  primary/reviewer shapes. */
    profileId: string;
    /** Explicit delivering/supporting posture; absent → derived from the
     *  profile's capability grants and the task's current deliverer. */
    delivers?: boolean;
    /** The agent's @mention handle (e.g. its name), prepended to the prompt so
     *  the comment reads as directing the agent by name ("@dev implement …"). */
    handle: string;
    /** Ruling 93: this directive puts the completeness question. */
    completeness?: boolean;
    /** Ruling 124: the run records no verdict. */
    noVerdict?: boolean;
  },
  ctx: TaskMutationContext = {},
): Promise<StartAgentRunResult> {
  const opCtx: TaskMutationContext = { ...ctx, operatorAuthorized: true };
  const directive = withMention(input.handle, input.directive);

  // 1. Post the operator's prompting comment (routed to-agent) so the hand-off
  //    is visible on the board before the agent starts streaming. The comment
  //    @mentions the agent by handle, so it reads as the operator directing that
  //    agent by name ("@dev implement …").
  // The POSTED form carries the ambiguity disclosure; the run's directive stays
  // exactly what the operator wrote (S5-G3 — the note addresses the humans
  // reading the timeline, not the agent about to work).
  // Ruling 70 amendment: no disclosure on a directive. It notifies nobody by
  // declared audience, so a note whose remedy is "spell the tag differently"
  // points at the wrong cause.
  const commentText = withAmbiguityDisclosure(db, directive, undefined, "agent");
  const comment: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: commentText,
    toAgent: true,
    evidence: null,
  };
  await appendTimelineEvent(taskRef(opCtx, input.projectSlug, input.taskKey), comment);
  reprojectTask(db, opCtx, input.projectSlug, input.taskKey);
  // P14-GV-06 added this fan-out so a human @tagged inside an operator directive
  // ("…coordinate with @Arda") was not silently dropped. Ruling 70 (owner,
  // 2026-09-14) reverses that for THIS writer: the comment's declared audience is
  // the agent, and pass 37 measured what the tags in it actually are — 19 of 49
  // mention notifications on the live instance came from directives whose @handle
  // was the operator SPECIFYING a deliverable ("end with an explicit @Arda
  // question naming Stripe, Adyen, and Mock-only"), re-issued on every rework
  // round. The call stays, carrying the audience, so the rule lives at the one
  // fan-out seam, which notifies nobody for an agent audience.
  // Ruling 20: and the event records who it reached, so compaction keeps it.
  await stampNotifiedRecipients(
    db,
    taskRef(ctx, input.projectSlug, input.taskKey),
    comment,
    notifyMentionedUsers(db, {
      text: commentText,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      from: OPERATOR_NOTIFY_FROM,
      occurredAt: comment.occurredAt,
      audience: "agent",
    }),
  );

  // 2. Trigger the agent's run with the operator's directive as its turn focus.
  const { isDispatchHeld, startAgentRun } = await import("./specialist-run.server");
  // Ruling 152: the dispatch's own verdict travels back to the operator's tool
  // reply, which used to say "started its run" for a refused one too.
  let started: StartAgentRunResult;
  try {
    const dispatch: Parameters<typeof startAgentRun>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: input.profileId,
      directive,
    };
    if (input.delivers !== undefined) dispatch.delivers = input.delivers;
    if (input.completeness) dispatch.completeness = true;
    if (input.noVerdict) dispatch.withholdVerdict = true;
    started = await startAgentRun(db, dispatch, OPERATOR_TASK_ACTOR, opCtx);
  } catch (error) {
    // The directive comment above is already on the timeline — a start that
    // REFUSES (stage eligibility, backend down, policy) must not leave it
    // standing as a delivered hand-off. Live-caught: an orphaned
    // "@blog-writer Rework…" from a refused start read as "already prompted"
    // to every later operator turn, so nothing ever re-engaged the deliverer.
    // Ruling 151 (pass 35, G35-4): a HOLD is not a refused start. The
    // dispatcher already wrote its own "Dispatch held" note ("nothing was
    // dispatched and no decision is needed") and already scheduled a
    // `run-agent` occurrence carrying THIS directive, so a second note here
    // told the timeline the opposite of the first one and asked for a re-send
    // that would mint a duplicate schedule on top of the pending one. The hold
    // is the record; the error still travels so the caller can read it as the
    // noop it is.
    if (isDispatchHeld(error)) throw error;
    const message = errorMessage(error);
    await appendPolicyNote(db, opCtx, input.projectSlug, input.taskKey, {
      // Hunt 2026-08-29: this note used to add "@X has not been engaged" —
      // written before auto-engage existed, and now a lie whenever the
      // engage half succeeded and only the RUN refused (a single-flight
      // 409, an unavailable backend). State only what is known true.
      text: `**Note:** the prompt above did NOT start a run: ${message} The directive needs to be re-sent once the blocker is resolved.`,
    });
    throw error;
  }

  // 3. The completion handler (reply → reconcile → verdict → react) is already
  //    installed by startAgentRun above, which read
  //    `ctx.operatorRun` from opCtx (preserved from this operator run) and pass
  //    the real workspace clone dir. So the chain continues at depth+1 with the
  //    correct workdir — no separate registration here.
  return started;
}

/** Prepend an `@handle` mention to a directive if it does not already lead with
 *  one, so an operator prompt always reads as directing the agent by name. */
function withMention(handle: string, directive: string): string {
  const text = directive.trim();
  const h = handle.trim();
  if (!h) return text;
  // Already leads with any @mention (custom directives may include their own).
  if (/^@[A-Za-z]/.test(text)) return text;
  return `@${h} ${text}`;
}
