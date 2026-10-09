/**
 * A comment on a task (ruling 13(a)): `appendComment`, a person's or the
 * operator's comment with its @mention fan-out; `commentToAgent`, a comment that
 * dispatches the agent it names and registers that run's completion; and the
 * answer a person's decision sends back to the agent that asked.
 */

import { existsSync } from "node:fs";
import { storedFileName } from "~/server/files/file-store-root.server";
import {
  checkAttachmentBatch,
  withAttachmentClaims,
  type WrittenAttachment,
} from "~/server/files/task-attachments.server";
import { MESSAGE_BATCH } from "~/shared/attachment-kinds";
import { escapeRegExp } from "~/shared/text/regexp";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  deliveringEngagement,
  type ParsedTaskFile,
  reviewSubjectId,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import { canRunAgents, requireProjectMutable } from "~/server/auth/project-authority.server";
import { compactTimelineEvents } from "./timeline-compaction.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  appendPolicyNote,
  loadProjectContext,
  reprojectTask,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { projectRunsForTask } from "~/server/runtimes/run-projection.server";
import { getMaxRunSpendUsd } from "~/server/settings/instance-settings.server";
import {
  getRun,
  listRunsForTaskRows,
  reviewSubjectAtDispatch,
} from "~/server/runtimes/run-store.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  refusedPrincipalUserId,
  resolveTaskRunPrincipal,
} from "~/server/runtimes/run-principal.server";
import { initialsOf } from "~/ui/initials";
import { logger } from "~/server/logging/logger.server";
import {
  mentionNonDeliveryNote,
  notifyMentionedUsers,
  stampNotifiedRecipients,
} from "./mention-notify.server";
import { userDisplayName } from "./user-display-name.server";
import { toError } from "~/shared/errors";
import {
  attachmentKb,
  avatarTone,
  humanActorRef,
  projectRepoFor,
  requireAction,
  stageName,
} from "./task-action-core.server";
import { canonicalTaskAnchor, specialistReplyDirective } from "./task-replies.server";
import { activeFileLeases } from "./file-leases.server";
import {
  liftHoldForRun,
  markWaitingAgent,
  registerAgentCompletion,
} from "./agent-completion.server";

/**
 * Ruling 68 (O39-a): the actor other than the asker that a person's answer to
 * an agent's question names, if any: another deployed agent (by name or
 * @handle) or the operator. Such an answer is routing, which is the
 * operator's job: the asking agent, resumed with it, can only report that it
 * cannot act on it.
 *
 * Live on ax-clone, three of three: AX-22 "Hand off to Surface Developer",
 * after which the developer did the Surface Developer's edits itself; AX-20
 * "Operator: move AX-20 back to Verify ...", which the developer spent a run
 * finding it had no tool for; AX-27 "Offer me a create_task option for the
 * Developer", which the Surface Developer wrote out and could not do. The
 * asker's own name is taken out first, so "Surface Developer" never reads as
 * naming "Developer".
 */
export function answerNamesAnotherActor(
  text: string,
  askerId: string,
  /** The deployed agents, each with the @handle a person would type. */
  agents: readonly { id: string; name: string; handle: string }[],
): string | null {
  // Never a profile id: ids are slugs.
  const OPERATOR = "(operator)";
  const candidates: { id: string; label: string; pattern: string }[] = [
    { id: OPERATOR, label: "the operator", pattern: "operator" },
  ];
  for (const agent of agents) {
    const label = agent.name.trim() || agent.id;
    if (agent.name.trim()) candidates.push({ id: agent.id, label, pattern: agent.name.trim() });
    if (agent.handle) candidates.push({ id: agent.id, label, pattern: agent.handle });
  }
  // Longest first, so "Surface Developer" claims its words before
  // "Developer" can: the asker's name and another agent's can share a word.
  candidates.sort((a, b) => b.pattern.length - a.pattern.length);
  const claimed: { start: number; end: number }[] = [];
  const hits: { at: number; id: string; label: string }[] = [];
  for (const candidate of candidates) {
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}_-])(@?${escapeRegExp(candidate.pattern)})(?=$|[^\\p{L}\\p{N}_-])`,
      "giu",
    );
    for (const match of text.matchAll(re)) {
      const start = (match.index ?? 0) + (match[1] ?? "").length;
      const end = start + (match[2] ?? "").length;
      if (claimed.some((span) => start < span.end && span.start < end)) continue;
      claimed.push({ start, end });
      hits.push({ at: start, id: candidate.id, label: candidate.label });
    }
  }
  const other = hits.filter((hit) => hit.id !== askerId).sort((a, b) => a.at - b.at)[0];
  return other?.label ?? null;
}

/**
 * R15-14 — hand a resolved decision back to the AGENT that asked for it, by
 * resuming that agent's own provider session.
 *
 * The `ask_human` contract has always been "you will not get the answer in this
 * run": the agent asks, the run ends, and the answer used to travel only through
 * the operator, which re-engages the specialist however it sees fit. When it
 * chooses a cold start, the run that receives the answer is not the run that
 * asked the question — it has none of the reasoning that produced it, and pays
 * to rediscover the situation it was already standing in.
 *
 * This routes the decision through `commentToAgent`, the same path an @mention
 * reply takes: it resolves the agent, records the answer on the timeline, and
 * resumes the provider session with the run confinement re-applied. Nothing is
 * held open while the human thinks — the session is resumed on resolution, so a
 * restart between question and answer costs nothing.
 *
 * Returns false when the answer could not be delivered (profile undeployed, no
 * resumable session, agent no longer resolvable), so the caller can fall back to
 * the operator hand-off rather than swallowing the human's decision. An asker
 * that is still running is owed the answer, not refused it (ruling 68): true.
 */
export async function answerAskingAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    question: string;
    decision: string;
    note?: string;
  },
  actor: TaskActor,
): Promise<boolean> {
  try {
    const { agentMentionHandle } = await import("./agent-reply.server");
    const {
      assertResumeEligible,
      listDeployedSpecialists,
    } = await import("./specialist-roster.server");
    const specialistCtx: TaskMutationContext = {};
    if (ctx.dataRoot) specialistCtx.dataRoot = ctx.dataRoot;
    const deployed = listDeployedSpecialists(
      input.projectSlug,
      specialistCtx,
    ).find((a: { id: string }) => a.id === input.profileId);
    if (!deployed) return false;

    // Ruling 68: only an agent that can run on the task now is handed the
    // answer. Live on AWSC-6 the task had moved on to Estimate by the time Arda
    // answered the Cloud Solutions Architect's mapping question, and "Continue
    // from where you stopped" was posted to an agent that does not run there:
    // the run was refused after the comment was down, and nothing said so. The
    // operator takes the answer instead, and the record says why.
    try {
      assertResumeEligible(db, specialistCtx, input.projectSlug, input.taskKey, deployed.id);
    } catch (error) {
      if (!isAppError(error)) throw error;
      const why = error.userMessage.split(/(?<=\.)\s/)[0] ?? error.userMessage;
      await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text: `The answer went to the operator, not back to ${deployed.name}, who asked: ${why}`,
        toAgent: false,
        evidence: null,
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      return false;
    }

    // Address the agent by the SAME handle a human would type, so resolution
    // goes through one code path instead of a private back door that can drift
    // from what @mentions do.
    const handle = agentMentionHandle({
      profileId: deployed.id,
      name: deployed.name,
    });
    const text =
      `@${handle} Your question, "${input.question}", has been answered by a human: ` +
      `**${input.decision}**.` +
      (input.note ? `\n\n> ${input.note.replace(/\n/g, "\n> ")}` : "") +
      `\n\nThis is the decision you were blocked on. Continue from where you stopped ` +
      `and act on it; do not re-open the same question.`;

    const result = await commentToAgent(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, text, relayed: true },
      // Attributed to the human who resolved it — this IS their decision being
      // relayed, and the runtime-role check inside commentToAgent must run
      // against a real person rather than a system actor that bypasses it.
      actor,
      ctx,
    );
    // Ruling 68: an asker still running when its question is answered gets the
    // answer when that run finishes: its completion delivers every comment the
    // single-flight guard refused (`deliverDeferredMention`). Live on AWSC-5
    // the Cloud Solutions Architect raised its packet and kept working, the
    // answer fell through to the operator with no note, and the operator told
    // the record the answer had gone "straight to" a run that never saw it.
    if (result.triggered === null && result.deferred) {
      await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text:
          `The answer waits for ${deployed.name}, who asked: its run on this task is still ` +
          "going, and Viberr starts it on the answer as soon as that run finishes.",
        toAgent: false,
        evidence: null,
      });
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
      return true;
    }
    // `triggered` is the only honest signal that the answer actually reached a
    // run: a recorded comment whose run never started has not answered anyone.
    return result.triggered !== null;
  } catch (error) {
    logger.warn("could not route a resolved question back to the asking agent", {
      taskKey: input.taskKey,
      profileId: input.profileId,
      err: toError(error),
    });
    return false;
  }
}

/** Mock routing rule (task-detail §5.1): mentions of these handles route
 * the comment to the agent side (`to: agent` tint). */
const AGENT_HANDLE_RE = /@(agent|operator|codex|claude)\b/i;

export interface AppendCommentResult {
  toAgent: boolean;
  mentionedUserIds: string[];
}

/**
 * Append a human comment to the task timeline.
 *
 * E1: this said "App-wide commenting: EVERY registered user may comment,
 * including non-members". That has not been true since the members-only ruling
 * (R15): a signed-in non-member gets a 404 from the task route and from this
 * POST, because the route resolves the project through membership before it
 * reaches here. Commenting is a MEMBER action — `comment`, held by all four
 * project roles including viewer, which is what "app-wide" had degraded into
 * meaning. The reason there is no `requireAction` call in this function is that
 * every one of its callers has already resolved membership; what it does guard
 * explicitly is the archived-project freeze below (R6-3).
 *
 * @mentions fan out `mention` notifications to resolved users (by email
 * local-part or first name, case-insensitive); agent handles route the comment
 * to the operator.
 */
export async function appendComment(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    text: string;
    /** Force the routed-to-agent tint (commentToAgent sets this when a named
     *  agent like `@dev` is mentioned — the reserved-handle regex alone would
     *  miss profile-name mentions). */
    forceToAgent?: boolean;
    /** Ruling 246: a server-side writer's own record, applied in the SAME
     *  locked write that appends the comment (the review relay stamps the
     *  GitHub ids it relayed, so a relay is recorded exactly when its comment
     *  is). Never set by a route. */
    alsoWrite?: (parsed: ParsedTaskFile) => void;
    /** Ruling 76: the files the comment carries, already on the task; the
     *  comment claims them. Set by `commentToAgent` only. */
    attachments?: readonly string[];
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AppendCommentResult> {
  const text = input.text.trim();
  if (!text) throw AppError.validation("Comment text is required.");

  // Archived projects are read-only (R6-3). Commenting is app-wide (not gated by
  // requireAction), so guard it explicitly — an archived project's timeline is
  // frozen until it is restored.
  requireProjectMutable(loadProjectContext(ctx, input.projectSlug), "comment on this task");

  // Existence only: the locked write below reads and parses the file itself
  // (ruling 11, CS-5 — this used to parse it a second time just to ask).
  if (!existsSync(resolveTaskFilePath(taskRef(ctx, input.projectSlug, input.taskKey)))) {
    throw AppError.notFound(`Task ${input.taskKey} not found.`);
  }

  const toAgent = input.forceToAgent === true || AGENT_HANDLE_RE.test(text);
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent,
    evidence: null,
  };
  if (input.attachments?.length) event.attachments = [...input.attachments];

  // Timeline compaction fires on HUMAN comments too — a comment flood used to
  // never compact because compaction only ran inside operator writes.
  const { guardrailCompaction } = await import("./comment-guardrails.server");
  const compaction = guardrailCompaction(ctx, input.projectSlug);
  // B-FD2 (H3): a handle that matched several people notifies NOBODY. The
  // author is the only one who can retag and is still on the page, so the
  // non-delivery lands next to their comment in the same write — resolved
  // BEFORE it, since the fan-out below runs after the file is already saved.
  //
  // F33-9 (pass 33): "matched several people" is no longer the only way a tag
  // reaches nobody. A handle that names exactly one real person who is NOT a
  // member of this project is now a non-delivery too — it used to be a
  // notification that named the project, the task and the comment to someone the
  // members-only 404 then refused (ruling 27 read backwards). Both reasons come
  // from ONE seam so the author gets one note and a third reason lands there
  // rather than here.
  const nonDeliveryNote = mentionNonDeliveryNote(db, text, input.projectSlug);
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(event);
    input.alsoWrite?.(parsed);
    if (nonDeliveryNote.length > 0) {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text: nonDeliveryNote,
        toAgent: false,
        evidence: null,
      });
    }
    if (compaction) parsed.timeline = compactTimelineEvents(parsed.timeline, compaction);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.comment",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { toAgent },
  });

  // Mention fan-out (notification kind `mention`, contracts §4) — the shared
  // helper every comment writer (human AND agent) funnels through (NEW-4).
  // Ruling 11 (CS-5): a comment with no `@` can mention nobody (every mention
  // starts at one), so the author's name and tone the notification would carry
  // are not even looked up.
  let mentionedUserIds: string[] = [];
  if (text.includes("@")) {
    const actorName = userDisplayName(db, actor.userId);
    mentionedUserIds = await stampNotifiedRecipients(
      db,
      taskRef(ctx, input.projectSlug, input.taskKey),
      event,
      notifyMentionedUsers(db, {
        text,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        excludeUserId: actor.userId,
        occurredAt: event.occurredAt,
        from: {
          kind: "human",
          userId: actor.userId,
          name: actorName,
          initials: initialsOf(actorName),
          tone: avatarTone(db, actor.userId),
        },
      }),
    );
  }

  // Ruling 11 (CS-5): no task summary here — every caller renders from its
  // own revalidation, and building one cost four statements and four file
  // reads per comment.
  return { toAgent, mentionedUserIds };
}

export interface CommentToAgentResult extends AppendCommentResult {
  /** The agent the comment @mentioned, or null when none was mentioned. */
  agent: { profileId: string; name: string; role: string } | null;
  /** How the mentioned agent was engaged (null when no agent was engaged). */
  triggered: "resumed" | "started" | null;
  /** Agent-log group to select after a reply run starts. */
  logThreadId: string | null;
  /**
   * True when an agent was mentioned but the commenter lacks the runtime role
   * (admin|maintainer) — the comment is recorded, the run is NOT triggered.
   * The route can toast about this; we never throw for a well-formed comment.
   */
  runtimeDenied: boolean;
  /**
   * Why an @operator mention did NOT start a run even though the commenter could
   * trigger one: `open-packet` (a decision packet is awaiting the human — resolve
   * it first) or `closed` (ruling 52: the task is archived or at its terminal
   * stage — restore or reopen it). `blocked-by` is in the type because it is
   * `runOperator`'s, but a manual trigger never meets it. Null when the
   * operator run started normally or no operator was mentioned. Without this the
   * operator branch reported `triggered: "started"` on a refused run, so the route
   * toasted "@Operator is picking it up" while nothing ran (the reply never came).
   */
  operatorRefused: "open-packet" | "closed" | "blocked-by" | null;
  /**
   * A8 (pass 23): the comment is recorded BEFORE any run starts, so a SPECIALIST
   * run-start failure (single-flight conflict, a backend the task owner has not
   * connected (ruling 137), stage ineligibility) used to throw out of here — the
   * commenter saw a bare error and could not tell their comment HAD posted. This
   * carries the reason the run did not start (the comment did), so the route
   * toasts "comment posted, run not started: <reason>" instead of an error that
   * reads as total failure. Null on the happy path and on the runtime-denied
   * path (which has its own signal).
   * Distinct from `operatorRefused`, which is the operator branch's governed
   * refusal signal.
   */
  runNotStarted: string | null;
  /** Ruling 69: the run did not start because this agent is already running
   *  on the task, which is the one refusal viberr makes good on: that run's
   *  completion starts it on this comment (`deliverDeferredMention`). */
  deferred?: true;
}

/**
 * F35-5 (pass 35): the durable trace of an @mention whose run did not start.
 * Best-effort, like the ambiguous-handle note beside it: the comment is
 * already on the record, and a failure to annotate it must not fail the post.
 */
async function noteMentionNotStarted(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  agentName: string,
  profileId: string,
  reason: string,
): Promise<void> {
  try {
    const detail = reason.trim().replace(/\.?$/, ".");
    await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
      title: "Mention not started",
      text:
        `**Not started:** @${agentName} was mentioned, but its run did not start: ${detail} ` +
        `The comment stays on the record.`,
    });
    recordAudit(db, {
      action: "task.comment.unrouted",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { profileId, reason: "run-not-started", detail },
    });
  } catch (noteError) {
    logger.warn("could not record the mention-not-started note", {
      taskKey: input.taskKey,
      err: toError(noteError),
    });
  }
}

/**
 * Ruling 76: a comment's files, checked before anything is written: the
 * `attach-file` tier, a task that is not archived, the upload's own rules for
 * a batch, and no name an agent run saved (ruling 84, as `attachTaskFile`).
 * `append` puts them on the task and writes the comment that claims them,
 * under the claim that keeps a completing run from taking them (ruling 77),
 * then audits each. The comment's text names them, so every reader of the
 * comment (an agent it wakes, a notification, a digest) learns what came.
 * Null when the comment carries no file.
 */
function commentFiles(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; text: string; files?: readonly { name: string; data: Uint8Array }[] },
  actor: TaskActor,
  ctx: TaskMutationContext,
): {
  text: string;
  append: <T>(write: (attachments: readonly string[]) => Promise<T>) => Promise<T>;
} | null {
  const files = input.files ?? [];
  if (files.length === 0) return null;
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "attach-file", "attach a file to a comment");
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) throw AppError.notFound(`No task ${input.taskKey} in ${input.projectSlug}.`);
  if (existing.parsed.frontmatter.archived) {
    throw AppError.validation(`${input.taskKey} is archived. Restore it before attaching a file.`);
  }
  const names = checkAttachmentBatch(files, MESSAGE_BATCH);
  // Ruling 76: composed, as `names` are and as the store resolves them.
  const agentSaved = new Set(
    existing.parsed.timeline.flatMap((e) => (e.actor.kind === "agent" ? (e.attachments ?? []).map(storedFileName) : [])),
  );
  const listed = names.map((name, i) => `\`${name}\` (${attachmentKb(files[i]!.data.byteLength)})`).join(", ");
  const words = input.text.trim();
  return {
    text: `${words ? `${words}\n\n` : ""}Attached ${listed}.`,
    append: async (write) => {
      const written: WrittenAttachment[] = [];
      const result = await withAttachmentClaims(
        input.projectSlug,
        input.taskKey,
        names,
        async (put) => {
          names.forEach((name, i) => {
            written.push(
              put(
                name,
                files[i]!.data,
                agentSaved.has(name)
                  ? `“${name}” is a file an agent run saved on ${input.taskKey}, and it may be the work under review. Attach yours under another name.`
                  : null,
              ),
            );
          });
          return write(written.map((w) => w.name));
        },
        ctx.dataRoot,
      );
      for (const file of written) {
        recordAudit(db, {
          action: "task.attachment.added",
          actor: { userId: actor.userId, label: actor.label },
          subjectKind: "task",
          subjectId: input.taskKey,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          details: { name: file.name, bytes: file.bytes, replaced: file.replaced },
        });
      }
      return result;
    },
  };
}

/** Append a comment and, when authorized, resume or start its mentioned agent. */
export async function commentToAgent(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    text: string;
    /** F35-5: set by the server when it relays a packet decision to the asking
     *  agent through this door. A refusal is then the resolver's to handle
     *  (it falls back to the operator), so no "Mention not started" note is
     *  written for it. Never set by a route. */
    relayed?: boolean;
    /** Ruling 69: this comment is ALREADY on the timeline — viberr is keeping
     *  the promise it made when the agent was busy, not recording a new one.
     *  Skips the append (and its mention fan-out, which already happened) and
     *  skips the "Mention not started" note on a second failure, because the
     *  first attempt's note already says why. Never set by a route. */
    redelivered?: boolean;
    /** Ruling 246: see `appendComment`. Never set by a route. */
    alsoWrite?: (parsed: ParsedTaskFile) => void;
    /** Ruling 76: files the person sends with the comment. They land as the
     *  task's attachments, claimed by the comment, which names them. */
    files?: readonly { name: string; data: Uint8Array }[];
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<CommentToAgentResult> {
  const withFiles = commentFiles(db, input, actor, ctx);
  // Resolve the mentioned agent FIRST (a dynamic import, though agent-reply
  // does not reach this module statically, so no cycle needs it). We need it
  // before appending so a named mention like `@dev` still flags the comment as
  // routed-to-agent (AGENT_HANDLE_RE alone only matches the reserved
  // backend/role handles).
  const {
    agentMentionHandle,
    ambiguousBackendHandle,
    ambiguousBackendHandleNote,
    resolveMentionedAgent,
    resumeWorkdir,
  } = await import("./agent-reply.server");
  // Ruling 11 (CS-5): an agent is engaged only by an @handle, so a comment
  // without an `@` skips both agent resolvers (each reads the project file and
  // every deployed profile) — the answer they would give, without the reads.
  const mayMention = input.text.includes("@");
  const target = mayMention
    ? resolveMentionedAgent(db, ctx, input.projectSlug, input.taskKey, input.text)
    : null;

  // 1. Record the comment (existing behavior, incl. mention fan-out). Flag
  //    the routed tint when an agent was resolved.
  const commentInput = target ? { ...input, forceToAgent: true } : input;
  const base = input.redelivered
    ? { toAgent: true, mentionedUserIds: [] }
    : withFiles
      ? await withFiles.append((attachments) =>
          appendComment(db, { ...commentInput, text: withFiles.text, attachments }, actor, ctx),
        )
      : await appendComment(db, commentInput, actor, ctx);

  if (!target) {
    // B-AG2: `@claude` on a project running two claude profiles engages NOBODY
    // — the refusal is right, but on its own it is a silent drop: no run, no
    // tint, no trace, while the composer still offers the handle. Say which
    // profiles the runtime handle covers so the human can re-tag precisely.
    const ambiguous = mayMention
      ? ambiguousBackendHandle(ctx, input.projectSlug, input.text)
      : null;
    if (ambiguous) {
      await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
        text: ambiguousBackendHandleNote(ambiguous),
      });
      // Its own action id: the comment itself is already audited as
      // `task.comment`, and re-using that id would double-count the comment in
      // every action-keyed projection that reads it.
      recordAudit(db, {
        action: "task.comment.unrouted",
        actor: { userId: actor.userId, label: actor.label },
        subjectKind: "task",
        subjectId: input.taskKey,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        details: {
          ambiguousBackendHandle: ambiguous.backend,
          candidates: ambiguous.candidates.map((c) => c.profileId).join(", "),
        },
      });
    } else if (/@agent\b/i.test(input.text)) {
      // Hunt 2026-08-29: with the static slot gone, a task normally has NO
      // delivering engagement until something dispatches one — so `@agent`
      // (which addresses the deliverer) resolves to nothing, while the
      // comment still gets the routed tint from AGENT_HANDLE_RE. The same
      // B-AG2 rule applies: a refusal that leaves no trace is a silent drop.
      const fm = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))
        ?.parsed.frontmatter;
      if (fm && deliveringEngagement(fm) === null) {
        await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
          text:
            "**Note:** `@agent` addresses the task's delivering agent, and no agent " +
            "delivers this task yet; the comment reached no agent. Run one from the " +
            "Execution profile (a repo-write agent's first run makes it the deliverer), " +
            "or mention a deployed agent by name.",
        });
        recordAudit(db, {
          action: "task.comment.unrouted",
          actor: { userId: actor.userId, label: actor.label },
          subjectKind: "task",
          subjectId: input.taskKey,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          details: { reservedHandle: "agent", reason: "no-delivering-agent" },
        });
      }
    }
    return {
      ...base,
      agent: null,
      triggered: null,
      logThreadId: null,
      runtimeDenied: false,
      operatorRefused: null,
      runNotStarted: null,
    };
  }

  const agentIdentity = {
    profileId: target.profileId,
    name: target.name,
    role: target.role,
  };

  // 3. RBAC: only admin|maintainer trigger runtime work. A lower role still
  //    got their comment recorded above — just skip the run (no throw).
  if (!hasRuntimeRole(db, ctx, input.projectSlug, actor)) {
    return {
      ...base,
      agent: agentIdentity,
      triggered: null,
      logThreadId: null,
      runtimeDenied: true,
      operatorRefused: null,
      runNotStarted: null,
    };
  }

  const commenterName = userDisplayName(db, actor.userId);

  // 3b. `@operator` → run the OPERATOR (a governed run), not a specialist. The
  //     human's comment is already on the timeline (appended above), so the
  //     operator reads it in its snapshot; it is also passed as the run's human
  //     directive. The operator responds via its own comments during the run.
  if (target.isOperator) {
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    const result = await runOperator(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      trigger: "manual",
      humanComment: input.text.trim(),
      humanCommentBy: commenterName,
      dataRoot: ctx.dataRoot,
      actor: { userId: actor.userId, label: actor.label },
    });
    // A manual operator trigger is REFUSED (no run) while a decision packet is
    // open or the task is Done — a paid no-op that would spin the operator while
    // the ball is in the human's court. `runOperator` returns `refused` +
    // `runId: null` then; report that honestly instead of claiming the operator
    // is picking the comment up (the reply would never come). The comment is
    // already recorded via `base`.
    if (result.refused) {
      // Ruling 52 (pass 36, F36-4): a closed task refuses the mention's run;
      // the comment stays on the record and the F35-5 note says the mention
      // went nowhere, with the same sentence the Run buttons show.
      if (result.refused === "closed") {
        await noteMentionNotStarted(
          db,
          ctx,
          input,
          actor,
          "operator",
          "operator",
          result.refusalReason ?? `${input.taskKey} is closed`,
        );
      }
      return {
        ...base,
        agent: agentIdentity,
        triggered: null,
        logThreadId: null,
        runtimeDenied: false,
        operatorRefused: result.refused,
        runNotStarted: null,
      };
    }
    const logThreadId = resolveReplyLogThread(
      db,
      input.projectSlug,
      input.taskKey,
      result.runId,
    );
    return {
      ...base,
      agent: agentIdentity,
      triggered: "started",
      logThreadId,
      runtimeDenied: false,
      operatorRefused: null,
      runNotStarted: null,
    };
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  const title = existing?.parsed.frontmatter.title ?? input.taskKey;
  const repo = projectRepoFor(ctx, input.projectSlug); // P13-D-5

  // P13-D-3: the canonical re-anchor block. This directive is the WHOLE prompt
  // a resumed specialist receives (the fresh-run path below builds its own
  // analyze prompt), so the canonical state has to ride with it or the agent
  // works from provider-session memory alone — stale goal included.
  let anchor: string | null = null;
  if (existing) {
    try {
      const project = loadProjectContext(ctx, input.projectSlug);
      anchor = canonicalTaskAnchor({
        parsed: existing.parsed,
        stageName: stageName(project, existing.parsed.frontmatter.stage),
        // Ruling 60: what another task owns right now, resolved as a fresh
        // run's anchor resolves it, so a resumed run is warned off it too.
        fileLeases: activeFileLeases(input.projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
        // Ruling 315: what Viberr ran on the revision under review.
        gates: project.gates,
      });
    } catch {
      // A missing/unreadable project file must never block a reply run — fall
      // back to the raw stage id rather than dropping the anchor entirely. The
      // leases and the gates are read from that file, so it names neither.
      anchor = canonicalTaskAnchor({
        parsed: existing.parsed,
        stageName: existing.parsed.frontmatter.stage,
        fileLeases: [],
        gates: [],
      });
    }
  }

  // The follow-up prompt built from the comment (autonomous reply).
  const directive: Parameters<typeof specialistReplyDirective>[0] = {
    commenterName,
    taskKey: input.taskKey,
    title,
    text: input.text.trim(),
    // A supporting engagement never delivers, so its directive says so instead
    // of naming push/PR rules that don't apply to it (P13-RT-05).
    delivers: target.isPrimary,
    repository: repo !== null,
  };
  if (anchor) directive.anchor = anchor;
  const followUp = specialistReplyDirective(directive);

  const { resumeRun } = await import(
    "~/server/runtimes/run-service.server"
  );

  let runId: string;
  let triggered: "resumed" | "started";
  let resumeOutcomeKey: string | undefined;
  /** Ruling 69: the single-flight guard refused it, so it is owed, not lost. */
  let deferred = false;

  // A8 (pass 23): the comment is ALREADY on the timeline. A run-start failure
  // (single-flight conflict, a backend the task owner has not connected (ruling
  // 137), stage ineligibility) below used to throw straight out of here, so the
  // commenter saw only an error and could not tell their comment HAD posted.
  // Catch it and return the partial success — comment recorded, run not started,
  // reason attached — rather than throwing. (The operator @mention refusal is a
  // separate governed signal.)
  try {
    // Dispatch-rework hunt (2026-08-29): the RESUME branch below calls
    // resumeRun directly and so bypassed dispatchAgentRun's same-engagement
    // single-flight entirely — an @mention landing while the agent was already
    // running resumed a SECOND process into the same isolated checkout (the
    // exact double-run the P8 serialization and the
    // idx_agent_runs__one_live_per_support index exist to prevent). Refuse it
    // here, before either branch; the A8 catch turns it into the honest
    // partial success (comment posted, run not started).
    const liveSameProfile = listRunsForTaskRows(
      db,
      input.projectSlug,
      input.taskKey,
    ).some(
      (r) =>
        r.agent_profile_id === target.profileId &&
        (r.state === "running" || r.state === "queued"),
    );
    if (liveSameProfile) {
      deferred = true;
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        // Ruling 69: this used to promise that the agent "will see the comment
        // when it next re-anchors". It carried no such comment: the anchor
        // holds the last five timeline events, clamped, and only a FRESH run
        // builds one — live, an owner's correction was eight events back
        // within 75 seconds and the agent it named never ran on that task
        // again. Viberr now keeps the promise instead of making it
        // (`deliverDeferredMention`, on that run's completion).
        userMessage:
          "This agent already has a run in progress on this task; Viberr starts it on this comment as soon as that run finishes. The comment stays on the record.",
      });
    }
    if (target.session) {
    // Ruling 181 (pass 34): the resume door is stage-gated like every other
    // door. Inside the A8 try, so a supporting agent gets the honest partial
    // success (comment posted, `runNotStarted` names the refusal) while the
    // engaged deliverer resumes anywhere.
    const { assertResumeEligible } = await import("./specialist-roster.server");
    assertResumeEligible(db, ctx, input.projectSlug, input.taskKey, target.profileId);
    // 4a. Resume the agent's existing provider session, reusing the clone
    //     workdir so it keeps its repo context. P8 (pass 25): a supporting agent
    //     resumes into its OWN isolated checkout, never the delivering tree.
    const workdir = resumeWorkdir(
      input.projectSlug,
      input.taskKey,
      repo,
      ctx.dataRoot,
      target.isPrimary ? undefined : { profileId: target.profileId },
    );
    // Ruling 137: a resumed task run bills the task owner AS OF NOW — the
    // caller resolves the principal, `resumeRun` re-resolves nothing. When the
    // seat changed hands since the original run, `resumeRun` takes the existing
    // continuity-reset path: one fresh run re-anchored on task.md, with the
    // timeline saying context was lost. That is the honest outcome — the
    // alternative is resuming one person's conversation inside another's
    // account (agents-and-runtime.md §3.6).
    //
    // Resolved FIRST, before the confinement below: `resolveResumeConfinement`
    // is not a read. It pre-flights every declared stdio MCP server by spawning
    // it, corrects the registry rows from what happened, and re-mounts the
    // granted skills into the task workspace — real processes and real writes,
    // whose only consumer is an agent process a refusal will never start.
    const resumeBackend: RealBackend =
      target.session.backend === "codex" ? "codex" : "claude";
    const resumePrincipal = resolveTaskRunPrincipal(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      resumeBackend,
    );
    // Ruling 151 (pass 35, G35-4), cluster review: a resume IS a dispatch —
    // it spends the same provider window. This branch never reaches
    // `dispatchAgentRun`, so the hold was read for a fresh mention and skipped
    // for the far more common one: @mentioning the agent that is already
    // working the task. Held here, before the confinement's MCP spawns and the
    // skill re-mount, the retry lands on the same schedule every other door's
    // hold uses; the A8 catch below turns the throw into the honest partial
    // success (comment posted, `runNotStarted` carrying the hold sentence).
    if (resumePrincipal.ok) {
      const { assertDispatchNotHeld } = await import("./specialist-run.server");
      await assertDispatchNotHeld(db, ctx, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        backend: resumeBackend,
        credentialUserId: resumePrincipal.principal.userId,
        profileId: target.profileId,
        agentName: target.name,
        deployed: true,
        directive: input.text.trim(),
        actor: { userId: actor.userId, label: actor.label },
      });
    }
    // Re-establish the specialist's run confinement — denylist, git ceiling,
    // MCP set, persona — that the fresh-run path applies. Without this a
    // resumed (@mention) specialist runs unconfined (XS-1). A refused resume
    // has no run to confine: `resumeRun` hands it to `startRun`, which records
    // the refusal and starts nothing.
    const { resolveResumeConfinement, recordRunInputs } = await import(
      "./specialist-run.server"
    );
    const confinement = resumePrincipal.ok
      ? await resolveResumeConfinement(db, ctx, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          profileId: target.profileId,
          backend: resumeBackend,
          role: target.role,
          delivers: target.isPrimary,
        })
      : null;
    const resume: Parameters<typeof resumeRun>[1] = {
      runId: target.session.id,
      prompt: followUp,
      credentialUserId: resumePrincipal.ok
        ? resumePrincipal.principal.userId
        : refusedPrincipalUserId(resumePrincipal.refusal),
      workdir,
      // Apply the agent's CURRENT profile model/effort on resume — not the
      // stale value on the prior run row (editing an agent to a new model
      // must take effect when its session is resumed via a comment).
      model: target.model,
      // Stamp the agent's identity so the reply run groups under (and labels)
      // the agent's own Agent-logs entry ("dev"), even when resuming a seeded
      // session row that predates the identity columns.
      agentName: target.name,
      agentProfileId: target.profileId,
      autonomous: true,
      dataRoot: ctx.dataRoot,
      actor: { userId: actor.userId, label: actor.label },
    };
    // The workspace mount survives between runs, but the SDK options do not —
    // re-arm the native skills filter or the resumed run enables none.
    if (confinement) {
      resume.disallowedTools = confinement.disallowedTools;
      if (confinement.mcpToolDenials) resume.mcpToolDenials = confinement.mcpToolDenials;
      if (confinement.mcpOptional) resume.mcpOptional = confinement.mcpOptional;
      resume.env = confinement.env;
      if (confinement.skills) resume.skills = confinement.skills;
      if (confinement.skillPlugin) resume.skillPlugin = confinement.skillPlugin;
      if (confinement.mcpServers) resume.mcpServers = confinement.mcpServers;
      if (confinement.systemPrompt) resume.systemPrompt = confinement.systemPrompt;
      // Ruling 170: the compaction anchor is part of the confinement too.
      if (confinement.compactAnchor) resume.compactAnchor = confinement.compactAnchor;
      // F7: re-arm the Codex outcome envelope so a resumed reviewer emits a
      // structured verdict/questions instead of falling back to the prose regex.
      if (confinement.outputSchema) resume.outputSchema = confinement.outputSchema;
      // C02-R3: the attachments drop is part of the confinement too (the Codex
      // sandbox's extra writable root) — dropped on resume, an evidence-granted
      // Codex reviewer could not post the files its persona promised.
      if (confinement.attachmentsWritableDir) {
        resume.attachmentsWritableDir = confinement.attachmentsWritableDir;
      }
      // Ruling 199: and the no-checkout scratch its file tools may write.
      if (confinement.scratchDir) resume.scratchDir = confinement.scratchDir;
    }
    if (target.effort) resume.effort = target.effort;
    if (!resumePrincipal.ok) resume.principalRefusal = resumePrincipal.refusal;
    // Ruling 153: what the resumed run will judge. A resume re-pins nothing:
    // the checkout is where the run it resumes left it, at that run's subject,
    // so a commit revision under review is that run's; files are read as they
    // stand, so a delivery of files is today's.
    const resumeFm = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter;
    if (resumeFm) {
      const pinned = reviewSubjectAtDispatch(getRun(db, target.session.id));
      resume.reviewSubject =
        pinned !== undefined && activeWorkRevision(resumeFm.workRevision) !== null
          ? pinned
          : reviewSubjectId(resumeFm);
    }
    const resumed = await resumeRun(db, resume);
    runId = resumed.runId;
    resumeOutcomeKey = confinement?.outcomeKey;
    triggered = "resumed";
    // Ruling 167: the disclosure the fresh path writes, on the resumed run too.
    // `resolveResumeConfinement` returns `runInputsFor` for exactly this, and
    // the caller "passes the whole thing to `recordRunInputs` once `resumeRun`
    // has minted the run id": the id names the run's own temp directory among
    // its file tools' roots (ruling 217(d)). The four fields it does not own
    // are all in scope here, because this function composes the prompt.
    if (confinement) {
      const resumedRow = getRun(db, runId);
      if (resumedRow) {
        recordRunInputs(db, {
          runId,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          threadId: resumedRow.thread_id,
          backend: resumeBackend,
          dataRoot: ctx.dataRoot,
          inputs: {
            ...confinement.runInputsFor(runId),
            promptChars: followUp.length,
            anchor: anchor ?? null,
            spendCapUsd: getMaxRunSpendUsd(db),
            directive: {
              from: commenterName,
              chars: input.text.trim().length,
            },
          },
        });
      }
    }
  } else {
    // 4b. No prior session for THIS agent — start a FRESH run. The
    //     dynamic-dispatch auto-engage (startAgentRun) routes the posture: an
    //     already-engaged agent keeps its shape, and an unengaged one becomes
    //     the deliverer only when the task has none AND the profile holds
    //     repo-write — otherwise it engages as supporting on its own thread
    //     (so a reviewer mention never clobbers the delivering specialist).
    const { startAgentRun } = await import("./specialist-run.server");
    const started = await startAgentRun(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: target.profileId,
        // P14-RT-02: a FRESH mention run gets the human's words and name, the
        // same way the resumed path gets `specialistReplyDirective`. Without
        // them the run received only the generic analyze prompt: live, the
        // agent read the TASK GOAL as its instruction, called it a
        // prompt-injection attempt, and answered nobody.
        directive: input.text.trim(),
        directiveFrom: commenterName,
        // Dispatch-completion contract: an @mention IS a manual dispatch —
        // the report tags the commenter + @operator and the completion
        // re-invokes the operator.
        triggeredByName: commenterName,
        triggeredByUserId: actor.userId,
      },
      actor,
      ctx,
    );
    runId = started.runId;
    triggered = "started";
    }
  } catch (error) {
    logger.warn("@mention run did not start; the comment was still recorded", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: target.profileId,
      err: toError(error),
    });
    const reason =
      error instanceof AppError ? error.userMessage : "the run could not be started";
    // F35-5 (pass 35): the refusal used to live in this log line only. The
    // comment answered 200 with a `mention` event addressed to the agent, and
    // the person believed the agent was asked (KNC-24: an @mention of a
    // reviewer scoped to later stages, at Triage, left no trace). The record
    // now carries the same note + audit shape the ambiguous-handle branch
    // writes. A packet decision the server RELAYS through this door reports
    // to its resolver instead (`relayed`), which owns the follow-up.
    // Ruling 69: a REDELIVERY that fails needs no second note — the first
    // attempt's note already names the agent and the reason, and repeating it
    // on every completion would turn one honest refusal into a drumbeat.
    if (!input.relayed && !input.redelivered) {
      await noteMentionNotStarted(db, ctx, input, actor, target.name, target.profileId, reason);
    }
    const refused: CommentToAgentResult = {
      ...base,
      agent: agentIdentity,
      triggered: null,
      logThreadId: null,
      runtimeDenied: false,
      operatorRefused: null,
      runNotStarted: reason,
    };
    if (deferred) refused.deferred = true;
    return refused;
  }

  // 5. Install THE canonical completion handler (reply → reconcile → verdict →
  //    react). A FRESH run's start fn (startAgentRun)
  //    already registered it with the real workspace dir; a RESUMED session
  //    (resumeRun ran no start fn) registers it here. An @mention carries no
  //    operator run in ctx, so completion begins a FRESH react chain against the
  //    deployed operator — the reviewer's verdict is recorded and the operator
  //    reads the reply and proposes the next step (fixes the old bug where an
  //    @mention dropped the verdict/reconcile and never re-engaged the operator).
  if (triggered === "resumed") {
    // Ruling 54 (pass 35, F35-8): the lift belongs to every door that starts
    // work, and this branch is a door — it resumes the provider session
    // directly, so it never passes through `dispatchAgentRun`, where the
    // sibling lift sits. The KNC-25 shape is exactly this one: the hold exists
    // because an agent's run FAILED, so that agent HAS a prior session, so a
    // person's "@Developer try again" takes this branch and used to leave
    // `readiness: blocked` standing beside `waiting: agent`.
    await liftHoldForRun(db, ctx, input.projectSlug, input.taskKey, {
      kind: "dispatch",
      profileId: target.profileId,
      name: target.name,
      by: ctx.operatorAuthorized ? null : { userId: actor.userId, label: actor.label },
    });
    await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);
    const completion: Parameters<typeof registerAgentCompletion>[2] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId,
      backend: target.session?.backend === "codex" ? "codex" : "claude",
      profileId: target.profileId,
      role: target.role,
      delivers: target.isPrimary,
      workdir: null,
      // P14-RT-12: ONE handle derivation. This path lower-cased the display
      // name (multi-word → `@docs writer`, which only resolves for a reader that
      // already knows the name) while `startAgentRun` took the role's first word
      // (`@senior`, which resolves to nothing) — so the same agent was addressed
      // differently depending on which path registered its completion.
      agentHandle: agentMentionHandle({
        profileId: target.profileId,
        name: target.name,
      }),
      // C5 (pass 25): this is the @mention resume path in `commentToAgent` — a
      // human's conversational reply to the agent, never a bare review
      // invocation. A reviewer answering it owes no verdict, so the no-verdict
      // note must not fire for it (see applyAgentCompletionEffects).
      fromHumanDirective: true,
      // Dispatch-completion contract: an @mention is a manual dispatch — the
      // report tags the commenter + @operator, and the completion always
      // re-invokes the operator.
      dispatchedByName: commenterName,
      dispatchedByUserId: actor.userId,
      // F-P11 (pass 25): `envelopeRequested` is intentionally left undefined here
      // — the confinement (which knows whether the resumed run got the envelope
      // schema) is scoped to the resume branch above, so this shared registration
      // keeps the legacy re-parse (undefined), which is safe: a resumed run that
      // genuinely had an envelope still resolves it.
    };
    if (resumeOutcomeKey) completion.outcomeKey = resumeOutcomeKey;
    if (ctx.operatorRun) completion.operatorRun = ctx.operatorRun;
    await registerAgentCompletion(db, ctx, completion);
  }

  // BUG 3: the Agent-logs selection id for the reply run's grouped entry. The
  // reply run is the NEWEST for this agent → the group representative, so its
  // group's RunView.id is the thread the UI should auto-select + stream. Look
  // it up from the freshly-projected grouped list (best-effort — a projection
  // hiccup just yields null and the UI simply doesn't auto-select).
  const logThreadId = resolveReplyLogThread(db, input.projectSlug, input.taskKey, runId);

  return {
    ...base,
    agent: agentIdentity,
    triggered,
    logThreadId,
    runtimeDenied: false,
    operatorRefused: null,
    runNotStarted: null,
  };
}

/**
 * The grouped RunView.id (Agent-logs selection key) that the just-started reply
 * `runId` will appear under. Finds the grouped run whose representative is this
 * run's DB id; falls back to the run's own thread id, then null.
 *
 * B10: `runId` is nullable because `runOperator` can honestly report that a
 * trigger reached NO run — it was queued behind a drive that has not written
 * its row yet. There is no thread to select in that window; it used to arrive
 * here as the literal string "queued" and be looked up as if it were an id.
 */
function resolveReplyLogThread(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  runId: string | null,
): string | null {
  if (!runId) return null;
  try {
    const runViews = projectRunsForTask(db, projectSlug, taskKey);
    const byRepresentative = runViews.find((r) => r.serverRunId === runId);
    if (byRepresentative) return byRepresentative.id;
    // Fallback: the run's own thread id (it may not yet be the representative
    // if a concurrent run is also running for the same agent).
    const row = getRun(db, runId);
    return row?.thread_id ?? null;
  } catch {
    return null;
  }
}

/** `run-agents` against project membership (runtime-action gate) — the single
 *  authority resolution, so an org admin passes as the audited D2 override.
 *  Non-throwing: a lower role's comment is still recorded, the run is skipped. */
function hasRuntimeRole(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
): boolean {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) return false;
  // Delegate the run-agents tier + audit to the ONE shared helper (§4g dedup).
  return canRunAgents(
    db,
    {
      slug: projectSlug,
      memberRoles: new Map(
        file.parsed.frontmatter.members.map((m) => [m.userId, m.role]),
      ),
      archived: file.parsed.frontmatter.archived === true,
    },
    actor,
    "trigger an agent run by @mention",
  );
}
