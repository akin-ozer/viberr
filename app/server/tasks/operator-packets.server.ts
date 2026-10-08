/**
 * What the operator writes for people (ruling 656): its comments on a task,
 * its recommendations, and the decision packets it opens and resolves.
 */

import { OPERATOR_NOTIFY_FROM } from "~/server/tasks/task-mutation.server";
import { closureRefusal, taskClosure } from "./task-closure.server";
import {
  misdirectedOptionPromise,
  misdirectedPromiseRefusal,
  moveStagePromiseMismatch,
  moveStageTarget,
} from "~/shared/workflow/packet-options";
import { taskHeadState } from "./react-progress.server";
import {
  notifyTaskWatchers,
  type OfferWithdrawalCause,
  type OfferWithdrawalSlot,
  recordRecommendationWithdrawal,
  reprojectTask,
  type TaskMutationContext,
  taskRef,
  terminalStageIdFor,
  withdrawAcceptanceOffers,
} from "./task-mutation.server";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { askedEntryText } from "./agent-outcome.server";
import {
  deliveringEngagement,
  type Engagement,
  PACKET_OPTION_KINDS,
  type PacketOption,
  type PacketOptionKind,
  type Recommendation,
  type RecommendationKind,
  type RevisionDeparture,
  revisionLeftWorkspace,
  type TaskFileEvent,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { compactTimelineEvents } from "./timeline-compaction.server";
import {
  applyCommentGuardrails,
  COMMENT_DROPPED_AUDIT_ACTION,
  type CommentGuardrailResult,
  guardrailCompaction,
  guardrailOn,
} from "./comment-guardrails.server";
import { newId } from "~/shared/ids/new-id.server";
import { backendDispatchHold } from "~/server/runtimes/backend-quota.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  notifyMentionedUsers,
  stampNotifiedRecipients,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { acceptanceTerminallyBlocked } from "./task-acceptance.server";
import { OPERATOR_AUDIT_ACTOR, recordAudit } from "~/server/audit/audit-recorder.server";
import { completionPacketRefusal } from "./completion-packet.server";
import { noRepositoryRuling } from "~/server/org/repository-ruling.server";
import { repoFootprintTasks } from "~/server/projections/repo-footprint.server";
import { isRepositoryOptionKind, repositoryAskCause } from "~/shared/repository-ask";
import { normalizeRepoInput } from "~/shared/repo-ref";
import { countLabel } from "~/shared/text/plural";
import {
  type ClosedDecision,
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import {
  gate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-authority.server";

/** The operator mutation context — carries the operator-authorized flag so
 *  the shared mutations skip human RBAC and attribute to the operator. */
export function opCtx(ctx: TaskMutationContext): TaskMutationContext {
  return { ...ctx, operatorAuthorized: true };
}

/**
 * Append an operator-authored `comment` timeline event, reproject, audit —
 * and REPORT what the anti-noise guardrails actually did (G1/B-FD8). `variant`
 * distinguishes a plain narration comment from a recommendation (kept as
 * literal audit actions so the static audit-coverage sweep can parse every
 * call site).
 *
 * Returns the {@link CommentGuardrailResult} so the caller can hand the model
 * the truth. This function used to be `Promise<void>` and silently early-return
 * on a meaningful/duplicate drop, so `operatorPostComment` reported
 * "Comment posted to the timeline." for a comment nobody would ever see — the
 * model then built on narration that did not exist and, on Codex, settled the
 * task to `waiting:human` with no packet or note (a silent strand).
 */
export async function writeOperatorComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
  variant: "comment" | "recommend",
): Promise<CommentGuardrailResult> {
  // Anti-noise guardrails — ALL enforced for real (owner ruling Q3):
  //  · meaningful-comment: trivial chatter never reaches the canonical record;
  //  · evidence-separation: raw output dumps are trimmed to a head + reference;
  //  · no-duplicate-summary: an exact restatement of the last operator comment
  //    is dropped;
  //  · compression-threshold: long timelines compact at the CONFIGURED value.
  // Operator narration is stored VERBATIM (owner ruling 2026-08-31) — the old
  // operator-brevity hard cap destroyed the overflow in the canonical record;
  // the timeline clamps long comments view-side behind a Show more toggle.
  //
  // The meaningful/evidence pair runs through the shared
  // `applyCommentGuardrails` so the outcome is a value, not a void early-return.
  // The no-duplicate check stays timeline-based (compares against the LAST
  // operator comment inside the write transaction) rather than a passed-in
  // previous text, so it is handled below instead of by the shared helper.
  const guardrail = applyCommentGuardrails({
    text,
    meaningful: guardrailOn(ctx, projectSlug, "meaningful-comment"),
    evidence: guardrailOn(ctx, projectSlug, "evidence-separation"),
  });
  if (guardrail.dropped === "meaningless") {
    logger.info("operator comment dropped by the meaningful-comment guardrail", {
      taskKey,
    });
    recordCommentDrop(db, projectSlug, taskKey, variant, "meaningless");
    return guardrail;
  }
  // S5-G3: the operator is instructed to tag the human it answers, so a handle
  // that matches two people is a NEW-4 failure the operator cannot fix on its
  // own — the comment discloses the non-delivery instead of dropping it in
  // silence. Applied after the guardrails so it rides the text actually written.
  const text2 = withAmbiguityDisclosure(db, guardrail.text ?? text);
  // Ruling 214 (F37-34): the same principle, one audience over. The operator's
  // own doctrine used to tell it to put the completeness question to a reviewer
  // "in ONE comment", and live on SHOP-10 it did — "@Code Reviewer, name
  // everything you would still block on" — to an audience that does not exist.
  // `post_comment` writes a timeline line and starts nothing, so no reviewer
  // ever read it; then the stranded backstop, which counts a transition, a
  // dispatch, a delivery or a packet as progress and a comment as none,
  // recorded a deliberate hold and paused coordination on the task five others
  // were waiting behind. The doctrine now names `run_agent`. This is the
  // backstop for when it tags an agent anyway: the record says plainly that
  // nothing was sent, instead of the tag going nowhere in silence.
  // Ruling 252: the sentence itself now lives beside the resolver, because the
  // controller and a mid-run agent needed the same one.
  // Ruling 262: all of them, in one sentence, from the disclosure resolver.
  const { unreachedAgents, unreachedAgentNote } = await import("./agent-reply.server");
  const note = unreachedAgentNote(
    unreachedAgents(ctx, projectSlug, taskKey, text2),
    "operator",
  );
  const text3 = note ? `${text2}\n\n${note}` : text2;
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: text3,
    toAgent: false,
    evidence: null,
  };
  const dedupeOn = guardrailOn(ctx, projectSlug, "no-duplicate-summary");
  const compaction = guardrailCompaction(ctx, projectSlug);
  let suppressed = false;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    if (dedupeOn) {
      const lastOperator = parsed.timeline.find(
        (e) => e.type === "comment" && e.actor.kind === "operator",
      );
      if (lastOperator && lastOperator.text.trim() === text3.trim()) {
        suppressed = true;
        return;
      }
    }
    parsed.timeline.unshift(event);
    // Timeline compaction (F5/FR17): once a long-running task crosses the
    // compression threshold, collapse OLD routine comments into a marker while
    // keeping every typed governance event, so the canonical file the agents
    // re-anchor on stays readable. The guardrail's CONFIGURED value drives the
    // threshold (it used to be ignored — the settings row advertised 40 while
    // the code hardcoded 60).
    if (compaction) parsed.timeline = compactTimelineEvents(parsed.timeline, compaction);
  });
  if (suppressed) {
    recordCommentDrop(db, projectSlug, taskKey, variant, "duplicate");
    return { text: null, dropped: "duplicate", trimmedBy: guardrail.trimmedBy };
  }
  reprojectTask(db, ctx, projectSlug, taskKey);
  // NEW-4: the operator is instructed to tag the person it answers ("@Arda …");
  // the tag must actually notify them — same fan-out as every other comment.
  // B-FD8b: scan the caller's ORIGINAL text, not the stored post-trim form — a
  // handle inside a fenced block that evidence-separation cut away must still
  // notify (the record lost the line; the ping must not be lost with it).
  // Ruling 382: and the event records who it reached, so compaction keeps it.
  await stampNotifiedRecipients(
    db,
    taskRef(ctx, projectSlug, taskKey),
    event,
    notifyMentionedUsers(db, {
      text,
      projectSlug,
      taskKey,
      from: { kind: "agent", name: "Operator" },
      occurredAt: event.occurredAt,
    }),
  );
  if (variant === "recommend") {
    recordAudit(db, {
      action: "task.operator.recommended",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  } else {
    recordAudit(db, {
      action: "task.operator.commented",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  }
  return { text: text3, dropped: null, trimmedBy: guardrail.trimmedBy };
}

/**
 * Record the audit row for a guardrail-dropped operator comment (G1/B-FD8).
 * The operator path used to leave NO trace on a drop — a maintainer asking
 * "why is there no narration for this turn?" had nothing to read. Same action
 * for every silent drop, with the reason in the details.
 */
function recordCommentDrop(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  variant: "comment" | "recommend",
  reason: "meaningless" | "duplicate",
): void {
  recordAudit(db, {
    action: COMMENT_DROPPED_AUDIT_ACTION,
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { reason, variant },
  });
}

/**
 * Append a structured, ACTIONABLE operator recommendation to the task (rendered
 * as a one-click Apply/Dismiss card) AND post the operator's reasoning as a
 * comment. Sets waiting=human. Idempotent per (kind, target). This is what a
 * SUPERVISED operator does instead of performing a governed action itself.
 */
export interface RecommendationInput {
  kind: RecommendationKind;
  profileId?: string;
  prompt?: string;
  delivers?: boolean;
  toStageId?: string;
  label: string;
  /** accept_completion — ruling 137: the work revision the offer binds to. */
  forHeadSha?: string;
  /** run_agent — ruling 421: the run puts the completeness question. */
  completeness?: boolean;
  /** run_agent — ruling 583: the run records no verdict. */
  noVerdict?: boolean;
}

export async function addRecommendation(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  rec: RecommendationInput,
  reasoning: string,
): Promise<void> {
  const recommendation: Recommendation = {
    id: newId("rec"),
    kind: rec.kind,
    label: rec.label,
    detail: reasoning,
  };
  // A recommendation carries only the targets its kind has — the dedupe below
  // and the card renderer both read these keys' presence.
  if (rec.profileId) recommendation.profileId = rec.profileId;
  if (rec.prompt) recommendation.prompt = rec.prompt;
  if (rec.delivers !== undefined) recommendation.delivers = rec.delivers;
  if (rec.completeness) recommendation.completeness = true;
  if (rec.noVerdict) recommendation.noVerdict = true;
  if (rec.toStageId) recommendation.toStageId = rec.toStageId;
  if (rec.forHeadSha) recommendation.forHeadSha = rec.forHeadSha;
  // Same disclosure the narration path carries (S5-G3): the reasoning is
  // operator prose and can tag a human, so an ambiguous handle must not vanish.
  const commentText = withAmbiguityDisclosure(
    db,
    `**Recommendation:** ${rec.label}. ${reasoning}`,
  );
  let wasNew = false;
  const reasoningAt = new Date().toISOString();
  // Ruling 644: built once, so the recipients are stamped on this event.
  const reasoningComment: TaskFileEvent = {
    occurredAt: reasoningAt,
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: commentText,
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    const existing = parsed.frontmatter.recommendations.find(
      (r) =>
        r.kind === rec.kind &&
        r.profileId === rec.profileId &&
        r.toStageId === rec.toStageId,
    );
    if (!existing) {
      parsed.frontmatter.recommendations.push(recommendation);
      wasNew = true;
    } else if (
      existing.prompt !== recommendation.prompt ||
      existing.delivers !== recommendation.delivers ||
      existing.completeness !== recommendation.completeness ||
      existing.noVerdict !== recommendation.noVerdict ||
      existing.label !== recommendation.label ||
      existing.forHeadSha !== recommendation.forHeadSha
    ) {
      // Hunt 2026-08-29: the per-target dedupe predates `prompt`/`delivers`
      // on run_agent cards, so a NEWER directive for the same agent was
      // silently discarded — the operator narrated Y while Apply dispatched
      // the stale X. A changed directive REPLACES the pending card's content
      // in place (same id, so nothing dangles) and counts as new — it is a
      // fresh decision the supervisors should be pinged about. An identical
      // re-recommendation stays the quiet no-op it always was.
      existing.label = recommendation.label;
      existing.detail = recommendation.detail;
      if (recommendation.prompt !== undefined) existing.prompt = recommendation.prompt;
      else delete existing.prompt;
      if (recommendation.delivers !== undefined) {
        existing.delivers = recommendation.delivers;
      } else {
        delete existing.delivers;
      }
      if (recommendation.completeness) existing.completeness = true;
      else delete existing.completeness;
      if (recommendation.noVerdict) existing.noVerdict = true;
      else delete existing.noVerdict;
      // Ruling 137: a re-recommended acceptance re-binds to the revision it
      // was authored against, or the card keeps a stale binding.
      if (recommendation.forHeadSha !== undefined) {
        existing.forHeadSha = recommendation.forHeadSha;
      } else {
        delete existing.forHeadSha;
      }
      wasNew = true;
    }
    parsed.frontmatter.waiting = "human";
    parsed.timeline.unshift(reasoningComment);
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
  recordAudit(db, {
    action: "task.operator.recommended",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { kind: rec.kind },
  });
  // NEW-4: recommendation reasoning that tags a person pings them too.
  // Ruling 382: and the event records who it reached, so compaction keeps it.
  await stampNotifiedRecipients(
    db,
    taskRef(ctx, projectSlug, taskKey),
    reasoningComment,
    notifyMentionedUsers(db, {
      text: commentText,
      projectSlug,
      taskKey,
      occurredAt: reasoningAt,
      from: { kind: "agent", name: "Operator" },
    }),
  );
  // Ping the supervisors: a supervised operator recommendation is a decision
  // waiting on a human. Without this, the recommendation card only appears if
  // someone happens to open the task — the bell and "Waiting on you" inbox stay
  // dark. (Journey 2: blocked tasks must reach a human decision quickly.) Only
  // on a NEW recommendation, so a re-running operator doesn't re-notify the same
  // pending decision every cycle.
  if (wasNew) {
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "approval",
        ptype: "input",
        // Ruling 361: the operator's own recommendation, named as such.
        from: OPERATOR_NOTIFY_FROM,
        title: `Operator recommends: ${rec.label}`,
        text: reasoning,
        // Ruling 497: the row opens the card, where it is applied.
        about: "recommendations",
      },
      ctx,
    );
  }
}

/**
 * F39-68: what a `create_task` option can and cannot reach. A task it creates
 * starts from the base branch. Live on ax-clone AX-5 the operator recommended
 * a core follow-up for review findings in `pty_linux.go`, a file that existed
 * only on `ax-5`, and made AX-5 wait on it. The new task could not have
 * reached that code, and AX-5 would have been held (ruling 186) until a
 * person found the cycle. Its guidance said to use the kind for "another
 * owner's package" and never said where a created task starts. Both operator
 * surfaces say it from here, so the two never disagree.
 */
export const CREATE_TASK_BASE_NOTE =
  "A created task starts from the base branch, so it cannot reach code that exists only on this " +
  "task's unmerged branch. Rework on files this task's own commits added stays on this task, even " +
  "when another owner's package holds them: hand delivery to that owner here instead. Never make " +
  "this task wait on a task that needs this task's code.";

/** Ruling 138: the longest `goalDraft` an option may carry into task.md. */
const GOAL_DRAFT_MAX_CHARS = 4000;

/** One option the operator offers on a decision/blocking packet. */
export interface OperatorPacketOptionInput {
  kind: PacketOptionKind;
  title: string;
  detail?: string;
  /** redirect and request_edit only — ruling 650: the person's own words are
   *  the choice, so the card requires them (ruling 478(e)'s `reply`). */
  reply?: boolean;
  recommended?: boolean;
  /** Pre-authored timeline text written when a human chooses this option. */
  ev?: string;
  /** retry_other_backend — the backend to re-run the failed agent on. */
  backend?: "codex" | "claude";
  /** retry_other_backend — a reviewer retry names its profile. Ruling 237:
   *  question_reviewer names the reviewer the question is put to. */
  profileId?: string;
  /** archive_task — also delete the task's remote branch (discard the work). */
  deleteBranch?: boolean;
  /** redirect — ruling 163: the resolution returns the task to the review
   *  stage when it stands at or past it (the branch-conflict packet sets it). */
  rework?: boolean;
  /** move_stage only — ruling 164: the stage id the resolution moves the task
   *  to. Required on the kind and refused on every other one. */
  toStage?: string;
  /** edit_goal only — ruling 138: the proposed goal text itself, what the goal
   *  editor opens with when the human confirms. Refused on any other kind. */
  goalDraft?: string;
  /** wait_for_window only — ruling 224: the provider's own reset instant, ISO.
   *  The resolution schedules the agent's re-dispatch just after it. */
  dueAt?: string;
  /** block_on_dependencies only — ruling 230: the tasks this one waits on. The resolution writes them through `setTaskDependencies`, so
   *  Viberr releases the task when the last entry finishes. */
  blockedBy?: string[];
  /** create_task only — ruling 269: the task the resolution creates. Required
   *  on the kind and refused on every other one. */
  newTask?: {
    title: string;
    goal: string;
    /** What the NEW task waits on — not this one. */
    blockedBy?: string[];
    /** Ruling 287: the EXISTING tasks that must wait on the new one. */
    blocks?: string[];
    labels?: string[];
  };
  /** connect_repository only — ruling 672: the repository the task names, as
   *  `owner/name`. The card opens its repository box with it. */
  repo?: string;
}

export interface OperatorOpenPacketInput {
  projectSlug: string;
  taskKey: string;
  /** input = a decision the human should make; blocked = work is stuck. */
  packetType: "input" | "blocked";
  title: string;
  body?: string;
  observations?: { k: string; v: string; code?: boolean }[];
  options: OperatorPacketOptionInput[];
  /** Ruling 315: the account-level cause that raised this, when the cause is
   *  bigger than the task. Packets sharing it are resolved together. */
  cause?: string;
  /** Ruling 432: a stall escalation (`openStuckLoopPacket`), the one family a
   *  later successful run may withdraw. Set by the server only; the operator's
   *  own packet tools build their input field by field and never carry it. */
  stalled?: true;
  /** Ruling 672: the repository question (`operatorAskForRepository`), the
   *  one packet that may offer `connect_repository` and
   *  `keep_without_repository`. Set by the server only, like `stalled`. */
  repositoryAsk?: true;
}

const PACKET_KIND_SET = new Set<string>(PACKET_OPTION_KINDS);

/**
 * Ruling 672: the option kinds an operator writes on a packet of its own:
 * every kind but the repository question's two, which only
 * `ask_for_repository` writes. Both backends' packet schemas offer these, so
 * neither can express the two, and the schema a project with a repository is
 * given is the one it had.
 */
export const OPERATOR_PACKET_OPTION_KINDS = PACKET_OPTION_KINDS.filter(
  (kind) => !isRepositoryOptionKind(kind),
);

/** `agent_runs.backend` is NOT NULL with a CHECK; `agent_profile_id` is read
 *  as nullable because a row that names no profile must not sink the lookup. */
const lastAgentRunSchema = z.object({
  backend: z.string(),
  agent_profile_id: z.string().nullable(),
});

interface RetryBackendDefaults {
  /** The backend to retry on — the OTHER one from the failure. */
  backend: RealBackend;
  /** The agent to re-run, when one can be identified. */
  profileId?: string;
}

/**
 * B1 — what a `retry_other_backend` option retries ON, when the operator did
 * not say.
 *
 * `resolvePacket` starts the retry with `option.backend ?? "claude"`, so an
 * option written without one ALWAYS re-ran on Claude — including when Claude
 * is exactly what just failed, which makes the recommended recovery path from
 * a Claude quota/auth failure a re-run of the same dead backend. Only the
 * completion pipeline stamped the field; the operator's own authoring
 * surfaces now expose it too, and an option that still arrives without one is
 * stamped here with the SAME rule the completion pipeline uses: the other
 * backend than the one that failed.
 *
 * "The one that failed" is the task's most recent AGENT run (the run a retry
 * re-runs), then the delivering engagement's backend, then the operator's own
 * — a packet authored before any agent ran still names a real target.
 */
function retryOtherBackendDefaults(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  frontmatter: { engagements: Engagement[] },
  authority: OperatorAuthority,
): RetryBackendDefaults {
  const row = lastAgentRunSchema.safeParse(
    db
      .prepare(
        `SELECT backend, agent_profile_id FROM agent_runs
       WHERE project_slug = ? AND task_key = ? AND kind IN ('primary', 'reviewer')
       ORDER BY rowid DESC LIMIT 1`,
      )
      .get(projectSlug, taskKey),
  );
  const lastAgentRun = row.success ? row.data : null;
  const delivering = deliveringEngagement(frontmatter);
  const failed = lastAgentRun?.backend ?? delivering?.backend ?? authority.backend;
  const profileId = lastAgentRun?.agent_profile_id ?? delivering?.profileId;
  const defaults: RetryBackendDefaults = {
    backend: failed === "codex" ? "claude" : "codex",
  };
  // Stamped so the retry re-runs the agent that failed rather than falling
  // back to the delivering one, and so a stall packet's withdrawal
  // (`withdrawSupersededStuckPacket`, ruling 432) joins it to the right
  // agent's success.
  if (profileId) defaults.profileId = profileId;
  return defaults;
}

/**
 * B2 as ruling 437 exposes it: a packet the operator may withdraw is one it
 * raised. `from` is stamped by each writer ("operator" for the operator's own,
 * the agent's actor ref for a question, the policy engine for its escalations),
 * and a question an agent asked through the operator still names the agent in
 * `askedBy`. One predicate for the refusal and for the snapshot that warns
 * about it, so the two cannot disagree.
 */
export function packetIsOperators(packet: Pick<TaskPacket, "from" | "askedBy">): boolean {
  return packet.from === "operator" && !packet.askedBy;
}

/** A title as a sentence: its own closing mark, or a full stop. */
function sentence(title: string): string {
  return /[.?!]$/.test(title) ? title : `${title}.`;
}

/**
 * Ruling 161: the one sentence naming why a `discard_branch` option cannot be
 * offered, from the fact that says the revision left the workspace.
 */
function revisionDepartureSentence(
  departure: RevisionDeparture,
  taskKey: string,
  branch: string | null,
): string {
  const name = branch ? `\`${branch}\`` : "the task branch";
  switch (departure.kind) {
    case "pr":
      return `PR #${departure.number} tracks ${name}, so it is no longer a local-only branch.`;
    case "unowned_pr":
      return `an unowned PR #${departure.number} stands on the branch name ${name}, so the local/remote framing would mislead.`;
    case "pushed":
      return `${taskKey}'s revision \`${departure.headSha.slice(0, 7)}\` was pushed to origin at ${departure.at}, so discarding the local branch would not remove it.`;
    default: {
      const exhaustive: never = departure;
      return exhaustive;
    }
  }
}

/** Open a typed human-decision packet and notify the task's supervisors. */
export async function operatorOpenPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: OperatorOpenPacketInput,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot open decision packets in this project.",
    };
  }
  const title = input.title.trim();
  if (!title) {
    return { outcome: "noop", message: "A packet needs a title." };
  }
  const rawOptions = input.options ?? [];
  if (rawOptions.length === 0) {
    return { outcome: "noop", message: "A packet needs at least one option." };
  }
  for (const o of rawOptions) {
    if (!PACKET_KIND_SET.has(o.kind)) {
      return {
        // `noop`, not `denied`: nothing about the operator's POLICY refused
        // this — the option was malformed. `denied` is reserved for authority
        // refusals so the plan narration can name the real reason.
        outcome: "noop",
        message: `Unknown packet option kind "${o.kind}". Valid kinds: ${PACKET_OPTION_KINDS.join(", ")}.`,
      };
    }
  }

  // Ruling 672: the two repository options are written one way, by the
  // question that owns them. Their resolution attaches a repository or writes
  // a standing ruling for the whole board, so an option an operator composed
  // itself (its own title, no second option to refuse with, a board that has
  // a repository) would promise something the resolution does not do.
  if (!input.repositoryAsk) {
    const stray = rawOptions.find((o) => isRepositoryOptionKind(o.kind));
    if (stray) {
      return {
        outcome: "noop",
        message:
          `${stray.kind} is not an option you write yourself ("${stray.title}"). ` +
          "Only ask_for_repository writes it, with both answers, and a run has that tool only " +
          "on a board with no repository whose rulings hold no decision to keep none.",
      };
    }
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  // Ruling 177 (pass 36, F36-5): no decision packet on a closed task. The
  // operator that outlives an acceptance (its turn started before the human
  // accepted) reaches this writer with a plan authored for an open task; the
  // packet it wants would ask a person to decide something about a task that
  // is already Shipped or archived.
  {
    const packetProject = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
    const closure = packetProject
      ? taskClosure(existing.parsed.frontmatter, packetProject.parsed.frontmatter.stages)
      : ({ closed: false } as const);
    if (closure.closed && packetProject) {
      return {
        outcome: "noop",
        message: closureRefusal(
          input.taskKey,
          closure,
          packetProject.parsed.frontmatter.stages,
          "opening a decision packet on it",
        ),
      };
    }
  }
  // F31-6: option/semantics coherence, checked where the option is AUTHORED.
  // `discard_branch` deletes the LOCAL, never-pushed branch and destroys its
  // commits — offered on a task whose revision has LEFT the workspace (a PR
  // tracks the branch, a stranger's PR stands on the name, or a delivery push
  // published the head), the human's confirm ceremony would truthfully promise
  // the opposite of the option's text (live-caught: an operator authored
  // "delete the conflicting REMOTE branch and push this task's commit fresh"
  // onto a discard_branch option — confirming it would have destroyed the
  // delivery it promised to push). Refuse the authoring and name the verb that
  // fits.
  //
  // Ruling 161 (pass 35, G35-6): the gate keys on `revisionLeftWorkspace`, not
  // on `workRevision !== null`. The revision registry writes a revision when
  // the agent's completion report lands, before any push, so "has a revision"
  // refused the discard on exactly the branch it exists for (KNC-21: reported
  // 18:56Z, push refused 19:10Z, discard refused 19:3xZ, and the only door left
  // was archiving the task). A reported head that never reached origin is the
  // task's local draft; the refusal names the real reason when one applies.
  if (rawOptions.some((o) => o.kind === "discard_branch")) {
    const fm = existing.parsed.frontmatter;
    const departure = revisionLeftWorkspace(fm);
    if (departure) {
      return {
        outcome: "noop",
        message:
          `discard_branch only fits a branch whose revision never left the workspace (ruling 161): ` +
          `${revisionDepartureSentence(departure, input.taskKey, fm.branch)} ` +
          "For a task-key branch collision (an unrelated remote branch or unowned PR under this task's branch name), offer resolve_remote_collision: the human's confirm closes the unowned PR, deletes the stale remote branch, and re-delivers this task's local work. To abandon pushed or tracked work entirely, offer archive_task with deleteBranch.",
      };
    }
  }
  // Owner ruling (pass 32): an `accept_completion` option is only coherent at
  // the acceptance boundary with a healthy verdict — everywhere else the
  // acceptance gate refuses the very decision the option offers (ruling 20:
  // verdict-gated; ruling 62: a no-change completion needs one too), and the
  // human is left confirming a card that cannot succeed. Live (VIB-3): a triage
  // packet offered "Accept as complete now" on a task at Triage with no
  // verdict. Refuse the authoring, name the verbs that fit; the admin's own
  // force-accept exists for "just close it".
  if (rawOptions.some((o) => o.kind === "accept_completion")) {
    const fm = existing.parsed.frontmatter;
    const projectFile = readProjectFile({
      projectSlug: input.projectSlug,
      dataRoot: ctx.dataRoot,
    });
    const stages = projectFile?.parsed.frontmatter.stages ?? [];
    const boundaryStageId = stages.length >= 2 ? stages[stages.length - 2]!.id : null;
    const atBoundary = boundaryStageId !== null && fm.stage === boundaryStageId;
    const verdictHealthy = fm.validation === "healthy";
    if (!atBoundary || !verdictHealthy) {
      return {
        outcome: "noop",
        message:
          "accept_completion only fits a task AT the acceptance boundary with a healthy verdict; " +
          (!atBoundary
            ? `${input.taskKey} is at stage ${fm.stage}, not the stage before Done. `
            : "its validation is not healthy, so acceptance would be refused. ") +
          "Offer archive_task to close a task that needs no work, edit_goal to scope real work, or transition_stage / run_agent to move it toward review. Only a human admin can force-accept from here.",
      };
    }
    // Ruling 521: a decision that offers acceptance is the operator's offer,
    // so it carries the completion packet the page draws inside it.
    const packetRefusal = completionPacketRefusal(fm, input.taskKey);
    if (packetRefusal) return { outcome: "noop", message: packetRefusal };
  }
  // Ruling 244 (pass 37, F37-73): the same rule the `accept_completion` arm
  // above applies, applied to its sibling. `resolve_remote_collision` clears a
  // FOREIGN remote — ruling 122's case, an unrelated branch or an unowned PR
  // squatting this task's branch name — and V19 put `unownedPr` in the
  // operator's own snapshot precisely so it can tell. With no collision
  // recorded, the resolution takes ruling 136(b)'s `own_pr_open` arm, answers
  // "No collision to clear: PR #N on `branch` is TASK's own review PR", and
  // leaves the block exactly where it was.
  //
  // Live on SHOP-11: a rebase diverged the branch from its own PR #15, the
  // operator offered this as the RECOMMENDED option promising to close PR #15
  // and delete the remote, a person confirmed it through the destructive-action
  // ceremony that names deleting a branch, and the answer was "The block
  // stays." The decision was spent, the packet was gone, and nothing had
  // happened — which is what the accept_completion refusal exists to prevent:
  // "the human is left confirming a card that cannot succeed."
  if (rawOptions.some((o) => o.kind === "resolve_remote_collision")) {
    const fm = existing.parsed.frontmatter;
    const unowned = fm.github?.unownedPr ?? null;
    if (unowned === null) {
      const own = fm.pr?.number ? `its own review PR #${fm.pr.number}` : "no unowned PR";
      return {
        outcome: "noop",
        message:
          `resolve_remote_collision only fits a FOREIGN remote under ${input.taskKey}'s branch name ` +
          `(an unrelated branch, or a pull request this task does not own). ` +
          `${input.taskKey} records no collision (the branch carries ${own}), so the resolution ` +
          `would answer "no collision to clear" and leave the block where it is. ` +
          "For a branch whose history diverged from its own PR, a person resolves the history: " +
          "offer custom naming what they must do, or archive_task with deleteBranch to abandon it.",
      };
    }
  }
  // Ruling 489: `deliver_for_review` promises a delivery, so it is offered only
  // over a head that has one owed — committed, and neither pushed by a
  // delivery nor carried by the live pull request. Anywhere else the confirm
  // would push nothing, which is ruling 244's false premise.
  if (rawOptions.some((o) => o.kind === "deliver_for_review")) {
    const head = taskHeadState(existing.parsed.frontmatter);
    if (head.kind !== "undelivered") {
      return {
        outcome: "noop",
        message:
          `deliver_for_review delivers a committed head that nothing has delivered, and ` +
          (head.kind === "none"
            ? `${input.taskKey} has no committed head on record, so there is nothing to deliver.`
            : `${input.taskKey}'s head \`${head.sha.slice(0, 7)}\` is already delivered` +
              (head.prNumber !== null ? ` (PR #${head.prNumber} carries it)` : "") +
              ", so the confirm would push nothing."),
      };
    }
  }
  // B3: one open decision at a time, the same refusal every sibling packet
  // writer makes (`openStuckLoopPacket`, `openAgentQuestionPacket`). This
  // writer alone assigned `parsed.packet` unconditionally, so a second packet
  // REPLACED the open one: a human mid-answer got "this decision was replaced
  // by a newer one" and the question they were answering vanished — and an
  // agent's own `ask_human` packet could be overwritten by an operator turn
  // that never read it. Prompt text asked the model not to; nothing enforced
  // it. Withdraw the open packet first (`resolve_decision_packet`) when it is
  // genuinely moot.
  if (existing.parsed.packet) {
    return {
      outcome: "noop",
      message:
        `A decision packet is already open on ${input.taskKey} ("${existing.parsed.packet.title}"). ` +
        "Answer from it, or withdraw it with resolve_decision_packet if it is moot, before opening another.",
    };
  }

  // Ruling 164 (pass 35, F35-14): an option TITLE is a promise the resolution
  // keeps, and the send-back kinds (custom / redirect / request_edit) keep no
  // promise but "the agent side hears about it". KNC-3's custom "Force-accept
  // as admin without a fresh verdict" re-ran the operator into a no-op behind
  // the verdict gate; KNC-16's redirect "Move KNC-16 back to Review" moved
  // nothing. Refuse the authoring where the option is written and name the kind
  // that performs the act. The stage list is this project's own, so the move
  // detector recognises the board's real stage names.
  {
    const projectStages = readProjectFile({
      projectSlug: input.projectSlug,
      dataRoot: ctx.dataRoot,
    })?.parsed.frontmatter.stages ?? [];
    for (const o of rawOptions) {
      const promise = misdirectedOptionPromise(
        {
          kind: o.kind,
          title: o.title,
          detail: o.detail ?? "",
          // Ruling 163: the branch-conflict packet's rework redirect really
          // does return the task to the review stage, and says so.
          rework: o.rework === true,
        },
        projectStages,
      );
      if (promise) {
        return {
          outcome: "noop",
          message: misdirectedPromiseRefusal(promise, o, input.taskKey),
        };
      }
    }
    // `move_stage` names the stage it moves to, and only that kind carries the
    // field: the same two refusals `resolvePacket` makes, made here so the
    // option is never written in a shape the confirm would refuse.
    // Ruling 269: `create_task` carries the task it will create, and only that
    // kind reads it — the same two refusals `move_stage` gets, for the same
    // reason: an option must never be written in a shape the confirm refuses.
    // Ruling 273 (pass 37, F37-106): a retry onto a backend the instance
    // ALREADY knows is spent. The same rule the `accept_completion` and
    // `resolve_remote_collision` guards apply — "the human is left confirming
    // a card that cannot succeed" — on the kind whose whole job is recovery.
    // Live on SHOP-37: Codex had been recorded exhausted for the owner's
    // credential since 03:26 ("try again at Sep 19th"), the operator
    // recommended "Re-run the Integration Verifier on the Codex backend" at
    // 09:0x, a person confirmed it, and the answer was "The retry could not
    // start: Held: Codex is out of quota until Sep 19… scheduled for then."
    // Nothing lied and nothing was lost — the hold is ruling 152(c) working —
    // but the decision was spent on a four-day park that was knowable when the
    // option was written. `wait_for_window` is the honest kind for that, and
    // ruling 224 built it for exactly this fact.
    if (rawOptions.some((o) => o.kind === "retry_other_backend")) {
      const ownerId = existing.parsed.frontmatter.ownerUserId;
      const retryTargets = rawOptions
        .filter((o) => o.kind === "retry_other_backend")
        .map((o) => ({ option: o, backend: o.backend ?? null }));
      for (const target of retryTargets) {
        const backend = target.backend;
        if (!backend || !ownerId) continue;
        const hold = backendDispatchHold(db, backend, { credentialUserId: ownerId });
        if (!hold) continue;
        const label = BACKEND_LABEL[backend];
        const until = hold.until
          ? ` until ${new Date(hold.until).toISOString()}`
          : "";
        return {
          outcome: "noop",
          message:
            `"${target.option.title}" retries on ${label}, and this instance already recorded ` +
            `${label} as out of quota for ${input.taskKey}'s owner${until}. The dispatch would ` +
            `be HELD and re-scheduled rather than run, so the person would spend a decision on a ` +
            `wait. Offer the OTHER backend, or offer wait_for_window with dueAt set to the reopen ` +
            `instant, which resumes by itself and says so.`,
        };
      }
    }
    const strayNewTask = rawOptions.find(
      (o) => o.kind !== "create_task" && o.newTask !== undefined,
    );
    if (strayNewTask) {
      return {
        outcome: "noop",
        message:
          `newTask only fits a create_task option. "${strayNewTask.title}" is ` +
          `${strayNewTask.kind}, and its resolution creates nothing.`,
      };
    }
    const emptyNewTask = rawOptions.find(
      (o) =>
        o.kind === "create_task" &&
        ((o.newTask?.title ?? "").trim() === "" || (o.newTask?.goal ?? "").trim() === ""),
    );
    if (emptyNewTask) {
      return {
        outcome: "noop",
        message:
          `"${emptyNewTask.title}" is a create_task option with no task on it. ` +
          "Give newTask a title and a goal; the goal is the contract the new task is " +
          "worked to, so write it as one (deliverable plus acceptance criteria). " +
          "Without them the confirm would create nothing.",
      };
    }
    // Ruling 288 (F37-123): a goal too long to carry is REFUSED, never cut. Both
    // of these texts become a task's CONTRACT — the one document every future
    // run on it re-anchors on (ruling 189) — and both were a bare
    // `.slice(0, GOAL_DRAFT_MAX_CHARS)`, so an over-long draft was committed
    // ending mid-sentence with nothing anywhere saying it had been cut.
    //
    // Live on SHOP-29 this afternoon: a person's decision asked the operator to
    // write the REASONING into a corrected acceptance criterion, precisely so a
    // later reader would not "fix" it back. The draft came out at 4,000
    // characters exactly, ending "…a 403 there would be", and the sentence
    // carrying the reason was gone. The editor showed it as ordinary text. Only
    // counting the characters revealed it, and the operator's own words were
    // unrecoverable by then — the slice happened at write time, so what was cut
    // was never stored anywhere.
    //
    // Refusing is ruling 139's rule applied to prose: check before anything is
    // written, name what is wrong, and write nothing. The operator can shorten
    // and re-offer inside the same turn; a truncated contract cannot be
    // repaired by anyone who does not already know what it said.
    const tooLong = rawOptions.find(
      (o) =>
        (o.goalDraft ?? "").trim().length > GOAL_DRAFT_MAX_CHARS ||
        (o.newTask?.goal ?? "").trim().length > GOAL_DRAFT_MAX_CHARS,
    );
    if (tooLong) {
      const draftLen = (tooLong.goalDraft ?? "").trim().length;
      const which =
        draftLen > GOAL_DRAFT_MAX_CHARS
          ? { field: "goalDraft", len: draftLen }
          : { field: "newTask.goal", len: (tooLong.newTask?.goal ?? "").trim().length };
      return {
        outcome: "noop",
        message:
          `"${tooLong.title}" carries a ${which.field} of ${which.len.toLocaleString("en-US")} ` +
          `characters and the limit is ${GOAL_DRAFT_MAX_CHARS.toLocaleString("en-US")}. ` +
          `Nothing was written. A goal is the contract every future run on the task ` +
          `re-anchors on, so Viberr will not commit one that stops mid-sentence. Shorten ` +
          `it and offer the option again. Cut narrative and worked examples before you cut ` +
          `a deliverable or an acceptance criterion; detail that does not fit belongs in ` +
          `the packet's own text or a comment, which have no such limit.`,
      };
    }
    const strayStage = rawOptions.find(
      (o) => o.kind !== "move_stage" && (o.toStage ?? "").trim() !== "",
    );
    if (strayStage) {
      return {
        outcome: "noop",
        message:
          `toStage only fits a move_stage option. "${strayStage.title}" is ${strayStage.kind}, ` +
          "and its resolution reads no stage.",
      };
    }
    for (const o of rawOptions) {
      if (o.kind !== "move_stage") continue;
      const target = moveStageTarget(o, projectStages, input.taskKey);
      if (!target.ok) {
        return { outcome: "noop", message: target.refusal };
      }
      if (target.stage.id === existing.parsed.frontmatter.stage) {
        return {
          outcome: "noop",
          message:
            `${input.taskKey} already stands at ${target.stage.name}, so "${o.title}" would move ` +
            "nothing. Offer the stage the work should be shown at, or a kind that acts on the task.",
        };
      }
      // Ruling 164 again, on the kind that carries BOTH a title and a target:
      // the card shows the words and the resolution reads the id, so a title
      // naming another stage is the same broken promise the send-back guard
      // above refuses — invisible to the person confirming it.
      const mismatch = moveStagePromiseMismatch(o, target.stage, projectStages, input.taskKey);
      if (mismatch) return { outcome: "noop", message: mismatch };
    }
    // `force_accept` is the admin override of a WEDGED gate. A pull request a
    // person closed unmerged is not wedged, it is decided (R16-3), and the
    // force path refuses it: an option offered there promises a close the
    // confirm cannot perform.
    const forceOption = rawOptions.find((o) => o.kind === "force_accept");
    if (forceOption && acceptanceTerminallyBlocked(existing.parsed.frontmatter)) {
      return {
        outcome: "noop",
        message:
          `force_accept cannot close ${input.taskKey}: its pull request was closed without ` +
          "merging, which no override can undo. Offer archive_task (with deleteBranch to " +
          "discard the work) or a redirect that delivers again.",
      };
    }
  }

  // Ruling 138: `goalDraft` is the goal editor's prefill, which only an
  // `edit_goal` option opens — on any other kind it is a claim nothing reads,
  // so the authoring is refused by name (the ruling-115 precedent above).
  const strayDraft = rawOptions.find(
    (o) => o.kind !== "edit_goal" && (o.goalDraft ?? "").trim() !== "",
  );
  if (strayDraft) {
    return {
      outcome: "noop",
      message:
        `goalDraft only fits an edit_goal option. "${strayDraft.title}" is ${strayDraft.kind}. ` +
        "Put the proposed goal text on the edit_goal option, or drop it.",
    };
  }

  // Ruling 224: a wait_for_window with no instant resolves into a schedule
  // with no due time, so it is refused by name like every other option whose
  // payload its kind requires.
  const strayWait = rawOptions.find(
    (o) => o.kind === "wait_for_window" && !(o.dueAt ?? "").trim(),
  );
  if (strayWait) {
    return {
      outcome: "noop",
      message:
        `A wait_for_window option needs the instant the window reopens; "${strayWait.title}" carries none. ` +
        "Pass dueAt as an ISO timestamp, or offer a different recovery.",
    };
  }
  const strayDue = rawOptions.find(
    (o) => o.kind !== "wait_for_window" && (o.dueAt ?? "").trim() !== "",
  );
  if (strayDue) {
    return {
      outcome: "noop",
      message:
        `dueAt only fits a wait_for_window option. "${strayDue.title}" is ${strayDue.kind}. ` +
        "Drop it, or offer the wait as its own option.",
    };
  }

  // Ruling 237 (F37-57): a question_reviewer names the reviewer it questions,
  // and that reviewer must be one this task actually has. Without the check the
  // resolution would promise "ask X" and then either dispatch nobody or, worse,
  // start the DELIVERER with a prompt telling it not to review — and the person
  // who chose the option would read a card that said otherwise.
  const strayQuestion = rawOptions.find(
    (o) => o.kind === "question_reviewer" && !(o.profileId ?? "").trim(),
  );
  if (strayQuestion) {
    return {
      outcome: "noop",
      message:
        `A question_reviewer option needs the reviewer it asks; "${strayQuestion.title}" names none. ` +
        "Pass profileId, or put the question in a comment instead.",
    };
  }
  const wrongQuestion = rawOptions.find(
    (o) =>
      o.kind === "question_reviewer" &&
      !existing.parsed.frontmatter.engagements.some(
        (e) => e.profileId === o.profileId && !e.delivers,
      ),
  );
  if (wrongQuestion) {
    return {
      outcome: "noop",
      message:
        `"${wrongQuestion.profileId}" is not a reviewer engaged on ${input.taskKey}, so a question_reviewer ` +
        `option cannot put a question to it ("${wrongQuestion.title}"). ` +
        "Name an engaged non-delivering agent, or engage one first.",
    };
  }

  // Ruling 230: a hold that names nothing to wait on resolves into a hold that
  // releases on nothing — the task would sit with no dependencies, no run and
  // no owner. Refused by name like every other option whose payload its kind
  // requires.
  const strayHold = rawOptions.find(
    (o) =>
      o.kind === "block_on_dependencies" &&
      (o.blockedBy ?? []).filter((e) => e.trim() !== "").length === 0,
  );
  if (strayHold) {
    return {
      outcome: "noop",
      message:
        `A block_on_dependencies option needs the work it waits on; "${strayHold.title}" names none. ` +
        "Pass blockedBy as task keys, or offer a different hold.",
    };
  }
  const strayBlockedBy = rawOptions.find(
    (o) => o.kind !== "block_on_dependencies" && (o.blockedBy ?? []).length > 0,
  );
  if (strayBlockedBy) {
    return {
      outcome: "noop",
      message:
        `blockedBy only fits a block_on_dependencies option. "${strayBlockedBy.title}" is ${strayBlockedBy.kind}. ` +
        "Drop it, or offer the hold as its own option.",
    };
  }

  // Ruling 226: the head-check override is the policy engine's to offer and
  // nobody else's. It is granted against a triple the gate read live at the
  // moment it refused, so an operator authoring it from a stale board would be
  // offering a waiver over facts it never checked — and the thing being waived
  // is the last guard between a review and the base branch.
  const strayWaiver = rawOptions.find((o) => o.kind === "accept_unverified_head");
  if (strayWaiver) {
    return {
      outcome: "noop",
      message:
        `accept_unverified_head is not an option you can offer ("${strayWaiver.title}"). ` +
        "The acceptance gate writes it itself when GitHub refuses the head comparison, " +
        "pinned to the shas it read at that moment.",
    };
  }

  // Exactly one recommended option (the parser expects this): honour the first
  // one the operator marked, else default to the first option.
  let recSeen = false;
  const retryDefaults = rawOptions.some((o) => o.kind === "retry_other_backend")
    ? retryOtherBackendDefaults(
        db,
        input.projectSlug,
        input.taskKey,
        existing.parsed.frontmatter,
        authority,
      )
    : null;
  const options: PacketOption[] = rawOptions.map((o) => {
    const rec = !recSeen && o.recommended === true;
    if (rec) recSeen = true;
    // B1: a retry option ALWAYS names the backend it retries on — an unnamed
    // one silently resolved to Claude, i.e. a re-run of whatever just failed.
    const retry = o.kind === "retry_other_backend" ? retryDefaults : null;
    const backend = o.backend ?? retry?.backend;
    const profileId = o.profileId ?? retry?.profileId;
    const option: PacketOption = {
      kind: o.kind,
      t: o.title.trim() || o.kind,
      d: (o.detail ?? "").trim(),
      rec,
    };
    // Each of these exists on the stored option ONLY when it was supplied —
    // `resolvePacket` branches on their presence.
    if (o.ev) option.ev = o.ev;
    if (backend) option.backend = backend;
    if (profileId) option.profileId = profileId;
    // U36-2 (pass 36): a branchless task has no branch to delete — the option
    // must not promise it, and the card's recovery paragraph keys on it.
    if (o.deleteBranch && existing.parsed.frontmatter.branch) option.deleteBranch = true;
    // Ruling 163: only a redirect returns the task to the review stage.
    if (o.rework && o.kind === "redirect") option.rework = true;
    // Ruling 650: an option that hands the person's words to the next run
    // requires them. Live on AWSC-100 "Ask the Estimate Judge to revise the
    // inputs first: write what to change" sat over a box marked optional, so
    // an empty confirm would have re-run the Judge with nothing to change.
    if (o.reply && (o.kind === "redirect" || o.kind === "request_edit")) option.reply = true;
    // Ruling 672: the repository to connect is the person's typed answer, so
    // the card requires it; the one the operator could name opens the box.
    if (o.kind === "connect_repository") {
      option.reply = true;
      if (o.repo) option.repo = o.repo;
    }
    // Ruling 164: the stage a move_stage resolution moves to, validated above.
    if (o.kind === "move_stage" && o.toStage) option.toStage = o.toStage.trim();
    // Ruling 224: only a wait_for_window carries the reset instant, and it is
    // useless without one — an option promising to resume "when the window
    // reopens" with no instant would resolve into a schedule with no due time.
    if (o.kind === "wait_for_window" && o.dueAt) option.dueAt = o.dueAt;
    if (o.kind === "block_on_dependencies" && o.blockedBy?.length) {
      option.blockedBy = [...o.blockedBy];
    }
    // Ruling 269: the task the create_task resolution will make, validated
    // above. Trimmed here, the one chokepoint both operator backends reach.
    if (o.kind === "create_task" && o.newTask) {
      const newTask: NonNullable<PacketOption["newTask"]> = {
        title: o.newTask.title.trim(),
        // Ruling 288: within the cap by construction — an over-long goal was
        // refused above, with nothing written.
        goal: o.newTask.goal.trim(),
      };
      if (o.newTask.blockedBy?.length) newTask.blockedBy = [...o.newTask.blockedBy];
      // Ruling 287: the reverse edge reaches the stored option, which is the
      // only place the resolver can read it from.
      if (o.newTask.blocks?.length) newTask.blocks = [...o.newTask.blocks];
      if (o.newTask.labels?.length) newTask.labels = [...o.newTask.labels];
      option.newTask = newTask;
    }
    // Ruling 138: the draft is model-authored prose bound for task.md — capped
    // here, the one chokepoint both operator backends reach.
    const goalDraft = o.goalDraft?.trim();
    // Ruling 288: within the cap by construction (refused above). It was a
    // silent `.slice` here, which is how a contract came to end mid-sentence.
    if (goalDraft) option.goalDraft = goalDraft;
    return option;
  });
  if (!recSeen && options[0]) options[0].rec = true;

  const packet: TaskPacket = {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
    type: input.packetType,
    kind: input.packetType === "blocked" ? "Blocked decision" : "Decision required",
    from: "operator",
    title,
    body: (input.body ?? "").trim(),
    observations: (input.observations ?? []).map((o) => ({
      k: o.k,
      v: o.v,
      code: o.code ?? false,
    })),
    options,
  };
  // Ruling 315: an account-level cause travels onto the packet, so a sibling
  // raised by the same failure can be found when this one is answered.
  if (input.cause) packet.cause = input.cause;
  // Ruling 432: what lets a later successful run withdraw it, and nothing else.
  if (input.stalled) packet.stalled = true;

  let opened = false;
  // Ruling 137: a packet pauses coordination, so the standing acceptance
  // offers (and the terminal transition cards, acceptances too) are withdrawn
  // on the record inside the same locked write.
  const packetCause: OfferWithdrawalCause = { kind: "packet", title };
  const terminalStageId = terminalStageIdFor(ctx, input.projectSlug);
  const packetWithdrawal: OfferWithdrawalSlot = { offers: null };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // Re-check inside the locked write — the read above raced other writers
    // (the same guard `openAgentQuestionPacket` makes).
    if (parsed.packet) return;
    parsed.packet = packet;
    opened = true;
    packetWithdrawal.offers = withdrawAcceptanceOffers(parsed, terminalStageId, packetCause, {
      kind: "operator",
    });
    parsed.frontmatter.waiting = "human";
    if (input.packetType === "blocked") {
      // Blocked-ness lives on `readiness` alone (F7-VAL1). It used to ALSO set
      // validation="failing", but `validation` is REVIEW health — only a
      // reviewer verdict or an acceptance owns it. A blocked packet from an
      // unrelated cause (e.g. a commit was denied, a run crashed) then made the
      // acceptance gate refuse with "the latest review is failing — rework and
      // re-review", which is nonsense when no review ever ran. The readiness
      // flag already gates the board; validation stays whatever review left it.
      parsed.frontmatter.readiness = "blocked";
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: input.packetType === "blocked" ? "blocked" : "comment",
      actor: { kind: "operator" },
      title,
      // Ruling 586: the entry carries the card, which leaves when answered.
      text: askedEntryText(
        input.packetType === "blocked"
          ? // Ruling 625: the entry's title already says what blocked it.
            "**Blocked.** Opened a decision packet for the owner to resolve."
          : `**Decision packet:** ${sentence(title)} Awaiting a human decision.`,
        packet,
      ),
      toAgent: false,
      evidence: null,
    });
  });
  if (!opened) {
    return {
      outcome: "noop",
      message: `Another decision packet was opened on ${input.taskKey} first; this one was not written.`,
    };
  }
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  if (packetWithdrawal.offers) {
    recordRecommendationWithdrawal(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      withdrawal: packetWithdrawal.offers,
      cause: packetCause,
      actor: OPERATOR_AUDIT_ACTOR,
    });
  }
  recordAudit(db, {
    action: "task.operator.packet_opened",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { type: input.packetType },
  });
  const notifiedUserIds = notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "packet",
      ptype: input.packetType,
      // Ruling 361: the operator's own packet.
      from: OPERATOR_NOTIFY_FROM,
      title:
        input.packetType === "blocked"
          ? `Blocked, decision needed: ${title}`
          : `Decision needed: ${title}`,
      text: packet.body || title,
      // Ruling 497: the row opens the packet, where it is decided.
      about: { decision: packet.id },
    },
    ctx,
  );
  return {
    outcome: "done",
    notifiedUserIds,
    message: `Opened a ${input.packetType === "blocked" ? "blocking" : "decision"} packet with ${options.length} option(s).`,
  };
}

export interface OperatorAskForRepositoryInput {
  projectSlug: string;
  taskKey: string;
  /** Why this task needs a repository: what the person reads before deciding. */
  reason: string;
  /** The repository the goal or a person named, as `owner/name`. */
  repository?: string;
}

/**
 * Ruling 672: ask a person to connect a repository to a board that has none,
 * because this task needs one. "Operator creates a packet to remind to user
 * to connect a repo" (owner, 2026-10-06).
 *
 * The packet is the server's: one title, the operator's reason as its body,
 * and the two answers `resolvePacket` carries out. It is refused, with nothing
 * written, on a board that has a repository (there is nothing to connect) and
 * on one whose rulings hold a person's decision to keep none: "never asked
 * again" is this refusal, not a sentence the operator is trusted to remember.
 */
export async function operatorAskForRepository(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: OperatorAskForRepositoryInput,
  authority: OperatorAuthority,
  /** The packet writer. Both operator backends pass the one that appends
   *  ruling 84's disclosure of the agents this run consulted. */
  open: (packet: OperatorOpenPacketInput) => Promise<OperatorActionResult> = (packet) =>
    operatorOpenPacket(db, ctx, packet, authority),
): Promise<OperatorActionResult> {
  const reason = input.reason.trim();
  if (!reason) {
    return {
      outcome: "noop",
      message:
        "Say why this task needs a repository: the reason is what the person reads before they decide.",
    };
  }
  const project = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return { outcome: "noop", message: `Project ${input.projectSlug} not found.` };
  const repo = project.parsed.frontmatter.repo;
  if (repo) {
    return {
      outcome: "noop",
      message:
        `This board already has a repository (${repo}), so there is nothing to connect. ` +
        "If no deployed agent may write it, that is a capability gap: say so in a decision packet, " +
        "and a project admin or the controller grants repo-write.",
    };
  }
  const ruling = noRepositoryRuling(input.projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {});
  if (ruling) {
    return {
      outcome: "noop",
      message:
        `A person already decided this board connects no repository (\`${ruling.kb}/${ruling.doc}\` in the project's rulings), ` +
        "so the question is not asked again. Deliver what can be delivered as files, and say plainly " +
        "what cannot be done without a repository.",
    };
  }
  const named = normalizeRepoInput(input.repository ?? "");
  const connect: OperatorPacketOptionInput = {
    kind: "connect_repository",
    title: "Connect a repository",
    detail:
      "Type it as owner/name. Viberr checks it on GitHub and attaches it, then starts the controller on this board, on your Claude account, to switch it to pull requests.",
    recommended: true,
  };
  if (named) connect.repo = named;
  // The settings door asks a person to acknowledge the records an earlier
  // repository left before it attaches another. Here the card states them
  // beside the answers, and confirming Connect is that acknowledgement.
  const footprint = repoFootprintTasks(db, input.projectSlug);
  const observations: NonNullable<OperatorOpenPacketInput["observations"]> = [];
  if (named) observations.push({ k: "Repository named", v: named, code: true });
  if (footprint > 0) {
    observations.push({
      k: "Earlier records",
      v: `${countLabel(footprint, "task")} here ${footprint === 1 ? "carries" : "carry"} branch or pull request records from a repository this project had before. They keep their history, and sync runs against the one you connect.`,
    });
  }
  const packet: OperatorOpenPacketInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    packetType: "input",
    title: `Connect a repository to ${project.parsed.frontmatter.name}?`,
    body: reason,
    options: [
      connect,
      {
        kind: "keep_without_repository",
        title: "Keep this board without one",
        detail:
          "Tasks keep coming back as files. The decision goes into the project's rulings, and the operator does not ask again.",
      },
    ],
    cause: repositoryAskCause(input.projectSlug),
    repositoryAsk: true,
  };
  if (observations.length > 0) packet.observations = observations;
  return open(packet);
}

/**
 * WITHDRAW the task's open decision packet — the operator's own cleanup for a
 * packet that has become moot (the input it asked for was provided out-of-band,
 * e.g. a human edited the goal instead of clicking an option). Same authority
 * as opening one (generate-packets). Restores `readiness` when the packet was
 * the thing that blocked it, and writes a typed timeline note so the decision
 * log shows WHY the packet disappeared. No-op when no packet is open.
 */
export async function operatorResolvePacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot manage decision packets in this project.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const packet = existing.parsed.packet;
  if (!packet) {
    return { outcome: "noop", message: "No open decision packet to resolve." };
  }
  // B2: withdraw only what the OPERATOR raised. `generate-packets` + "a packet
  // exists" was the whole check, so the operator could silently withdraw an
  // agent's `ask_human` question — the agent stays blocked on an answer that
  // now has no surface, and the R15-14 `askedBy` resume (which fires from the
  // human's resolution) never runs. `from` is stamped by the writer:
  // "operator" here, the agent's actor ref in `buildAgentQuestionPacket`.
  if (!packetIsOperators(packet)) {
    // F39-10: `noop` — WHO raised the open packet is task state, the same kind
    // of fact as "no open decision packet to resolve" one branch above, which
    // has always been a noop. `generate-packets` is granted either way.
    return {
      outcome: "noop",
      message:
        `The open packet "${packet.title}" was raised by ${packet.from}, not by you. ` +
        "Only a human can resolve an agent's question. Answer it in a comment or leave it standing.",
    };
  }
  const reason =
    (input.reason ?? "").trim() ||
    "The input it asked for has since been provided.";
  let withdrawn: ClosedDecision | null = null;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // Re-check inside the locked write — the read above raced other writers.
    // Both halves matter: the packet standing NOW must still be the operator's
    // (never an agent question that landed in the window), and it must be the
    // same packet this decision was made about (F10-09 ids).
    const current = parsed.packet;
    if (!current || !packetIsOperators(current)) return;
    if (packet.id && current.id !== packet.id) return;
    parsed.packet = null;
    const closedAt = new Date().toISOString();
    withdrawn = { packetId: current.id, closedAt };
    // A blocked packet set readiness=blocked when it opened — withdrawing the
    // packet lifts that (a genuine standing block would re-assert itself).
    if (packet.type === "blocked" && parsed.frontmatter.readiness === "blocked") {
      parsed.frontmatter.readiness = "ready";
    }
    parsed.timeline.unshift({
      occurredAt: closedAt,
      type: "transition",
      actor: { kind: "operator" },
      title: null,
      text: `**Packet withdrawn:** ${packet.title}. ${reason}`,
      toAgent: false,
      evidence: null,
    });
  });
  if (!withdrawn) {
    return {
      outcome: "noop",
      message: `The open packet on ${input.taskKey} changed before it could be withdrawn; nothing was removed.`,
    };
  }
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  followClosedDecision(db, input.projectSlug, input.taskKey, withdrawn);
  recordAudit(db, {
    action: "task.operator.packet_withdrawn",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { title: packet.title, reason },
  });
  return { outcome: "done", message: `Withdrew the packet "${packet.title}".` };
}
