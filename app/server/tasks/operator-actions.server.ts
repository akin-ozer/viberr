import { OPERATOR_NOTIFY_FROM } from "~/server/tasks/task-mutation.server";
import { taskClosure } from "./task-closure.server";
import { tasksWaitingOn } from "~/server/projections/dependencies.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { setTaskDependencies } from "./dependencies.server";
import { reprojectTask, taskRef } from "./task-mutation.server";
import { joinDependencyEntries } from "~/shared/dependencies";
import type { DatabaseSync } from "node:sqlite";
import { type TaskFileEvent } from "~/schemas/task-file.schema";
import { setTasksEpic } from "./epic-actions.server";
import { commentOutcomeMessage, repairDoubledNewlines } from "./comment-guardrails.server";
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
import { DEFAULT_GOAL } from "./task-edits.server";
import { OPERATOR_TASK_ACTOR } from "./task-action-core.server";
import { OPERATOR_AUDIT_ACTOR } from "~/server/audit/audit-recorder.server";
import { notifyTaskWatchers, type TaskMutationContext } from "./task-mutation.server";
import { resolveDeployedSpecialist } from "./specialist-roster.server";
import {
  type ClosedDecision,
  followClosedDecision,
  followEditedComment,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import { correctKnowledgeDoc, type KbCorrectionRequest } from "./kb-correction-actions.server";
import { relayToTask, takeFromTask, type TakeRequest } from "./task-relay.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import {
  deliverGate,
  gate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-authority.server";
import { writeOperatorComment } from "./operator-packets.server";

// ------------------------------------------------- KB-vs-repository conflict

/** R19-2 — the timeline title a context conflict always carries. */
const CONTEXT_CONFLICT_TITLE =
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
 * R19-2 (ruling 206) — a KB-vs-repo disagreement is a `quality` flag on the
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
 * grants and the project's rulings) and every engaged agent's. Ruling 210: the
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
 * F39-1/F39-7 (pass 39, ruling 210), generalized by ruling 210 (F40-53) and
 * made a write by ruling 210: the operator CORRECTS a knowledge base, in the
 * document itself.
 *
 * Ruling 210 gave it a proposal against the project's rulings only; ruling 210
 * widened it to every knowledge base a run on the task holds (live in pass 40
 * the stale facts were in the akin-dossier and the deploy runbook, and the
 * operator answered "I'm not changing them myself"). Ruling 210 (owner,
 * 2026-09-26: "No human can approve all of these while inspecting them
 * thoroughly") writes the correction as it is made: `replaces` is the exact
 * passage, `text` what takes its place, and a person undoes it from the
 * Controller page. `kb` null keeps ruling 210's default, the project's rulings.
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
 * Ruling 133 (owner, 2026-09-29): "operator decides if it's own comments needs
 * deleting or editing. Don't expose this to the end user, fixes the problem
 * silently with mcp and doing it itself, not asking the user."
 *
 * On AWSC-19 the Estimate Judge's report said which golden entries price no
 * load-balancer line, on a task every agent can read, and the operator told
 * Arda "A comment is not something I can remove". Ruling 80 gave a person a
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

/** Ruling 61: the audit action shared with the settings page's lease writer. */
const FILE_LEASES_AUDIT_ACTION = "project.file_leases.updated";

/**
 * Ruling 61 (owner, 2026-09-23): the operator leases files to ITS OWN task.
 *
 * Ruling 60 gave the project leases ("this task owns these paths until it
 * merges") and ruling 61 a human surface, but only a person on the settings
 * page, or the controller when a person asked it, could declare one. The
 * operator is the first to SEE two open PRs sharing a file (ruling 116) and
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
      message: `${input.taskKey} is closed, and a lease held by a finished task binds nobody (ruling 60). Nothing was leased.`,
    };
  }
  const leaseCtx = ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {};
  // Ruling 61: a lease that would park work other tasks wait on is a person's
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
          `wrong (ruling 61). Nothing was leased.`,
      };
    }
    return {
      outcome: "noop",
      message:
        `\`${first.path}\` is changed by ${first.key}'s open PR #${first.pr}, and ` +
        `${joinDependencyEntries(others)} ${others.length === 1 ? "waits" : "wait"} on ${first.key}: ` +
        `leasing it to ${input.taskKey} would hold all of them behind ${input.taskKey}. ` +
        `Which of the two lands first is a person's call (ruling 61). Open a decision packet ` +
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
 * Ruling 135 (F40-67): post on ANOTHER task of this project, as the operator.
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
    /** Ruling 135: this task's attachments to put on the other task. */
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

/** Ruling 135: take named attachments of another task onto this one. The
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
      // Ruling 74: the operator flagged the conflict (the event's own actor).
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
 * Ruling 55 (pass 34): the operator records what a task WAITS ON with a
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
 * Ruling 116: the operator puts ITS OWN task in an epic, moves it to another,
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
  /** Ruling 75: the awaiting packet the drafted goal fulfils; the note below
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
