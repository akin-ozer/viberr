import { OPERATOR_NOTIFY_FROM } from "~/server/tasks/task-mutation.server";
import { taskClosure } from "./task-closure.server";
import { holdRefusalFor, tasksWaitingOn } from "~/server/projections/dependencies.server";
import {
  cancelScheduledAction,
  OPERATOR_SCHEDULER_ID,
  scheduleDueMs,
  scheduleTaskAction,
} from "./schedule.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { setTaskDependencies } from "./dependencies.server";
import {
  reprojectTask,
  stageDisplayName,
  taskRef,
  terminalStageIdFor,
} from "./task-mutation.server";
import { canonicalDependencyRef, joinDependencyEntries } from "~/shared/dependencies";
import type { DatabaseSync } from "node:sqlite";
import {
  deliveringEngagement,
  type Engagement,
  type TaskFileEvent,
  type TaskPacket,
  unpushedRevisionOf,
} from "~/schemas/task-file.schema";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { escapeRegExp } from "~/shared/text/regexp";
import { indefiniteArticle } from "~/shared/text/sentence";
import { setTasksEpic } from "./epic-actions.server";
import { activeWorkRevision } from "~/schemas/task-file.schema";
import { commentOutcomeMessage, repairDoubledNewlines } from "./comment-guardrails.server";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  readProjectFile,
  resolveProjectFilePath,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { leaseHeldAgainst } from "~/server/tasks/file-leases.server";
import { matchesGlob } from "~/shared/file-leases";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import { DEFAULT_GOAL } from "./task-edits.server";
import { operatorPromptAgent } from "./agent-completion.server";
import { transitionStage } from "./task-transitions.server";
import { performDelivery } from "./task-delivery.server";
import {
  acceptanceRefusalFor,
  applyAcceptanceWrite,
  mergeReadinessRefusal,
  revisionDriftNote,
} from "./task-acceptance.server";
import { OPERATOR_TASK_ACTOR } from "./task-action-core.server";
import { OPERATOR_AUDIT_ACTOR } from "~/server/audit/audit-recorder.server";
import { notifyTaskWatchers, type TaskMutationContext } from "./task-mutation.server";
import {
  acceptanceNoChangeCheck,
  kbCorrectionsOutcome,
  noChangeApplies,
  noChangeCandidate,
  noChangeCompletionEvent,
  standingKbCorrections,
} from "./no-change-completion.server";
import { canOwnDelivery, cannotOwnDeliverySentence } from "./specialist-prompt.server";
import { isDispatchHeld, startAgentRun, type DispatchHeldError } from "./specialist-run.server";
import {
  listDeployedSpecialists,
  projectBoard,
  resolveDeployedSpecialist,
  runEligibilityFor,
  type DeployedSpecialistView,
} from "./specialist-roster.server";
import {
  acceptanceOfferBasis,
  readRequiredReviewers,
  requiredReviewerDeliversRefusal,
} from "./required-reviewers.server";
import {
  type CompletionPacketInput,
  completionPacketRefusal,
  writeCompletionPacket,
} from "./completion-packet.server";
import {
  type ClosedDecision,
  followClosedDecision,
  followEditedComment,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import { correctKnowledgeDoc, type KbCorrectionRequest } from "./kb-correction-actions.server";
import { relayToTask, takeFromTask, type TakeRequest } from "./task-relay.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { listMcpServerNames } from "~/server/org/resources.server";
import {
  deliverGate,
  dispatchGate,
  gate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-authority.server";
import {
  addRecommendation,
  opCtx,
  type RecommendationInput,
  writeOperatorComment,
} from "./operator-packets.server";

// ------------------------------------------------------------- authority

// ------------------------------------------------------------- helpers

// ------------------------------------------------- KB-vs-repository conflict

/** R19-2 — the timeline title a context conflict always carries. */
export const CONTEXT_CONFLICT_TITLE =
  "Knowledge base disagrees with the repository";

export interface ContextConflict {
  /** The knowledge-base document that disagrees. */
  kbSource: string;
  /** The repository file that is authoritative. */
  repoSource: string;
  /** One or two sentences: what each says, and what was followed. */
  detail: string;
}

/**
 * R19-2 (ruling 56) — a KB-vs-repo disagreement is a `quality` flag on the
 * timeline. The existing type carries exactly this meaning: nothing was
 * violated (`policy`) and nothing is stuck (`blocked`), but a human must see
 * that two sources of convention disagree about the same repository. It already
 * renders as "Quality flag" and is already a notification kind, so no new
 * timeline type is added — `TIMELINE_EVENT_TYPES` is untouched.
 *
 * The event states the RULING as its first words, because the record is also
 * what the next agent re-anchors on: the repository won, and here is what lost.
 */
function contextConflictEvent(
  actor: TaskFileEvent["actor"],
  conflict: ContextConflict,
): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "quality",
    actor,
    title: CONTEXT_CONFLICT_TITLE,
    text:
      `**The repository wins:** \`${conflict.repoSource}\` is authoritative; the knowledge base ` +
      `\`${conflict.kbSource}\` says otherwise. ${conflict.detail}`,
    toAgent: false,
    evidence: null,
  };
}

// ------------------------------------------ propose a knowledge-base change

/**
 * The knowledge bases a run on this task was given: the operator's own (its
 * grants and the project's rulings) and every engaged agent's. Ruling 483: the
 * operator relays a correction an agent proved, and on Codex the agent has no
 * tool to make one itself, so the operator may correct any base a run on this
 * task was handed, not only its own.
 */
function kbsGivenToTaskRuns(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  operatorKbs: readonly string[],
): string[] {
  const out = new Set(operatorKbs);
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  for (const engagement of file?.parsed.frontmatter.engagements ?? []) {
    try {
      for (const kb of resolveDeployedSpecialist(ctx, projectSlug, engagement.profileId).kb) {
        out.add(kb);
      }
    } catch {
      // An engagement whose profile is no longer deployed gave its run
      // nothing this operator can still name.
    }
  }
  return [...out];
}

/**
 * F39-1/F39-7 (pass 39, ruling 378), generalized by ruling 483 (F40-53) and
 * made a write by ruling 498: the operator CORRECTS a knowledge base, in the
 * document itself.
 *
 * Ruling 378 gave it a proposal against the project's rulings only; ruling 483
 * widened it to every knowledge base a run on the task holds (live in pass 40
 * the stale facts were in the akin-dossier and the deploy runbook, and the
 * operator answered "I'm not changing them myself"). Ruling 498 (owner,
 * 2026-09-26: "No human can approve all of these while inspecting them
 * thoroughly") writes the correction as it is made: `replaces` is the exact
 * passage, `text` what takes its place, and a person undoes it from the
 * Controller page. `kb` null keeps ruling 378's default, the project's rulings.
 * Same gate as the typed event it posts.
 */
export async function operatorCorrectKnowledgeDoc(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string } & KbCorrectionRequest,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project.",
    };
  }
  return correctKnowledgeDoc(db, ctx, {
    ...input,
    actorRef: { kind: "operator" },
    filedBy: "Operator",
    auditActor: OPERATOR_AUDIT_ACTOR,
    allowedKbs: kbsGivenToTaskRuns(ctx, input.projectSlug, input.taskKey, authority.kb),
  });
}

/**
 * Ruling 584 (owner, 2026-09-29): "operator decides if it's own comments needs
 * deleting or editing. Don't expose this to the end user, fixes the problem
 * silently with mcp and doing it itself, not asking the user."
 *
 * On AWSC-19 the Estimate Judge's report said which golden entries price no
 * load-balancer line, on a task every agent can read, and the operator told
 * Arda "A comment is not something I can remove". Ruling 582 gave a person a
 * Remove on the comment's row; the owner gave the comment to the operator.
 *
 * Only a comment the operator or an agent wrote: a person's words are theirs.
 * An edit replaces its text, keeping its author, time, title and files; a
 * delete takes the entry off the timeline. The notifications that link to it
 * follow. Nothing on the task or in anyone's inbox says so: the audit row
 * keeps the time, the author and the reason, never the words.
 */
export async function operatorEditComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    /** The comment's time, as the timeline gives it. */
    at: string;
    /** The words that replace the comment's; null or blank deletes it. */
    text: string | null;
    /** Why, for the audit row. */
    reason: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot post events in this project." };
  }
  const text = input.text?.trim() ? repairDoubledNewlines(input.text.trim()) : null;
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const commentAt = (timeline: readonly TaskFileEvent[]) =>
    timeline.findIndex((e) => e.occurredAt === input.at && e.type === "comment");
  const found = readTaskFile(ref)?.parsed.timeline.find(
    (e) => e.occurredAt === input.at && e.type === "comment",
  );
  if (!found) {
    return {
      outcome: "noop",
      message: `${input.taskKey} has no comment at ${input.at}. Nothing changed; read_timeline_entry gives each comment's time.`,
    };
  }
  if (found.actor.kind !== "agent" && found.actor.kind !== "operator") {
    return {
      outcome: "noop",
      message: `The comment at ${input.at} is a person's, so it is theirs to change. Nothing changed.`,
    };
  }
  if (text !== null && text === found.text) {
    return { outcome: "noop", message: "The comment already says that. Nothing changed." };
  }
  const author = encodeActorRef(found.actor);
  await updateTaskFile(ref, (parsed) => {
    const index = commentAt(parsed.timeline);
    const entry = parsed.timeline[index];
    // The read above raced every other writer: it is still the same comment.
    if (!entry || encodeActorRef(entry.actor) !== author) {
      throw AppError.conflict(`The comment at ${input.at} changed while it was being edited.`);
    }
    if (text === null) parsed.timeline.splice(index, 1);
    else entry.text = text;
  });
  followEditedComment(db, input.projectSlug, input.taskKey, input.at, text);
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: text === null ? "task.comment.deleted" : "task.comment.edited",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { at: input.at, author, reason: input.reason.trim() },
  });
  return {
    outcome: "done",
    message:
      text === null
        ? `Deleted the comment at ${input.at}; nothing on the task says so.`
        : `Edited the comment at ${input.at}; nothing on the task says so.`,
  };
}

/** Ruling 417: the audit action shared with the settings page's lease writer. */
const FILE_LEASES_AUDIT_ACTION = "project.file_leases.updated";

/**
 * Ruling 417 (owner, 2026-09-23): the operator leases files to ITS OWN task.
 *
 * Ruling 245 gave the project leases ("this task owns these paths until it
 * merges") and ruling 396 a human surface, but only a person on the settings
 * page, or the controller when a person asked it, could declare one. The
 * operator is the first to SEE two open PRs sharing a file (ruling 413) and
 * could do nothing about it: on ax-clone AX-20 and AX-21 collided on
 * `internal/sandbox/local.go` and it cost an agent run, a decision packet and
 * the owner's answer. The owner chose the direct door over a proposal a person
 * adopts: first come, first served, and a person clears one on the settings
 * page.
 *
 * Gated on DELIVERY authority, not a new grant: a lease orders deliveries, and
 * an operator that cannot deliver has nothing to land first. Refused by name
 * when another active task already holds an overlapping path. Every other task
 * whose open PR changes a newly leased path is told on its own timeline, since
 * its next delivery is now refused.
 */
export async function operatorLeaseFiles(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; paths: string[]; reason: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const paths = [...new Set(input.paths.map((p) => p.trim()).filter(Boolean))];
  const reason = input.reason.trim();
  if (paths.length === 0 || !reason) {
    return {
      outcome: "noop",
      message:
        "A lease needs at least one path and the reason it is held: the reason is what every task it refuses is shown. Nothing was leased.",
    };
  }
  if (deliverGate(authority) === "deny") {
    return {
      outcome: "denied",
      message:
        "This operator may not deliver on this project, so it has nothing to land first and nothing to lease files for.",
    };
  }
  const project = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!project || !task) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (taskClosure(task.parsed.frontmatter, project.parsed.frontmatter.stages).closed) {
    return {
      outcome: "noop",
      message: `${input.taskKey} is closed, and a lease held by a finished task binds nobody (ruling 245(b)). Nothing was leased.`,
    };
  }
  const leaseCtx = ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {};
  // Ruling 426: a lease that would park work other tasks wait on is a person's
  // call. Live on ax-clone AX-22's operator leased `internal/controller/task.go`
  // at 23:47, which AX-20's open PR #13 already changed; AX-20's operator then
  // made AX-20 wait on AX-22, and AX-21, AX-5 and goal-6 waited on AX-20. The
  // critical path sat behind AX-22's ninth review round, and AX-20's finished
  // rework could not even be reviewed. Neither operator could see the whole
  // chain; this check can.
  const stalled = listProjectTasks(db, input.projectSlug, { dataRoot: ctx.dataRoot }).flatMap((t) => {
    if (t.key === input.taskKey || !t.pr || t.pr.state !== "review") return [];
    const hit = (t.pr.paths?.changed ?? []).find((path) => paths.some((glob) => matchesGlob(path, glob)));
    if (!hit) return [];
    const waiting = tasksWaitingOn(db, input.projectSlug, t.key);
    return waiting.length > 0 ? [{ key: t.key, pr: t.pr.number, path: hit, waiting }] : [];
  });
  const first = stalled[0];
  if (first) {
    const others = first.waiting.filter((k) => k !== input.taskKey);
    // The leaser waiting on the task it would park is a cycle: each would
    // wait for the other to merge, and neither ever could.
    if (others.length < first.waiting.length) {
      return {
        outcome: "noop",
        message:
          `\`${first.path}\` is changed by ${first.key}'s open PR #${first.pr}, and ${input.taskKey} ` +
          `itself waits on ${first.key}: leasing it to ${input.taskKey} would make each wait for the ` +
          `other to merge. Keep ${input.taskKey}'s work off those paths, or drop the wait if it is ` +
          `wrong (ruling 426). Nothing was leased.`,
      };
    }
    return {
      outcome: "noop",
      message:
        `\`${first.path}\` is changed by ${first.key}'s open PR #${first.pr}, and ` +
        `${joinDependencyEntries(others)} ${others.length === 1 ? "waits" : "wait"} on ${first.key}: ` +
        `leasing it to ${input.taskKey} would hold all of them behind ${input.taskKey}. ` +
        `Which of the two lands first is a person's call (ruling 426). Open a decision packet ` +
        `that names both tasks and what waits on each, keep ${input.taskKey}'s work off those ` +
        `paths, or wait for ${first.key} to merge (set_dependencies). Nothing was leased.`,
    };
  }
  let refusal: string | null = null;
  let fresh: string[] = [];
  // Checked INSIDE the project file's lock, so two operators leasing at once
  // cannot both win the same path.
  await updateProjectFile(
    { projectSlug: input.projectSlug, dataRoot: ctx.dataRoot },
    (parsed) => {
      const leases = parsed.frontmatter.fileLeases ?? [];
      const mine = new Set(
        leases.filter((l) => l.taskKey === input.taskKey).flatMap((l) => l.paths),
      );
      fresh = paths.filter((p) => !mine.has(p));
      if (fresh.length === 0) return;
      const held = leaseHeldAgainst(input.projectSlug, leases, input.taskKey, fresh, leaseCtx);
      if (held) {
        refusal =
          `\`${held.glob}\` is already held by ${held.taskKey} (${held.reason || "no reason given"}), ` +
          `and it overlaps what ${input.taskKey} asked for. First come, first served: the lease stays with ` +
          `${held.taskKey}. Keep ${input.taskKey}'s work off those paths, wait for ${held.taskKey} to merge ` +
          "(set_dependencies), or open a decision packet if a person should move the lease.";
        return;
      }
      parsed.frontmatter.fileLeases = [...leases, { paths: fresh, taskKey: input.taskKey, reason }];
    },
  );
  if (refusal) return { outcome: "noop", message: refusal };
  if (fresh.length === 0) {
    return {
      outcome: "noop",
      message: `${input.taskKey} already holds ${paths.map((p) => `\`${p}\``).join(", ")}. Nothing changed.`,
    };
  }
  rebuildPath(
    db,
    resolveProjectFilePath({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot }),
    { dataRoot: ctx.dataRoot },
  );
  const list = fresh.map((p) => `\`${p}\``).join(", ");
  const at = new Date().toISOString();
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: at,
      type: "note",
      actor: { kind: "operator" },
      title: "Files leased",
      text:
        `**The operator leased ${list} to ${input.taskKey} until it merges:** ${reason} ` +
        "Any other task whose delivery changes these paths is refused before it reaches GitHub. " +
        "A person can clear the lease on the project's settings page.",
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: FILE_LEASES_AUDIT_ACTION,
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { leased: fresh.join(", "), holder: input.taskKey, by: "operator" },
  });
  // Every other task whose OPEN PR changes a newly leased path: its next
  // delivery is refused from now on, and it hears that now rather than at the
  // refused push.
  const affected = listProjectTasks(db, input.projectSlug, { dataRoot: ctx.dataRoot }).flatMap((t) => {
    if (t.key === input.taskKey || !t.pr || t.pr.state !== "review") return [];
    const hit = (t.pr.paths?.changed ?? []).find((path) => fresh.some((glob) => matchesGlob(path, glob)));
    return hit ? [{ key: t.key, pr: t.pr.number, path: hit }] : [];
  });
  for (const other of affected) {
    const text =
      `**${input.taskKey} now holds ${list}** (leased by its operator: ${reason}). ` +
      `PR #${other.pr} changes \`${other.path}\`, so ${other.key}'s next delivery is refused until ` +
      `${input.taskKey} merges. Drop that change, wait for ${input.taskKey}, or ask a person to clear ` +
      "the lease on the project's settings page.";
    await updateTaskFile(taskRef(ctx, input.projectSlug, other.key), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: at,
        type: "policy",
        actor: { kind: "operator" },
        title: "Files leased by another task",
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, other.key);
    notifyTaskWatchers(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: other.key,
        kind: "policy",
        title: "Files leased by another task",
        text,
        occurredAt: at,
        about: { event: at },
        from: OPERATOR_NOTIFY_FROM,
      },
      ctx,
    );
  }
  return {
    outcome: "done",
    message:
      `Leased ${list} to ${input.taskKey} until it merges.` +
      (affected.length > 0
        ? ` ${affected.map((a) => `${a.key} (PR #${a.pr})`).join(", ")} changes one of them and was told its next delivery is refused.`
        : ""),
  };
}

// ------------------------------------------------------------- snapshot

// ------------------------------------------------------------- actions

/** Post an operator comment (governed by append-typed-events). */
export async function operatorPostComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; text: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const text = input.text.trim();
  if (!text) return { outcome: "noop", message: "Empty comment ignored." };
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot post events in this project." };
  }
  const result = await writeOperatorComment(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    text,
    "comment",
  );
  // G1/B-FD8: report the REAL outcome. A guardrail drop returns `noop` (a
  // task-state refusal, not an authority one) so the Codex plan executor's
  // `record()` — which captures denied/noop — narrates it instead of the run
  // settling to `waiting:human` with no trace; the SDK path gets the honest
  // message so the model can rephrase rather than build on narration nobody saw.
  if (result.dropped) {
    return { outcome: "noop", message: commentOutcomeMessage(result) };
  }
  return { outcome: "done", message: commentOutcomeMessage(result) };
}

/**
 * Ruling 488 (F40-67): post on ANOTHER task of this project, as the operator.
 * Gated like `post_comment` (`append-typed-events`): it is a comment, on the
 * task a goal told this one to write to. The door refuses what a relay may
 * not reach, writes the source task's line and wakes the target's operator
 * (`relayToTask`).
 */
export async function operatorRelayToTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    toTaskKey: string;
    text: string;
    /** Ruling 538: this task's attachments to put on the other task. */
    files?: readonly string[];
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project, so it cannot relay to another task.",
    };
  }
  return relayToTask(db, ctx, {
    projectSlug: input.projectSlug,
    fromTaskKey: input.taskKey,
    toTaskKey: input.toTaskKey,
    text: input.text,
    files: input.files ?? [],
    author: {
      actorRef: { kind: "operator" },
      name: "operator",
      auditActor: OPERATOR_AUDIT_ACTOR,
      notifyFrom: OPERATOR_NOTIFY_FROM,
    },
  });
}

/** Ruling 557: take named attachments of another task onto this one. The
 *  relay's grant: it is the relay's claim comment, written on this task. */
export async function operatorTakeFromTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    fromTaskKey: string;
    files: readonly string[];
    text?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project, so it cannot take files from another task.",
    };
  }
  const request: TakeRequest = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    fromTaskKey: input.fromTaskKey,
    files: input.files,
    author: {
      actorRef: { kind: "operator" },
      name: "operator",
      auditActor: OPERATOR_AUDIT_ACTOR,
      notifyFrom: OPERATOR_NOTIFY_FROM,
    },
  };
  if (input.text) request.text = input.text;
  return takeFromTask(db, ctx, request);
}

/**
 * R19-2 — record a KB-vs-repository conflict as a typed `quality` event.
 *
 * The ruling has two halves and this is the second: the repository wins, AND
 * the disagreement is never settled quietly. Live (Q19-2) a KB-granted Codex
 * developer followed the knowledge base's pass-note format while a KB-less
 * Claude writer followed `qa/smoke/README.md` and flagged the KB-shaped files
 * as non-conforming — two agents, one repo, two house styles, and nothing on
 * the timeline said why. A precedence rule with no visible record just moves
 * the silence.
 *
 * Gated on `append-typed-events` — this writes to the canonical record, so it
 * answers to the same capability as every other operator-authored event.
 */
export async function operatorFlagContextConflict(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string } & ContextConflict,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const kbSource = input.kbSource.trim();
  const repoSource = input.repoSource.trim();
  const detail = input.detail.trim();
  if (!kbSource || !repoSource) {
    return {
      outcome: "noop",
      message:
        "A conflict needs BOTH sources named: the knowledge-base document and the repository file it disagrees with.",
    };
  }
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project.",
    };
  }
  const event = contextConflictEvent(
    { kind: "operator" },
    { kbSource, repoSource, detail },
  );
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.context_conflict",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kbSource, repoSource },
  });
  // A convention conflict is a judgement call a human owns; the flag is worth
  // nothing if it only exists on a page nobody opens.
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "quality",
      title: CONTEXT_CONFLICT_TITLE,
      text: event.text,
      occurredAt: event.occurredAt,
      about: { event: event.occurredAt },
      // Ruling 361: the operator flagged the conflict (the event's own actor).
      from: OPERATOR_NOTIFY_FROM,
    },
    ctx,
  );
  return {
    outcome: "done",
    message: `Recorded: \`${repoSource}\` wins; a human will settle it.`,
  };
}

/**
 * Ruling 131(b) (pass 34): the operator records what a task WAITS ON with a
 * tool of its own instead of a hold packet (JC-9's "standing token"). Gated
 * like packets (`generate-packets`: the wait is the packet's replacement, so
 * it reuses the packet's own grant rather than minting a catalog id for one
 * tool). A validator refusal is a `noop` carrying the validator's own
 * sentence: the task's state ruled it out, not the project's policy (the
 * LV-03 misblame rule); an unchanged list is a `noop`; success is `done`.
 */
export async function operatorSetDependencies(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; blockedBy: readonly string[]; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot record what a task waits on in this project (the generate-packets grant is withheld).",
    };
  }
  try {
    const result = await setTaskDependencies(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, blockedBy: input.blockedBy },
      OPERATOR_TASK_ACTOR,
      { ...ctx, operatorAuthorized: true },
    );
    const list = result.blockedBy.join(", ");
    if (!result.changed) {
      return {
        outcome: "noop",
        message: list
          ? `Unchanged: ${input.taskKey} already waits on ${list}.`
          : `Unchanged: ${input.taskKey} waits on nothing.`,
      };
    }
    const why = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";
    return {
      outcome: "done",
      message: !list
        ? `Recorded: ${input.taskKey} no longer waits on other work.${why}`
        : result.satisfied
          ? `Recorded: ${input.taskKey} waits on ${list}. Every entry is done, so Viberr releases it within a minute and hands the task back to you.${why}`
          : `Recorded: ${input.taskKey} waits on ${list}. Viberr holds it and releases it when every entry is done.${why}`,
    };
  } catch (error) {
    // The validator's refusal names the reference and the reason: a fact about
    // the store, never a policy block.
    if (error instanceof AppError && error.status === 400) {
      return { outcome: "noop", message: error.userMessage };
    }
    throw error;
  }
}

/**
 * Ruling 503: the operator puts ITS OWN task in an epic, moves it to another,
 * or takes it out, through the one writer of a task's `epic`
 * (`setTasksEpic`), so the task's note, the epic's history line, the audit
 * row and the lead's notice read as they do when a person does it. It rides
 * `append-typed-events`, the grant of its other planning edit on the task
 * (`set_goal`). A refusal the store rules out (no such epic, an archived
 * task) is a `noop` carrying its sentence, never a policy block.
 */
export async function operatorSetEpic(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; epicId: string | null; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot change which epic a task is in on this project (the append-typed-events grant is withheld).",
    };
  }
  try {
    const result = await setTasksEpic(
      db,
      { projectSlug: input.projectSlug, taskKeys: [input.taskKey], epicId: input.epicId },
      OPERATOR_TASK_ACTOR,
      { ...ctx, operatorAuthorized: true },
    );
    if (result.changed.length === 0) return { outcome: "noop", message: `Unchanged: ${result.message}` };
    const why = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";
    return { outcome: "done", message: `Recorded: ${result.message}${why}` };
  } catch (error) {
    if (error instanceof AppError && (error.status === 400 || error.status === 404)) {
      return { outcome: "noop", message: error.userMessage };
    }
    throw error;
  }
}

/** Fill only an unspecified goal; established scope remains human-controlled. */
export async function operatorSetGoal(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; goal: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot draft the goal in this project." };
  }
  const goal = input.goal.trim();
  if (goal.length < 3) {
    return { outcome: "noop", message: "A goal of at least 3 characters is required." };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const current = existing.parsed.goal.trim();
  if (current !== "" && current !== DEFAULT_GOAL) {
    return {
      outcome: "noop",
      message:
        "The goal is already specified. Open an edit_goal packet to propose a change instead of overwriting it.",
    };
  }
  if (current === goal) {
    return { outcome: "noop", message: "Goal unchanged." };
  }
  /** Ruling 547: the awaiting packet the drafted goal fulfils; the note below
   *  is its record. */
  let clearedPacket: ClosedDecision | null = null;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.goal = goal;
    const draftedAt = new Date().toISOString();
    // Fulfil an awaiting goal-edit packet (the operator drafted the scope the
    // human asked it to) — clear it + lift its readiness gate, exactly like
    // updateTaskGoal does for a human edit.
    if (parsed.packet?.awaiting === "goal_edit") {
      const wasBlocked = parsed.packet.type === "blocked";
      clearedPacket = { packetId: parsed.packet.id, closedAt: draftedAt };
      parsed.packet = null;
      if (wasBlocked && parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
    }
    parsed.timeline.unshift({
      occurredAt: draftedAt,
      // A drafted goal is a neutral lifecycle note, not a policy violation
      // (P13-LV-03 — this rendered as a coral "Policy violation" shield).
      type: "note",
      actor: { kind: "operator" },
      title: "Goal drafted",
      text: input.reason?.trim()
        ? `The operator drafted the task goal: ${input.reason.trim()}. Downstream agents re-anchor on the new goal.`
        : "The operator drafted the task goal from the request. Downstream agents re-anchor on the new goal.",
      toAgent: false,
      evidence: null,
    });
  });
  if (clearedPacket) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
    followClosedDecision(db, input.projectSlug, input.taskKey, clearedPacket);
  }
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.goal.updated",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { by: "operator" },
  });
  return { outcome: "done", message: "Task goal drafted." };
}

/**
 * F21-6 — what a NON-delivering engagement is called.
 *
 * The schema already distinguishes the two (`!delivers && verdictCapable` makes
 * a required reviewer; everything else is supporting — task-file.schema), and
 * the execution profile renders them under "SUPPORTING AGENTS". This copy did
 * not: every non-delivering engagement was announced "as a reviewer". Live, the
 * Web Verifier profile (verdict = Off, so its report gates nothing) was engaged
 * "as a reviewer" and then displayed as supporting — two names for one thing,
 * and the misleading one implies acceptance-gating authority it does not hold.
 *
 * An UNKNOWN profile (not deployed) reads as supporting: the weaker claim is the
 * honest one when the grant cannot be resolved.
 */
function supportingRoleWord(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): "a reviewer" | "a supporting agent" {
  return deployedAgent(ctx, projectSlug, profileId)?.capabilities.verdict
    ? "a reviewer"
    : "a supporting agent";
}

// --------------------------------------------------- dispatch helpers

/** Org MCP names compared loosely: `qa_echo`, `qa-echo` and `QA-Echo` are
 *  one server (the tool prefix a model sees is `mcp__<name>__…`). */
function mcpNameKey(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * F32-8 (pass 32): a directive that names an org MCP server the target profile
 * does NOT hold gets a server-attributed note appended — on the hand-off
 * comment AND the run's directive. Live (VIB-1, VIB-2) the operator's reviewer
 * brief said "re-call qa_echo yourself" to a Reviewer with no MCP grant (KBs are
 * inherited from the deliverer, R18-1; MCPs are not), and the reviewer burned
 * 20-30 turns per task hunting the tool. The snapshot the operator plans from
 * already carries `deployedSpecialists[].resources`; this makes the mismatch
 * impossible to hand off silently. Names are matched as whole words against
 * the instance registry, so ordinary prose never trips it.
 */
function annotateUngrantedMcps(
  db: DatabaseSync,
  agent: DeployedSpecialistView,
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return prompt;
  const held = new Set(agent.resources.mcps.map(mcpNameKey));
  const text = mcpNameKey(prompt);
  const ungranted = listMcpServerNames(db).filter((name) => {
    const key = mcpNameKey(name);
    if (held.has(key)) return false;
    return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(key)}([^a-z0-9-]|$)`).test(text);
  });
  if (ungranted.length === 0) return prompt;
  return (
    `${prompt}\n\n(Note from Viberr: ${agent.name} holds no MCP grant for ` +
    `${ungranted.map((n) => `\`${n}\``).join(", ")} on this project, so those ` +
    `tools will not be available to it; any evidence from them is already on ` +
    `the task timeline. Do not hunt for them.)`
  );
}

function deployedAgent(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): DeployedSpecialistView | null {
  return (
    listDeployedSpecialists(projectSlug, ctx).find((s) => s.id === profileId) ??
    null
  );
}

/**
 * Best-effort task-key branch creation on GitHub when a specialist is about to
 * work. Isolated + swallowing so a GitHub failure (or unconfigured repo) can
 * never fail the operator's coordination — ensureTaskBranch already returns
 * typed results and writes the branch name into task.md on success.
 */
async function ensureTaskBranchBestEffort(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  const { ensureTaskBranchBestEffort: shared } = await import(
    "~/server/github/branch-sync.server"
  );
  await shared(db, { projectSlug, taskKey }, OPERATOR_AUDIT_ACTOR, {
    dataRoot: ctx.dataRoot,
  });
}

// ------------------------------------------------- generic agent dispatch

/** One agent-selection decision, as the trace records it. */
interface AgentSelection {
  projectSlug: string;
  taskKey: string;
  profileId: string;
  delivers: boolean;
  /** The operator's stated reason, when it gave one. */
  reason?: string;
}

/** Best-effort audit trace for every operator profile selection. */
function recordAgentSelectionTrace(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: AgentSelection,
): void {
  try {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const stage = file?.parsed.frontmatter.stage;
    const engagements = file?.parsed.frontmatter.engagements ?? [];
    const engaged = new Set(engagements.map((e) => e.profileId));
    const board = projectBoard(ctx, input.projectSlug);
    const candidates = listDeployedSpecialists(input.projectSlug, ctx).map(
      (s) => ({
        profileId: s.id,
        // Ruling 133: may it RUN here (declared, or the engaged deliverer).
        eligibleForStage: stage
          ? runEligibilityFor(s, engagements, s.id, stage, board).ok
          : false,
        alreadyEngaged: engaged.has(s.id),
        // The posture the dispatch will TAKE: for the chosen profile the
        // resolved delivers intent (auto-engage included, so a first
        // dispatch reads `true` while `alreadyEngaged` is false); for every
        // other candidate its current engagement's posture.
        deliveringAtSelection:
          s.id === input.profileId
            ? input.delivers
            : engagements.some((e) => e.profileId === s.id && e.delivers),
        chosen: s.id === input.profileId,
      }),
    );
    recordAudit(db, {
      action: "task.operator.agent_selected",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        chosen: input.profileId,
        delivers: input.delivers,
        reason: input.reason ?? null,
        candidates,
      },
    });
  } catch {
    // Tracing must never block a routing decision.
  }
}

/**
 * The dynamic-dispatch rule this module and `startAgentRun`'s auto-engage
 * agree on (the trace below must record what the dispatch will actually do):
 * explicit hint wins; an engaged profile keeps its shape; an unengaged profile
 * delivers iff the task has no deliverer yet AND the profile holds a
 * repo-write grant — a verdict-only reviewer dispatched first on a fresh task
 * engages as supporting, never as a deliverer that can ship nothing.
 */
function resolveDeliversIntent(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  agent: DeployedSpecialistView,
  hint: boolean | undefined,
): boolean {
  if (hint !== undefined) return hint;
  const file = readTaskFile({
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  });
  const fm = file?.parsed.frontmatter;
  if (!fm) return false;
  const delivering = deliveringEngagement(fm);
  if (delivering?.profileId === agent.id) return true;
  if (fm.engagements.some((e) => e.profileId === agent.id)) return false;
  // Ruling 556: a reviewer the project requires is run to review, never
  // handed delivery by default, whatever its grants.
  if (readRequiredReviewers(projectSlug, ctx).some((rule) => rule.profileId === agent.id)) return false;
  return delivering === null && agent.capabilities.delivery;
}

/**
 * Dynamic-dispatch rework (2026-08-29): the ONE operator action for putting an
 * agent to work — the collapsed replacement for engage_agent / run_agent /
 * prompt_agent and the specialist/reviewer function pairs behind them. Gated by
 * `dispatch-agents` (the collapsed assign/summon pair):
 *
 *   direct    → engage-if-needed (capability-derived posture, inside
 *               `startAgentRun`), post the prompt as an operator comment when
 *               one is given, and start the run with it as the directive. A
 *               bare dispatch (no prompt) starts the run with no synthetic
 *               comment — the agent re-anchors on task.md.
 *   recommend → ONE `run_agent` card carrying the profile + prompt, which a
 *               human applies (the applied dispatch then runs exactly this).
 *   deny      → refused out loud (R19-6).
 */
export async function operatorDispatchAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    /** The run's directive; absent → a bare re-run with no hand-off comment. */
    prompt?: string;
    /** Explicit posture — `true` is a delivery hand-off (reassigns the
     *  delivering engagement); absent → derived (see resolveDeliversIntent). */
    delivers?: boolean;
    /** The operator's stated reason, when it gave one. */
    reason?: string;
    /** Ruling 421: this run puts ruling 410's completeness question, so the
     *  verdict it returns is recorded as the reviewer's complete set. */
    completeness?: boolean;
    /** Ruling 583: this run must not judge, so its verdict tool is withheld
     *  and nothing it writes is read as a verdict. */
    noVerdict?: boolean;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = dispatchGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Dispatching agents is not permitted for the operator here.",
    };
  }
  const agent = deployedAgent(ctx, input.projectSlug, input.profileId);
  if (!agent) {
    return {
      outcome: "noop",
      message: `No deployed agent "${input.profileId}" to run. Pick a profile from get_task's deployedSpecialists.`,
    };
  }
  const prompt = annotateUngrantedMcps(db, agent, input.prompt?.trim() || undefined);
  // Hunt 2026-08-29: refuse the two CONTRADICTORY hints up front, before any
  // card or trace can announce a posture the dispatch would not install.
  // (1) `delivers: true` for a profile with no repo-write grant — the dispatch
  // refuses it at both engage doors; filing a card for it would strand a
  // maintainer's Apply on that refusal.
  // Ruling 535: an agent that can post files on the task can own a results
  // task's delivery without a repo-write grant.
  if (input.delivers === true && !canOwnDelivery(agent, input.delivers)) {
    return { outcome: "noop", message: cannotOwnDeliverySentence(agent.name) };
  }
  // (2) `delivers: false` aimed at the CURRENT deliverer — dispatchAgentRun
  // deliberately keeps an engaged profile's shape (a delivering run cannot be
  // demoted per-dispatch), so honoring the hint in the label/trace while the
  // run went out `kind: "primary"` was a governed lie.
  const currentDeliverer = ((): string | null => {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    return file
      ? (deliveringEngagement(file.parsed.frontmatter)?.profileId ?? null)
      : null;
  })();
  if (input.delivers === false && currentDeliverer === input.profileId) {
    return {
      outcome: "noop",
      message:
        `${agent.name} IS the delivering agent on this task; its runs deliver. ` +
        `Omit \`delivers\` to run it, or hand delivery to another repo-write ` +
        `profile first (\`delivers: true\` on that profile).`,
    };
  }
  const delivers = resolveDeliversIntent(
    ctx,
    input.projectSlug,
    input.taskKey,
    agent,
    input.delivers,
  );
  // Ruling 556: nor to a reviewer the project requires. The engage refuses it
  // (`assignSpecialist`), and a card for it would strand Apply on that refusal.
  if (delivers && currentDeliverer !== input.profileId) {
    const reviews = readRequiredReviewers(input.projectSlug, ctx).filter(
      (rule) => rule.profileId === input.profileId,
    );
    if (reviews.length > 0) {
      return {
        outcome: "noop",
        message: requiredReviewerDeliversRefusal(agent.name, input.taskKey, reviews),
      };
    }
  }
  const as = delivers
    ? "the delivering agent"
    : supportingRoleWord(ctx, input.projectSlug, input.profileId);

  if (g === "recommend") {
    const rec: Parameters<typeof addRecommendation>[4] = {
      kind: "run_agent",
      profileId: input.profileId,
      label: `Run ${agent.name}`,
    };
    if (prompt) rec.prompt = prompt;
    // Persist the EXPLICIT hint so Apply dispatches what this arm announced —
    // the card used to drop it and Apply re-derived, sometimes the opposite.
    if (input.delivers !== undefined) rec.delivers = input.delivers;
    if (input.completeness) rec.completeness = true;
    if (input.noVerdict) rec.noVerdict = true;
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      rec,
      input.reason ??
        prompt ??
        `${agent.name} fits what the current stage needs; a maintainer starts the run.`,
    );
    return {
      outcome: "recommended",
      message: `Recommended running ${agent.name} as ${as}.`,
    };
  }

  // direct
  const selection: AgentSelection = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    delivers,
  };
  if (input.reason) selection.reason = input.reason;
  recordAgentSelectionTrace(db, ctx, selection);
  if (delivers) {
    // Delivery spine (FR31): the agent is about to own the branch — ensure the
    // task-key branch exists on GitHub. Best-effort, degrades cleanly.
    await ensureTaskBranchBestEffort(db, ctx, input.projectSlug, input.taskKey);
  }
  // Ruling 152(c) (pass 35, G35-4): a HOLD is the task's state ruling the
  // dispatch out for now, which is exactly what `noop` means — never a
  // failure. The plan says so and the Codex operator makes it load-bearing:
  // its plan executor ABORTS every remaining action on a thrown one and writes
  // "Coordination stopped" on the timeline, so a held `run_agent` step cost the
  // rest of a paid turn (the transitions, comments and packets after it) for a
  // hold whose own note says nothing was dispatched and no decision is needed.
  // The retry is already on the task's schedule, so the message ends the
  // subject rather than inviting a packet.
  const heldNoop = (error: DispatchHeldError): OperatorActionResult => {
    // Ruling 207(h): the hold is scoped to (backend, TASK OWNER) — every run on
    // this task bills that one person (ruling 127) — so "pick a <other>
    // profile" only helps when the OWNER has the other backend connected. When
    // they do not, the operator follows the advice, the dispatch is refused on
    // the owner's credential, and the failure opens the very packet this
    // sentence forbade. So the alternative is offered only when it exists.
    const otherBackend: RealBackend = error.hold.backend === "codex" ? "claude" : "codex";
    const other = BACKEND_LABEL[otherBackend];
    const ownerId =
      readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter
        .ownerUserId ?? null;
    const fallbackReachable =
      ownerId !== null && isBackendAvailableFor(db, ownerId, otherBackend);
    return {
      outcome: "noop",
      message:
        `${error.userMessage} Do not open a packet for this; ` +
        (fallbackReachable
          ? `pick a ${other} profile if the work cannot wait.`
          : `there is no ${other} fallback either. This task's runs bill its owner, ` +
            `who has no ${other} account connected. The retry is already scheduled.`),
    };
  };
  if (prompt) {
    const promptInput: Parameters<typeof operatorPromptAgent>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: input.profileId,
      handle: agent.name,
      directive: prompt,
    };
    // Thread only the EXPLICIT hint: the auto-engage derives the posture with
    // the same rule as the trace above, and an explicit `true` is what asks
    // assignSpecialist for a delivery hand-off.
    if (input.delivers !== undefined) promptInput.delivers = input.delivers;
    if (input.completeness) promptInput.completeness = true;
    if (input.noVerdict) promptInput.noVerdict = true;
    let prompted: Awaited<ReturnType<typeof operatorPromptAgent>>;
    try {
      prompted = await operatorPromptAgent(db, promptInput, ctx);
    } catch (error) {
      if (isDispatchHeld(error)) return heldNoop(error);
      throw error;
    }
    // Ruling 263 (F37-93): "and started its run" was said for a run that was
    // refused before any process existed, and for one parked behind the cap.
    // The operator plans its next move on this sentence.
    if (prompted.outcome === "refused") {
      return {
        outcome: "noop",
        message:
          `The prompt is on the timeline for @${agent.name} (${as}), but no run started: ` +
          `${prompted.refusal ?? "the run was refused before any process started."} ` +
          `Re-send it once that is resolved.`,
      };
    }
    if (prompted.outcome === "queued") {
      return {
        outcome: "done",
        message:
          `Prompted @${agent.name} (${as}). The instance is at its concurrent-run cap, ` +
          `so the run is queued and starts when a slot frees.`,
      };
    }
    return {
      outcome: "done",
      message: `Prompted @${agent.name} (${as}) and started its run.`,
    };
  }
  const dispatch: Parameters<typeof startAgentRun>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
  };
  if (input.delivers !== undefined) dispatch.delivers = input.delivers;
  if (input.completeness) dispatch.completeness = true;
  if (input.noVerdict) dispatch.withholdVerdict = true;
  let result: Awaited<ReturnType<typeof startAgentRun>>;
  try {
    result = await startAgentRun(db, dispatch, OPERATOR_TASK_ACTOR, opCtx(ctx));
  } catch (error) {
    if (isDispatchHeld(error)) return heldNoop(error);
    throw error;
  }
  if (result.outcome === "refused") {
    return {
      outcome: "noop",
      message:
        `No run started for ${agent.name} (${as}): ` +
        `${result.refusal ?? "the run was refused before any process started."} ` +
        `Try again once that is resolved.`,
    };
  }
  if (result.outcome === "queued") {
    return {
      outcome: "done",
      message:
        `${agent.name}'s (${as}) run is queued: the instance is at its concurrent-run cap, ` +
        `so it starts when a slot frees.`,
    };
  }
  return {
    outcome: "done",
    message: `Started a ${BACKEND_LABEL[result.backend]} run for ${agent.name} (${as}).`,
  };
}

// ------------------------------------------------- scheduled runs (487)

/** Ruling 487: the refusal both schedule verbs give an operator whose
 *  `dispatch-agents` grant is not `direct`, or null when it is. */
function scheduleGrantRefusal(authority: OperatorAuthority): OperatorActionResult | null {
  const g = dispatchGate(authority);
  if (g === "direct") return null;
  return {
    outcome: "denied",
    message:
      g === "recommend"
        ? "Scheduling a run needs a `direct` `dispatch-agents` grant: a scheduled run starts with " +
          "nobody present, and yours has a person start every run you propose. Recommend the run " +
          "with `run_agent` when it is due."
        : "Dispatching agents is not permitted for the operator here, so scheduling a run is not either.",
  };
}

/**
 * Ruling 487: why this agent could not be dispatched on the task NOW, or null.
 * The same gates its immediate `run_agent` meets at the dispatcher: a
 * dependency hold (ruling 186) and the stage the task stands at (ruling 133:
 * the engaged deliverer runs at every stage, anyone else at the stages it
 * declares). A schedule is that dispatch with a date on it, so it may not
 * reach what the dispatch could not.
 */
function dispatchRefusalNow(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  agent: DeployedSpecialistView,
): string | null {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const fm = file.parsed.frontmatter;
  if (fm.blockedBy.length > 0) {
    return holdRefusalFor(db, projectSlug, taskKey, fm.blockedBy, "scheduling an agent run on it");
  }
  const eligibility = runEligibilityFor(
    agent,
    fm.engagements,
    agent.id,
    fm.stage,
    projectBoard(ctx, projectSlug),
  );
  return eligibility.ok ? null : eligibility.refusal;
}

/**
 * Ruling 487 (F40-65): the operator schedules a future run on its OWN task:
 * its own re-run, or a deployed agent's run with a directive, 1 minute to 28
 * days out. It is the controller's `schedule_task_action` (ruling 153) at the
 * operator's door: the same `schedules[]` entry, the same firing path (the
 * profile deployed when it fires), the same `task.schedule.created` row and
 * "Scheduled:" line, attributed to the operator.
 *
 * Live on WEB-9 the task had to read a deployed cron run at 12:17Z. The
 * operator could not set that run itself, so it asked the owner to route one
 * through the controller and then opened a packet only to record the wait.
 * Scheduling adds no authority: it is the dispatch the operator already holds,
 * gated the same way (`scheduleGrantRefusal`, `dispatchRefusalNow`).
 */
export async function operatorScheduleRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    /** "operator" for its own re-run, or a deployed profile id. */
    agent: string;
    delayMinutes?: number;
    /** An ISO instant. Give this or `delayMinutes`. */
    dueAt?: string;
    /** The steer for its own re-run, or the agent's directive. */
    prompt?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const refused = scheduleGrantRefusal(authority);
  if (refused) return refused;
  const nowMs = Date.now();
  let dueMs: number;
  try {
    dueMs = scheduleDueMs(input, nowMs);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // The model has no clock of its own: the refusal says what "now" is.
    return {
      outcome: "noop",
      message: `${error.userMessage} It is ${new Date(nowMs).toISOString()} now.`,
    };
  }
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length > 4000) {
    return { outcome: "noop", message: "Keep the run prompt under 4000 characters." };
  }
  const target = input.agent.trim();
  const schedInput: Parameters<typeof scheduleTaskAction>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dueAt: new Date(dueMs).toISOString(),
    prompt,
  };
  let what = "your own re-run";
  if (target.toLowerCase() !== "operator") {
    const agent = deployedAgent(ctx, input.projectSlug, target);
    if (!agent) {
      return {
        outcome: "noop",
        message:
          `No deployed agent "${target}" to schedule. Pick a profile from get_task's ` +
          `deployedSpecialists, or "operator" for your own re-run.`,
      };
    }
    const notNow = dispatchRefusalNow(db, ctx, input.projectSlug, input.taskKey, agent);
    if (notNow) {
      return {
        outcome: "noop",
        message: `${agent.name}'s run cannot be scheduled, because it could not be dispatched now: ${notNow}`,
      };
    }
    schedInput.action = "run-agent";
    schedInput.profileId = agent.id;
    what = `${indefiniteArticle(agent.name)} ${agent.name} run`;
  }
  let scheduled: Awaited<ReturnType<typeof scheduleTaskAction>>;
  try {
    scheduled = await scheduleTaskAction(db, schedInput, OPERATOR_AUDIT_ACTOR, opCtx(ctx));
  } catch (error) {
    // A closed task refuses with the closure sentence (ruling 177): the
    // task's state, not the policy.
    if (error instanceof AppError && error.status === 400) {
      return { outcome: "noop", message: error.userMessage };
    }
    throw error;
  }
  const minutes = Math.round((Date.parse(scheduled.dueAt) - nowMs) / 60_000);
  return {
    outcome: "done",
    message:
      `Scheduled ${what} on ${input.taskKey} for ${scheduled.dueAt}, in ${minutes} minutes ` +
      `(${scheduled.id}). It runs on the profile deployed when it fires, and get_task lists it ` +
      "under `schedules`. A hold it explains needs no decision packet: one note naming it is the record.",
  };
}

/**
 * Ruling 487: cancel a pending run the operator scheduled on its OWN task. The
 * task is the one this toolkit is bound to, so another task's entry is simply
 * not there; a person's entry (the task page, the controller) is theirs to
 * cancel, never the operator's.
 */
export async function operatorCancelSchedule(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; scheduleId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const refused = scheduleGrantRefusal(authority);
  if (refused) return refused;
  const scheduleId = input.scheduleId.trim();
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const schedules = file.parsed.frontmatter.schedules;
  const entry = schedules.find((s) => s.id === scheduleId && s.status === "pending");
  if (!entry) {
    const pending = schedules.filter((s) => s.status === "pending").map((s) => s.id);
    return {
      outcome: "noop",
      message:
        `${scheduleId} is not a pending schedule on ${input.taskKey}. ` +
        (pending.length > 0 ? `Pending here: ${pending.join(", ")}.` : "Nothing is scheduled on it."),
    };
  }
  if (entry.createdBy !== OPERATOR_SCHEDULER_ID) {
    return {
      outcome: "denied",
      message:
        `${scheduleId} was scheduled by ${entry.createdByLabel || "a person"}, so it is theirs to ` +
        "cancel, not yours. If it no longer fits the task, say so in a comment.",
    };
  }
  const result = await cancelScheduledAction(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey, scheduleId },
    OPERATOR_AUDIT_ACTOR,
    opCtx(ctx),
  );
  return result.cancelled
    ? { outcome: "done", message: `Cancelled ${scheduleId} on ${input.taskKey}.` }
    : { outcome: "noop", message: `${scheduleId} is not pending on ${input.taskKey}.` };
}

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
